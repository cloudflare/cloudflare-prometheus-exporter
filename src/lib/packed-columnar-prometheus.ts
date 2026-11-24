import type { SerializeOptions } from "./prometheus";

export type ColumnarFamily = {
	name: string;
	help: string;
	type: "counter" | "gauge";
};

// UTF-8 uses at most three bytes per UTF-16 code unit. Leave room for a line
// without constructing a second encoded copy merely to measure every buffer.
const CHUNK_TARGET_CHARS = 16 * 1024;

/** One exported sample: the zone label plus positional key labels. */
export type ColumnarSample = {
	zone: string;
	keys: readonly string[];
	value: number;
};

/**
 * Lazily yields one sample per stored row for the requested value slot.
 * Implementations read packed columns directly so a scrape never materializes
 * every row before the response stream consumes it.
 */
export type ColumnarSampleSource = () => Generator<ColumnarSample>;

function formatValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
	return String(value);
}

function escapeLabel(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}

function escapeHelp(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * Aggregates collapsed samples the same way `serializeToPrometheus` does:
 * counters sum and gauges keep the maximum value.
 */
function* aggregateSamples(
	samples: Iterable<ColumnarSample>,
	keptIndexes: readonly number[],
	includeZone: boolean,
	metricType: string,
): Generator<ColumnarSample> {
	const aggregated = new Map<string, ColumnarSample>();
	for (const sample of samples) {
		const keys = keptIndexes.map((index) => sample.keys[index] ?? "");
		const zone = includeZone ? sample.zone : "";
		const signature = `${zone}\x00${keys.join("\x01")}`;
		const existing = aggregated.get(signature);
		if (existing === undefined) {
			aggregated.set(signature, { zone, keys, value: sample.value });
		} else {
			existing.value =
				metricType === "counter"
					? existing.value + sample.value
					: Math.max(existing.value, sample.value);
		}
	}
	yield* aggregated.values();
}

function formatLabels(
	sample: ColumnarSample,
	keptLabels: readonly string[],
	includeZone: boolean,
): string {
	const parts = includeZone ? [`zone="${escapeLabel(sample.zone)}"`] : [];
	for (const [index, label] of keptLabels.entries()) {
		parts.push(`${label}="${escapeLabel(sample.keys[index] ?? "")}"`);
	}
	return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

function* familyLines(
	samples: Iterable<ColumnarSample>,
	family: ColumnarFamily,
	keptLabels: readonly string[],
	includeZone: boolean,
): Generator<string> {
	let wroteHeaders = false;
	const metricType = family.type ?? "counter";
	for (const sample of samples) {
		// Emit headers only once a family has a sample, so a fully aged-out
		// family produces no bare HELP/TYPE block.
		if (!wroteHeaders) {
			yield `# HELP ${family.name} ${escapeHelp(family.help)}\n# TYPE ${family.name} ${metricType}\n`;
			wroteHeaders = true;
		}
		yield `${family.name}${formatLabels(sample, keptLabels, includeZone)} ${formatValue(sample.value)}\n`;
	}
	if (wroteHeaders) yield "\n";
}

/**
 * Lazily serializes packed columnar metrics in bounded output chunks so
 * streaming respects backpressure from a slow scraper.
 *
 * @param samplesFor Lazy sample source for a value slot.
 * @param families Exported families and the value slot each one reads.
 * @param keyLabels Label names forming the row key, in export order.
 * @param options Denylist and label-exclusion options.
 * @returns Generator of Prometheus text chunks.
 */
export function* serializeColumnarMetrics(
	samplesFor: ColumnarSampleSource,
	family: ColumnarFamily,
	keyLabels: readonly string[],
	options: SerializeOptions,
): Generator<string> {
	if (options.denylist?.has(family.name)) return;
	const excludeLabels = options.excludeLabels ?? new Set<string>();
	const includeZone = !excludeLabels.has("zone");
	const keptIndexes = keyLabels
		.map((_, index) => index)
		.filter((index) => !excludeLabels.has(keyLabels[index] ?? ""));
	const keptLabels = keptIndexes.map((index) => keyLabels[index] ?? "");
	const needsAggregation =
		!includeZone || keptIndexes.length !== keyLabels.length;

	let buffer = "";
	const samples = samplesFor();
	for (const line of familyLines(
		needsAggregation
			? aggregateSamples(samples, keptIndexes, includeZone, family.type)
			: samples,
		family,
		keptLabels,
		includeZone,
	)) {
		buffer += line;
		if (buffer.length >= CHUNK_TARGET_CHARS) {
			yield buffer;
			buffer = "";
		}
	}
	if (buffer.length > 0) yield buffer;
}
