import { CloudflarePrometheusError, ErrorCode } from "./errors";

const ACCESS_DENIED_RETRY_SECONDS = 60 * 60;

/**
 * Selects the next refresh delay after a failed metrics query.
 * Access-denied products are retried infrequently so newly granted access is
 * discovered without issuing a failing API request every minute.
 */
export function getMetricRefreshDelaySeconds(
	error: unknown,
	defaultDelaySeconds: number,
): number {
	if (
		error instanceof CloudflarePrometheusError &&
		error.code === ErrorCode.GRAPHQL_FIELD_ACCESS
	) {
		return Math.max(defaultDelaySeconds, ACCESS_DENIED_RETRY_SECONDS);
	}
	return defaultDelaySeconds;
}
