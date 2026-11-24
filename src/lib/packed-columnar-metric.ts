import { type RefinementCtx, z } from "zod";
import type { MetricDefinition, MetricType, MetricValue } from "./metrics";
import {
	type ColumnarFamily,
	type ColumnarSampleSource,
	serializeColumnarMetrics,
} from "./packed-columnar-prometheus";
import type { SerializeOptions } from "./prometheus";
import { metricKey } from "./time";
import type { CounterState } from "./types";

export const COLUMNAR_METRIC_QUERIES = [
	"adaptive-metrics",
	"cache-miss-metrics",
	"colo-metrics",
	"colo-error-metrics",
	"edge-country-metrics",
	"health-check-metrics",
	"hostname-http-metrics",
	"http-metrics",
	"load-balancer-metrics",
	"lb-weight-metrics",
	"logpush-zone",
	"origin-status-metrics",
	"request-method-metrics",
	"ssl-certificates",
] as const;

export type ColumnarMetricQuery = (typeof COLUMNAR_METRIC_QUERIES)[number];

export type DirectColumnarColumns = {
	labels: Record<string, string[]>;
	values: number[];
	indexes: Map<string, number>;
};

export type ColumnarMetricSource = Omit<MetricDefinition, "values"> & {
	values: Iterable<MetricValue>;
	direct?: {
		labels: readonly string[];
		zones: Map<string, DirectColumnarColumns>;
	};
};

const FamilyMetadataSchema = z.object({
	name: z.string(),
	help: z.string(),
	type: z.enum(["counter", "gauge"]),
});

const CounterColumnsSchema = z.object({
	misses: z.array(z.number().int().positive()),
	lastIngest: z.array(z.number()),
});

const FamilyColumnsSchema = z.object({
	family: z.number().int().nonnegative(),
	labels: z.record(z.string(), z.array(z.string())),
	labelsFrom: z.number().int().nonnegative().optional(),
	values: z.array(z.number()),
	counter: CounterColumnsSchema.optional(),
});

const ZoneColumnsSchema = z.object({
	zone: z.string(),
	families: z.array(FamilyColumnsSchema),
});

const PackedColumnarMetricStateBaseSchema = z.object({
	format: z.literal("metric-columnar-v1"),
	lastIngest: z.number(),
	families: z.array(FamilyMetadataSchema),
	zones: z.array(ZoneColumnsSchema),
});

type PackedColumnarMetricStateValue = z.infer<
	typeof PackedColumnarMetricStateBaseSchema
>;
type FamilyMetadata = z.infer<typeof FamilyMetadataSchema>;
type FamilyColumns = z.infer<typeof FamilyColumnsSchema>;
type ValidationContext = RefinementCtx<PackedColumnarMetricStateValue>;

function addValidationIssue(
	ctx: ValidationContext,
	path: (string | number)[],
	message: string,
) {
	ctx.addIssue({ code: "custom", path, message });
}

function validateFamilyNames(
	families: readonly FamilyMetadata[],
	ctx: ValidationContext,
) {
	const names = new Set<string>();
	for (const [index, family] of families.entries()) {
		if (names.has(family.name)) {
			addValidationIssue(
				ctx,
				["families", index, "name"],
				"Duplicate metric family",
			);
		}
		names.add(family.name);
	}
}

function validateFamilyTable(
	family: FamilyMetadata,
	table: FamilyColumns,
	labels: Record<string, string[]>,
	path: (string | number)[],
	ctx: ValidationContext,
) {
	if (
		Object.values(labels).some(
			(column) => column.length !== table.values.length,
		)
	) {
		addValidationIssue(
			ctx,
			[...path, "labels"],
			"Packed columns must have equal lengths",
		);
	}

	const rowKeys = new Set<string>();
	const labelNames = Object.keys(labels);
	for (let rowIndex = 0; rowIndex < table.values.length; rowIndex++) {
		const key = rowKey(
			labelNames.map((label) => labels[label]?.[rowIndex] ?? ""),
		);
		if (rowKeys.has(key)) {
			addValidationIssue(
				ctx,
				[...path, "values", rowIndex],
				"Duplicate label tuple",
			);
		}
		rowKeys.add(key);
	}

	const counterColumnsMatch =
		table.counter !== undefined &&
		table.counter.misses.length === table.values.length &&
		table.counter.lastIngest.length === table.values.length;
	if (family.type === "counter" && !counterColumnsMatch) {
		addValidationIssue(
			ctx,
			[...path, "counter"],
			"Counter columns must match values",
		);
	}
	if (family.type === "gauge" && table.counter !== undefined) {
		addValidationIssue(
			ctx,
			[...path, "counter"],
			"Gauge families cannot have counter columns",
		);
	}
}

function validateZones(
	state: PackedColumnarMetricStateValue,
	ctx: ValidationContext,
) {
	const zoneNames = new Set<string>();
	for (const [zoneIndex, zone] of state.zones.entries()) {
		if (zoneNames.has(zone.zone)) {
			addValidationIssue(ctx, ["zones", zoneIndex, "zone"], "Duplicate zone");
		}
		zoneNames.add(zone.zone);

		const familyIndexes = new Set<number>();
		for (const [tableIndex, table] of zone.families.entries()) {
			const path = ["zones", zoneIndex, "families", tableIndex];
			const family = state.families[table.family];
			if (family === undefined || familyIndexes.has(table.family)) {
				addValidationIssue(
					ctx,
					[...path, "family"],
					"Invalid or duplicate family index",
				);
				continue;
			}
			familyIndexes.add(table.family);
			const labelSource =
				table.labelsFrom === undefined
					? undefined
					: zone.families.find(
							(candidate) => candidate.family === table.labelsFrom,
						);
			if (
				table.labelsFrom !== undefined &&
				(labelSource === undefined || labelSource.labelsFrom !== undefined)
			) {
				addValidationIssue(
					ctx,
					[...path, "labelsFrom"],
					"Invalid shared label source",
				);
				continue;
			}
			validateFamilyTable(
				family,
				table,
				labelSource?.labels ?? table.labels,
				path,
				ctx,
			);
		}
	}
}

export const PackedColumnarMetricStateSchema =
	PackedColumnarMetricStateBaseSchema.superRefine((state, ctx) => {
		validateFamilyNames(state.families, ctx);
		validateZones(state, ctx);
	});

export type PackedColumnarMetricState = z.infer<
	typeof PackedColumnarMetricStateSchema
>;

const STALE_MISSES = 5;

export function isColumnarMetricQuery(
	query: string,
): query is ColumnarMetricQuery {
	return COLUMNAR_METRIC_QUERIES.some((candidate) => candidate === query);
}

function rowKey(labels: readonly string[]) {
	return JSON.stringify(labels);
}

function metricLabels(metric: ColumnarMetricSource): string[] {
	if (metric.direct !== undefined) return [...metric.direct.labels];
	const labels = new Set<string>();
	for (const sample of metric.values) {
		for (const label of Object.keys(sample.labels)) {
			if (label !== "zone") labels.add(label);
		}
	}
	return [...labels];
}

function collectFamilies(
	previous: PackedColumnarMetricState | undefined,
	metrics: readonly ColumnarMetricSource[],
): FamilyMetadata[] {
	const families: FamilyMetadata[] = [];
	const indexes = new Map<string, number>();
	for (const metric of metrics) {
		const current = {
			name: metric.name,
			help: metric.help,
			type: metric.type,
		};
		const index = indexes.get(metric.name);
		if (index === undefined) {
			indexes.set(metric.name, families.length);
			families.push(current);
		} else {
			families[index] = current;
		}
	}
	for (const family of previous?.families ?? []) {
		if (!indexes.has(family.name)) {
			indexes.set(family.name, families.length);
			families.push({ ...family });
		}
	}
	return families;
}

function reindexPreviousState(
	previous: PackedColumnarMetricState | undefined,
	families: readonly FamilyMetadata[],
): PackedColumnarMetricState | undefined {
	if (previous === undefined) return undefined;
	const indexes = new Map(
		families.map((family, index) => [family.name, index]),
	);
	const oldToNew = previous.families.map((family) => {
		const index = indexes.get(family.name);
		return index !== undefined && families[index]?.type === family.type
			? index
			: undefined;
	});
	return {
		...previous,
		families: [...families],
		zones: previous.zones.map((zone) => ({
			...zone,
			families: zone.families
				.flatMap((table) => {
					const family = oldToNew[table.family];
					if (family === undefined) return [];
					const labelsFrom =
						table.labelsFrom === undefined
							? undefined
							: oldToNew[table.labelsFrom];
					return [
						{
							...table,
							family,
							...(table.labelsFrom === undefined
								? {}
								: labelsFrom === undefined
									? {
											labels: resolveLabels(zone, table),
											labelsFrom: undefined,
										}
									: { labelsFrom }),
						},
					];
				})
				.sort((left, right) => left.family - right.family),
		})),
	};
}

function collectFamilyLabels(
	previous: PackedColumnarMetricState | undefined,
	metrics: readonly ColumnarMetricSource[],
	families: readonly FamilyMetadata[],
): Map<number, string[]> {
	const labelsByFamily = new Map<number, string[]>();
	const append = (family: number, labels: readonly string[]) => {
		const current = labelsByFamily.get(family) ?? [];
		current.push(...labels.filter((label) => !current.includes(label)));
		labelsByFamily.set(family, current);
	};
	for (const zone of previous?.zones ?? []) {
		for (const table of zone.families) {
			append(table.family, Object.keys(resolveLabels(zone, table)));
		}
	}
	const familyIndexes = new Map(
		families.map((family, index) => [family.name, index]),
	);
	for (const metric of metrics) {
		const family = familyIndexes.get(metric.name);
		if (family !== undefined) append(family, metricLabels(metric));
	}
	return labelsByFamily;
}

function emptyColumns(labels: readonly string[]): DirectColumnarColumns {
	return {
		labels: Object.fromEntries(labels.map((label) => [label, []])),
		values: [],
		indexes: new Map(),
	};
}

function addObservation(
	columns: DirectColumnarColumns,
	labels: readonly string[],
	tuple: readonly string[],
	value: number,
	type: MetricType,
) {
	const key = rowKey(tuple);
	const index = columns.indexes.get(key);
	if (index === undefined) {
		columns.indexes.set(key, columns.values.length);
		columns.values.push(value);
		for (const [labelIndex, label] of labels.entries()) {
			columns.labels[label]?.push(tuple[labelIndex] ?? "");
		}
	} else if (type === "counter") {
		columns.values[index] = (columns.values[index] ?? 0) + value;
	} else {
		columns.values[index] = Math.max(columns.values[index] ?? 0, value);
	}
}

function observedColumnsByZone(
	metrics: readonly ColumnarMetricSource[],
	families: readonly FamilyMetadata[],
	labelsByFamily: ReadonlyMap<number, readonly string[]>,
): Map<string, Map<number, DirectColumnarColumns>> {
	const familyIndexes = new Map(
		families.map((family, index) => [family.name, index]),
	);
	const zones = new Map<string, Map<number, DirectColumnarColumns>>();
	for (const metric of metrics) {
		const familyIndex = familyIndexes.get(metric.name);
		const family =
			familyIndex === undefined ? undefined : families[familyIndex];
		if (familyIndex === undefined || family === undefined) continue;
		const labelNames = labelsByFamily.get(familyIndex) ?? [];
		if (metric.direct !== undefined) {
			for (const [zone, source] of metric.direct.zones) {
				const tables = zones.get(zone) ?? new Map();
				let columns = tables.get(familyIndex);
				if (columns === undefined) {
					columns = source;
					for (const label of labelNames) {
						columns.labels[label] ??= Array(columns.values.length).fill("");
					}
					columns.indexes.clear();
					for (let index = 0; index < columns.values.length; index++) {
						columns.indexes.set(
							rowKey(
								labelNames.map((label) => columns.labels[label]?.[index] ?? ""),
							),
							index,
						);
					}
					tables.set(familyIndex, columns);
				} else {
					for (let index = 0; index < source.values.length; index++) {
						const tuple = labelNames.map(
							(label) => source.labels[label]?.[index] ?? "",
						);
						addObservation(
							columns,
							labelNames,
							tuple,
							source.values[index] ?? 0,
							family.type,
						);
					}
				}
				zones.set(zone, tables);
			}
			metric.direct.zones.clear();
			continue;
		}
		for (const sample of metric.values) {
			const zone = sample.labels.zone ?? "";
			const tables = zones.get(zone) ?? new Map();
			const columns = tables.get(familyIndex) ?? emptyColumns(labelNames);
			const tuple = labelNames.map((label) => sample.labels[label] ?? "");
			addObservation(columns, labelNames, tuple, sample.value, family.type);
			tables.set(familyIndex, columns);
			zones.set(zone, tables);
		}
	}
	return zones;
}

function resolveLabels(
	zone: z.infer<typeof ZoneColumnsSchema>,
	table: FamilyColumns,
): Record<string, string[]> {
	if (table.labelsFrom === undefined) return table.labels;
	return (
		zone.families.find((candidate) => candidate.family === table.labelsFrom)
			?.labels ?? table.labels
	);
}

function shareIdenticalLabels(
	tables: PackedColumnarMetricState["zones"][number]["families"],
) {
	const sources = new Map<string, number>();
	return tables.map((table) => {
		const key = JSON.stringify(table.labels);
		const source = sources.get(key);
		if (source !== undefined) {
			return { ...table, labels: {}, labelsFrom: source };
		}
		sources.set(key, table.family);
		return table;
	});
}

export function accumulateColumnarMetricState(input: {
	previous: PackedColumnarMetricState | undefined;
	metrics: readonly ColumnarMetricSource[];
	ingestId: number;
	failedScopes: ReadonlySet<string>;
}): PackedColumnarMetricState {
	const families = collectFamilies(input.previous, input.metrics);
	const previous = reindexPreviousState(input.previous, families);
	const labelsByFamily = collectFamilyLabels(previous, input.metrics, families);
	const previousZones = new Map(
		(previous?.zones ?? []).map((zone) => [zone.zone, zone]),
	);
	const observedZones = observedColumnsByZone(
		input.metrics,
		families,
		labelsByFamily,
	);
	const zoneNames = new Set(previousZones.keys());
	for (const zone of observedZones.keys()) zoneNames.add(zone);
	const ageMissing = previous?.lastIngest !== input.ingestId;
	const zones: PackedColumnarMetricState["zones"] = [];
	for (const zone of zoneNames) {
		const previousZone = previousZones.get(zone);
		if (input.failedScopes.has(zone) && previousZone !== undefined) {
			zones.push(previousZone);
			continue;
		}
		const tables = families.flatMap((family, familyIndex) => {
			const labelNames = labelsByFamily.get(familyIndex) ?? [];
			const current =
				observedZones.get(zone)?.get(familyIndex) ?? emptyColumns(labelNames);
			const { labels, values, indexes } = current;
			if (family.type === "gauge") {
				indexes.clear();
				return values.length === 0
					? []
					: [{ family: familyIndex, labels, values }];
			}

			const misses = Array(values.length).fill(STALE_MISSES);
			const lastIngest = Array(values.length).fill(input.ingestId);
			const previousTable = previousZone?.families.find(
				(table) => table.family === familyIndex,
			);
			if (previousZone !== undefined && previousTable !== undefined) {
				const previousLabels = resolveLabels(previousZone, previousTable);
				for (
					let oldIndex = 0;
					oldIndex < previousTable.values.length;
					oldIndex++
				) {
					const tuple = labelNames.map(
						(label) => previousLabels[label]?.[oldIndex] ?? "",
					);
					const index = indexes.get(rowKey(tuple));
					if (index !== undefined) {
						values[index] =
							(previousTable.values[oldIndex] ?? 0) +
							(previousTable.counter?.lastIngest[oldIndex] === input.ingestId
								? 0
								: (values[index] ?? 0));
						continue;
					}
					const oldMisses =
						previousTable.counter?.misses[oldIndex] ?? STALE_MISSES;
					if (ageMissing && oldMisses <= 1) continue;
					for (const [labelIndex, label] of labelNames.entries()) {
						labels[label]?.push(tuple[labelIndex] ?? "");
					}
					values.push(previousTable.values[oldIndex] ?? 0);
					misses.push(ageMissing ? oldMisses - 1 : oldMisses);
					lastIngest.push(previousTable.counter?.lastIngest[oldIndex] ?? 0);
				}
			}
			indexes.clear();
			return values.length === 0
				? []
				: [
						{
							family: familyIndex,
							labels,
							values,
							counter: { misses, lastIngest },
						},
					];
		});
		if (tables.length > 0) {
			zones.push({ zone, families: shareIdenticalLabels(tables) });
		}
	}
	for (const tables of observedZones.values()) {
		for (const columns of tables.values()) columns.indexes.clear();
	}
	return {
		format: "metric-columnar-v1",
		lastIngest: input.ingestId,
		families,
		zones,
	};
}

function parseLegacyCounterKey(
	key: string,
): { name: string; labels: Record<string, string> } | undefined {
	const labelsStart = key.indexOf("{");
	if (labelsStart < 1 || !key.endsWith("}")) return undefined;
	const labels: Record<string, string> = {};
	const encodedLabels = key.slice(labelsStart + 1, -1);
	if (encodedLabels !== "") {
		for (const encodedLabel of encodedLabels.split(",")) {
			const separator = encodedLabel.indexOf("=");
			if (separator < 1) return undefined;
			labels[encodedLabel.slice(0, separator)] = encodedLabel.slice(
				separator + 1,
			);
		}
	}
	return { name: key.slice(0, labelsStart), labels };
}

/** Convert legacy counter state, including dormant series, to packed storage. */
export function migrateLegacyColumnarMetricState(input: {
	metrics: readonly MetricDefinition[];
	counters: Readonly<Record<string, CounterState>>;
	ingestId: number;
}): PackedColumnarMetricState {
	const counterFamilies = new Map<string, MetricDefinition>();
	const currentCounters = new Map<
		string,
		{ name: string; help: string; labels: Record<string, string> }
	>();
	const metrics: MetricDefinition[] = [];

	for (const metric of input.metrics) {
		if (metric.type === "gauge") {
			metrics.push(metric);
			continue;
		}
		const family = { ...metric, values: [] };
		counterFamilies.set(metric.name, family);
		metrics.push(family);
		for (const value of metric.values) {
			currentCounters.set(metricKey(metric.name, value.labels), {
				name: metric.name,
				help: metric.help,
				labels: value.labels,
			});
		}
	}

	for (const [key, counter] of Object.entries(input.counters)) {
		const storedIdentity = counter.metric ?? currentCounters.get(key);
		const identity = storedIdentity ?? parseLegacyCounterKey(key);
		if (identity === undefined) continue;
		let family = counterFamilies.get(identity.name);
		if (family === undefined) {
			const newFamily: MetricDefinition = {
				name: identity.name,
				help: storedIdentity?.help ?? "",
				type: "counter",
				values: [],
			};
			counterFamilies.set(identity.name, newFamily);
			metrics.push(newFamily);
			family = newFamily;
		}
		family.values.push({ labels: identity.labels, value: counter.accumulated });
	}

	const migrated = accumulateColumnarMetricState({
		previous: undefined,
		metrics,
		ingestId: input.ingestId,
		failedScopes: new Set(),
	});
	for (const zone of migrated.zones) {
		for (const table of zone.families) {
			const family = migrated.families[table.family];
			if (family?.type !== "counter" || table.counter === undefined) continue;
			const labels = resolveLabels(zone, table);
			for (let index = 0; index < table.values.length; index++) {
				const sampleLabels = Object.fromEntries(
					Object.entries(labels).map(([name, values]) => [
						name,
						values[index] ?? "",
					]),
				);
				if (zone.zone !== "") sampleLabels.zone = zone.zone;
				const counter = input.counters[metricKey(family.name, sampleLabels)];
				if (counter === undefined) continue;
				table.counter.misses[index] = counter.missesRemaining ?? STALE_MISSES;
				table.counter.lastIngest[index] = counter.lastIngest ?? input.ingestId;
			}
		}
	}
	return migrated;
}

function familySamples(
	states: readonly PackedColumnarMetricState[],
	metricName: string,
	labels: readonly string[],
): ColumnarSampleSource {
	return function* samples() {
		for (const state of states) {
			const familyIndex = state.families.findIndex(
				(family) => family.name === metricName,
			);
			if (familyIndex < 0) continue;
			for (const zone of state.zones) {
				const table = zone.families.find(
					(candidate) => candidate.family === familyIndex,
				);
				if (table === undefined) continue;
				const labelColumns = resolveLabels(zone, table);
				for (let index = 0; index < table.values.length; index++) {
					yield {
						zone: zone.zone,
						keys: labels.map((label) => labelColumns[label]?.[index] ?? ""),
						value: table.values[index] ?? 0,
					};
				}
			}
		}
	};
}

export function* serializeColumnarMetricStates(
	states: readonly PackedColumnarMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const families = new Map<string, FamilyMetadata>();
	const labelsByFamily = new Map<string, string[]>();
	for (const state of states) {
		const populatedFamilies = new Set(
			state.zones.flatMap((zone) =>
				zone.families
					.filter((table) => table.values.length > 0)
					.map((table) => table.family),
			),
		);
		for (const [index, family] of state.families.entries()) {
			if (populatedFamilies.has(index) && !families.has(family.name)) {
				families.set(family.name, family);
			}
		}
		for (const zone of state.zones) {
			for (const table of zone.families) {
				const name = state.families[table.family]?.name;
				if (name === undefined) continue;
				const labels = labelsByFamily.get(name) ?? [];
				const labelColumns = resolveLabels(zone, table);
				labels.push(
					...Object.keys(labelColumns).filter(
						(label) => !labels.includes(label),
					),
				);
				labelsByFamily.set(name, labels);
			}
		}
	}
	for (const family of families.values()) {
		const labels = labelsByFamily.get(family.name) ?? [];
		const outputFamily: ColumnarFamily = family;
		yield* serializeColumnarMetrics(
			familySamples(states, family.name, labels),
			outputFamily,
			labels,
			options,
		);
	}
}
