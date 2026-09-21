import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FREE_PLAN_ID } from "../lib/filters";
import { PackedColumnarMetricStateSchema } from "../lib/packed-columnar-metric";
import { MetricExporter } from "./MetricExporter";

class AlarmStorage {
	readonly setAlarm = vi.fn().mockResolvedValue(undefined);
	getManyFailures = 0;
	readonly values = new Map<string, unknown>();

	async get(keyOrKeys: string | string[]): Promise<unknown> {
		if (this.getManyFailures > 0) {
			this.getManyFailures--;
			throw new Error("state storage unavailable");
		}
		if (typeof keyOrKeys === "string") return this.values.get(keyOrKeys);
		const result = new Map<string, unknown>();
		for (const key of keyOrKeys) {
			if (this.values.has(key)) result.set(key, this.values.get(key));
		}
		return result;
	}

	async put(entries: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) {
			this.values.set(key, structuredClone(value));
		}
	}

	async delete(keys: string[]): Promise<void> {
		for (const key of keys) this.values.delete(key);
	}
}

function createExporter(
	storage: AlarmStorage,
	envOverrides: Record<string, unknown> = {},
): {
	exporter: MetricExporter;
	ready: Promise<void>;
} {
	let ready = Promise.resolve();
	const ctx = {
		storage,
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_FORMAT: "json",
		LOG_LEVEL: "error",
		...envOverrides,
	};
	return {
		exporter: new MetricExporter(
			ctx as unknown as DurableObjectState,
			env as unknown as Env,
		),
		ready,
	};
}

function storedState(): Record<string, unknown> {
	return {
		scopeType: "account",
		scopeId: "account-id",
		queryName: "worker-totals",
		counters: {},
		metrics: [],
		lastIngest: 0,
		accountId: "account-id",
		accountName: "Account",
		zones: [],
		firewallRules: {},
		zoneMetadata: null,
		refreshInterval: 60,
		lastRefresh: 0,
		lastError: null,
		lastSslFetch: 0,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("MetricExporter state recovery", () => {
	it("caches a successful empty legacy snapshot", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", {
			...storedState(),
			scopeType: "zone",
			scopeId: zone.id,
			queryName: "lb-weight-metrics",
			zoneMetadata: zone,
			processedZoneMode: "legacy",
			lastSslFetch: Date.now(),
		});
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: {
				limit: vi.fn().mockResolvedValue({ success: true }),
			},
		});
		await ready;

		await exporter.triggerRefresh({
			mintime: "2026-01-01T00:00:00.000Z",
			maxtime: "2026-01-01T00:01:00.000Z",
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(storage.setAlarm).toHaveBeenCalledOnce();
	});

	it("refreshes a packed cache marker when its snapshot is missing", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", {
			...storedState(),
			scopeType: "zone",
			scopeId: zone.id,
			queryName: "lb-weight-metrics",
			zoneMetadata: zone,
			processedZoneMode: "packed",
			lastSslFetch: Date.now(),
		});
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json({
				success: true,
				result: [],
				result_info: { page: 1, per_page: 20, count: 0, total_count: 0 },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			PACKED_METRIC_STORAGE: true,
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: {
				limit: vi.fn().mockResolvedValue({ success: true }),
			},
		});
		await ready;

		await exporter.triggerRefresh({
			mintime: "2026-01-01T00:00:00.000Z",
			maxtime: "2026-01-01T00:01:00.000Z",
		});

		expect(fetch).toHaveBeenCalled();
	});

	it("schedules recovery when constructor state loading keeps failing", async () => {
		const storage = new AlarmStorage();
		storage.getManyFailures = 2;
		const { exporter, ready } = createExporter(storage);
		await ready;

		await expect(exporter.alarm()).resolves.toBeUndefined();

		expect(storage.setAlarm).toHaveBeenCalledOnce();
	});

	it.each([
		false,
		true,
	])("backs off only a denied zone chunk while refreshing successful chunks with packed storage=%s", async (packedMetricStorage) => {
		const storage = new AlarmStorage();
		const zones = Array.from({ length: 11 }, (_, index) => ({
			id: `zone-${index}`,
			name: `zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		}));
		storage.values.set("state", {
			...storedState(),
			queryName: "adaptive-metrics",
			zones,
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
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
				),
			)
			.mockResolvedValue(
				new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), {
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetch);
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: rateLimiter,
			PACKED_METRIC_STORAGE: packedMetricStorage,
		});
		await ready;

		await exporter.alarm();
		expect(storage.values.get("state")).toMatchObject({ lastError: null });
		await exporter.alarm();

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(storage.setAlarm).toHaveBeenCalledTimes(2);
		consoleLog.mockRestore();
		vi.unstubAllGlobals();
	});

	it("completes a packed refresh when every zone is backed off", async () => {
		const storage = new AlarmStorage();
		const zones = Array.from({ length: 11 }, (_, index) => ({
			id: `zone-${index}`,
			name: `zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		}));
		storage.values.set("state", {
			...storedState(),
			queryName: "adaptive-metrics",
			zones,
			zoneRetryAfter: Object.fromEntries(
				zones.map((zone) => [zone.id, Date.now() + 60_000]),
			),
		});
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: {
				limit: vi.fn().mockResolvedValue({ success: true }),
			},
			PACKED_METRIC_STORAGE: true,
		});
		await ready;

		await exporter.alarm();

		expect(fetch).not.toHaveBeenCalled();
		expect(storage.values.get("state")).toMatchObject({ lastError: null });
		expect(await exporter.exportPackedMetrics()).toMatchObject({
			format: "metric-columnar-v1",
			zones: [],
		});
	});

	it("does not double-count when the platform retries the same alarm window", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", { ...storedState(), zones: [zone] });
		storage.setAlarm
			.mockRejectedValueOnce(new Error("ordinary alarm scheduling failed"))
			.mockRejectedValueOnce(new Error("recovery alarm scheduling failed"));
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{
											dimensions: { scriptName: "worker" },
											sum: { requests: 42, errors: 0 },
											quantiles: null,
										},
									],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetch);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: rateLimiter,
		});
		await ready;

		await expect(exporter.alarm()).rejects.toThrow(
			"recovery alarm scheduling failed",
		);
		await exporter.alarm();

		const metrics = await exporter.export();
		const requests = metrics.find(
			(metric) => metric.name === "cloudflare_worker_requests_total",
		);
		expect(requests?.values[0]?.value).toBe(42);
	});

	it("retries a transient constructor load before initialize can overwrite state", async () => {
		const storage = new AlarmStorage();
		storage.getManyFailures = 1;
		storage.values.set("state", storedState());
		const { exporter, ready } = createExporter(storage);
		await ready;

		await exporter.initialize("account:account-id:worker-totals");

		await expect(exporter.export()).resolves.toEqual([]);
	});
});

// Exercise real refresh, storage codecs, and GraphQL translation; only the
// platform boundary and upstream HTTP response are replaced by local fixtures.
async function createColoHarness(zoneCount = 1) {
	const storage = new AlarmStorage();
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	const zones = Array.from({ length: zoneCount }, (_, index) => ({
		...zone,
		id: index === 0 ? zone.id : `zone-${index}`,
		name: index === 0 ? zone.name : `zone-${index}.example.com`,
	}));
	storage.values.set("state", {
		...storedState(),
		queryName: "colo-metrics",
		zones,
	});
	let packed = false;
	let observations = [
		{ host: "www.example.com", visits: 10, requests: 10, bytes: 10 },
	];
	const queries: string[] = [];
	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		const body = String(init?.body);
		queries.push(body);
		const requested = new Set<string>(
			z
				.object({ variables: z.object({ zoneIDs: z.array(z.string()) }) })
				.parse(JSON.parse(body)).variables.zoneIDs,
		);
		return new Response(
			JSON.stringify({
				data: {
					viewer: {
						zones: zones
							.filter((zone) => requested.has(zone.id))
							.map((zone) => ({
								zoneTag: zone.id,
								httpRequestsAdaptiveGroups: observations.map((row) => ({
									dimensions: {
										coloCode: "SJC",
										clientRequestHTTPHost: row.host,
									},
									count: row.requests,
									sum: { visits: row.visits, edgeResponseBytes: row.bytes },
								})),
							})),
					},
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ coloMetricsPackedStorage: packed }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	let { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		storage,
		queries,
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async restart() {
			({ exporter, ready } = createExporter(storage, env));
			await ready;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
		async requests() {
			const packed = await exporter.exportPackedMetrics();
			const family = packed?.families.findIndex(
				(candidate) =>
					candidate.name === "cloudflare_zone_colocation_requests_total",
			);
			return packed?.zones[0]?.families.find((table) => table.family === family)
				?.values;
		},
	};
}

describe("MetricExporter packed colo storage", () => {
	it("migrates the legacy colo snapshot without resetting counters", async () => {
		const h = await createColoHarness();
		h.storage.values.set("packed-colo-metrics", {
			format: "colo-packed-by-zone-v2",
			accountId: "account-id",
			accountName: "Account",
			queryName: "colo-metrics",
			lastFetch: 1,
			lastIngest: 1735689600000,
			zones: [
				{
					zone: "example.com",
					colo: ["SJC"],
					host: ["www.example.com"],
					visits: [100],
					edgeResponseBytes: [100],
					requests: [100],
					misses: [4],
					lastIngest: [1735689600000],
				},
			],
		});
		h.setPacked(true);
		const migrated = PackedColumnarMetricStateSchema.parse(
			await h.exporter.exportPackedMetrics(),
		);
		expect(migrated.zones[0]?.families[0]).toMatchObject({
			values: [100],
			counter: { misses: [4], lastIngest: [1735689600000] },
		});
		await h.refresh(1);

		expect(await h.requests()).toEqual([110]);
		expect(await h.exporter.exportPackedMetrics()).toMatchObject({
			format: "metric-columnar-v1",
		});
	});

	it("accumulates packed counters across refreshes and restarts without double-counting retries", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		await h.refresh(2);
		await h.restart();
		await h.refresh(2);
		expect(await h.requests()).toEqual([20]);
		expect(
			h.queries.every((query) => query.includes("ColoMetricsPackedStorage")),
		).toBe(true);
	});

	it("expires packed counters absent for five refreshes, aging once per window", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		h.setObservations([]);
		await h.refresh(2);
		await h.refresh(2);
		const snapshot = await h.exporter.exportPackedMetrics();
		const requestsFamily = snapshot?.families.findIndex(
			(family) => family.name === "cloudflare_zone_colocation_requests_total",
		);
		expect(
			snapshot?.zones[0]?.families.find(
				(table) => table.family === requestsFamily,
			)?.counter?.misses,
		).toEqual([4]);
		for (let minute = 3; minute <= 6; minute++) await h.refresh(minute);
		const expired = await h.exporter.exportPackedMetrics();
		expect(expired?.zones).toEqual([]);
	});

	it("round-trips 150,000 packed rows (450,000 samples) within the storage guard", async () => {
		const h = await createColoHarness(15);
		h.setPacked(true);
		h.setObservations(
			Array.from({ length: 10_000 }, (_, index) => ({
				host: `host-${index}.example.com`,
				visits: 10,
				requests: 10,
				bytes: 10,
			})),
		);
		await h.refresh(1);
		await h.restart();
		expect(h.storage.values.get("state")).toMatchObject({ lastError: null });
		const snapshot = await h.exporter.exportPackedMetrics();
		expect(
			snapshot?.zones.reduce(
				(total, zone) => total + (zone.families[0]?.values.length ?? 0),
				0,
			),
		).toBe(150_000);
		const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
		expect(bytes).toBeLessThan(16 * 1024 * 1024);
		expect(h.storage.values.get("packed-colo-metrics:manifest")).toMatchObject({
			bytes,
		});
	}, 15_000);

	it("migrates the unpacked generation when packed storage is re-enabled", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		expect(await h.requests()).toEqual([10]);
		h.setPacked(false);
		await h.refresh(2);
		expect(await h.exporter.exportPackedMetrics()).toBeUndefined();
		expect(
			[...h.storage.values.keys()].filter((key) =>
				key.startsWith("packed-colo-metrics"),
			),
		).toEqual([]);
		h.setPacked(true);
		await h.refresh(3);
		expect(await h.requests()).toEqual([20]);
	});
});

async function createColumnarHarness(packed: boolean) {
	const storage = new AlarmStorage();
	let packedStorage = packed;
	let fetchObserver: ((packedStateExists: boolean) => void) | undefined;
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	storage.values.set("state", {
		...storedState(),
		queryName: "request-method-metrics",
		zones: [zone],
	});
	vi.stubGlobal("fetch", async () => {
		fetchObserver?.(storage.values.has("packed-colo-metrics"));
		return new Response(
			JSON.stringify({
				data: {
					viewer: {
						zones: [
							{
								zoneTag: "zone-id",
								httpRequestsAdaptiveGroups: [
									{
										dimensions: { clientRequestHTTPMethodName: "GET" },
										count: 10,
									},
								],
							},
						],
					},
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ packedMetricStorage: packedStorage }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	let { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packedStorage = enabled;
		},
		observeFetch(observer: (packedStateExists: boolean) => void) {
			fetchObserver = observer;
		},
		async markZoneFree() {
			await exporter.updateZoneContext(
				"account-id",
				"Account",
				[{ ...zone, plan: { id: FREE_PLAN_ID, name: "Free" } }],
				{},
				{
					mintime: "2026-01-01T00:00:00.000Z",
					maxtime: "2026-01-01T00:01:00.000Z",
				},
			);
		},
		async restart() {
			({ exporter, ready } = createExporter(storage, env));
			await ready;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
	};
}

describe("MetricExporter packed columnar storage", () => {
	it("ages packed counters when no paid zones remain", async () => {
		const h = await createColumnarHarness(true);
		await h.refresh(1);
		await h.markZoneFree();

		await h.refresh(2);

		const snapshot = PackedColumnarMetricStateSchema.parse(
			await h.exporter.exportPackedMetrics(),
		);
		expect(snapshot.lastIngest).toBe(1735689720000);
		expect(snapshot.zones[0]?.families[0]?.values).toEqual([10]);
		expect(snapshot.zones[0]?.families[0]?.counter?.misses).toEqual([4]);
	});

	it("persists the unpacked migration before fetching packed metrics", async () => {
		const h = await createColumnarHarness(false);
		await h.refresh(1);
		h.setPacked(true);
		let packedStateExisted = false;
		h.observeFetch((exists) => {
			packedStateExisted = exists;
		});

		await h.refresh(2);

		expect(packedStateExisted).toBe(true);
	});

	it("migrates the active unpacked counter before the first packed refresh", async () => {
		const h = await createColumnarHarness(false);
		await h.refresh(1);
		h.setPacked(true);

		const migrated = PackedColumnarMetricStateSchema.parse(
			await h.exporter.exportPackedMetrics({ migrateLegacyMetrics: true }),
		);
		expect(migrated.zones[0]?.families[0]?.values).toEqual([10]);

		await h.restart();
		await h.refresh(2);
		const refreshed = PackedColumnarMetricStateSchema.parse(
			await h.exporter.exportPackedMetrics(),
		);
		expect(refreshed.zones[0]?.families[0]?.values).toEqual([20]);
		expect(await h.exporter.export()).toEqual([]);
	});

	it("migrates a retained counter when the legacy snapshot is empty", async () => {
		const storage = new AlarmStorage();
		storage.values.set("state", {
			...storedState(),
			queryName: "request-method-metrics",
			lastIngest: 1,
			counters: {
				"cloudflare_zone_requests_by_method_total{method=GET,zone=example.com}":
					{
						accumulated: 100,
						missesRemaining: 4,
						lastIngest: 1,
						metric: {
							name: "cloudflare_zone_requests_by_method_total",
							help: "Requests by HTTP method",
							labels: { zone: "example.com", method: "GET" },
						},
					},
			},
		});
		const { exporter, ready } = createExporter(storage);
		await ready;

		const migrated = PackedColumnarMetricStateSchema.parse(
			await exporter.exportPackedMetrics({ migrateLegacyMetrics: true }),
		);

		expect(migrated.zones[0]?.families[0]?.values).toEqual([100]);
		expect(migrated.zones[0]?.families[0]?.counter?.misses).toEqual([4]);
	});

	it("persists and replays counters while retaining the flag-off legacy path", async () => {
		const packed = await createColumnarHarness(true);
		await packed.refresh(1);
		await packed.restart();
		await packed.refresh(2);
		await packed.restart();
		await packed.refresh(2);

		const snapshot = PackedColumnarMetricStateSchema.parse(
			await packed.exporter.exportPackedMetrics(),
		);
		expect(snapshot.zones[0]?.families[0]?.values).toEqual([20]);
		expect(await packed.exporter.export()).toEqual([]);
		expect(await packed.exporter.exportProcessedZones("packed")).toEqual([
			"example.com",
		]);
		expect(await packed.exporter.exportProcessedZones("legacy")).toEqual([]);

		const legacy = await createColumnarHarness(false);
		await legacy.refresh(1);
		expect(await legacy.exporter.exportPackedMetrics()).toBeUndefined();
		expect(await legacy.exporter.exportProcessedZones("legacy")).toEqual([
			"example.com",
		]);
		expect(await legacy.exporter.export()).toMatchObject([
			{
				name: "cloudflare_zone_requests_by_method_total",
				values: [{ labels: { zone: "example.com", method: "GET" }, value: 10 }],
			},
		]);
	});
});
