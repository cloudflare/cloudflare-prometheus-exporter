import { describe, expect, it } from "vitest";
import { ColumnarObservationSink } from "./columnar-observations";
import type { MetricDefinition } from "./metrics";
import {
	accumulateColumnarMetricState,
	COLUMNAR_METRIC_QUERIES,
	type ColumnarMetricQuery,
	migrateLegacyColumnarMetricState,
	PackedColumnarMetricStateSchema,
	serializeColumnarMetricStates,
} from "./packed-columnar-metric";
import { serializeToPrometheus } from "./prometheus";

function accumulate(
	queryName: ColumnarMetricQuery,
	metrics: MetricDefinition[],
	ingestId: number,
	previous?: ReturnType<typeof accumulateColumnarMetricState>,
	failedScopes: ReadonlySet<string> = new Set(),
) {
	void queryName;
	return accumulateColumnarMetricState({
		previous,
		metrics,
		ingestId,
		failedScopes,
	});
}

function counter(value: number): MetricDefinition[] {
	return [
		{
			name: "cloudflare_zone_requests_by_method_total",
			help: "Requests by HTTP method",
			type: "counter",
			values: [{ labels: { zone: "example.com", method: "GET" }, value }],
		},
	];
}

function direct(metrics: MetricDefinition[]) {
	const sink = new ColumnarObservationSink();
	const captured: MetricDefinition[] = metrics.map((metric) => ({
		...metric,
		values: [],
	}));
	sink.capture(captured);
	for (const [index, metric] of metrics.entries()) {
		captured[index]?.values.push(...metric.values);
	}
	return sink.finish();
}

describe("generic packed columnar metrics", () => {
	it("continues a dormant legacy counter after packed migration", () => {
		const migrated = migrateLegacyColumnarMetricState({
			metrics: [],
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
			ingestId: 1,
		});

		expect(migrated.zones[0]?.families[0]?.values).toEqual([100]);
		expect(migrated.zones[0]?.families[0]?.counter?.misses).toEqual([4]);
		const refreshed = accumulate(
			"request-method-metrics",
			counter(5),
			2,
			migrated,
		);
		expect(refreshed.zones[0]?.families[0]?.values).toEqual([105]);
	});

	it("retains empty families in declaration order", () => {
		const source = direct([
			{
				name: "first_total",
				help: "First",
				type: "counter",
				values: [],
			},
			{
				name: "second_total",
				help: "Second",
				type: "counter",
				values: [{ labels: { zone: "example.com" }, value: 1 }],
			},
		]);

		expect(source.map((family) => family.name)).toEqual([
			"first_total",
			"second_total",
		]);
	});

	it("reindexes migrated families into current declaration order", () => {
		const metric = (name: string, value: number): MetricDefinition => ({
			name,
			help: name,
			type: "counter",
			values: [{ labels: { zone: "example.com", method: "GET" }, value }],
		});
		const previous = accumulate(
			"http-metrics",
			[metric("second_total", 10), metric("third_total", 20)],
			1,
		);
		const state = accumulate(
			"http-metrics",
			[
				metric("first_total", 1),
				metric("second_total", 1),
				metric("third_total", 2),
			],
			2,
			previous,
		);

		expect(state.families.map((family) => family.name)).toEqual([
			"first_total",
			"second_total",
			"third_total",
		]);
		expect(state.zones[0]?.families.map((table) => table.family)).toEqual([
			0, 1, 2,
		]);
		expect(state.zones[0]?.families[2]?.labelsFrom).toBe(0);
		expect(state.zones[0]?.families.map((table) => table.values)).toEqual([
			[1],
			[11],
			[22],
		]);
		expect(PackedColumnarMetricStateSchema.parse(state)).toEqual(state);

		const failed = accumulate(
			"http-metrics",
			[
				metric("first_total", 1),
				metric("second_total", 1),
				metric("third_total", 1),
			],
			3,
			previous,
			new Set(["example.com"]),
		);
		expect(failed.zones[0]?.families.map((table) => table.family)).toEqual([
			1, 2,
		]);
		expect(failed.zones[0]?.families[1]?.labelsFrom).toBe(1);
		expect(PackedColumnarMetricStateSchema.parse(failed)).toEqual(failed);
	});

	it("orders families by their first emitting state", () => {
		const family = (name: string, value?: number): MetricDefinition => ({
			name,
			help: name,
			type: "counter",
			values:
				value === undefined ? [] : [{ labels: { zone: "example.com" }, value }],
		});
		const first = accumulate(
			"http-metrics",
			[family("first_total"), family("second_total", 1)],
			1,
		);
		const second = accumulate(
			"http-metrics",
			[family("first_total", 1), family("second_total", 1)],
			1,
		);
		const output = [...serializeColumnarMetricStates([first, second], {})].join(
			"",
		);

		expect(output.indexOf("# HELP second_total")).toBeLessThan(
			output.indexOf("# HELP first_total"),
		);
	});

	it("drops stale counters when a family changes type", () => {
		const previous = accumulate(
			"http-metrics",
			[
				{
					name: "source",
					help: "Source",
					type: "counter",
					values: [
						{
							labels: { zone: "example.com", method: "GET" },
							value: 10,
						},
					],
				},
				{
					name: "dependent_total",
					help: "Dependent",
					type: "counter",
					values: [
						{
							labels: { zone: "example.com", method: "GET" },
							value: 20,
						},
					],
				},
			],
			1,
		);
		const state = accumulate(
			"http-metrics",
			[
				{
					name: "source",
					help: "Source",
					type: "gauge",
					values: [
						{
							labels: { zone: "example.com", method: "POST" },
							value: 3,
						},
					],
				},
			],
			2,
			previous,
		);

		expect(state.zones[0]?.families[0]?.counter).toBeUndefined();
		expect(state.zones[0]?.families[0]?.values).toEqual([3]);
		expect(state.zones[0]?.families[1]).toMatchObject({
			family: 1,
			labels: { method: ["GET"] },
			values: [20],
		});
		expect(state.zones[0]?.families[1]?.labelsFrom).toBeUndefined();
		expect(PackedColumnarMetricStateSchema.parse(state)).toEqual(state);
	});

	it("writes observations directly into packed columns", () => {
		const metrics = counter(10);
		metrics[0]?.values.push({
			labels: { zone: "example.com", method: "GET" },
			value: 2,
		});
		metrics.push({
			name: "request_duration",
			help: "Request duration",
			type: "gauge",
			values: [1, 3, 2].map((value) => ({
				labels: { zone: "example.com", method: "GET" },
				value,
			})),
		});
		const expected = accumulate("request-method-metrics", metrics, 1);
		const source = direct(metrics);
		let state = accumulateColumnarMetricState({
			previous: undefined,
			metrics: source,
			ingestId: 1,
			failedScopes: new Set(),
		});
		expect(state).toEqual(expected);
		expect(source.every((metric) => metric.direct?.zones.size === 0)).toBe(
			true,
		);

		const next = counter(4);
		const nextExpected = accumulate(
			"request-method-metrics",
			next,
			2,
			expected,
		);
		state = accumulateColumnarMetricState({
			previous: state,
			metrics: direct(next),
			ingestId: 2,
			failedScopes: new Set(),
		});
		expect(state).toEqual(nextExpected);
		expect(PackedColumnarMetricStateSchema.parse(state)).toEqual(state);
	});

	it("round-trips arbitrary families for every registered query", () => {
		for (const query of COLUMNAR_METRIC_QUERIES) {
			const metrics: MetricDefinition[] = [
				{
					name: `test_${query.replaceAll("-", "_")}_total`,
					help: `Dynamic\\help for\n${query}`,
					type: "counter",
					values: [
						{
							labels: { zone: "example.com", first: "a", second: "b" },
							value: 2,
						},
					],
				},
				{
					name: `test_${query.replaceAll("-", "_")}_ratio`,
					help: "Gauge help",
					type: "gauge",
					values: [{ labels: { zone: "example.com" }, value: 0.5 }],
				},
			];
			const state = accumulate(query, metrics, 1);

			expect(PackedColumnarMetricStateSchema.parse(state)).toEqual(state);
			expect(state.families).toMatchObject([
				{ type: "counter" },
				{ type: "gauge" },
			]);
			expect(state.zones[0]?.families[0]?.labels).toEqual({
				first: ["a"],
				second: ["b"],
			});
			expect(
				[...serializeColumnarMetricStates([state], {})].join("").trimEnd(),
			).toBe(serializeToPrometheus(metrics).trimEnd());
		}
	});

	it("deduplicates query windows, ages missing counters, and preserves failed scopes", () => {
		let state = accumulate("request-method-metrics", counter(10), 1);
		state = accumulate("request-method-metrics", counter(10), 1, state);
		expect(state.zones[0]?.families[0]?.values).toEqual([10]);

		state = accumulate("request-method-metrics", counter(4), 2, state);
		expect(state.zones[0]?.families[0]?.values).toEqual([14]);
		expect(state.zones[0]?.families[0]?.counter?.misses).toEqual([5]);

		state = accumulate("request-method-metrics", [], 3, state);
		expect(state.zones[0]?.families[0]?.counter?.misses).toEqual([4]);
		state = accumulate(
			"request-method-metrics",
			[],
			4,
			state,
			new Set(["example.com"]),
		);
		expect(state.zones[0]?.families[0]?.counter?.misses).toEqual([4]);

		for (let ingestId = 5; ingestId <= 8; ingestId++) {
			state = accumulate("request-method-metrics", [], ingestId, state);
		}
		expect(state.zones).toEqual([]);
	});

	it("collapses duplicate gauges by maximum and replaces them each window", () => {
		const metric = (values: number[]): MetricDefinition[] => [
			{
				name: "cloudflare_zone_cache_miss_origin_duration_seconds",
				help: "Average origin response duration on cache miss in seconds",
				type: "gauge",
				values: values.map((value) => ({
					labels: {
						zone: "example.com",
						country: "US",
						host: "www.example.com",
					},
					value,
				})),
			},
		];
		let state = accumulate("cache-miss-metrics", metric([1, 3, 2]), 1);
		expect(state.zones[0]?.families[0]?.values).toEqual([3]);
		state = accumulate("cache-miss-metrics", metric([0.5]), 2, state);
		expect(state.zones[0]?.families[0]?.values).toEqual([0.5]);
		state = accumulate("cache-miss-metrics", [], 3, state);
		expect(state.zones).toEqual([]);
	});

	it("rejects duplicate zones and duplicate label tuples", () => {
		const state = accumulate("request-method-metrics", counter(1), 1);
		expect(
			PackedColumnarMetricStateSchema.safeParse({
				...state,
				zones: [...state.zones, state.zones[0]],
			}).success,
		).toBe(false);

		const zone = state.zones[0];
		const family = zone?.families[0];
		expect(zone).toBeDefined();
		expect(family).toBeDefined();
		if (zone === undefined || family === undefined) return;
		expect(
			PackedColumnarMetricStateSchema.safeParse({
				...state,
				zones: [
					{
						...zone,
						families: [
							{
								...family,
								labels: Object.fromEntries(
									Object.entries(family.labels).map(([label, column]) => [
										label,
										[column[0], column[0]],
									]),
								),
								values: [1, 2],
								counter: { misses: [5, 5], lastIngest: [1, 1] },
							},
						],
					},
				],
			}).success,
		).toBe(false);
	});

	it("remaps label columns across independently packed accounts", () => {
		const firstMetrics: MetricDefinition[] = [
			{
				name: "test_requests_total",
				help: "Requests",
				type: "counter",
				values: [
					{
						labels: { zone: "one.example", method: "GET", status: "200" },
						value: 2,
					},
				],
			},
		];
		const firstMetric = firstMetrics[0];
		if (firstMetric === undefined) throw new Error("missing test metric");
		const secondMetrics: MetricDefinition[] = [
			{
				...firstMetric,
				values: [
					{
						labels: { zone: "two.example", status: "500", method: "POST" },
						value: 3,
					},
				],
			},
		];
		const first = accumulate("http-metrics", firstMetrics, 1);
		const second = accumulate("http-metrics", secondMetrics, 1);

		expect(Object.keys(second.zones[0]?.families[0]?.labels ?? {})).toEqual([
			"status",
			"method",
		]);
		const output = [...serializeColumnarMetricStates([first, second], {})].join(
			"",
		);
		expect(output).toContain(
			'test_requests_total{zone="two.example",method="POST",status="500"} 3',
		);
	});

	it("preserves a failed zone when another zone adds labels", () => {
		const initial = accumulate("http-metrics", counter(1), 1);
		const baseMetric = counter(1)[0];
		if (baseMetric === undefined) throw new Error("missing test metric");
		const state = accumulate(
			"http-metrics",
			[
				{
					...baseMetric,
					values: [
						{
							labels: { zone: "other.example", method: "GET", status: "200" },
							value: 1,
						},
					],
				},
			],
			2,
			initial,
			new Set(["example.com"]),
		);

		expect(PackedColumnarMetricStateSchema.parse(state)).toEqual(state);
		expect(state.zones[0]?.families[0]?.labels).toEqual({
			method: ["GET"],
		});
	});

	it("matches legacy denylist and excluded-label aggregation", () => {
		const metrics: MetricDefinition[] = [
			{
				name: "test_requests_total",
				help: "Requests",
				type: "counter",
				values: [
					{ labels: { zone: "example.com", host: "a.example" }, value: 2 },
					{ labels: { zone: "example.com", host: "b.example" }, value: 3 },
				],
			},
			{
				name: "denied_total",
				help: "Denied",
				type: "counter",
				values: [{ labels: { zone: "example.com" }, value: 1 }],
			},
		];
		const state = accumulate("http-metrics", metrics, 1);
		const options = {
			excludeLabels: new Set(["host"]),
			denylist: new Set(["denied_total"]),
		};

		expect(
			[...serializeColumnarMetricStates([state], options)].join("").trimEnd(),
		).toBe(serializeToPrometheus(metrics, options).trimEnd());
	});
});
