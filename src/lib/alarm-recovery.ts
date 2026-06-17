export interface AlarmRecoveryLogger {
	error(message: string, context?: Record<string, unknown>): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function logError(
	logger: AlarmRecoveryLogger | undefined,
	message: string,
	error: unknown,
): void {
	try {
		logger?.error(message, { error: errorMessage(error) });
	} catch {
		// Recovery must not depend on logging succeeding.
	}
}

export async function runAlarmWithRecovery(options: {
	run: () => Promise<void>;
	getLogger: () => AlarmRecoveryLogger | undefined;
	scheduleRecoveryAlarm: () => Promise<void>;
}): Promise<void> {
	try {
		await options.run();
	} catch (error) {
		logError(options.getLogger(), "Alarm handler failed", error);

		try {
			await options.scheduleRecoveryAlarm();
		} catch (scheduleError) {
			logError(
				options.getLogger(),
				"Failed to schedule recovery alarm",
				scheduleError,
			);
			throw scheduleError;
		}
	}
}
