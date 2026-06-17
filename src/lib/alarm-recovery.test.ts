import { describe, expect, it, vi } from "vitest";
import { runAlarmWithRecovery } from "./alarm-recovery";

describe("alarm recovery", () => {
	it("does not schedule a recovery alarm after a successful handler", async () => {
		const scheduleRecoveryAlarm = vi.fn().mockResolvedValue(undefined);

		await runAlarmWithRecovery({
			run: async () => undefined,
			getLogger: () => undefined,
			scheduleRecoveryAlarm,
		});

		expect(scheduleRecoveryAlarm).not.toHaveBeenCalled();
	});

	it("schedules a recovery alarm and swallows the handler error", async () => {
		const logger = { error: vi.fn() };
		const scheduleRecoveryAlarm = vi.fn().mockResolvedValue(undefined);

		await expect(
			runAlarmWithRecovery({
				run: async () => {
					throw new Error("refresh failed before rescheduling");
				},
				getLogger: () => logger,
				scheduleRecoveryAlarm,
			}),
		).resolves.toBeUndefined();

		expect(scheduleRecoveryAlarm).toHaveBeenCalledOnce();
		expect(logger.error).toHaveBeenCalledWith("Alarm handler failed", {
			error: "refresh failed before rescheduling",
		});
	});

	it("keeps the alarm loop alive across repeated handler failures", async () => {
		const scheduleRecoveryAlarm = vi.fn().mockResolvedValue(undefined);

		for (let attempt = 0; attempt < 10; attempt++) {
			await runAlarmWithRecovery({
				run: async () => {
					throw new Error("refresh failed");
				},
				getLogger: () => undefined,
				scheduleRecoveryAlarm,
			});
		}

		expect(scheduleRecoveryAlarm).toHaveBeenCalledTimes(10);
	});

	it("still schedules recovery when error logging fails", async () => {
		const scheduleRecoveryAlarm = vi.fn().mockResolvedValue(undefined);

		await expect(
			runAlarmWithRecovery({
				run: async () => {
					throw new Error("refresh failed");
				},
				getLogger: () => ({
					error: () => {
						throw new Error("logger failed");
					},
				}),
				scheduleRecoveryAlarm,
			}),
		).resolves.toBeUndefined();

		expect(scheduleRecoveryAlarm).toHaveBeenCalledOnce();
	});

	it("rethrows when the recovery alarm cannot be scheduled", async () => {
		const scheduleError = new Error("storage unavailable");
		const logger = { error: vi.fn() };

		await expect(
			runAlarmWithRecovery({
				run: async () => {
					throw new Error("refresh failed before rescheduling");
				},
				getLogger: () => logger,
				scheduleRecoveryAlarm: async () => {
					throw scheduleError;
				},
			}),
		).rejects.toThrow(scheduleError);

		expect(logger.error).toHaveBeenLastCalledWith(
			"Failed to schedule recovery alarm",
			{ error: "storage unavailable" },
		);
	});
});
