export type ColoMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "colo-metrics";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		zones: number;
		colosPerZone: number;
		hostsPerColo: number;
		trafficPerHost: Readonly<{
			requests: number;
			visits: number;
			responseBytes: number;
		}>;
	}>;
}>;

// Add a case here using business traffic dimensions; the test derives records.
export const COLO_METRIC_SCENARIOS = [
	{
		name: "small colo account",
		path: {
			metric: "colo-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 1,
			colosPerZone: 10,
			hostsPerColo: 10,
			trafficPerHost: {
				requests: 10,
				visits: 8,
				responseBytes: 2_048,
			},
		},
	},
	{
		name: "large colo account",
		path: {
			metric: "colo-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 15,
			colosPerZone: 10,
			hostsPerColo: 1_000,
			trafficPerHost: {
				requests: 10,
				visits: 8,
				responseBytes: 2_048,
			},
		},
	},
] satisfies readonly ColoMetricScenario[];
