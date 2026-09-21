/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCloudflareMetricsClient } from "../../src/cloudflare/client";
import {
	createPaidZone,
	expectSuccessfulRefresh,
	initializeMetricExporter,
	mockBatchedZoneGroups,
	setupGraphQLNetwork,
} from "./metric-exporter-helpers";

const network = setupGraphQLNetwork();

afterEach(() => vi.restoreAllMocks());

describe("metric-columnar-v1 integration", () => {
	it("stores HTTP families selected by the packed query shape", async () => {
		const accountId = "http-account";
		const zone = createPaidZone(accountId, "http-zone");
		network.use(
			http.post("https://api.cloudflare.com/client/v4/graphql", () => {
				return HttpResponse.json({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									httpRequests1mGroups: [
										{ sum: { requests: 5, cachedRequests: 2 } },
									],
									firewallEventsAdaptiveGroups: [],
								},
							],
						},
					},
				});
			}),
		);

		const snapshot = await expectSuccessfulRefresh(
			await initializeMetricExporter(accountId, "http-metrics", [zone]),
		);

		expect(snapshot.families.slice(0, 2)).toMatchObject([
			{ name: "cloudflare_zone_requests_total", type: "counter" },
			{ name: "cloudflare_zone_requests_cached", type: "gauge" },
		]);
		expect(snapshot.families.at(-1)).toMatchObject({
			name: "cloudflare_zone_cache_hit_ratio",
			type: "gauge",
		});
		const valuesByName = new Map(
			snapshot.zones[0]?.families.map((table) => [
				snapshot.families[table.family]?.name,
				table.values,
			]),
		);
		expect(valuesByName).toEqual(
			new Map([
				["cloudflare_zone_requests_total", [5]],
				["cloudflare_zone_requests_cached", [2]],
				["cloudflare_zone_cache_hit_ratio", [0.4]],
			]),
		);
	});

	it("stores an account-scoped GraphQL counter", async () => {
		const accountId = "request-method-account";
		const zone = createPaidZone(accountId, "request-zone");
		const requests = mockBatchedZoneGroups(
			network,
			[zone],
			"httpRequestsAdaptiveGroups",
			[
				{
					dimensions: { clientRequestHTTPMethodName: "POST" },
					count: 12,
				},
			],
		);

		const snapshot = await expectSuccessfulRefresh(
			await initializeMetricExporter(accountId, "request-method-metrics", [
				zone,
			]),
		);

		expect(requests()).toBe(1);
		expect(snapshot).toMatchObject({
			zones: [
				{
					zone: zone.name,
					families: [
						{
							family: 0,
							labels: { method: ["POST"] },
							values: [12],
							counter: { misses: [5] },
						},
					],
				},
			],
		});
		expect(snapshot.zones[0]?.families[0]?.counter?.lastIngest).toHaveLength(1);
	});

	it("maps a multi-family GraphQL response into generic columns", async () => {
		const accountId = "hostname-account";
		const zone = createPaidZone(accountId, "hostname-zone");
		network.use(
			http.post("https://api.cloudflare.com/client/v4/graphql", () =>
				HttpResponse.json({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									hostRequests: [
										{
											dimensions: { clientRequestHTTPHost: "EXAMPLE.COM" },
											count: 12,
										},
									],
									hostStatus: [],
									hostCache: [],
									hostLatency: [
										{
											dimensions: { clientRequestHTTPHost: "EXAMPLE.COM" },
											avg: {
												edgeTimeToFirstByteMs: 100,
												originResponseDurationMs: 200,
											},
											quantiles: {
												edgeTimeToFirstByteMsP50: 80,
												edgeTimeToFirstByteMsP95: 180,
												originResponseDurationMsP50: 150,
												originResponseDurationMsP95: 350,
											},
										},
									],
								},
							],
						},
					},
				}),
			),
		);

		const snapshot = await expectSuccessfulRefresh(
			await initializeMetricExporter(accountId, "hostname-http-metrics", [
				zone,
			]),
		);

		expect(snapshot.zones[0]).toMatchObject({
			zone: zone.name,
			families: [
				{ family: 0, labels: { host: ["example.com"] }, values: [12] },
				{ family: 3, labels: {}, labelsFrom: 0, values: [0.1] },
				{ family: 4, labels: {}, labelsFrom: 0, values: [0.08] },
				{ family: 5, labels: {}, labelsFrom: 0, values: [0.18] },
				{ family: 6, labels: {}, labelsFrom: 0, values: [0.2] },
				{ family: 7, labels: {}, labelsFrom: 0, values: [0.15] },
				{ family: 8, labels: {}, labelsFrom: 0, values: [0.35] },
			],
		});
	});

	it("maps packed load-balancer aliases in legacy metric order", async () => {
		const accountId = "load-balancer-account";
		const zone = createPaidZone(accountId, "load-balancer-zone");
		network.use(
			http.post("https://api.cloudflare.com/client/v4/graphql", () =>
				HttpResponse.json({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									poolRequests: [
										{
											count: 7,
											dimensions: {
												lbName: "lb",
												selectedPoolName: "pool",
												selectedOriginName: "origin",
											},
										},
									],
									poolRtt: [
										{
											count: 7,
											dimensions: {
												lbName: "lb",
												selectedPoolName: "pool",
												selectedPoolAvgRttMs: 250,
											},
										},
									],
									originsSelected: [
										{
											count: 7,
											dimensions: {
												lbName: "lb",
												selectedPoolName: "pool",
												numberOriginsSelected: 2,
											},
										},
									],
									steeringPolicies: [
										{
											count: 7,
											dimensions: {
												lbName: "lb",
												steeringPolicy: "dynamic_latency",
											},
										},
									],
									loadBalancingRequestsAdaptive: [
										{
											lbName: "lb",
											pools: [{ poolName: "pool", healthy: true }],
										},
									],
								},
							],
						},
					},
				}),
			),
		);

		const snapshot = await expectSuccessfulRefresh(
			await initializeMetricExporter(accountId, "load-balancer-metrics", [
				zone,
			]),
		);

		expect(snapshot.families.map((family) => family.name)).toEqual([
			"cloudflare_zone_pool_health_status",
			"cloudflare_zone_pool_requests_total",
			"cloudflare_zone_lb_pool_rtt_seconds",
			"cloudflare_zone_lb_steering_policy_info",
			"cloudflare_zone_lb_origins_selected_count",
		]);
		expect(snapshot.zones[0]?.families.map((family) => family.values)).toEqual([
			[1],
			[7],
			[0.25],
			[1],
			[2],
		]);
	});

	it("routes a zone-scoped REST gauge", async () => {
		const accountId = "certificate-account";
		const zone = createPaidZone(accountId, "certificate-zone");
		const getSSLCertificates = vi
			.spyOn(getCloudflareMetricsClient(env), "getSSLCertificates")
			.mockResolvedValue([
				{
					id: "cert-1",
					type: "advanced",
					status: "active",
					issuer: "LetsEncrypt",
					expiresOn: "2026-02-01T00:00:00.000Z",
					hosts: [zone.name],
				},
			]);

		const snapshot = await expectSuccessfulRefresh(
			await initializeMetricExporter(
				accountId,
				"ssl-certificates",
				[zone],
				"zone",
			),
		);

		expect(getSSLCertificates).toHaveBeenCalledWith(zone.id);
		expect(snapshot).toMatchObject({
			zones: [
				{
					zone: zone.name,
					families: [
						{
							family: 0,
							labels: {
								type: ["advanced"],
								issuer: ["LetsEncrypt"],
								status: ["active"],
							},
							values: [1_769_904_000],
						},
					],
				},
			],
		});
	});
});
