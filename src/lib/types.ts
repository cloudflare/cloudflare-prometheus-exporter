import z from "zod";
import { MetricDefinitionSchema } from "./metrics";

// Re-export metric types from metrics.ts
export type { MetricDefinition, MetricType, MetricValue } from "./metrics";
export { MetricDefinitionSchema } from "./metrics";

/**
 * Zod schema for MetricExporter scope: account-level or zone-level.
 */
export const ScopeTypeSchema = z.enum(["account", "zone"]);

/**
 * Scope discriminator for MetricExporter DOs.
 */
export type ScopeType = z.infer<typeof ScopeTypeSchema>;

/**
 * String literal type for MetricExporter DO IDs: "scope:id:queryName".
 */
export type MetricExporterIdString =
	`${"account" | "zone"}:${string}:${string}`;

/**
 * Zod schema that parses and validates MetricExporter DO ID strings.
 * Transforms "scope:id:query" into structured object.
 */
export const MetricExporterIdSchema = z
	.string()
	.regex(/^(account|zone):[^:]+:[^:]+$/)
	.transform((s) => {
		const parts = s.split(":");
		// Regex guarantees exactly 3 parts with account|zone prefix
		const scopeType = ScopeTypeSchema.parse(parts[0]);
		const scopeId = z.string().min(1).parse(parts[1]);
		const queryName = z.string().min(1).parse(parts[2]);
		return { scopeType, scopeId, queryName };
	});

/**
 * Parsed MetricExporter DO identifier with scope, ID, and query name.
 */
export type MetricExporterId = z.infer<typeof MetricExporterIdSchema>;

/**
 * Zod schema for accumulated counter state and stale-series expiry.
 * Cloudflare API returns window-based totals, so observed values are summed.
 */
export const CounterStateSchema = z
	.object({
		accumulated: z.number(),
		/**
		 * Refreshes this series may remain unobserved before it is discarded.
		 * Optional so state written by earlier exporter versions can be migrated.
		 */
		missesRemaining: z.number().int().nonnegative().optional(),
		/** Query-window identifier last accumulated for at-least-once safety. */
		lastIngest: z.number().int().nonnegative().optional(),
		/** Zone label used to isolate expiry during partial query failures. */
		scope: z.string().optional(),
	})
	.readonly();

/**
 * Counter state for Prometheus monotonic counter semantics.
 */
export type CounterState = z.infer<typeof CounterStateSchema>;

/**
 * Zod schema for persistent metric state in MetricExporter DO storage.
 */
export const MetricStateSchema = z
	.object({
		accountId: z.string().optional(),
		accountName: z.string().optional(),
		counters: z.record(z.string(), CounterStateSchema),
		metrics: z.array(MetricDefinitionSchema).readonly(),
		lastFetch: z.number(),
		lastError: z.string().optional(),
	})
	.readonly();

/**
 * Persistent metric state stored in MetricExporter DO.
 */
export type MetricState = z.infer<typeof MetricStateSchema>;

/**
 * Zod schema for Cloudflare account API response.
 */
export const AccountSchema = z
	.object({
		id: z.string(),
		name: z.string(),
	})
	.readonly();

/**
 * Cloudflare account with ID and name.
 */
export type Account = z.infer<typeof AccountSchema>;

/**
 * Zod schema for Cloudflare zone API response with plan and account.
 */
export const ZoneSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		status: z.string(),
		plan: z.object({
			id: z.string(),
			name: z.string(),
		}),
		account: z.object({
			id: z.string(),
			name: z.string(),
		}),
	})
	.readonly();

/**
 * Cloudflare zone with plan and account associations.
 */
export type Zone = z.infer<typeof ZoneSchema>;

/**
 * Zod schema for Cloudflare SSL certificate API response.
 */
export const SSLCertificateSchema = z
	.object({
		id: z.string(),
		type: z.string(),
		status: z.string(),
		issuer: z.string(),
		expiresOn: z.string(),
		hosts: z.array(z.string()),
	})
	.readonly();

/**
 * SSL certificate with expiration and host coverage.
 */
export type SSLCertificate = z.infer<typeof SSLCertificateSchema>;

/**
 * Zod schema for GraphQL query time range with ISO 8601 timestamps.
 */
export const TimeRangeSchema = z
	.object({
		mintime: z.string(),
		maxtime: z.string(),
	})
	.readonly();

/**
 * Time range for GraphQL queries with start and end timestamps.
 */
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/**
 * Zod schema for load balancer origin configuration.
 */
export const LoadBalancerOriginSchema = z
	.object({
		name: z.string(),
		address: z.string(),
		enabled: z.boolean(),
		weight: z.number(),
	})
	.passthrough()
	.readonly();

/**
 * Load balancer origin with weight configuration.
 */
export type LoadBalancerOrigin = z.infer<typeof LoadBalancerOriginSchema>;

/**
 * Zod schema for load balancer pool configuration.
 */
export const LoadBalancerPoolSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		enabled: z.boolean(),
		origins: z.array(LoadBalancerOriginSchema),
	})
	.passthrough()
	.readonly();

/**
 * Load balancer pool with origins.
 */
export type LoadBalancerPool = z.infer<typeof LoadBalancerPoolSchema>;

/**
 * Combined load balancer with resolved pools.
 */
export type LoadBalancerWithPools = {
	readonly id: string;
	readonly name: string;
	readonly pools: readonly LoadBalancerPool[];
};
