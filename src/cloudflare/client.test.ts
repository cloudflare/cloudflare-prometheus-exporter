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
