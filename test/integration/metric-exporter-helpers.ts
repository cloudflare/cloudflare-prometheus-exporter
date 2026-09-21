/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll } from "vitest";
import { z } from "zod";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";
import type { MetricExporter } from "../../src/durable-objects/MetricExporter";
import type { Zone } from "../../src/lib/types";

const METRIC_TIME_RANGE = {
	mintime: "2026-01-01T00:00:00.000Z",
	maxtime: "2026-01-01T00:01:00.000Z",
};

type MetricExporterStub = ReturnType<typeof env.MetricExporter.getByName>;

export function createPaidZone(accountId: string, id: string): Zone {
	return {
		id,
		name: `${id}.example.com`,
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: accountId, name: accountId },
	};
}

export function setupGraphQLNetwork() {
	const network = setupNetwork();
	beforeAll(() => network.enable());
	afterEach(() => network.resetHandlers());
	afterAll(() => network.disable());
	return network;
}

export function mockBatchedZoneGroups(
	network: ReturnType<typeof setupNetwork>,
	zones: Zone[],
	groupField: string,
	groups: object[],
): () => number {
	let requests = 0;
	network.use(
		http.post(CLOUDFLARE_GQL_URL, async ({ request }) => {
			requests++;
			const { variables } = z
				.object({ variables: z.object({ zoneIDs: z.array(z.string()) }) })
				.parse(await request.json());
			const requestedZones = new Set(variables.zoneIDs);
			return HttpResponse.json({
				data: {
					viewer: {
						zones: zones
							.filter((zone) => requestedZones.has(zone.id))
							.map((zone) => ({
								zoneTag: zone.id,
								[groupField]: groups,
							})),
					},
				},
			});
		}),
	);
	return () => requests;
}

export async function initializeMetricExporter(
	accountId: string,
	queryName: string,
	zones: Zone[],
	scope: "account" | "zone" = "account",
): Promise<MetricExporterStub> {
	const scopeId = scope === "account" ? accountId : zones[0]?.id;
	if (!scopeId || (scope === "zone" && zones.length !== 1)) {
		throw new Error("zone exporters require exactly one zone");
	}
	const exporterId = `${scope}:${scopeId}:${queryName}`;
	const stub = env.MetricExporter.getByName(exporterId);
	await stub.initialize(exporterId);
	if (scope === "account") {
		await stub.updateZoneContext(
			accountId,
			accountId,
			zones,
			{},
			METRIC_TIME_RANGE,
		);
	} else {
		const zone = zones[0];
		if (!zone) {
			throw new Error("zone exporter requires a zone");
		}
		await stub.initializeZone(zone, accountId, accountId, METRIC_TIME_RANGE);
	}
	return stub;
}

export async function exportSuccessfulSnapshot(stub: MetricExporterStub) {
	const lastError = await runInDurableObject(
		stub,
		async (_instance: MetricExporter, state) =>
			(await state.storage.get<{ lastError: string | null }>("state"))
				?.lastError,
	);
	if (lastError !== null) {
		throw new Error(`metric refresh failed: ${lastError}`);
	}
	await evictDurableObject(stub);
	return stub.exportPackedMetrics();
}

export async function expectSuccessfulRefresh(stub: MetricExporterStub) {
	const snapshot = await exportSuccessfulSnapshot(stub);
	if (snapshot?.format !== "metric-columnar-v1") {
		throw new Error("expected metric-columnar-v1 snapshot");
	}
	return snapshot;
}
