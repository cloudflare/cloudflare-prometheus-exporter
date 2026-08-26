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

	it("reports active Magic Transit tunnel health checks", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									magicTransitTunnelHealthChecksAdaptiveGroups: [
										{
											count: 3,
											dimensions: {
												active: 1,
												resultStatus: "ok",
												siteName: "site",
												tunnelName: "tunnel",
											},
										},
										{
											count: 2,
											dimensions: {
												active: 0,
												resultStatus: "timeout",
												siteName: "site",
												tunnelName: "tunnel",
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
		const client = createClient(fetch);

		const metrics = await client.getAccountMetrics(
			"magic-transit",
			"account-id",
			"Account",
			{
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			},
		);

		expect(
			metrics.find(
				(metric) => metric.name === "cloudflare_magic_transit_active_tunnels",
			)?.values,
		).toEqual([
			{
				labels: {
					account: "account",
					site_name: "site",
					tunnel_name: "tunnel",
				},
				value: 3,
			},
		]);
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
