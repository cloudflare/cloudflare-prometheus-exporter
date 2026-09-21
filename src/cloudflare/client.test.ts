import { parse, visit } from "graphql";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode } from "../lib/errors";
import { CloudflareMetricsClient } from "./client";

function createClient(fetch: typeof globalThis.fetch): CloudflareMetricsClient {
	return new CloudflareMetricsClient({
		apiToken: "test-token",
		queryLimit: 100,
		scrapeDelaySeconds: 300,
		timeWindowSeconds: 60,
		fetch,
	});
}

describe("CloudflareMetricsClient", () => {
	it.each([
		false,
		true,
	])("keeps HTTP metrics grouped by datetime when packed storage=%s", async (packed) => {
		const client = createClient(async (input, init) => {
			const body = z
				.object({
					query: z.string(),
				})
				.parse(await new Request(input, init).json());
			expect(body.query).toContain("datetime");
			expect(body.query).not.toContain("@skip");
			return Response.json({
				data: {
					viewer: {
						zones: [
							{
								zoneTag: "zone-id",
								httpRequests1mGroups: [
									{
										dimensions: { datetime: "2026-01-01T00:00:00Z" },
										sum: { requests: 1 },
									},
									{
										dimensions: { datetime: "2026-01-01T00:01:00Z" },
										sum: { requests: 2 },
									},
								],
								firewallEventsAdaptiveGroups: [],
							},
						],
					},
				},
			});
		});

		const metrics = await client.getZoneMetrics(
			"http-metrics",
			["zone-id"],
			[
				{
					id: "zone-id",
					name: "example.com",
					status: "active",
					plan: { id: "paid", name: "Paid" },
					account: { id: "account-id", name: "Account" },
				},
			],
			{},
			{
				mintime: "2026-01-01T00:00:00Z",
				maxtime: "2026-01-01T00:02:00Z",
			},
			undefined,
			undefined,
			false,
			packed,
		);

		expect(
			metrics.find((metric) => metric.name === "cloudflare_zone_requests_total")
				?.values,
		).toEqual([{ labels: { zone: "example.com" }, value: 1 }]);
	});

	it("parses the legacy load-balancer response when packed storage is disabled", async () => {
		const client = createClient(async (input, init) => {
			const body = z
				.object({ variables: z.object({ packed: z.boolean() }) })
				.parse(await new Request(input, init).json());
			expect(body.variables.packed).toBe(false);
			return Response.json({
				data: {
					viewer: {
						zones: [
							{
								zoneTag: "zone-id",
								loadBalancingRequestsAdaptiveGroups: [
									{
										count: 7,
										dimensions: {
											lbName: "lb",
											selectedPoolName: "pool",
											selectedOriginName: "origin",
											selectedPoolAvgRttMs: 250,
											numberOriginsSelected: 2,
											steeringPolicy: "dynamic_latency",
										},
									},
								],
								loadBalancingRequestsAdaptive: [],
							},
						],
					},
				},
			});
		});

		const metrics = await client.getZoneMetrics(
			"load-balancer-metrics",
			["zone-id"],
			[
				{
					id: "zone-id",
					name: "example.com",
					status: "active",
					plan: { id: "paid", name: "Paid" },
					account: { id: "account-id", name: "Account" },
				},
			],
			{},
			{ mintime: "2026-01-01T00:00:00Z", maxtime: "2026-01-01T00:01:00Z" },
		);

		expect(metrics.map((metric) => metric.name)).toEqual([
			"cloudflare_zone_pool_requests_total",
			"cloudflare_zone_lb_pool_rtt_seconds",
			"cloudflare_zone_lb_steering_policy_info",
			"cloudflare_zone_lb_origins_selected_count",
		]);
	});

	it.each([
		false,
		true,
	])("only removes unused colo dimensions when packed storage=%s", async (packed) => {
		const timeRange = {
			mintime: "2026-01-01T00:00:00.000Z",
			maxtime: "2026-01-01T00:01:00.000Z",
		};
		const fields: string[] = [];
		const client = createClient(async (input, init) => {
			const body = z
				.object({
					query: z.string(),
					variables: z.object({ mintime: z.string(), maxtime: z.string() }),
				})
				.parse(await new Request(input, init).json());
			expect(body.variables).toEqual(timeRange);
			visit(parse(body.query), {
				Field(node) {
					fields.push(node.name.value);
				},
			});
			return Response.json({ data: { viewer: { zones: [] } } });
		});
		await client.getZoneMetrics(
			"colo-metrics",
			["zone-id"],
			[],
			{},
			timeRange,
			undefined,
			undefined,
			false,
			packed,
		);
		expect(fields).toEqual(
			expect.arrayContaining([
				"zoneTag",
				"coloCode",
				"clientRequestHTTPHost",
				"count",
				"visits",
				"edgeResponseBytes",
			]),
		);
		expect(fields.includes("datetime")).toBe(!packed);
		expect(fields.includes("originResponseStatus")).toBe(!packed);
	});

	it.each([
		"worker-totals",
		"logpush-account",
		"magic-transit",
		"magic-transit-slo",
		"magic-transit-traffic",
		"magic-firewall-samples",
		"network-analytics",
		"stream-video-playback",
		"stream-live-inputs",
	] as const)("surfaces %s access denial instead of reporting an empty refresh", async (query) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					errors: [
						{
							message: "account does not have access to the path",
							extensions: { code: "FORBIDDEN" },
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics(query, "account-id", "Account", {
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			}),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_FIELD_ACCESS });
	});

	it("allows a successful query with no observations", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), {
				headers: { "content-type": "application/json" },
			});
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics("network-analytics", "account-id", "Account", {
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			}),
		).resolves.toEqual([]);
	});

	it.each([
		{
			httpStatusGroup: false,
			expected: [
				{ labels: { status: "200", zone: "example.com" }, value: 3 },
				{ labels: { status: "204", zone: "example.com" }, value: 2 },
			],
		},
		{
			httpStatusGroup: true,
			expected: [{ labels: { status: "2xx", zone: "example.com" }, value: 5 }],
		},
	])("respects HTTP status grouping when set to $httpStatusGroup", async ({
		httpStatusGroup,
		expected,
	}) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: "zone-id",
									httpRequests1mGroups: [
										{
											sum: {
												requests: 5,
												responseStatusMap: [
													{ edgeResponseStatus: 200, requests: 3 },
													{ edgeResponseStatus: 204, requests: 2 },
												],
											},
										},
									],
									firewallEventsAdaptiveGroups: [],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		const client = createClient(fetch);

		const metrics = await client.getZoneMetrics(
			"http-metrics",
			["zone-id"],
			[
				{
					id: "zone-id",
					name: "example.com",
					status: "active",
					plan: { id: "paid", name: "Paid" },
					account: { id: "account-id", name: "Account" },
				},
			],
			{},
			{
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			},
			undefined,
			undefined,
			httpStatusGroup,
		);

		expect(
			metrics.find(
				(metric) => metric.name === "cloudflare_zone_requests_status_total",
			)?.values,
		).toEqual(expected);
	});

	it.each([
		"http-metrics",
		"adaptive-metrics",
		"edge-country-metrics",
		"colo-metrics",
		"colo-error-metrics",
		"request-method-metrics",
		"health-check-metrics",
		"load-balancer-metrics",
		"logpush-zone",
		"origin-status-metrics",
		"cache-miss-metrics",
		"hostname-http-metrics",
	] as const)("surfaces %s access denial for exporter backoff", async (query) => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					errors: [
						{
							message: "zone does not have access to the path",
							extensions: { code: "FORBIDDEN" },
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		const client = createClient(fetch);

		await expect(
			client.getZoneMetrics(
				query,
				["zone-id"],
				[
					{
						id: "zone-id",
						name: "example.com",
						status: "active",
						plan: { id: "paid", name: "Paid" },
						account: { id: "account-id", name: "Account" },
					},
				],
				{},
				{
					mintime: "2026-01-01T00:00:00.000Z",
					maxtime: "2026-01-01T00:01:00.000Z",
				},
				query === "hostname-http-metrics"
					? new Set(["example.com"])
					: undefined,
			),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_FIELD_ACCESS });
	});
});
