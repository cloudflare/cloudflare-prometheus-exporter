import { describe, expect, it } from "vitest";
import { AccountMetricCoordinator } from "./AccountMetricCoordinator";

function createCoordinator(options: { failStream?: boolean } = {}) {
	let ready = Promise.resolve();
	let initialized = 0;
	let streamed = 0;
	let releaseInitializers: (() => void) | undefined;
	const initializersReady = new Promise<void>((resolve) => {
		releaseInitializers = resolve;
	});
	const ctx = {
		storage: {
			get: async () => ({
				accountId: "account-a",
				accountName: "Account A",
				zones: [{ id: "zone-a", name: "example.com", plan: "pro" }],
				totalZoneCount: 1,
				firewallRules: {},
				lastZoneFetch: Date.now(),
				lastRefresh: Date.now(),
			}),
		},
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const exporter = {
		async initialize() {
			initialized++;
			if (initialized === 2) releaseInitializers?.();
			await initializersReady;
		},
		exportProcessedZones: async () => ["example.com"],
		async exportPrometheus() {
			streamed++;
			if (options.failStream) throw new Error("export stream failed");
			return new Response("");
		},
	};
	const env = {
		LOG_LEVEL: "error",
		LOG_FORMAT: "json",
		CONFIG_KV: { get: async () => "{}" },
		MetricExporter: { getByName: () => exporter },
	};
	const coordinator = new AccountMetricCoordinator(
		ctx as unknown as DurableObjectState,
		env as unknown as Env,
	);
	return {
		coordinator,
		ready,
		counts: () => ({ initialized, streamed }),
	};
}

describe("AccountMetricCoordinator Prometheus export", () => {
	it("resolves exporters concurrently and reuses each stub for streaming", async () => {
		const harness = createCoordinator();
		await harness.ready;
		const response = await harness.coordinator.exportForPrometheus({
			packedMetricQueries: [],
		});
		await response.text();

		const counts = harness.counts();
		expect(counts.initialized).toBeGreaterThan(1);
		expect(counts.streamed).toBe(counts.initialized);
	});

	it("continues after exporter stream failures", async () => {
		const harness = createCoordinator({ failStream: true });
		await harness.ready;
		const response = await harness.coordinator.exportForPrometheus({
			packedMetricQueries: [],
		});

		await expect(response.text()).resolves.toBe("");
		const counts = harness.counts();
		expect(counts.streamed).toBe(counts.initialized);
	});
});
