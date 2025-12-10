import z from "zod";

/**
 * Zod schema for all supported metric query names.
 * Includes both account-level and zone-level queries.
 */
export const MetricQueryNameSchema = z.enum([
	// Account-level
	"worker-totals",
	"logpush-account",
	"magic-transit",
	// Zone-level
	"http-metrics",
	"adaptive-metrics",
	"edge-country-metrics",
	"colo-metrics",
	"colo-error-metrics",
	"request-method-metrics",
	"health-check-metrics",
	"load-balancer-metrics",
	"logpush-zone",
	"origin-status-metrics",
	"cache-miss-metrics",
	// REST API
	"ssl-certificates",
	"lb-weight-metrics",
]);

/**
 * Union of all metric query names (account and zone level).
 */
export type MetricQueryName = z.infer<typeof MetricQueryNameSchema>;

/**
 * Account-scoped metric queries (require single accountTag).
 */
export const ACCOUNT_LEVEL_QUERIES = [
	"worker-totals",
	"logpush-account",
	"magic-transit",
] as const;

/**
 * Union of account-level query names.
 */
export type AccountLevelQuery = (typeof ACCOUNT_LEVEL_QUERIES)[number];

/**
 * Zone-scoped metric queries (support multiple zoneIDs).
 */
export const ZONE_LEVEL_QUERIES = [
	"http-metrics",
	"adaptive-metrics",
	"edge-country-metrics",
	"colo-metrics",
	"colo-error-metrics",
	"request-method-metrics",
	"health-check-metrics",
	"load-balancer-metrics",
	"logpush-zone",
	"origin-status-metrics",
	"cache-miss-metrics",
	"ssl-certificates",
	"lb-weight-metrics",
] as const;

/**
 * Union of zone-level query names.
 */
export type ZoneLevelQuery = (typeof ZONE_LEVEL_QUERIES)[number];

/**
 * Type guard for account-level queries.
 *
 * @param query Query name to check.
 * @returns True if query is account-level.
 */
export function isAccountLevelQuery(query: string): query is AccountLevelQuery {
	return (ACCOUNT_LEVEL_QUERIES as readonly string[]).includes(query);
}

/**
 * Type guard for zone-level queries.
 *
 * @param query Query name to check.
 * @returns True if query is zone-level.
 */
export function isZoneLevelQuery(query: string): query is ZoneLevelQuery {
	return (ZONE_LEVEL_QUERIES as readonly string[]).includes(query);
}

/**
 * Query types available on free tier accounts.
 */
export const FREE_TIER_QUERIES = [
	"worker-totals",
	"logpush-account",
	"magic-transit",
] as const;

/**
 * Type for free tier query names.
 */
export type FreeTierQuery = (typeof FREE_TIER_QUERIES)[number];

/**
 * Zone-level GraphQL queries that require paid tier.
 * Free tier zones don't have access to adaptive analytics endpoints.
 */
export const PAID_TIER_GRAPHQL_QUERIES = [
	"http-metrics",
	"adaptive-metrics",
	"edge-country-metrics",
	"colo-metrics",
	"colo-error-metrics",
	"request-method-metrics",
	"health-check-metrics",
	"load-balancer-metrics",
	"logpush-zone",
	"origin-status-metrics",
	"cache-miss-metrics",
] as const;

/**
 * Type for paid tier GraphQL query names.
 */
export type PaidTierGraphQLQuery = (typeof PAID_TIER_GRAPHQL_QUERIES)[number];

/**
 * Type guard for paid tier GraphQL queries.
 *
 * @param query Query name to check.
 * @returns True if query requires paid tier.
 */
export function isPaidTierGraphQLQuery(
	query: string,
): query is PaidTierGraphQLQuery {
	return (PAID_TIER_GRAPHQL_QUERIES as readonly string[]).includes(query);
}
