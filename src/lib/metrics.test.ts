import { describe, expect, it } from "vitest";
import { mergeMetricDefinitions } from "./metrics";

describe("mergeMetricDefinitions", () => {
	it("merges a family with more values than the argument-spread limit", () => {
		const family = (count: number, offset: number) => ({
			name: "cloudflare_zone_colocation_requests_total",
			help: "Requests per colo",
			type: "counter" as const,
			values: Array.from({ length: count }, (_, index) => ({
				labels: { host: `host-${offset + index}` },
				value: 1,
			})),
		});
		const merged = mergeMetricDefinitions([family(1, 0)], [family(200_000, 1)]);
		expect(merged[0]?.values).toHaveLength(200_001);
		expect(merged[0]?.values[200_000]?.labels.host).toBe("host-200000");
	});
});
