/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";
import type { MetricExporter } from "../../src/durable-objects/MetricExporter";
import { setupGraphQLNetwork } from "./metric-exporter-helpers";

const network = setupGraphQLNetwork();
const metricName = "cloudflare_turnstile_events_total";
const dimensions = [
	{ siteKey: "site-A", action: "", eventType: "challenge_issued" },
	{ siteKey: "site-B", action: "", eventType: "challenge_issued" },
	{ siteKey: "site-A", action: "checkout", eventType: "challenge_issued" },
	{ siteKey: "site-A", action: "", eventType: "future_event" },
];

async function expectCounters(
	exporter: DurableObjectStub<MetricExporter>,
	values: number[],
): Promise<string> {
	const response = await exporter.exportPrometheus({
		packed: false,
		denylist: [],
		excludeLabels: [],
	});
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).toContain(`# TYPE ${metricName} counter\n`);
	const samples = text
		.split("\n")
		.filter((line) => line.startsWith(`${metricName}{`))
		.map((line) =>
			line.replace(
				/\{([^}]*)\}/,
				(_match, labels: string) => `{${labels.split(",").sort().join(",")}}`,
			),
		)
		.sort();
	expect(samples).toEqual(
		dimensions
			.map(
				({ siteKey, action, eventType }, index) =>
					`${metricName}{account="turnstile-test-account",action="${action}",event_type="${eventType}",site_key="${siteKey}"} ${values[index]}`,
			)
			.sort(),
	);
	return text;
}

describe("Turnstile MetricExporter integration", () => {
	it("accumulates zero-zone account events once per window and retains them across eviction and errors", async () => {
		const accountId = "turnstile-integration-account";
		const exporterId = `account:${accountId}:turnstile`;
		const firstWindow = {
			mintime: "2026-01-01T00:00:00.000Z",
			maxtime: "2026-01-01T00:01:00.000Z",
		};
		const secondWindow = {
			mintime: firstWindow.maxtime,
			maxtime: "2026-01-01T00:02:00.000Z",
		};
		const thirdWindow = {
			mintime: secondWindow.maxtime,
			maxtime: "2026-01-01T00:03:00.000Z",
		};
		let failThirdWindow = true;
		network.use(
			http.post(CLOUDFLARE_GQL_URL, async ({ request }) => {
				const { variables } = z
					.object({
						variables: z.object({
							mintime: z.string(),
							maxtime: z.string(),
						}),
					})
					.parse(await request.json());
				const window = {
					mintime: variables.mintime,
					maxtime: variables.maxtime,
				};
				const isThirdWindow = window.maxtime === thirdWindow.maxtime;
				const failure = isThirdWindow && failThirdWindow;
				const counts = failure
					? [1000, 1000, 1000, 1000]
					: isThirdWindow
						? [2, 4, 6, 8]
						: window.maxtime === secondWindow.maxtime
							? [3, 5, 7, 9]
							: [7, 11, 13, 17];
				return HttpResponse.json({
					data: {
						viewer: {
							accounts: [
								{
									turnstileAdaptiveGroups: dimensions.map(
										(dimensions, index) => ({
											dimensions,
											count: counts[index],
										}),
									),
								},
							],
						},
					},
					...(failure
						? { errors: [{ message: "Turnstile analytics unavailable" }] }
						: {}),
				});
			}),
		);

		const exporter = env.MetricExporter.getByName(exporterId);
		await exporter.initialize(exporterId);
		await exporter.updateZoneContext(
			accountId,
			"Turnstile Test Account",
			[],
			{},
			firstWindow,
		);
		const firstText = await expectCounters(exporter, [7, 11, 13, 17]);
		expect(await expectCounters(exporter, [7, 11, 13, 17])).toBe(firstText);

		await exporter.triggerRefresh(secondWindow);
		const secondText = await expectCounters(exporter, [10, 16, 20, 26]);
		await exporter.triggerRefresh(secondWindow);
		expect(await expectCounters(exporter, [10, 16, 20, 26])).toBe(secondText);
		expect(await expectCounters(exporter, [10, 16, 20, 26])).toBe(secondText);

		await evictDurableObject(exporter);
		const recreated = env.MetricExporter.getByName(exporterId);
		await recreated.initialize(exporterId);
		expect(await expectCounters(recreated, [10, 16, 20, 26])).toBe(secondText);

		// Partial GraphQL data must not replace or increment the previous counters.
		await recreated.triggerRefresh(thirdWindow);
		expect(await expectCounters(recreated, [10, 16, 20, 26])).toBe(secondText);
		await evictDurableObject(recreated);
		const recovered = env.MetricExporter.getByName(exporterId);
		expect(await expectCounters(recovered, [10, 16, 20, 26])).toBe(secondText);

		failThirdWindow = false;
		await recovered.triggerRefresh(thirdWindow);
		const thirdText = await expectCounters(recovered, [12, 20, 26, 34]);
		await recovered.triggerRefresh(thirdWindow);
		expect(await expectCounters(recovered, [12, 20, 26, 34])).toBe(thirdText);
	});
});
