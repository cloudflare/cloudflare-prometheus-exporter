import { describe, expect, it } from "vitest";
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
		"worker-totals",
		"logpush-account",
		"magic-transit",
		"magic-transit-slo",
		"magic-transit-traffic",
		"magic-firewall-samples",
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

	// Network-analytics diverges from the other account queries: each NAv2
	// dataset is queried independently so a per-dataset access denial does NOT
	// throw away the datasets the account IS entitled to (this avoids GraphQL
	// null-bubbling collapsing the whole combined response). A denied dataset is
	// skipped and cached, never surfaced as a thrown error.
	it("skips access-denied network-analytics datasets without throwing", async () => {
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
			client.getAccountMetrics("network-analytics", "account-id", "Account", {
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			}),
		).resolves.toEqual([]);
	});

	it("returns entitled network-analytics datasets when others are denied", async () => {
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const body = String(init?.body ?? "");
			// Only Magic Transit is entitled; every other dataset is denied.
			if (body.includes("NetworkAnalyticsMagicTransit")) {
				return new Response(
					JSON.stringify({
						data: {
							viewer: {
								accounts: [
									{
										magicTransitNetworkAnalyticsAdaptiveGroups: [
											{
												sum: { bits: 100, packets: 5 },
												dimensions: {
													outcome: "pass",
													direction: "ingress",
													ipProtocolName: "tcp",
													mitigationSystem: "flowtrackd",
												},
											},
										],
									},
								],
							},
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
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
		};
		const client = createClient(fetch);

		const metrics = await client.getAccountMetrics(
			"network-analytics",
			"account-id",
			"Account",
			{
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			},
		);

		const names = metrics.map((m) => m.name);
		expect(names).toContain(
			"cloudflare_network_analytics_magic_transit_bits_total",
		);
		expect(names).toContain(
			"cloudflare_network_analytics_magic_transit_packets_total",
		);
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
