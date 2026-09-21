/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	createPaidZone,
	expectSuccessfulRefresh,
	initializeMetricExporter,
	mockBatchedZoneGroups,
	setupGraphQLNetwork,
} from "./metric-exporter-helpers";
import { COLO_METRIC_SCENARIOS, type ColoMetricScenario } from "./scenarios";

const network = setupGraphQLNetwork();

function createColoGroups(scenario: ColoMetricScenario) {
	const { colosPerZone, hostsPerColo, trafficPerHost } = scenario.scale;
	return Array.from({ length: colosPerZone }, (_, coloIndex) =>
		Array.from({ length: hostsPerColo }, (_, hostIndex) => ({
			dimensions: {
				coloCode: `COLO-${coloIndex}`,
				clientRequestHTTPHost: `host-${coloIndex}-${hostIndex}.example.com`,
			},
			count: trafficPerHost.requests,
			sum: {
				visits: trafficPerHost.visits,
				edgeResponseBytes: trafficPerHost.responseBytes,
			},
		})),
	).flat();
}

describe("colo-metrics Durable Object", () => {
	it.each(COLO_METRIC_SCENARIOS)("$name", async (scenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) =>
			createPaidZone(accountId, `${accountId}-zone-${index}`),
		);
		const groups = createColoGroups(scenario);
		const graphQLRequests = mockBatchedZoneGroups(
			network,
			zones,
			"httpRequestsAdaptiveGroups",
			groups,
		);
		const exporter = await initializeMetricExporter(
			accountId,
			"colo-metrics",
			zones,
		);
		const snapshot = await expectSuccessfulRefresh(exporter);

		expect(graphQLRequests()).toBe(Math.ceil(scenario.scale.zones / 10));
		const expectedRecords =
			scenario.scale.zones *
			scenario.scale.colosPerZone *
			scenario.scale.hostsPerColo;
		expect(
			snapshot.zones.reduce(
				(total, zone) => total + (zone.families[0]?.values.length ?? 0),
				0,
			),
		).toBe(expectedRecords);
		for (const zone of snapshot.zones) {
			const valuesByName = new Map(
				zone.families.map((table) => [
					snapshot.families[table.family]?.name,
					table.values,
				]),
			);
			expect(
				valuesByName
					.get("cloudflare_zone_colocation_visits_total")
					?.every((value) => value === scenario.scale.trafficPerHost.visits),
			).toBe(true);
			expect(
				valuesByName
					.get("cloudflare_zone_colocation_edge_response_bytes_total")
					?.every(
						(value) => value === scenario.scale.trafficPerHost.responseBytes,
					),
			).toBe(true);
			expect(
				valuesByName
					.get("cloudflare_zone_colocation_requests_total")
					?.every((value) => value === scenario.scale.trafficPerHost.requests),
			).toBe(true);
		}

		if (expectedRecords >= 150_000) {
			const accountCoordinator = env.AccountMetricCoordinator.getByName(
				`account:${accountId}`,
			);
			await accountCoordinator.initialize(accountId, accountId);
			await runInDurableObject(accountCoordinator, async (_instance, state) => {
				await state.storage.put("state", {
					accountId,
					accountName: accountId,
					zones,
					totalZoneCount: zones.length,
					firewallRules: {},
					lastZoneFetch: Date.now(),
					lastRefresh: Date.now(),
				});
			});
			await evictDurableObject(accountCoordinator);
			const metricCoordinator = env.MetricCoordinator.getByName(
				`stream-test:${accountId}`,
			);
			await metricCoordinator.setIdentifier(`stream-test:${accountId}`);
			await runInDurableObject(metricCoordinator, async (_instance, state) => {
				await state.storage.put("state", {
					identifier: `stream-test:${accountId}`,
					accounts: [{ id: accountId, name: accountId }],
					lastAccountFetch: Date.now(),
				});
			});
			await evictDurableObject(metricCoordinator);
			const response = await metricCoordinator.fetch(
				new Request("https://test/export"),
			);
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (reader === undefined) throw new Error("missing Prometheus stream");
			let streamedBytes = 0;
			let largestChunk = 0;
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				streamedBytes += next.value.byteLength;
				largestChunk = Math.max(largestChunk, next.value.byteLength);
			}
			expect(streamedBytes).toBeGreaterThan(32 * 1024 * 1024);
			expect(largestChunk).toBeLessThan(64 * 1024);
		}
	});
});
