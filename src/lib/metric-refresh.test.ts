import { describe, expect, it } from "vitest";
import { GraphQLError } from "./errors";
import { getMetricRefreshDelaySeconds } from "./metric-refresh";

describe("getMetricRefreshDelaySeconds", () => {
	it("backs off access-denied queries for one hour", () => {
		const error = new GraphQLError("access denied", [
			{
				message: "account does not have access to the path",
				extensions: { code: "FORBIDDEN" },
			},
		]);

		expect(getMetricRefreshDelaySeconds(error, 60)).toBe(3_600);
	});

	it("uses the normal interval for transient failures", () => {
		expect(getMetricRefreshDelaySeconds(new Error("timeout"), 60)).toBe(60);
	});
});
