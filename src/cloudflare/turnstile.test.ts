import { buildSchema, type GraphQLResolveInfo, graphql, Kind } from "graphql";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode } from "../lib/errors";
import { CloudflareMetricsClient } from "./client";

const timeRange = {
	mintime: "2026-01-01T00:00:00Z",
	maxtime: "2026-01-01T00:01:00Z",
};

function createClient(fetch: typeof globalThis.fetch): CloudflareMetricsClient {
	return new CloudflareMetricsClient({
		apiToken: "test-token",
		queryLimit: 100,
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

const schema = buildSchema(`
	scalar string
	scalar uint64
	scalar Time
	input AccountFilter { accountTag: string }
	input AccountTurnstileAdaptiveGroupsFilter_InputObject {
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
	type Account {
		turnstileAdaptiveGroups(
			filter: AccountTurnstileAdaptiveGroupsFilter_InputObject!
			limit: uint64!
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
									}: {
										filter: Record<string, string>;
										limit: number;
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
										if (
											(bounds.datetime_geq &&
												row.datetime < bounds.datetime_geq) ||
											(bounds.datetime_gt &&
												row.datetime <= bounds.datetime_gt) ||
											(bounds.datetime_leq &&
												row.datetime > bounds.datetime_leq) ||
											(bounds.datetime_lt && row.datetime >= bounds.datetime_lt)
										)
											continue;
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
									return [...groups.values()].slice(0, limit);
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
