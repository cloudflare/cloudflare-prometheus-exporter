import type { MetricDefinition } from "./metrics";

const CHUNK_TARGET_CHARS = 16 * 1024;

/**
 * Options for Prometheus serialization.
 */
export type SerializeOptions = {
	/** Set of metric names to exclude from output. */
	denylist?: ReadonlySet<string>;
	/** Set of label keys to exclude from all metrics. */
	excludeLabels?: ReadonlySet<string>;
};

/** Adapts Prometheus chunks to a backpressure-aware byte stream. */
export function createPrometheusStream(
	chunks: AsyncGenerator<string | Uint8Array, void, void>,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		type: "bytes",
		async pull(controller) {
			try {
				const next = await chunks.next();
				if (next.done) controller.close();
				else {
					controller.enqueue(
						typeof next.value === "string"
							? encoder.encode(next.value)
							: next.value,
					);
				}
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await chunks.return();
		},
	});
}

/**
 * Serializes MetricDefinition array to Prometheus text exposition format.
 * Groups metrics by name, outputs HELP/TYPE headers, then values.
 * Aggregates duplicate label combinations (sum for counters, max for gauges).
 *
 * @param metrics Array of metric definitions to serialize.
 * @param options Serialization options for filtering.
 * @returns Prometheus-formatted metrics string.
 */
export function serializeToPrometheus(
	metrics: readonly MetricDefinition[],
	options?: SerializeOptions,
): string {
	return [...serializeToPrometheusChunks(metrics, options)].join("");
}

/** Lazily serializes legacy metrics into bounded, line-aligned chunks. */
export function* serializeToPrometheusChunks(
	metrics: readonly MetricDefinition[],
	options?: SerializeOptions,
): Generator<string> {
	const denylist = options?.denylist ?? new Set<string>();
	const excludeLabels = options?.excludeLabels ?? new Set<string>();

	// Group metrics by name to consolidate HELP/TYPE headers
	const grouped = new Map<string, MetricDefinition>();

	for (const metric of metrics) {
		// Skip denied metrics
		if (denylist.has(metric.name)) {
			continue;
		}

		// Filter excluded labels from all values
		const filteredValues =
			excludeLabels.size > 0
				? metric.values.map((v) => ({
						...v,
						labels: filterLabels(v.labels, excludeLabels),
					}))
				: metric.values;

		const existing = grouped.get(metric.name);
		if (existing) {
			// Merge values
			grouped.set(metric.name, {
				...existing,
				values: [...existing.values, ...filteredValues],
			});
		} else {
			grouped.set(metric.name, { ...metric, values: [...filteredValues] });
		}
	}

	let buffer = "";
	const append = function* (line: string) {
		buffer += `${line}\n`;
		if (buffer.length >= CHUNK_TARGET_CHARS) {
			yield buffer;
			buffer = "";
		}
	};

	const families = [...grouped];
	for (const [familyIndex, [name, metric]] of families.entries()) {
		// HELP line
		yield* append(`# HELP ${name} ${escapeHelp(metric.help)}`);
		// TYPE line
		yield* append(`# TYPE ${name} ${metric.type}`);

		// Aggregate values by label signature to eliminate duplicates
		const aggregated = aggregateByLabels(metric.values, metric.type);

		// Value lines
		for (const { labels, value } of aggregated) {
			const labelStr = formatLabels(labels);
			yield* append(`${name}${labelStr} ${formatValue(value)}`);
		}

		if (familyIndex < families.length - 1) yield* append("");
	}
	if (buffer.length > 0) yield buffer;
}

/**
 * Aggregates metric values with identical labels.
 * Counters are summed; gauges take the maximum value.
 *
 * @param values Array of metric values to aggregate.
 * @param type Metric type (counter, gauge, etc.).
 * @returns Deduplicated array of metric values.
 */
function aggregateByLabels(
	values: readonly { labels: Record<string, string>; value: number }[],
	type: string,
): { labels: Record<string, string>; value: number }[] {
	const bySignature = new Map<
		string,
		{ labels: Record<string, string>; value: number }
	>();

	for (const { labels, value } of values) {
		const sig = labelSignature(labels);
		const existing = bySignature.get(sig);

		if (existing) {
			if (type === "counter") {
				existing.value += value;
			} else {
				// For gauges (including percentiles), take max as upper bound
				existing.value = Math.max(existing.value, value);
			}
		} else {
			bySignature.set(sig, { labels, value });
		}
	}

	return [...bySignature.values()];
}

/**
 * Creates stable signature from labels for deduplication.
 *
 * @param labels Label key-value pairs.
 * @returns Stable string signature for comparison.
 */
function labelSignature(labels: Record<string, string>): string {
	return Object.entries(labels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}\x00${v}`)
		.join("\x01");
}

/**
 * Filters out excluded label keys from a labels object.
 *
 * @param labels Original label key-value pairs.
 * @param exclude Set of label keys to exclude.
 * @returns Filtered labels object.
 */
function filterLabels(
	labels: Record<string, string>,
	exclude: ReadonlySet<string>,
): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(labels)) {
		if (!exclude.has(key)) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Formats labels object into Prometheus label string.
 *
 * @param labels Label key-value pairs.
 * @returns Formatted label string like `{key="value"}` or empty string.
 */
function formatLabels(labels: Record<string, string>): string {
	const entries = Object.entries(labels);
	if (entries.length === 0) return "";

	const formatted = entries
		.map(([key, value]) => `${key}="${escapeLabel(value)}"`)
		.join(",");

	return `{${formatted}}`;
}

/**
 * Formats numeric value for Prometheus output.
 *
 * @param value Numeric value to format.
 * @returns String representation handling NaN and Infinity.
 */
function formatValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
	return String(value);
}

/**
 * Escapes special characters in HELP text.
 *
 * @param help Raw help text.
 * @returns Escaped help text.
 */
function escapeHelp(help: string): string {
	return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * Escapes special characters in label values.
 *
 * @param value Raw label value.
 * @returns Escaped label value.
 */
function escapeLabel(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}
