import { buildSchema, type GraphQLResolveInfo, graphql, Kind } from "graphql";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode } from "../lib/errors";
import { CloudflareMetricsClient } from "./client";

const timeRange = {
	mintime: "2026-01-01T00:00:00Z",
	maxtime: "2026-01-01T00:01:00Z",
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

type TurnstileEvent = {
	accountID: string;
	datetime: string;
	siteKey: string;
	action: string;
	eventType: string;
};

type EventFilter = Partial<
	Record<
		| "datetime_geq"
		| "datetime_gt"
		| "datetime_leq"
		| "datetime_lt"
		| "siteKey"
		| "siteKey_gt"
		| "action"
		| "action_gt"
		| "eventType"
		| "eventType_gt",
		string
	>
> & { OR?: EventFilter[]; AND?: EventFilter[] };

function matchesFilter(row: TurnstileEvent, filter: EventFilter): boolean {
	return (
		(filter.OR === undefined ||
			filter.OR.some((branch) => matchesFilter(row, branch))) &&
		(filter.AND === undefined ||
			filter.AND.every((branch) => matchesFilter(row, branch))) &&
		(filter.datetime_geq === undefined ||
			row.datetime >= filter.datetime_geq) &&
		(filter.datetime_gt === undefined || row.datetime > filter.datetime_gt) &&
		(filter.datetime_leq === undefined ||
			row.datetime <= filter.datetime_leq) &&
		(filter.datetime_lt === undefined || row.datetime < filter.datetime_lt) &&
		(filter.siteKey === undefined || row.siteKey === filter.siteKey) &&
		(filter.siteKey_gt === undefined || row.siteKey > filter.siteKey_gt) &&
		(filter.action === undefined || row.action === filter.action) &&
		(filter.action_gt === undefined || row.action > filter.action_gt) &&
		(filter.eventType === undefined || row.eventType === filter.eventType) &&
		(filter.eventType_gt === undefined || row.eventType > filter.eventType_gt)
	);
}

const schema = buildSchema(`
	scalar string
	scalar uint64
	scalar Time
	input AccountFilter { accountTag: string }
	input AccountTurnstileAdaptiveGroupsFilter_InputObject {
		OR: [AccountTurnstileAdaptiveGroupsFilter_InputObject!]
		AND: [AccountTurnstileAdaptiveGroupsFilter_InputObject!]
		siteKey: string
		siteKey_gt: string
		action: string
		action_gt: string
		eventType: string
		eventType_gt: string
		datetime_geq: Time
		datetime_gt: Time
		datetime_leq: Time
		datetime_lt: Time
	}
	type TurnstileDimensions {
		siteKey: string!
		action: string!
		eventType: string!
	}
	type TurnstileGroup { count: uint64! dimensions: TurnstileDimensions }
	enum AccountTurnstileAdaptiveGroupsOrderBy { siteKey_ASC action_ASC eventType_ASC }
	type Account {
		turnstileAdaptiveGroups(
			filter: AccountTurnstileAdaptiveGroupsFilter_InputObject!
			limit: uint64!
			orderBy: [AccountTurnstileAdaptiveGroupsOrderBy!]
		): [TurnstileGroup!]!
	}
	type Viewer { accounts(filter: AccountFilter!): [Account!]! }
	type Query { viewer: Viewer! }
`);

function event(overrides: Partial<TurnstileEvent> = {}): TurnstileEvent {
	return {
		accountID: "account-id",
		datetime: "2026-01-01T00:00:30Z",
		siteKey: "widget-a",
		action: "login",
		eventType: "challenge_issued",
		...overrides,
	};
}

// Like the analytics API, aggregate raw observations by the selected dimensions.
// Executing the actual request makes omitted dimensions and wrong bounds observable.
function analyticsFetch(events: TurnstileEvent[]): typeof globalThis.fetch {
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
						const accountEvents = events.filter(
							(row) =>
								!filter.accountTag || row.accountID === filter.accountTag,
						);
						if (accountEvents.length === 0) return [];
						return [
							{
								turnstileAdaptiveGroups: (
									{
										filter: bounds,
										limit,
										orderBy = [],
									}: {
										filter: EventFilter;
										limit: number;
										orderBy?: string[];
									},
									_context: unknown,
									info: GraphQLResolveInfo,
								) => {
									const dimensions = info.fieldNodes
										.flatMap((node) => node.selectionSet?.selections ?? [])
										.flatMap((node) =>
											node.kind === Kind.FIELD &&
											node.name.value === "dimensions"
												? (node.selectionSet?.selections ?? [])
												: [],
										)
										.flatMap((node) =>
											node.kind === Kind.FIELD ? [node.name.value] : [],
										);
									const groups = new Map<
										string,
										{
											count: number;
											dimensions: Record<string, string>;
										}
									>();
									for (const row of accountEvents) {
										if (!matchesFilter(row, bounds)) continue;
										const eventDimensions: Record<string, string> = {
											siteKey: row.siteKey,
											action: row.action,
											eventType: row.eventType,
										};
										const labels = Object.fromEntries(
											dimensions.map((dimension) => [
												dimension,
												eventDimensions[dimension] ?? "",
											]),
										);
										const key = JSON.stringify(labels);
										const group = groups.get(key);
										if (group) group.count += 1;
										else groups.set(key, { count: 1, dimensions: labels });
									}
									return [...groups.values()]
										.sort((a, b) => {
											for (const order of orderBy) {
												const field = order.slice(0, -4);
												const left = a.dimensions[field] ?? "";
												const right = b.dimensions[field] ?? "";
												if (left !== right) return left < right ? -1 : 1;
											}
											return 0;
										})
										.slice(0, limit);
								},
							},
						];
					},
				},
			},
		});
		return Response.json(result);
	};
}

function series(
	site_key: string,
	action: string,
	event_type: string,
	value: number,
) {
	return {
		labels: { account: "my-account", site_key, action, event_type },
		value,
	};
}

describe("Turnstile account metrics", () => {
	it("keeps widgets, actions, blank actions and future event types as separate counter series", async () => {
		const client = createClient(
			analyticsFetch([
				event(),
				event(),
				event({ siteKey: "widget-b" }),
				event({ action: "signup" }),
				event({ action: "" }),
				event({ eventType: "challenge_solved" }),
				event({ eventType: "future_event_type" }),
				event({ accountID: "unrelated-account" }),
			]),
		);

		const metrics = await client.getAccountMetrics(
			"turnstile",
			"account-id",
			"My Account",
			timeRange,
		);

		expect(metrics).toHaveLength(1);
		expect(metrics[0]).toMatchObject({
			name: "cloudflare_turnstile_events_total",
			type: "counter",
		});
		expect(metrics[0]?.values).toHaveLength(6);
		expect(metrics[0]?.values).toEqual(
			expect.arrayContaining([
				series("widget-a", "login", "challenge_issued", 2),
				series("widget-b", "login", "challenge_issued", 1),
				series("widget-a", "signup", "challenge_issued", 1),
				series("widget-a", "", "challenge_issued", 1),
				series("widget-a", "login", "challenge_solved", 1),
				series("widget-a", "login", "future_event_type", 1),
			]),
		);
	});

	it.each([
		1, 2, 4,
	])("exports every group when the page size is %s", async (queryLimit) => {
		const client = createClient(
			analyticsFetch([
				event({ siteKey: "widget-b", action: "" }),
				event({ eventType: "challenge_solved" }),
				event({ action: "" }),
				event({ action: "" }),
				event({
					siteKey: "widget-b",
					action: "",
					eventType: "challenge_solved",
				}),
				event({ action: "checkout" }),
				event(),
				event({ siteKey: "widget-z", datetime: timeRange.maxtime }),
				event({ siteKey: "widget-z", datetime: "2025-12-31T23:59:59Z" }),
				event({ siteKey: "widget-z", accountID: "another-account" }),
			]),
			queryLimit,
		);

		const metrics = await client.getAccountMetrics(
			"turnstile",
			"account-id",
			"My Account",
			timeRange,
		);
		expect(metrics[0]?.values).toHaveLength(6);
		expect(metrics[0]?.values).toEqual(
			expect.arrayContaining([
				series("widget-a", "", "challenge_issued", 2),
				series("widget-a", "checkout", "challenge_issued", 1),
				series("widget-a", "login", "challenge_issued", 1),
				series("widget-a", "login", "challenge_solved", 1),
				series("widget-b", "", "challenge_issued", 1),
				series("widget-b", "", "challenge_solved", 1),
			]),
		);
	});

	it("rejects the whole window when a later page fails", async () => {
		const fetch = analyticsFetch([event(), event({ siteKey: "widget-b" })]);
		let page = 0;
		const client = createClient(async (input, init) => {
			if (++page === 2) {
				return Response.json({
					errors: [{ message: "analytics backend failed" }],
				});
			}
			return fetch(input, init);
		}, 1);

		await expect(
			client.getAccountMetrics(
				"turnstile",
				"account-id",
				"My Account",
				timeRange,
			),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
	});

	it("returns raw half-open window deltas without dropping or double-counting boundary events", async () => {
		const client = createClient(
			analyticsFetch([
				event({ datetime: "2025-12-31T23:59:59Z" }),
				event({ datetime: timeRange.mintime }),
				event(),
				event({ datetime: timeRange.maxtime }),
				event({ datetime: "2026-01-01T00:02:00Z" }),
			]),
		);

		const first = await client.getAccountMetrics(
			"turnstile",
			"account-id",
			"My Account",
			timeRange,
		);
		const second = await client.getAccountMetrics(
			"turnstile",
			"account-id",
			"My Account",
			{
				mintime: timeRange.maxtime,
				maxtime: "2026-01-01T00:02:00Z",
			},
		);

		expect(first[0]?.values).toEqual([
			series("widget-a", "login", "challenge_issued", 2),
		]);
		expect(second[0]?.values).toEqual([
			series("widget-a", "login", "challenge_issued", 1),
		]);
	});

	it.each([
		{
			name: "no matching account",
			events: [event({ accountID: "another-account" })],
		},
		{
			name: "an empty dataset in the requested window",
			events: [event({ datetime: timeRange.maxtime })],
		},
	])("returns no metric families for $name", async ({ events }) => {
		const client = createClient(analyticsFetch(events));
		await expect(
			client.getAccountMetrics(
				"turnstile",
				"account-id",
				"My Account",
				timeRange,
			),
		).resolves.toEqual([]);
	});

	it("skips groups with null dimensions without losing valid groups", async () => {
		const client = createClient(async () =>
			Response.json({
				data: {
					viewer: {
						accounts: [
							{
								turnstileAdaptiveGroups: [
									{ count: 99, dimensions: null },
									{
										count: 3,
										dimensions: {
											siteKey: "widget-b",
											action: "",
											eventType: "future_event_type",
										},
									},
								],
							},
						],
					},
				},
			}),
		);

		const metrics = await client.getAccountMetrics(
			"turnstile",
			"account-id",
			"My Account",
			timeRange,
		);
		expect(metrics).toHaveLength(1);
		expect(metrics[0]?.values).toEqual([
			series("widget-b", "", "future_event_type", 3),
		]);
	});

	it.each([
		{
			partial: false,
			message: "account does not have access to the path",
			extensions: { code: "FORBIDDEN" },
			code: ErrorCode.GRAPHQL_FIELD_ACCESS,
		},
		{
			partial: true,
			message: "account does not have access to the path",
			extensions: { code: "FORBIDDEN" },
			code: ErrorCode.GRAPHQL_FIELD_ACCESS,
		},
		{
			partial: true,
			message: "analytics backend failed",
			extensions: {},
			code: ErrorCode.GRAPHQL_ERROR,
		},
	])("rejects GraphQL failures rather than returning a successful refresh (partial=$partial, code=$code)", async ({
		partial,
		message,
		extensions,
		code,
	}) => {
		const client = createClient(async () =>
			Response.json({
				errors: [{ message, extensions }],
				...(partial
					? {
							data: {
								viewer: {
									accounts: [
										{
											turnstileAdaptiveGroups: [
												{
													count: 7,
													dimensions: {
														siteKey: "widget-a",
														action: "login",
														eventType: "challenge_issued",
													},
												},
											],
										},
									],
								},
							},
						}
					: {}),
			}),
		);

		await expect(
			client.getAccountMetrics(
				"turnstile",
				"account-id",
				"My Account",
				timeRange,
			),
		).rejects.toMatchObject({
			code,
			graphqlErrors: [expect.objectContaining({ message })],
		});
	});
});
