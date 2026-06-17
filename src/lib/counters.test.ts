import { describe, expect, it } from "vitest";
import { accumulateCounterMetrics } from "./counters";
import type { MetricDefinition } from "./metrics";

describe("accumulateCounterMetrics", () => {
	it("exports a counter series the first time it is observed", () => {
		const rawMetrics: MetricDefinition[] = [
			{
				name: "cloudflare_requests_total",
				help: "Total requests",
				type: "counter",
				values: [
					{
						labels: { country: "US", zone: "example.com" },
						value: 42,
					},
				],
			},
		];

		const result = accumulateCounterMetrics(rawMetrics, {});

		expect(result.metrics).toEqual(rawMetrics);
		expect(
			result.counters["cloudflare_requests_total{country=US,zone=example.com}"]
				?.accumulated,
		).toBe(42);
	});

	it("accumulates repeated counter observations", () => {
		const counter: MetricDefinition = {
			name: "cloudflare_requests_total",
			help: "Total requests",
			type: "counter",
			values: [{ labels: { zone: "example.com" }, value: 42 }],
		};
		const firstRefresh = accumulateCounterMetrics([counter], {});

		counter.values[0] = { labels: { zone: "example.com" }, value: 8 };
		const secondRefresh = accumulateCounterMetrics(
			[counter],
			firstRefresh.counters,
		);

		expect(secondRefresh.metrics[0]?.values[0]?.value).toBe(50);
	});

	it("aggregates duplicate observations before accumulating", () => {
		const counter: MetricDefinition = {
			name: "cloudflare_requests_total",
			help: "Total requests",
			type: "counter",
			values: [
				{ labels: { zone: "example.com" }, value: 3 },
				{ labels: { zone: "example.com" }, value: 4 },
			],
		};

		const result = accumulateCounterMetrics([counter], {});

		expect(result.metrics[0]?.values).toEqual([
			{ labels: { zone: "example.com" }, value: 7 },
		]);
	});

	it("does not accumulate the same query window twice", () => {
		const counter: MetricDefinition = {
			name: "cloudflare_requests_total",
			help: "Total requests",
			type: "counter",
			values: [{ labels: { zone: "example.com" }, value: 42 }],
		};
		const first = accumulateCounterMetrics([counter], {}, { ingestId: 123 });
		const replay = accumulateCounterMetrics([counter], first.counters, {
			ingestId: 123,
			ageMissingCounters: false,
		});

		expect(replay.metrics[0]?.values[0]?.value).toBe(42);
		expect(replay.counters).toEqual(first.counters);
	});

	it("ages successful scopes but not failed scopes during a partial refresh", () => {
		const failedKey = "cloudflare_requests_total{zone=failed.example.com}";
		const successfulKey =
			"cloudflare_requests_total{zone=successful.example.com}";
		const result = accumulateCounterMetrics(
			[],
			{
				[failedKey]: {
					accumulated: 42,
					missesRemaining: 5,
					lastIngest: 123,
					scope: "failed.example.com",
				},
				[successfulKey]: {
					accumulated: 7,
					missesRemaining: 5,
					lastIngest: 123,
					scope: "successful.example.com",
				},
			},
			{
				ingestId: 124,
				failedScopes: new Set(["failed.example.com"]),
			},
		);

		expect(result.counters[failedKey]?.missesRemaining).toBe(5);
		expect(result.counters[successfulKey]?.missesRemaining).toBe(4);
	});

	it("passes gauges through without retaining counter state", () => {
		const gauge: MetricDefinition = {
			name: "cloudflare_active_connections",
			help: "Current active connections",
			type: "gauge",
			values: [{ labels: { zone: "example.com" }, value: 7 }],
		};

		const result = accumulateCounterMetrics([gauge], {});

		expect(result.metrics).toEqual([gauge]);
		expect(result.counters).toEqual({});
	});

	it("expires a counter after five consecutive refreshes without an observation", () => {
		const counter: MetricDefinition = {
			name: "cloudflare_requests_total",
			help: "Total requests",
			type: "counter",
			values: [{ labels: { zone: "example.com" }, value: 42 }],
		};
		const key = "cloudflare_requests_total{zone=example.com}";
		let result = accumulateCounterMetrics([counter], {});

		for (let missedRefreshes = 1; missedRefreshes < 5; missedRefreshes++) {
			result = accumulateCounterMetrics([], result.counters);
			expect(result.counters[key]?.accumulated).toBe(42);
		}

		result = accumulateCounterMetrics([], result.counters);
		expect(result.counters[key]).toBeUndefined();
	});

	it("continues an accumulated counter when it reappears before expiry", () => {
		const counter: MetricDefinition = {
			name: "cloudflare_requests_total",
			help: "Total requests",
			type: "counter",
			values: [{ labels: { zone: "example.com" }, value: 42 }],
		};
		let result = accumulateCounterMetrics([counter], {});
		result = accumulateCounterMetrics([], result.counters);
		result = accumulateCounterMetrics([], result.counters);

		counter.values[0] = { labels: { zone: "example.com" }, value: 8 };
		result = accumulateCounterMetrics([counter], result.counters);

		expect(result.metrics[0]?.values[0]?.value).toBe(50);
	});

	it("starts a new counter when a series reappears after expiry", () => {
		const counter: MetricDefinition = {
			name: "cloudflare_requests_total",
			help: "Total requests",
			type: "counter",
			values: [{ labels: { zone: "example.com" }, value: 42 }],
		};
		let result = accumulateCounterMetrics([counter], {});
		for (let missedRefreshes = 1; missedRefreshes <= 5; missedRefreshes++) {
			result = accumulateCounterMetrics([], result.counters);
		}

		counter.values[0] = { labels: { zone: "example.com" }, value: 8 };
		result = accumulateCounterMetrics([counter], result.counters);

		expect(result.metrics[0]?.values[0]?.value).toBe(8);
	});

	it("protects legacy zone counters during a partial chunk failure", () => {
		const key = "cloudflare_requests_total{zone=failed.example.com}";
		const result = accumulateCounterMetrics(
			[],
			{ [key]: { accumulated: 42 } },
			{ failedScopes: new Set(["failed.example.com"]) },
		);

		expect(result.counters[key]).toEqual({
			accumulated: 42,
			scope: "failed.example.com",
		});
	});

	it("expires counter state written before stale-series tracking was added", () => {
		const key = "cloudflare_requests_total{zone=example.com}";
		let result = accumulateCounterMetrics([], {
			[key]: { accumulated: 42 },
		});

		for (let missedRefreshes = 2; missedRefreshes <= 5; missedRefreshes++) {
			result = accumulateCounterMetrics([], result.counters);
		}

		expect(result.counters[key]).toBeUndefined();
	});

	it("bounds retained state when labels continually churn", () => {
		let counters = {};

		for (let refresh = 0; refresh < 20; refresh++) {
			const metric: MetricDefinition = {
				name: "cloudflare_requests_total",
				help: "Total requests",
				type: "counter",
				values: Array.from({ length: 10 }, (_, series) => ({
					labels: { series: `${refresh}-${series}` },
					value: 1,
				})),
			};

			counters = accumulateCounterMetrics([metric], counters).counters;
		}

		expect(Object.keys(counters)).toHaveLength(50);
	});
});
