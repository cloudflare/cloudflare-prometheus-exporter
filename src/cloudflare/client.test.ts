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
		"r2-operations",
		"r2-storage",
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

	describe("R2 metrics", () => {
		it("computes operations and error metrics from separate GraphQL calls", async () => {
			const client = createClient(async (input, init) => {
				const body = z
					.object({ query: z.string() })
					.parse(await new Request(input, init).json());
				if (body.query.includes("R2OperationsErrors")) {
					return Response.json({
						data: {
							viewer: {
								accounts: [
									{
										r2OperationsAdaptiveGroups: [
											{
												dimensions: {
													actionType: "GetObject",
													bucketName: "my-bucket",
													responseStatusCode: 404,
												},
												sum: { requests: 2 },
											},
										],
									},
								],
							},
						},
					});
				}
				return Response.json({
					data: {
						viewer: {
							accounts: [
								{
									r2OperationsAdaptiveGroups: [
										{
											dimensions: {
												actionType: "GetObject",
												actionStatus: "success",
												bucketName: "my-bucket",
												storageClass: "Standard",
											},
											sum: {
												requests: 10,
												responseBytes: 2048,
												responseObjectSize: 4096,
											},
										},
									],
								},
							],
						},
					},
				});
			});

			const metrics = await client.getAccountMetrics(
				"r2-operations",
				"account-id",
				"My Account",
				{
					mintime: "2026-01-01T00:00:00.000Z",
					maxtime: "2026-01-01T00:01:00.000Z",
				},
			);

			const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));
			expect(byName.cloudflare_r2_operations_requests_total?.values).toEqual([
				{
					labels: {
						account: "my-account",
						bucket: "my-bucket",
						operation: "GetObject",
						status: "success",
						storage_class: "Standard",
					},
					value: 10,
				},
			]);
			expect(
				byName.cloudflare_r2_operations_response_bytes_total?.values[0]?.value,
			).toBe(2048);
			expect(
				byName.cloudflare_r2_operations_response_object_size_bytes_total
					?.values[0]?.value,
			).toBe(4096);
			expect(byName.cloudflare_r2_operations_errors_total?.values).toEqual([
				{
					labels: {
						account: "my-account",
						bucket: "my-bucket",
						operation: "GetObject",
						response_status_code: "404",
					},
					value: 2,
				},
			]);
		});

		it("queries a wider lookback than the scrape window and keeps the most recent snapshot per bucket", async () => {
			const timeRange = {
				mintime: "2026-01-05T00:00:00.000Z",
				maxtime: "2026-01-05T00:01:00.000Z",
			};
			let capturedVariables: { mintime: string; maxtime: string } | undefined;
			const client = createClient(async (input, init) => {
				const body = z
					.object({
						variables: z.object({ mintime: z.string(), maxtime: z.string() }),
					})
					.parse(await new Request(input, init).json());
				capturedVariables = body.variables;
				return Response.json({
					data: {
						viewer: {
							accounts: [
								{
									// Ordered datetime_DESC, as the real API would return.
									r2StorageAdaptiveGroups: [
										{
											dimensions: {
												bucketName: "my-bucket",
												storageClass: "Standard",
												datetime: "2026-01-04T00:00:00.000Z",
											},
											max: {
												objectCount: 100,
												payloadSize: 5000,
												metadataSize: 50,
												uploadCount: 3,
											},
										},
										{
											dimensions: {
												bucketName: "my-bucket",
												storageClass: "Standard",
												datetime: "2026-01-03T00:00:00.000Z",
											},
											max: {
												objectCount: 90,
												payloadSize: 4000,
												metadataSize: 40,
												uploadCount: 1,
											},
										},
									],
								},
							],
						},
					},
				});
			});

			const metrics = await client.getAccountMetrics(
				"r2-storage",
				"account-id",
				"My Account",
				timeRange,
			);

			// The scrape window is one minute wide; the storage handler must
			// widen it to reliably see a daily snapshot.
			expect(capturedVariables?.maxtime).toBe(timeRange.maxtime);
			expect(capturedVariables?.mintime).not.toBe(timeRange.mintime);
			expect(
				new Date(timeRange.maxtime).getTime() -
					new Date(capturedVariables?.mintime ?? 0).getTime(),
			).toBeGreaterThan(24 * 60 * 60 * 1000);

			const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));
			expect(byName.cloudflare_r2_storage_object_count?.values).toEqual([
				{
					labels: {
						account: "my-account",
						bucket: "my-bucket",
						storage_class: "Standard",
					},
					value: 100,
				},
			]);
			expect(byName.cloudflare_r2_storage_upload_count?.values[0]?.value).toBe(
				3,
			);
		});
	});
});
