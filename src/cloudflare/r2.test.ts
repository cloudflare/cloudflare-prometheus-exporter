import { buildSchema, type GraphQLResolveInfo, graphql, Kind } from "graphql";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode } from "../lib/errors";
import { CloudflareMetricsClient } from "./client";

const timeRange = {
	mintime: "2026-01-05T00:00:00Z",
	maxtime: "2026-01-05T00:01:00Z",
};

function createClient(
	fetch: typeof globalThis.fetch,
	queryLimit = 100,
): CloudflareMetricsClient {
	return new CloudflareMetricsClient({
		apiToken: "test-token",
		queryLimit,
		scrapeDelaySeconds: 300,
		timeWindowSeconds: 60,
		fetch,
	});
}

type Row = Record<string, string | number>;

type OperationRow = {
	accountID: string;
	datetime: string;
	bucketName: string;
	actionType: string;
	actionStatus: string;
	storageClass: string;
	responseStatusCode: number;
	requests: number;
	responseBytes: number;
	responseObjectSize: number;
};

type StorageRow = {
	accountID: string;
	datetime: string;
	bucketName: string;
	storageClass: string;
	objectCount: number;
	payloadSize: number;
	metadataSize: number;
	uploadCount: number;
};

type Filter = { [key: string]: unknown };

function isFilter(value: unknown): value is Filter {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(field: string, left: string | number, right: unknown): number {
	if (field.startsWith("datetime") && typeof left === "string") {
		return Date.parse(left) - Date.parse(String(right));
	}
	if (typeof left === "number") return left - Number(right);
	const r = String(right);
	return left === r ? 0 : left < r ? -1 : 1;
}

// Evaluates the subset of the analytics filter grammar the client uses:
// equality, _gt/_geq/_lt/_leq comparisons, and nested OR/AND branches.
function matchesFilter(row: Row, filter: Filter): boolean {
	for (const [key, expected] of Object.entries(filter)) {
		if (expected === undefined || expected === null) continue;
		if (key === "OR" || key === "AND") {
			if (!Array.isArray(expected)) throw new Error(`${key} must be a list`);
			const branches = expected.filter(isFilter);
			const ok =
				key === "OR"
					? branches.some((branch) => matchesFilter(row, branch))
					: branches.every((branch) => matchesFilter(row, branch));
			if (!ok) return false;
			continue;
		}
		const match = /^(.*?)(_gt|_geq|_lt|_leq)?$/.exec(key);
		const field = match?.[1] ?? key;
		const op = match?.[2];
		const actual = row[field];
		if (actual === undefined) throw new Error(`Unknown filter field ${key}`);
		const cmp = compare(field, actual, expected);
		const ok =
			op === "_gt"
				? cmp > 0
				: op === "_geq"
					? cmp >= 0
					: op === "_lt"
						? cmp < 0
						: op === "_leq"
							? cmp <= 0
							: cmp === 0;
		if (!ok) return false;
	}
	return true;
}

const schema = buildSchema(`
	scalar string
	scalar uint16
	scalar uint64
	scalar Time
	input AccountFilter { accountTag: string }
	input AccountR2OperationsAdaptiveGroupsFilter_InputObject {
		OR: [AccountR2OperationsAdaptiveGroupsFilter_InputObject!]
		AND: [AccountR2OperationsAdaptiveGroupsFilter_InputObject!]
		datetime_geq: Time
		datetime_lt: Time
		bucketName: string
		bucketName_gt: string
		actionType: string
		actionType_gt: string
		actionStatus: string
		actionStatus_gt: string
		storageClass: string
		storageClass_gt: string
		responseStatusCode: uint16
		responseStatusCode_gt: uint16
		responseStatusCode_geq: uint16
	}
	input AccountR2StorageAdaptiveGroupsFilter_InputObject {
		datetime_geq: Time
		datetime_lt: Time
	}
	type R2OperationsDimensions {
		actionType: string!
		actionStatus: string!
		bucketName: string!
		storageClass: string!
		responseStatusCode: uint16!
	}
	type R2OperationsSum {
		requests: uint64!
		responseBytes: uint64!
		responseObjectSize: uint64!
	}
	type R2OperationsGroup { dimensions: R2OperationsDimensions sum: R2OperationsSum }
	enum R2OperationsOrderBy {
		bucketName_ASC
		actionType_ASC
		actionStatus_ASC
		storageClass_ASC
		responseStatusCode_ASC
	}
	type R2StorageDimensions {
		bucketName: string!
		storageClass: string!
		datetime: Time!
		datetimeHour: Time!
	}
	type R2StorageMax {
		objectCount: uint64!
		payloadSize: uint64!
		metadataSize: uint64!
		uploadCount: uint64!
	}
	type R2StorageGroup { dimensions: R2StorageDimensions max: R2StorageMax }
	enum R2StorageOrderBy { datetime_DESC datetimeHour_DESC }
	type Account {
		r2OperationsAdaptiveGroups(
			filter: AccountR2OperationsAdaptiveGroupsFilter_InputObject!
			limit: uint64!
			orderBy: [R2OperationsOrderBy!]
		): [R2OperationsGroup!]!
		r2StorageAdaptiveGroups(
			filter: AccountR2StorageAdaptiveGroupsFilter_InputObject!
			limit: uint64!
			orderBy: [R2StorageOrderBy!]
		): [R2StorageGroup!]!
	}
	type Viewer { accounts(filter: AccountFilter!): [Account!]! }
	type Query { viewer: Viewer! }
`);

function selectedDimensions(info: GraphQLResolveInfo): string[] {
	return info.fieldNodes
		.flatMap((node) => node.selectionSet?.selections ?? [])
		.flatMap((node) =>
			node.kind === Kind.FIELD && node.name.value === "dimensions"
				? (node.selectionSet?.selections ?? [])
				: [],
		)
		.flatMap((node) => (node.kind === Kind.FIELD ? [node.name.value] : []));
}

type Group = {
	dimensions: Row;
	values: Record<string, number>;
};

// Like the analytics API, aggregate raw rows by the selected dimensions,
// then order and truncate to the requested limit.
function aggregate(
	rows: Row[],
	args: { filter: Filter; limit: number; orderBy?: string[] },
	info: GraphQLResolveInfo,
	metrics: string[],
	reduce: (a: number, b: number) => number,
): Group[] {
	const dimensions = selectedDimensions(info);
	const groups = new Map<string, Group>();
	for (const row of rows) {
		if (!matchesFilter(row, args.filter)) continue;
		const labels: Row = {};
		for (const dimension of dimensions) {
			const value = row[dimension];
			if (value === undefined)
				throw new Error(`Unknown dimension ${dimension}`);
			labels[dimension] = value;
		}
		const key = JSON.stringify(labels);
		const group = groups.get(key);
		if (group) {
			for (const metric of metrics) {
				group.values[metric] = reduce(
					group.values[metric] ?? 0,
					Number(row[metric]),
				);
			}
		} else {
			groups.set(key, {
				dimensions: labels,
				values: Object.fromEntries(
					metrics.map((metric) => [metric, Number(row[metric])]),
				),
			});
		}
	}
	return [...groups.values()]
		.sort((a, b) => {
			for (const order of args.orderBy ?? []) {
				const descending = order.endsWith("_DESC");
				const field = order.replace(/_(ASC|DESC)$/, "");
				const left = a.dimensions[field];
				const right = b.dimensions[field];
				if (left === undefined || right === undefined) {
					throw new Error(`orderBy ${order} is not a selected dimension`);
				}
				const cmp = compare(field, left, right);
				if (cmp !== 0) return descending ? -cmp : cmp;
			}
			return 0;
		})
		.slice(0, args.limit);
}

function withHour(row: StorageRow): Row {
	return { ...row, datetimeHour: `${row.datetime.slice(0, 13)}:00:00Z` };
}

function analyticsFetch(data: {
	operations?: OperationRow[];
	storage?: StorageRow[];
}): typeof globalThis.fetch {
	return async (input, init) => {
		const body = z
			.object({
				query: z.string(),
				variables: z.record(z.string(), z.unknown()),
			})
			.parse(await new Request(input, init).json());
		const result = await graphql({
			schema,
			source: body.query,
			variableValues: body.variables,
			rootValue: {
				viewer: {
					accounts: ({ filter }: { filter: { accountTag?: string } }) => {
						const inAccount = (row: { accountID: string }) =>
							!filter.accountTag || row.accountID === filter.accountTag;
						return [
							{
								r2OperationsAdaptiveGroups: (
									args: { filter: Filter; limit: number; orderBy?: string[] },
									_context: unknown,
									info: GraphQLResolveInfo,
								) =>
									aggregate(
										(data.operations ?? []).filter(inAccount),
										args,
										info,
										["requests", "responseBytes", "responseObjectSize"],
										(a, b) => a + b,
									).map((group) => ({
										dimensions: group.dimensions,
										sum: group.values,
									})),
								r2StorageAdaptiveGroups: (
									args: { filter: Filter; limit: number; orderBy?: string[] },
									_context: unknown,
									info: GraphQLResolveInfo,
								) =>
									aggregate(
										(data.storage ?? []).filter(inAccount).map(withHour),
										args,
										info,
										[
											"objectCount",
											"payloadSize",
											"metadataSize",
											"uploadCount",
										],
										Math.max,
									).map((group) => ({
										dimensions: group.dimensions,
										max: group.values,
									})),
							},
						];
					},
				},
			},
		});
		return Response.json(result);
	};
}

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
	return {
		accountID: "account-id",
		datetime: "2026-01-05T00:00:30Z",
		bucketName: "bucket-a",
		actionType: "GetObject",
		actionStatus: "success",
		storageClass: "Standard",
		responseStatusCode: 200,
		requests: 1,
		responseBytes: 100,
		responseObjectSize: 200,
		...overrides,
	};
}

function storage(overrides: Partial<StorageRow> = {}): StorageRow {
	return {
		accountID: "account-id",
		datetime: "2026-01-04T23:00:00Z",
		bucketName: "bucket-a",
		storageClass: "Standard",
		objectCount: 100,
		payloadSize: 5000,
		metadataSize: 50,
		uploadCount: 0,
		...overrides,
	};
}

function valuesOf(
	metrics: Awaited<ReturnType<CloudflareMetricsClient["getAccountMetrics"]>>,
	name: string,
) {
	return metrics.find((metric) => metric.name === name)?.values ?? [];
}

describe("R2 operations metrics", () => {
	const operations = [
		operation(),
		operation({ requests: 2, responseBytes: 50, responseObjectSize: 60 }),
		operation({ actionType: "PutObject", responseBytes: 0 }),
		operation({ storageClass: "InfrequentAccess" }),
		operation({ bucketName: "bucket-b" }),
		operation({
			actionStatus: "userError",
			responseStatusCode: 404,
			requests: 3,
		}),
		operation({
			actionStatus: "userError",
			responseStatusCode: 403,
		}),
		operation({
			bucketName: "bucket-b",
			actionType: "PutObject",
			actionStatus: "internalError",
			responseStatusCode: 500,
		}),
		// Outside the half-open scrape window or account: must not be counted.
		operation({ datetime: timeRange.maxtime }),
		operation({ datetime: "2026-01-04T23:59:59Z" }),
		operation({ accountID: "another-account" }),
	];

	it.each([
		1, 2, 3, 100,
	])("exports every operation and error group when the page size is %s", async (queryLimit) => {
		const client = createClient(analyticsFetch({ operations }), queryLimit);

		const metrics = await client.getAccountMetrics(
			"r2-operations",
			"account-id",
			"My Account",
			timeRange,
		);

		const labels = (
			bucket: string,
			operation: string,
			status: string,
			storage_class: string,
		) => ({ account: "my-account", bucket, operation, status, storage_class });

		expect(
			valuesOf(metrics, "cloudflare_r2_operations_requests_total"),
		).toEqual(
			expect.arrayContaining([
				{
					labels: labels("bucket-a", "GetObject", "success", "Standard"),
					value: 3,
				},
				{
					labels: labels(
						"bucket-a",
						"GetObject",
						"success",
						"InfrequentAccess",
					),
					value: 1,
				},
				{
					labels: labels("bucket-a", "PutObject", "success", "Standard"),
					value: 1,
				},
				{
					labels: labels("bucket-b", "GetObject", "success", "Standard"),
					value: 1,
				},
				{
					labels: labels("bucket-a", "GetObject", "userError", "Standard"),
					value: 4,
				},
				{
					labels: labels("bucket-b", "PutObject", "internalError", "Standard"),
					value: 1,
				},
			]),
		);
		expect(
			valuesOf(metrics, "cloudflare_r2_operations_requests_total"),
		).toHaveLength(6);
		expect(
			valuesOf(metrics, "cloudflare_r2_operations_response_bytes_total"),
		).toContainEqual({
			labels: labels("bucket-a", "GetObject", "success", "Standard"),
			value: 150,
		});
		expect(
			valuesOf(
				metrics,
				"cloudflare_r2_operations_response_object_size_bytes_total",
			),
		).toContainEqual({
			labels: labels("bucket-a", "GetObject", "success", "Standard"),
			value: 260,
		});

		const errors = valuesOf(metrics, "cloudflare_r2_operations_errors_total");
		expect(errors).toHaveLength(3);
		expect(errors).toEqual(
			expect.arrayContaining([
				{
					labels: {
						account: "my-account",
						bucket: "bucket-a",
						operation: "GetObject",
						response_status_code: "403",
					},
					value: 1,
				},
				{
					labels: {
						account: "my-account",
						bucket: "bucket-a",
						operation: "GetObject",
						response_status_code: "404",
					},
					value: 3,
				},
				{
					labels: {
						account: "my-account",
						bucket: "bucket-b",
						operation: "PutObject",
						response_status_code: "500",
					},
					value: 1,
				},
			]),
		);
	});

	it("omits the errors metric when no operation returned an error status", async () => {
		const client = createClient(
			analyticsFetch({
				operations: [operation(), operation({ responseStatusCode: 304 })],
			}),
		);

		const metrics = await client.getAccountMetrics(
			"r2-operations",
			"account-id",
			"My Account",
			timeRange,
		);

		expect(metrics.map((metric) => metric.name)).not.toContain(
			"cloudflare_r2_operations_errors_total",
		);
	});

	it("rejects the whole window when a later page fails", async () => {
		const fetch = analyticsFetch({
			operations: [operation(), operation({ bucketName: "bucket-b" })],
		});
		let operationPages = 0;
		const client = createClient(async (input, init) => {
			const body = z
				.object({ query: z.string() })
				.parse(await new Request(input, init).clone().json());
			if (
				body.query.includes("R2OperationsMetrics") &&
				++operationPages === 2
			) {
				return Response.json({
					errors: [{ message: "analytics backend failed" }],
				});
			}
			return fetch(input, init);
		}, 1);

		await expect(
			client.getAccountMetrics(
				"r2-operations",
				"account-id",
				"My Account",
				timeRange,
			),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
	});
});

describe("R2 storage metrics", () => {
	it("queries a 24-hour lookback anchored on maxtime and keeps the latest value per bucket and storage class", async () => {
		let variables: { mintime?: unknown; maxtime?: unknown } = {};
		const fetch = analyticsFetch({
			storage: [
				storage({
					datetime: "2026-01-04T22:00:00Z",
					objectCount: 90,
					uploadCount: 4,
				}),
				storage({
					datetime: "2026-01-04T23:00:00Z",
					objectCount: 100,
					uploadCount: 2,
				}),
				// The bucket shrank within the newest hour: the latest value is
				// reported, not the hour's maximum.
				storage({
					datetime: "2026-01-04T23:30:00Z",
					objectCount: 80,
					uploadCount: 1,
				}),
				storage({
					storageClass: "InfrequentAccess",
					datetime: "2026-01-04T23:00:00Z",
					objectCount: 7,
				}),
				// A bucket whose latest value is hours old is still exported.
				storage({
					bucketName: "bucket-quiet",
					datetime: "2026-01-04T06:00:00Z",
					objectCount: 5,
					payloadSize: 10,
					metadataSize: 1,
					uploadCount: 3,
				}),
				// Older than the lookback, after maxtime, or another account.
				storage({
					bucketName: "bucket-old",
					datetime: "2026-01-03T23:59:00Z",
				}),
				storage({
					bucketName: "bucket-future",
					datetime: "2026-01-05T00:02:00Z",
				}),
				storage({ bucketName: "bucket-other", accountID: "another-account" }),
			],
		});
		const client = createClient(async (input, init) => {
			variables = z
				.object({ variables: z.record(z.string(), z.unknown()) })
				.parse(await new Request(input, init).clone().json()).variables;
			return fetch(input, init);
		});

		const metrics = await client.getAccountMetrics(
			"r2-storage",
			"account-id",
			"My Account",
			timeRange,
		);

		expect(variables.maxtime).toBe(timeRange.maxtime);
		expect(
			Date.parse(timeRange.maxtime) - Date.parse(String(variables.mintime)),
		).toBe(24 * 60 * 60 * 1000);

		const labels = (bucket: string, storage_class: string) => ({
			account: "my-account",
			bucket,
			storage_class,
		});
		const objectCount = valuesOf(metrics, "cloudflare_r2_storage_object_count");
		expect(objectCount).toHaveLength(3);
		expect(objectCount).toEqual(
			expect.arrayContaining([
				{ labels: labels("bucket-a", "Standard"), value: 80 },
				{ labels: labels("bucket-a", "InfrequentAccess"), value: 7 },
				{ labels: labels("bucket-quiet", "Standard"), value: 5 },
			]),
		);
		expect(
			valuesOf(metrics, "cloudflare_r2_storage_pending_multipart_uploads"),
		).toEqual(
			expect.arrayContaining([
				{ labels: labels("bucket-a", "Standard"), value: 1 },
				{ labels: labels("bucket-quiet", "Standard"), value: 3 },
			]),
		);
		expect(
			valuesOf(metrics, "cloudflare_r2_storage_payload_bytes"),
		).toContainEqual({
			labels: labels("bucket-quiet", "Standard"),
			value: 10,
		});
		expect(
			valuesOf(metrics, "cloudflare_r2_storage_metadata_bytes"),
		).toContainEqual({
			labels: labels("bucket-quiet", "Standard"),
			value: 1,
		});
		expect(metrics.map((metric) => metric.name)).not.toContain(
			"cloudflare_r2_storage_upload_count",
		);
	});

	it("still exports the newest value for every recently reported bucket when rows are truncated", async () => {
		const client = createClient(
			analyticsFetch({
				storage: [
					storage({ datetime: "2026-01-04T23:00:00Z", objectCount: 3 }),
					storage({
						bucketName: "bucket-b",
						datetime: "2026-01-04T23:10:00Z",
						objectCount: 30,
					}),
					storage({ datetime: "2026-01-04T22:00:00Z", objectCount: 2 }),
					storage({ datetime: "2026-01-04T21:00:00Z", objectCount: 1 }),
				],
			}),
			2,
		);

		const metrics = await client.getAccountMetrics(
			"r2-storage",
			"account-id",
			"My Account",
			timeRange,
		);

		expect(valuesOf(metrics, "cloudflare_r2_storage_object_count")).toEqual(
			expect.arrayContaining([
				{
					labels: {
						account: "my-account",
						bucket: "bucket-a",
						storage_class: "Standard",
					},
					value: 3,
				},
				{
					labels: {
						account: "my-account",
						bucket: "bucket-b",
						storage_class: "Standard",
					},
					value: 30,
				},
			]),
		);
	});
});
