import type { MetricDefinition, MetricValue } from "./metrics";
import { metricKey } from "./time";
import type { CounterState } from "./types";

export type CounterProcessingResult = {
	metrics: MetricDefinition[];
	counters: Record<string, CounterState>;
};

export type CounterProcessingOptions = {
	/** Stable identifier for the Cloudflare query window being accumulated. */
	ingestId?: number;
	/** False when replaying a window where absence is not authoritative. */
	ageMissingCounters?: boolean;
	/** Zone labels whose query failed and therefore must not age this refresh. */
	failedScopes?: ReadonlySet<string>;
};

const DEFAULT_STALE_COUNTER_MISSES = 5;

function zoneScopeFromMetricKey(key: string): string | undefined {
	return /(?:\{|,)zone=([^,}]*)/.exec(key)?.[1];
}

/**
 * Converts window-based counter observations into accumulated Prometheus counters.
 *
 * @param rawMetrics Metrics returned for the current query window.
 * @param existingCounters Previously accumulated counter state.
 * @param options Query-window and partial-failure context.
 * @returns Metrics ready for export and updated counter state.
 */
export function accumulateCounterMetrics(
	rawMetrics: MetricDefinition[],
	existingCounters: Record<string, CounterState>,
	options: CounterProcessingOptions = {},
): CounterProcessingResult {
	const counters: Record<string, CounterState> = {};
	const metrics = rawMetrics.map((metric) => {
		if (metric.type !== "counter") {
			return metric;
		}

		const observations = new Map<string, MetricValue>();
		for (const value of metric.values) {
			const key = metricKey(metric.name, value.labels);
			const existing = observations.get(key);
			if (existing === undefined) {
				observations.set(key, { labels: value.labels, value: value.value });
			} else {
				existing.value += value.value;
			}
		}

		const values: MetricValue[] = [];
		for (const [key, value] of observations) {
			const existing = existingCounters[key];
			const alreadyIngested =
				options.ingestId !== undefined &&
				existing?.lastIngest === options.ingestId;
			const accumulated =
				(existing?.accumulated ?? 0) + (alreadyIngested ? 0 : value.value);
			counters[key] = {
				accumulated,
				missesRemaining: DEFAULT_STALE_COUNTER_MISSES,
				...(options.ingestId === undefined
					? {}
					: { lastIngest: options.ingestId }),
				...(value.labels.zone === undefined
					? {}
					: { scope: value.labels.zone }),
			};
			values.push({ labels: value.labels, value: accumulated });
		}

		return { ...metric, values };
	});

	for (const [key, state] of Object.entries(existingCounters)) {
		if (Object.hasOwn(counters, key)) {
			continue;
		}

		const scope = state.scope ?? zoneScopeFromMetricKey(key);
		if (
			options.ageMissingCounters === false ||
			(options.failedScopes !== undefined &&
				options.failedScopes.size > 0 &&
				(scope === undefined || options.failedScopes.has(scope)))
		) {
			counters[key] = scope === undefined ? state : { ...state, scope };
			continue;
		}

		const missesRemaining =
			state.missesRemaining ?? DEFAULT_STALE_COUNTER_MISSES;
		if (missesRemaining > 1) {
			counters[key] = {
				...state,
				...(scope === undefined ? {} : { scope }),
				missesRemaining: missesRemaining - 1,
			};
		}
	}

	return { metrics, counters };
}
