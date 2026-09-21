import type { MetricDefinition, MetricType, MetricValue } from "./metrics";
import type {
	ColumnarMetricSource,
	DirectColumnarColumns,
} from "./packed-columnar-metric";

export type ColumnarObservedFamily = {
	name: string;
	help: string;
	type: MetricType;
	labels: string[];
	zones: Map<string, DirectColumnarColumns>;
};

function rowKey(labels: readonly string[]) {
	return JSON.stringify(labels);
}

class ObservationValues extends Array<MetricValue> {
	private count = 0;

	constructor(private readonly emit: (value: MetricValue) => void) {
		super();
	}

	override push(...values: MetricValue[]): number {
		for (const value of values) this.emit(value);
		this.count += values.length;
		return this.count;
	}
}

/** Collects query-handler emissions without retaining MetricValue objects. */
export class ColumnarObservationSink {
	private readonly families = new Map<string, ColumnarObservedFamily>();

	capture(metrics: readonly MetricDefinition[]) {
		for (const metric of metrics) {
			let family = this.families.get(metric.name);
			if (family === undefined) {
				family = {
					name: metric.name,
					help: metric.help,
					type: metric.type,
					labels: [],
					zones: new Map(),
				};
				this.families.set(metric.name, family);
			} else {
				family.help = metric.help;
				family.type = metric.type;
			}
			metric.values = new ObservationValues((value) => this.add(family, value));
		}
	}

	finish(): ColumnarMetricSource[] {
		return [...this.families.values()].map((family) => ({
			name: family.name,
			help: family.help,
			type: family.type,
			values: [],
			direct: { labels: family.labels, zones: family.zones },
		}));
	}

	private add(family: ColumnarObservedFamily, sample: MetricValue) {
		const discovered = Object.keys(sample.labels).filter(
			(label) => label !== "zone" && !family.labels.includes(label),
		);
		if (discovered.length > 0) {
			family.labels.push(...discovered);
			for (const columns of family.zones.values()) {
				for (const label of discovered) {
					columns.labels[label] = Array(columns.values.length).fill("");
				}
				columns.indexes.clear();
				for (let index = 0; index < columns.values.length; index++) {
					columns.indexes.set(
						rowKey(
							family.labels.map(
								(label) => columns.labels[label]?.[index] ?? "",
							),
						),
						index,
					);
				}
			}
		}

		const zone = sample.labels.zone ?? "";
		let columns = family.zones.get(zone);
		if (columns === undefined) {
			columns = {
				labels: Object.fromEntries(family.labels.map((label) => [label, []])),
				values: [],
				indexes: new Map(),
			};
			family.zones.set(zone, columns);
		}
		const labels = family.labels.map((label) => sample.labels[label] ?? "");
		const key = rowKey(labels);
		const existing = columns.indexes.get(key);
		if (existing === undefined) {
			columns.indexes.set(key, columns.values.length);
			columns.values.push(sample.value);
			for (const [index, label] of family.labels.entries()) {
				columns.labels[label]?.push(labels[index] ?? "");
			}
		} else if (family.type === "counter") {
			columns.values[existing] = (columns.values[existing] ?? 0) + sample.value;
		} else {
			columns.values[existing] = Math.max(
				columns.values[existing] ?? 0,
				sample.value,
			);
		}
	}
}
