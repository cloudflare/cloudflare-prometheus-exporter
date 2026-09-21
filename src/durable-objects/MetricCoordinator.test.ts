import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "../lib/metrics";
import { serializeColumnarMetricStates } from "../lib/packed-columnar-metric";
import {
	accumulatePackedMetricState,
	type PackedMetricState,
} from "../lib/packed-metric-state";
import { serializeToPrometheus } from "../lib/prometheus";
import { MetricCoordinator } from "./MetricCoordinator";

const requestsName = "cloudflare_zone_colocation_requests_total";

type Row = { host: string; value: number };

function expectedMetrics(rows: Row[]): MetricDefinition[] {
	return (
		[
			["cloudflare_zone_colocation_visits_total", "Visits per colo"],
			[
				"cloudflare_zone_colocation_edge_response_bytes_total",
				"Edge response bytes per colo",
			],
			[requestsName, "Requests per colo"],
		] as const
	).map(([name, help]) => ({
		name,
		help,
		type: "counter" as const,
		values: rows.map((row) => ({
			labels: { zone: "example.com", colo: "SJC", host: row.host },
			value: row.value,
		})),
	}));
}

function packedState(rows: Row[]): PackedMetricState {
	return accumulatePackedMetricState({
		previous: undefined,
		metrics: expectedMetrics(rows),
		ingestId: 1,
		failedScopes: new Set(),
	});
}

async function createCoordinator(
	packedStates: PackedMetricState[],
	legacy: MetricDefinition[] = [],
	overrides: {
		excludeHost?: boolean;
		metricsDenylist?: string;
		coloMetricsPackedStorage?: boolean;
	} = {},
	onPackedExport: (index: number) => void = () => {},
) {
	let ready = Promise.resolve();
	const ctx = {
		storage: {
			get: async () => ({
				identifier: "metric-coordinator",
				lastAccountFetch: Date.now(),
				accounts: [
					{ id: "account-a", name: "A" },
					{ id: "account-b", name: "B" },
				],
			}),
		},
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_LEVEL: "error",
		LOG_FORMAT: "json",
		CONFIG_KV: {
			get: async () =>
				JSON.stringify({ coloMetricsPackedStorage: true, ...overrides }),
		},
		AccountMetricCoordinator: {
			getByName: (id: string) => ({
				initialize: async () => {},
				// Mirrors AccountMetricCoordinator: the caller's mode decides which
				// representation packed metrics use for this scrape.
				exportForPrometheus: async (options: {
					packedMetricQueries: readonly string[];
				}) => {
					const packedStorage =
						options.packedMetricQueries.includes("colo-metrics");
					const serializeOptions = {
						denylist: new Set(
							overrides.metricsDenylist ? [overrides.metricsDenylist] : [],
						),
						excludeLabels: overrides.excludeHost
							? new Set(["host"])
							: undefined,
					};
					const states = packedStorage
						? id === "account:account-a"
							? packedStates
									.slice(0, 1)
									.map((state, index) => ({ state, index }))
							: packedStates.slice(1).map((state, index) => ({
									state,
									index: index + 1,
								}))
						: [];
					const chunks = (function* () {
						for (const { state, index } of states) {
							try {
								onPackedExport(index);
								yield* serializeColumnarMetricStates([state], serializeOptions);
							} catch {}
						}
						if (id === "account:account-b" && !packedStorage) {
							yield serializeToPrometheus(legacy, serializeOptions);
						}
					})();
					const encoder = new TextEncoder();
					return new Response(
						new ReadableStream({
							type: "bytes",
							pull(controller) {
								const next = chunks.next();
								if (next.done) controller.close();
								else controller.enqueue(encoder.encode(next.value));
							},
						}),
						{
							headers: {
								"X-Metrics-Zones-Total": "1",
								"X-Metrics-Zones-Filtered": "1",
								"X-Metrics-Zones-Processed": "1",
								"X-Metrics-Zones-Skipped-Free-Tier": "0",
							},
						},
					);
				},
			}),
		},
	};
	// SAFETY: The runtime shim uses only these storage/config/RPC operations. Worker
	// platform types also require native bindings unavailable in this Node harness.
	const coordinator = new MetricCoordinator(
		ctx as unknown as DurableObjectState,
		env as unknown as Env,
	);
	await ready;
	return coordinator;
}

function coloOutput(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("cloudflare_zone_colocation_"))
		.sort();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MetricCoordinator packed colo output", () => {
	it("emits exporter families before packed zone families", async () => {
		const coordinator = await createCoordinator([
			packedState([{ host: "www.example.com", value: 1 }]),
		]);
		const text = await (
			await coordinator.fetch(new Request("https://test/export"))
		).text();

		expect(text.indexOf("# HELP cloudflare_exporter_up")).toBeLessThan(
			text.indexOf("# HELP cloudflare_zone_colocation_visits_total"),
		);
	});

	it.each([
		false,
		true,
	])("matches legacy serialization including escaping and excludeHost=%s", async (excludeHost) => {
		const rows = [
			{ host: 'www.\\\\"\nexample.com', value: 10 },
			{ host: "other.example.com", value: 20 },
		];
		const state = packedState(rows);
		const coordinator = await createCoordinator([state], [], {
			excludeHost,
			metricsDenylist: requestsName,
		});
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(response.status).toBe(200);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(
				serializeToPrometheus(expectedMetrics(rows), {
					excludeLabels: excludeHost ? new Set(["host"]) : undefined,
					denylist: new Set([requestsName]),
				}),
			),
		);
	});

	it("matches numeric formatting for NaN and infinities", async () => {
		const state = packedState(
			[0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
				(value, index) => ({ host: `host-${index}.example.com`, value }),
			),
		);
		const coordinator = await createCoordinator([state]);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(
				serializeToPrometheus(
					expectedMetrics(
						[
							0,
							Number.NaN,
							Number.POSITIVE_INFINITY,
							Number.NEGATIVE_INFINITY,
						].map((value, index) => ({
							host: `host-${index}.example.com`,
							value,
						})),
					),
				),
			),
		);
	});

	it("does not serialize the whole packed snapshot before a slow reader consumes it", async () => {
		let visitsRead = 0;
		const exportedSnapshots: number[] = [];
		const rows = Array.from({ length: 5000 }, (_, index) => ({
			host: `host-${index}.example.com`,
			value: 10,
		}));
		const state = packedState(rows);
		const visits = state.zones[0]?.families[0];
		if (visits === undefined) throw new Error("fixture has no visits table");
		visits.values = new Proxy(visits.values, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property))
					visitsRead++;
				return Reflect.get(target, property, receiver);
			},
		});
		const coordinator = await createCoordinator(
			[state, packedState([{ host: "second.example.com", value: 1 }])],
			[],
			{},
			(index) => exportedSnapshots.push(index),
		);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(visitsRead).toBeLessThan(rows.length);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader?.read();
		expect(first?.value?.byteLength).toBeLessThan(66 * 1024);
		await reader?.cancel();
		const readsAtCancel = visitsRead;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(visitsRead).toBe(readsAtCancel);
		expect(exportedSnapshots).toEqual([]);
	});

	it("continues with the next exporter when one snapshot fails", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const coordinator = await createCoordinator(
			[
				packedState([{ host: "failed.example.com", value: 1 }]),
				packedState([{ host: "successful.example.com", value: 2 }]),
			],
			[],
			{},
			(index) => {
				if (index === 0) throw new Error("snapshot unavailable");
			},
		);

		const text = await (
			await coordinator.fetch(new Request("https://test/export"))
		).text();

		expect(text).not.toContain("failed.example.com");
		expect(text).toContain("successful.example.com");
	});

	it("passes one storage mode to every account so HELP/TYPE appear once", async () => {
		const legacy = expectedMetrics([{ host: "b.example.com", value: 1 }]);
		for (const coloMetricsPackedStorage of [true, false]) {
			const coordinator = await createCoordinator(
				[
					packedState([{ host: "a.example.com", value: 1 }]),
					packedState([{ host: "b.example.com", value: 1 }]),
				],
				legacy,
				{ coloMetricsPackedStorage },
			);
			const text = await (
				await coordinator.fetch(new Request("https://test/export"))
			).text();
			expect(
				text.match(/^# HELP cloudflare_zone_colocation_requests_total/gm),
			).toHaveLength(1);
			expect(
				text.match(/^# TYPE cloudflare_zone_colocation_requests_total/gm),
			).toHaveLength(1);
		}
	});
});
