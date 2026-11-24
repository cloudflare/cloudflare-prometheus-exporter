import z from "zod";

/**
 * Prometheus metric type discriminator.
 */
export type MetricType = z.infer<typeof MetricTypeSchema>;

/**
 * Zod schema validating Prometheus metric types (counter or gauge).
 */
export const MetricTypeSchema = z.union([
	z.literal("counter"),
	z.literal("gauge"),
]);

/**
 * Single metric observation with labels and numeric value.
 */
export type MetricValue = z.infer<typeof MetricValueSchema>;

/**
 * Zod schema validating metric observations with label key-value pairs and numeric values.
 */
export const MetricValueSchema = z.object({
	labels: z.record(z.string(), z.string()),
	value: z.number(),
});

/**
 * Complete metric definition with metadata and observations for Prometheus export.
 */
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

/**
 * Zod schema validating complete metric definitions including name, help text, type, and observations.
 */
export const MetricDefinitionSchema = z.object({
	name: z.string(),
	help: z.string(),
	type: MetricTypeSchema,
	values: z.array(MetricValueSchema),
});

/**
 * Merge multiple MetricDefinition arrays by metric name.
 * Metrics with the same name have their values concatenated.
 * Used when zone-chunked queries produce partial results that need recombining.
 *
 * @param arrays MetricDefinition arrays to merge.
 * @returns Single merged array with values combined per metric name.
 */
export function mergeMetricDefinitions(
	...arrays: MetricDefinition[][]
): MetricDefinition[] {
	if (arrays.length === 0) return [];

	const first = arrays[0];
	if (arrays.length === 1 && first !== undefined) return first;

	const byName = new Map<string, MetricDefinition>();
	for (const metrics of arrays) {
		for (const m of metrics) {
			const existing = byName.get(m.name);
			if (existing) {
				// Spreading into push() overflows the call stack past ~100k values.
				for (const value of m.values) existing.values.push(value);
			} else {
				byName.set(m.name, {
					name: m.name,
					help: m.help,
					type: m.type,
					values: [...m.values],
				});
			}
		}
	}
	return Array.from(byName.values());
}
