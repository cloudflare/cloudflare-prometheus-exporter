import type { MetricDefinition, MetricValue } from "./metrics";
import { metricKey } from "./time";
import type { CounterState } from "./types";

export type CounterProcessingResult = {
	metrics: MetricDefinition[];
	counters: Record<string, CounterState>;
};

const DEFAULT_STALE_COUNTER_MISSES = 5;

/**
 * Converts window-based counter observations into accumulated Prometheus counters.
 *
 * @param rawMetrics Metrics returned for the current query window.
 * @param existingCounters Previously accumulated counter state.
 * @returns Metrics ready for export and updated counter state.
 */
export function accumulateCounterMetrics(
	rawMetrics: MetricDefinition[],
	existingCounters: Record<string, CounterState>,
): CounterProcessingResult {
	const counters: Record<string, CounterState> = {};
	const metrics = rawMetrics.map((metric) => {
		if (metric.type !== "counter") {
			return metric;
		}

		const values: MetricValue[] = metric.values.map((value) => {
			const key = metricKey(metric.name, value.labels);
			const accumulated =
				(existingCounters[key]?.accumulated ?? 0) + value.value;
			counters[key] = {
				accumulated,
				missesRemaining: DEFAULT_STALE_COUNTER_MISSES,
			};
			return { labels: value.labels, value: accumulated };
		});

		return { ...metric, values };
	});

	for (const [key, state] of Object.entries(existingCounters)) {
		if (Object.hasOwn(counters, key)) {
			continue;
		}

		const missesRemaining =
			state.missesRemaining ?? DEFAULT_STALE_COUNTER_MISSES;
		if (missesRemaining > 1) {
			counters[key] = {
				accumulated: state.accumulated,
				missesRemaining: missesRemaining - 1,
			};
		}
	}

	return { metrics, counters };
}
