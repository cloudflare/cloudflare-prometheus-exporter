import { Client, fetchExchange } from "@urql/core";
import Cloudflare from "cloudflare";
import DataLoader from "dataloader";
import z from "zod";
import { GraphQLError } from "../lib/errors";
import { findZoneName } from "../lib/filters";
import {
	configFromEnv,
	createLogger,
	type Logger,
	type LoggerConfig,
} from "../lib/logger";
import type { MetricDefinition } from "../lib/metrics";
import type {
	Account,
	LoadBalancerPool,
	LoadBalancerWithPools,
	SSLCertificate,
	TimeRange,
	Zone,
} from "../lib/types";
import { LoadBalancerPoolSchema } from "../lib/types";
import {
	AdaptiveMetricsQuery,
	CacheMissMetricsQuery,
	ColoErrorMetricsQuery,
	ColoMetricsQuery,
	EdgeCountryMetricsQuery,
	HealthCheckMetricsQuery,
	HTTPMetricsQuery,
	HTTPMetricsQueryNoBots,
	LoadBalancerMetricsQuery,
	LogpushAccountMetricsQuery,
	LogpushZoneMetricsQuery,
	MagicTransitMetricsQuery,
	OriginStatusMetricsQuery,
	RequestMethodMetricsQuery,
	WorkerTotalsQuery,
} from "./gql/queries";
import type { AccountLevelQuery, ZoneLevelQuery } from "./queries";

export const CLOUDFLARE_GQL_URL =
	"https://api.cloudflare.com/client/v4/graphql";

export type {
	AccountLevelQuery,
	MetricQueryName,
	ZoneLevelQuery,
} from "./queries";
// Re-export query types for consumers
export {
	ACCOUNT_LEVEL_QUERIES,
	isAccountLevelQuery,
	isZoneLevelQuery,
	MetricQueryNameSchema,
	ZONE_LEVEL_QUERIES,
} from "./queries";

const API_PAGE_SIZE = 100;

/**
 * Groups HTTP status code into category string.
 *
 * @param code HTTP status code.
 * @returns Status category string (1xx, 2xx, 3xx, 4xx, 5xx).
 */
function groupStatusCode(code: number): string {
	if (code < 200) return "1xx";
	if (code < 300) return "2xx";
	if (code < 400) return "3xx";
	if (code < 500) return "4xx";
	return "5xx";
}

/**
 * Normalizes account name for use in Prometheus labels.
 *
 * @param name Account name.
 * @returns Normalized account name (lowercase, spaces replaced with dashes).
 */
function normalizeAccountName(name: string): string {
	return name.toLowerCase().replace(/ /g, "-");
}

// Worker metric names
const WORKER_METRICS = {
	REQUESTS: "cloudflare_worker_requests_total",
	ERRORS: "cloudflare_worker_errors_total",
	CPU_TIME: "cloudflare_worker_cpu_time_seconds",
	DURATION: "cloudflare_worker_duration_seconds",
} as const;
// ### API Call Summary
//
// Most zone-level request/bandwidth/threat metrics come from **a single GraphQL call** (`HTTPMetricsQuery`). Premium metrics require separate calls.
//
// | gql.tada Query | Metrics | Notes |
// |----------------|---------|-------|
// | `HTTPMetricsQuery` | ~27 | Core zone metrics + firewall + bot detection |
// | `AdaptiveMetricsQuery` | 5 | Origin errors (4xx/5xx) + error rate |
// | `EdgeCountryMetricsQuery` | 3 | Edge status by country/host + error rate |
// | `ColoMetricsQuery` | 3 | Colo traffic |
// | `ColoErrorMetricsQuery` | 3 | Colo errors |
// | `RequestMethodMetricsQuery` | 1 | HTTP methods |
// | `HealthCheckMetricsQuery` | 2 | Health checks |
// | `WorkerTotalsQuery` | 4 | Account-level workers |
// | `LoadBalancerMetricsQuery` | 2 | LB health/requests |
// | `LogpushAccountMetricsQuery` | 1 | Account logpush |
// | `LogpushZoneMetricsQuery` | 1 | Zone logpush |
// | `MagicTransitMetricsQuery` | 4 | Tunnel health (active/healthy/failures/colos) |
// | `OriginStatusMetricsQuery` | 1 | Origin status by country/host |
//
// | SDK Call | Metrics | Notes |
// |----------|---------|-------|
// | `client.zones.list()` | 5 | Zone counts (total/filtered/processed) |
// | `client.ssl.certificatePacks.list()` | 1 | Per-zone |
// | `client.firewall.rules.list()` | - | Rule names for labels |
//

/**
 * Configuration for CloudflareMetricsClient.
 * Controls API access, scrape timing, and fetch behavior.
 */
export type CloudflareMetricsClientConfig = Readonly<{
	apiToken: string;
	queryLimit: number;
	scrapeDelaySeconds: number;
	timeWindowSeconds: number;
	loggerConfig?: LoggerConfig;
	fetch?: typeof globalThis.fetch;
}>;

/**
 * Input parameters for HTTP metrics GraphQL query.
 * Specifies time range and zones to fetch.
 */
export type HttpMetricsInput = Readonly<{
	limit: number;
	maxtime: Date;
	mintime: Date;
	zoneIds: string[];
}>;

// Workers-compatible batch scheduler
const batchScheduleFn = (cb: () => void) => queueMicrotask(cb);

/**
 * Client for fetching Cloudflare metrics via GraphQL and REST APIs.
 * Supports both account-level and zone-level queries with batching via DataLoader.
 */
export class CloudflareMetricsClient {
	private readonly api: Cloudflare;
	private readonly gql: Client;
	private readonly config: CloudflareMetricsClientConfig;
	private readonly logger: Logger;

	// DataLoader for batched parallel REST calls (firewall rules benefit from
	// batching in AccountMetricCoordinator where Promise.all fires multiple calls)
	private readonly firewallRulesLoader: DataLoader<string, Map<string, string>>;

	constructor(config: CloudflareMetricsClientConfig) {
		this.config = config;
		this.logger = createLogger("cf_api", config.loggerConfig);
		this.api = new Cloudflare({
			apiToken: config.apiToken,
			fetch: config.fetch,
		});

		this.gql = new Client({
			url: CLOUDFLARE_GQL_URL,
			preferGetMethod: false,
			exchanges: [fetchExchange],
			fetch: config.fetch,
			fetchOptions() {
				return {
					headers: {
						authorization: `Bearer ${config.apiToken}`,
					},
				};
			},
		});

		// DataLoader: firewall rules by zone ID
		// Used effectively in AccountMetricCoordinator where Promise.all
		// fires multiple getFirewallRules() calls in the same tick
		this.firewallRulesLoader = new DataLoader(
			(zoneIds) => this.batchGetFirewallRules([...zoneIds]),
			{ batchScheduleFn, cache: false },
		);
	}

	/**
	 * Fetches HTTP metrics via GraphQL (raw query, not processed).
	 * For processed metrics use getZoneMetrics with "http-metrics" query.
	 *
	 * @param input HTTP metrics input parameters.
	 * @returns Promise of raw GraphQL query result.
	 */
	async getHttpMetrics(input: HttpMetricsInput) {
		const result = await this.gql.query(HTTPMetricsQuery, {
			limit: input.limit,
			maxtime: input.maxtime.toISOString(),
			mintime: input.mintime.toISOString(),
			zoneIDs: input.zoneIds,
		});

		return result;
	}

	/**
	 * Fetches all accounts accessible by the API token.
	 *
	 * @returns Promise of accounts accessible by the API token.
	 */
	async getAccounts(): Promise<Account[]> {
		this.logger.info("Fetching accounts");
		const response = await this.api.accounts.list({ per_page: API_PAGE_SIZE });

		const accounts = response.result.map((acc) => ({
			id: acc.id,
			name: acc.name,
		}));
		this.logger.info("Accounts fetched", { count: accounts.length });
		return accounts;
	}

	/**
	 * Fetches all zones for a given account.
	 *
	 * @param accountId Cloudflare account ID.
	 * @returns Promise of zones for the account.
	 */
	async getZones(accountId: string): Promise<Zone[]> {
		this.logger.info("Fetching zones", { account_id: accountId });
		const zones: Zone[] = [];

		for await (const zone of this.api.zones.list({
			account: { id: accountId },
			per_page: API_PAGE_SIZE,
		})) {
			zones.push({
				id: zone.id,
				name: zone.name,
				status: zone.status ?? "unknown",
				plan: {
					id: zone.plan?.id ?? "",
					name: zone.plan?.name ?? "",
				},
				account: {
					id: zone.account?.id ?? "",
					name: zone.account?.name ?? "",
				},
			});
		}

		this.logger.info("Zones fetched", {
			account_id: accountId,
			count: zones.length,
		});
		return zones;
	}

	/**
	 * Fetches firewall rules for a zone via DataLoader batching.
	 * Returns map of rule ID to rule name/description.
	 *
	 * @param zoneId Cloudflare zone ID.
	 * @returns Promise of map from rule ID to rule name.
	 */
	async getFirewallRules(zoneId: string): Promise<Map<string, string>> {
		return this.firewallRulesLoader.load(zoneId);
	}

	/**
	 * Fetches firewall rules internally (without DataLoader).
	 * Fetches both traditional firewall rules and managed rulesets.
	 *
	 * @param zoneId Cloudflare zone ID.
	 * @returns Promise of map from rule ID to rule name.
	 */
	private async getFirewallRulesInternal(
		zoneId: string,
	): Promise<Map<string, string>> {
		this.logger.info("Fetching firewall rules", { zone_id: zoneId });
		const rules = new Map<string, string>();

		try {
			// Traditional firewall rules (deprecated but still used)
			for await (const rule of this.api.firewall.rules.list({
				zone_id: zoneId,
			})) {
				if (rule.id) {
					rules.set(rule.id, rule.description ?? rule.id);
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logger.error("Firewall rules API unavailable", {
				zone_id: zoneId,
				error: msg,
			});
		}

		try {
			// Managed rulesets
			const rulesets = await this.api.rulesets.list({ zone_id: zoneId });
			for (const ruleset of rulesets.result) {
				rules.set(ruleset.id, ruleset.name ?? ruleset.id);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logger.error("Rulesets API unavailable", {
				zone_id: zoneId,
				error: msg,
			});
		}

		this.logger.info("Firewall rules fetched", {
			zone_id: zoneId,
			count: rules.size,
		});
		return rules;
	}

	/**
	 * Batches firewall rule fetches for multiple zones via DataLoader.
	 *
	 * @param zoneIds Array of zone IDs.
	 * @returns Promise of array of rule maps (one per zone).
	 */
	private async batchGetFirewallRules(
		zoneIds: string[],
	): Promise<Map<string, string>[]> {
		this.logger.debug("DataLoader batch: firewall rules", {
			batch_size: zoneIds.length,
			zone_ids: zoneIds,
		});

		const results = await Promise.allSettled(
			zoneIds.map((id) => this.getFirewallRulesInternal(id)),
		);

		const fulfilled = results.filter((r) => r.status === "fulfilled").length;
		this.logger.debug("DataLoader batch complete: firewall rules", {
			batch_size: zoneIds.length,
			fulfilled,
			rejected: zoneIds.length - fulfilled,
		});

		return results.map((r, i) => {
			if (r.status === "fulfilled") return r.value;
			this.logger.warn("Firewall fetch failed", { zone_id: zoneIds[i] });
			return new Map();
		});
	}

	/**
	 * Fetches SSL certificate packs for a zone.
	 * Returns empty array on API errors.
	 *
	 * @param zoneId Cloudflare zone ID.
	 * @returns Promise of SSL certificates for the zone.
	 */
	async getSSLCertificates(zoneId: string): Promise<SSLCertificate[]> {
		this.logger.info("Fetching SSL certificates", { zone_id: zoneId });
		const certs: SSLCertificate[] = [];

		// Schema for SDK response validation - lenient to handle missing/null fields
		const CertificateSchema = z
			.object({
				id: z.string(),
				issuer: z.string().optional(),
				status: z.string().optional(),
				expires_on: z.string().optional(),
			})
			.passthrough();

		const CertPackSchema = z
			.object({
				id: z.string().optional(),
				type: z.string().optional(),
				status: z.string().optional(),
				primary_certificate: z.string().optional().nullable(), // Just the cert ID
				certificates: z.array(CertificateSchema).optional().default([]),
				hosts: z.array(z.string()).optional().default([]),
			})
			.passthrough();

		try {
			const response = await this.api.ssl.certificatePacks.list({
				zone_id: zoneId,
			});
			for (const raw of response.result) {
				const parsed = CertPackSchema.safeParse(raw);
				if (!parsed.success) {
					this.logger.debug("Invalid cert pack shape", {
						zone_id: zoneId,
						error: parsed.error.message,
						raw: JSON.stringify(raw),
					});
					continue;
				}
				const pack = parsed.data;
				for (const certData of pack.certificates) {
					certs.push({
						id: certData.id ?? pack.id ?? "",
						type: pack.type ?? "",
						status: certData.status ?? pack.status ?? "",
						issuer: certData.issuer ?? "unknown",
						expiresOn: certData.expires_on ?? "",
						hosts: pack.hosts,
					});
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logger.error("SSL API unavailable", { zone_id: zoneId, error: msg });
		}

		this.logger.info("SSL certificates fetched", {
			zone_id: zoneId,
			count: certs.length,
		});
		return certs;
	}

	/**
	 * Fetches account-level metrics for a specific query type.
	 * Each MetricExporter DO calls this directly - no batching needed since
	 * Cloudflare's accounts filter only supports single accountTag.
	 *
	 * @param query Account-level query name.
	 * @param accountId Cloudflare account ID.
	 * @param accountName Account name for metric labels.
	 * @param timeRange Shared time range for query alignment.
	 * @returns Promise of metric definitions for the account.
	 * @throws {Error} When unknown query type provided.
	 */
	async getAccountMetrics(
		query: AccountLevelQuery,
		accountId: string,
		accountName: string,
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		this.logger.info("Fetching account metrics", {
			query,
			account_id: accountId,
		});

		const normalizedAccount = normalizeAccountName(accountName);

		switch (query) {
			case "worker-totals":
				return this.getWorkerTotalsMetrics(
					accountId,
					normalizedAccount,
					timeRange,
				);
			case "logpush-account":
				return this.getLogpushAccountMetricsInternal(
					accountId,
					normalizedAccount,
					timeRange,
				);
			case "magic-transit":
				return this.getMagicTransitMetricsInternal(
					accountId,
					normalizedAccount,
					timeRange,
				);
			default: {
				const _exhaustive: never = query;
				throw new Error(`Unknown account metric query: ${_exhaustive}`);
			}
		}
	}

	/**
	 * Fetches worker totals metrics (requests, errors, CPU time, duration).
	 *
	 * @param accountId Cloudflare account ID.
	 * @param normalizedAccount Normalized account name for labels.
	 * @param timeRange Query time range.
	 * @returns Worker metrics.
	 */
	private async getWorkerTotalsMetrics(
		accountId: string,
		normalizedAccount: string,
		timeRange: { mintime: string; maxtime: string },
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(WorkerTotalsQuery, {
			accountID: accountId,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			this.logger.error("GraphQL error", { error: result.error.message });
			return [];
		}

		const metrics: MetricDefinition[] = [];
		const requestsMetric: MetricDefinition = {
			name: WORKER_METRICS.REQUESTS,
			help: "Total number of worker requests",
			type: "counter",
			values: [],
		};
		const errorsMetric: MetricDefinition = {
			name: WORKER_METRICS.ERRORS,
			help: "Total number of worker errors",
			type: "counter",
			values: [],
		};
		const cpuTimeMetric: MetricDefinition = {
			name: WORKER_METRICS.CPU_TIME,
			help: "Worker CPU time in seconds",
			type: "gauge",
			values: [],
		};
		const durationMetric: MetricDefinition = {
			name: WORKER_METRICS.DURATION,
			help: "Worker execution duration in seconds",
			type: "gauge",
			values: [],
		};

		for (const accountData of result.data?.viewer?.accounts ?? []) {
			for (const worker of accountData.workersInvocationsAdaptive ?? []) {
				const scriptName = worker.dimensions?.scriptName ?? "unknown";
				const baseLabels = {
					script_name: scriptName,
					account: normalizedAccount,
				};

				requestsMetric.values.push({
					labels: baseLabels,
					value: worker.sum?.requests ?? 0,
				});
				errorsMetric.values.push({
					labels: baseLabels,
					value: worker.sum?.errors ?? 0,
				});

				const quantiles = worker.quantiles;
				if (quantiles) {
					for (const { q, val } of [
						{ q: "P50", val: quantiles.cpuTimeP50 },
						{ q: "P75", val: quantiles.cpuTimeP75 },
						{ q: "P99", val: quantiles.cpuTimeP99 },
						{ q: "P999", val: quantiles.cpuTimeP999 },
					]) {
						if (val != null) {
							// Convert microseconds to seconds
							cpuTimeMetric.values.push({
								labels: { ...baseLabels, quantile: q },
								value: val / 1_000_000,
							});
						}
					}
					for (const { q, val } of [
						{ q: "P50", val: quantiles.durationP50 },
						{ q: "P75", val: quantiles.durationP75 },
						{ q: "P99", val: quantiles.durationP99 },
						{ q: "P999", val: quantiles.durationP999 },
					]) {
						if (val != null) {
							// Convert milliseconds to seconds
							durationMetric.values.push({
								labels: { ...baseLabels, quantile: q },
								value: val / 1000,
							});
						}
					}
				}
			}
		}

		if (requestsMetric.values.length > 0) metrics.push(requestsMetric);
		if (errorsMetric.values.length > 0) metrics.push(errorsMetric);
		if (cpuTimeMetric.values.length > 0) metrics.push(cpuTimeMetric);
		if (durationMetric.values.length > 0) metrics.push(durationMetric);

		return metrics;
	}

	/**
	 * Fetches logpush account metrics (failed jobs).
	 *
	 * @param accountId Cloudflare account ID.
	 * @param normalizedAccount Normalized account name for labels.
	 * @param timeRange Query time range.
	 * @returns Logpush account metrics.
	 */
	private async getLogpushAccountMetricsInternal(
		accountId: string,
		normalizedAccount: string,
		timeRange: { mintime: string; maxtime: string },
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(LogpushAccountMetricsQuery, {
			accountID: accountId,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			this.logger.error("GraphQL error", { error: result.error.message });
			return [];
		}

		const metric: MetricDefinition = {
			name: "cloudflare_logpush_failed_jobs_account_total",
			help: "Number of failed logpush jobs at account level",
			type: "counter",
			values: [],
		};

		for (const accountData of result.data?.viewer?.accounts ?? []) {
			for (const group of accountData.logpushHealthAdaptiveGroups ?? []) {
				metric.values.push({
					labels: {
						account: normalizedAccount,
						job_id: String(group.dimensions?.jobId ?? "unknown"),
						status: String(group.dimensions?.status ?? "unknown"),
						destination_type: group.dimensions?.destinationType ?? "unknown",
					},
					value: group.count ?? 0,
				});
			}
		}

		return metric.values.length > 0 ? [metric] : [];
	}

	/**
	 * Magic Transit tunnel health metrics (active, healthy, failures, colo count).
	 *
	 * @param accountId Cloudflare account ID.
	 * @param normalizedAccount Normalized account name for labels.
	 * @param timeRange Query time range.
	 * @returns Magic Transit tunnel metrics.
	 */
	private async getMagicTransitMetricsInternal(
		accountId: string,
		normalizedAccount: string,
		timeRange: { mintime: string; maxtime: string },
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(MagicTransitMetricsQuery, {
			accountID: accountId,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			this.logger.error("GraphQL error", { error: result.error.message });
			return [];
		}

		const activeTunnels: MetricDefinition = {
			name: "cloudflare_magic_transit_active_tunnels",
			help: "Active Magic Transit tunnels",
			type: "gauge",
			values: [],
		};
		const healthyTunnels: MetricDefinition = {
			name: "cloudflare_magic_transit_healthy_tunnels",
			help: "Healthy Magic Transit tunnels",
			type: "gauge",
			values: [],
		};
		const tunnelFailures: MetricDefinition = {
			name: "cloudflare_magic_transit_tunnel_failures",
			help: "Magic Transit tunnel failures",
			type: "gauge",
			values: [],
		};
		const edgeColoCount: MetricDefinition = {
			name: "cloudflare_magic_transit_edge_colo_count",
			help: "Edge colocations serving tunnels",
			type: "gauge",
			values: [],
		};

		for (const accountData of result.data?.viewer?.accounts ?? []) {
			const groups =
				accountData.magicTransitTunnelHealthChecksAdaptiveGroups ?? [];

			// Group by tunnel for aggregation
			const byTunnel = new Map<string, (typeof groups)[number][]>();
			for (const g of groups) {
				const key = `${g.dimensions?.tunnelName ?? ""}:${g.dimensions?.siteName ?? ""}`;
				const existing = byTunnel.get(key);
				if (existing) {
					existing.push(g);
				} else {
					byTunnel.set(key, [g]);
				}
			}

			for (const [key, tunnelGroups] of byTunnel) {
				const [tunnelName, siteName] = key.split(":");
				const labels = {
					account: normalizedAccount,
					tunnel_name: tunnelName ?? "",
					site_name: siteName ?? "",
				};

				// Active: count where active=true
				const active = tunnelGroups
					.filter((g) => String(g.dimensions?.active) === "true")
					.reduce((sum, g) => sum + (g.count ?? 0), 0);
				if (active > 0) activeTunnels.values.push({ labels, value: active });

				// Healthy: resultStatus === "healthy"
				const healthy = tunnelGroups
					.filter((g) => g.dimensions?.resultStatus === "healthy")
					.reduce((sum, g) => sum + (g.count ?? 0), 0);
				if (healthy > 0) healthyTunnels.values.push({ labels, value: healthy });

				// Failures: resultStatus !== "healthy"
				const failures = tunnelGroups
					.filter((g) => g.dimensions?.resultStatus !== "healthy")
					.reduce((sum, g) => sum + (g.count ?? 0), 0);
				if (failures > 0)
					tunnelFailures.values.push({ labels, value: failures });

				// Edge colo count: distinct colos
				const colos = new Set(
					tunnelGroups
						.map((g) => g.dimensions?.edgeColoCity)
						.filter((c): c is string => c != null && c !== ""),
				);
				if (colos.size > 0)
					edgeColoCount.values.push({ labels, value: colos.size });
			}
		}

		return [
			activeTunnels,
			healthyTunnels,
			tunnelFailures,
			edgeColoCount,
		].filter((m) => m.values.length > 0);
	}

	/**
	 * Fetches zone-level metrics for a specific query type.
	 * Requires zone IDs and zone metadata for label resolution.
	 *
	 * @param query Zone-level query name.
	 * @param zoneIds Array of Cloudflare zone IDs.
	 * @param zones Zone metadata for label mapping.
	 * @param firewallRules Map of firewall rule IDs to names.
	 * @param timeRange Shared time range for query alignment.
	 * @returns Promise of metric definitions for the zones.
	 * @throws {Error} When unknown query type provided.
	 */
	async getZoneMetrics(
		query: ZoneLevelQuery,
		zoneIds: string[],
		zones: Zone[],
		firewallRules: Record<string, string>,
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		this.logger.info("Fetching zone metrics", {
			query,
			zone_count: zoneIds.length,
		});
		const firewallMap = new Map(Object.entries(firewallRules));
		switch (query) {
			case "http-metrics":
				return this.getHttpMetricsHandler(
					zoneIds,
					zones,
					firewallMap,
					timeRange,
				);
			case "adaptive-metrics":
				return this.getAdaptiveMetrics(zoneIds, zones, timeRange);
			case "edge-country-metrics":
				return this.getEdgeCountryMetrics(zoneIds, zones, timeRange);
			case "colo-metrics":
				return this.getColoMetrics(zoneIds, zones, timeRange);
			case "colo-error-metrics":
				return this.getColoErrorMetrics(zoneIds, zones, timeRange);
			case "request-method-metrics":
				return this.getRequestMethodMetrics(zoneIds, zones, timeRange);
			case "health-check-metrics":
				return this.getHealthCheckMetrics(zoneIds, zones, timeRange);
			case "load-balancer-metrics":
				return this.getLoadBalancerMetrics(zoneIds, zones, timeRange);
			case "logpush-zone":
				return this.getLogpushZoneMetrics(zoneIds, zones, timeRange);
			case "origin-status-metrics":
				return this.getOriginStatusMetrics(zoneIds, zones, timeRange);
			case "cache-miss-metrics":
				return this.getCacheMissMetrics(zoneIds, zones, timeRange);
			case "ssl-certificates":
				return this.getSSLCertificateMetrics(zones);
			case "lb-weight-metrics":
				return this.getLbWeightMetrics(zones);
			default: {
				const _exhaustive: never = query;
				throw new Error(`Unknown zone metric query: ${_exhaustive}`);
			}
		}
	}

	/**
	 * Extracts ~27 metrics from HTTPMetricsQuery.
	 * Including requests, bandwidth, threats, pageviews, uniques, firewall events, and bot detection.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param firewallRules Map of rule IDs to names for labels.
	 * @param timeRange Time range for the query.
	 * @returns HTTP metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getHttpMetricsHandler(
		zoneIds: string[],
		zones: Zone[],
		firewallRules: Map<string, string>,
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const queryVars = {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		};

		let result = await this.gql.query(HTTPMetricsQuery, queryVars);

		// Fallback to query without bot fields if zone lacks Bot Management
		if (result.error?.message.includes("does not have access to the field")) {
			this.logger.warn(
				"Bot fields unavailable for some zones, retrying without bot metrics",
			);
			result = await this.gql.query(HTTPMetricsQueryNoBots, queryVars);
		}

		// Safety net: free tier zones should be filtered upstream, but handle gracefully
		if (result.error?.message.includes("does not have access to the path")) {
			this.logger.error(
				"Zone(s) lack GraphQL analytics access - ensure free tier zones are filtered",
				{ error: result.error.message },
			);
			return [];
		}

		if (result.error) {
			throw new GraphQLError(
				`GraphQL error: ${result.error.message}`,
				result.error.graphQLErrors ?? [],
				{ context: { query: "http-metrics", zone_count: zoneIds.length } },
			);
		}

		// Initialize all metric definitions
		const requestsTotal: MetricDefinition = {
			name: "cloudflare_zone_requests_total",
			help: "Total requests",
			type: "counter",
			values: [],
		};
		const requestsCached: MetricDefinition = {
			name: "cloudflare_zone_requests_cached",
			help: "Cached requests",
			type: "gauge",
			values: [],
		};
		const requestsSsl: MetricDefinition = {
			name: "cloudflare_zone_requests_ssl_encrypted_total",
			help: "SSL encrypted requests",
			type: "counter",
			values: [],
		};
		const requestsContentType: MetricDefinition = {
			name: "cloudflare_zone_requests_content_type_total",
			help: "Requests by content type",
			type: "counter",
			values: [],
		};
		const requestsCountry: MetricDefinition = {
			name: "cloudflare_zone_requests_country_total",
			help: "Requests by country",
			type: "counter",
			values: [],
		};
		const requestsStatus: MetricDefinition = {
			name: "cloudflare_zone_requests_status_total",
			help: "Requests by status code group",
			type: "counter",
			values: [],
		};
		const requestsBrowser: MetricDefinition = {
			name: "cloudflare_zone_requests_browser_map_page_views_total",
			help: "Page views by browser family",
			type: "counter",
			values: [],
		};

		const bandwidthTotal: MetricDefinition = {
			name: "cloudflare_zone_bandwidth_total",
			help: "Total bandwidth bytes",
			type: "counter",
			values: [],
		};
		const bandwidthCached: MetricDefinition = {
			name: "cloudflare_zone_bandwidth_cached_total",
			help: "Cached bandwidth bytes",
			type: "counter",
			values: [],
		};
		const bandwidthSsl: MetricDefinition = {
			name: "cloudflare_zone_bandwidth_ssl_encrypted_total",
			help: "SSL encrypted bandwidth bytes",
			type: "counter",
			values: [],
		};
		const bandwidthContentType: MetricDefinition = {
			name: "cloudflare_zone_bandwidth_content_type_total",
			help: "Bandwidth by content type",
			type: "counter",
			values: [],
		};
		const bandwidthCountry: MetricDefinition = {
			name: "cloudflare_zone_bandwidth_country_total",
			help: "Bandwidth by country",
			type: "counter",
			values: [],
		};

		const threatsTotal: MetricDefinition = {
			name: "cloudflare_zone_threats_total",
			help: "Total threats",
			type: "counter",
			values: [],
		};
		const threatsCountry: MetricDefinition = {
			name: "cloudflare_zone_threats_country_total",
			help: "Threats by country",
			type: "counter",
			values: [],
		};
		const threatsType: MetricDefinition = {
			name: "cloudflare_zone_threats_type_total",
			help: "Threats by type",
			type: "counter",
			values: [],
		};

		const pageviewsTotal: MetricDefinition = {
			name: "cloudflare_zone_pageviews_total",
			help: "Total pageviews",
			type: "counter",
			values: [],
		};
		const uniquesTotal: MetricDefinition = {
			name: "cloudflare_zone_uniques_total",
			help: "Unique visitors",
			type: "counter",
			values: [],
		};

		const firewallEvents: MetricDefinition = {
			name: "cloudflare_zone_firewall_events_total",
			help: "Firewall events",
			type: "counter",
			values: [],
		};

		const requestsIpClass: MetricDefinition = {
			name: "cloudflare_zone_requests_ip_class_total",
			help: "Requests by IP classification",
			type: "counter",
			values: [],
		};

		const requestsSslProtocol: MetricDefinition = {
			name: "cloudflare_zone_requests_ssl_protocol_total",
			help: "Requests by SSL/TLS protocol version",
			type: "counter",
			values: [],
		};

		const requestsHttpVersion: MetricDefinition = {
			name: "cloudflare_zone_requests_http_version_total",
			help: "Requests by HTTP protocol version",
			type: "counter",
			values: [],
		};

		const botsDetected: MetricDefinition = {
			name: "cloudflare_zone_firewall_bots_detected_total",
			help: "Bot requests detected by score bucket",
			type: "counter",
			values: [],
		};

		const botByCountry: MetricDefinition = {
			name: "cloudflare_zone_bot_requests_by_country_total",
			help: "Bot requests by country",
			type: "counter",
			values: [],
		};

		const cacheHitRatio: MetricDefinition = {
			name: "cloudflare_zone_cache_hit_ratio",
			help: "Cache hit ratio",
			type: "gauge",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);
			const baseLabels = { zone: zoneName };

			// httpRequests1mGroups may have multiple groups, aggregate first one
			const group = zoneData.httpRequests1mGroups?.[0];
			if (!group) continue;

			const sum = group.sum;
			const uniq = group.uniq;

			// Basic metrics
			if (sum?.requests != null) {
				requestsTotal.values.push({ labels: baseLabels, value: sum.requests });
			}
			if (sum?.cachedRequests != null) {
				requestsCached.values.push({
					labels: baseLabels,
					value: sum.cachedRequests,
				});
			}
			if (sum?.encryptedRequests != null) {
				requestsSsl.values.push({
					labels: baseLabels,
					value: sum.encryptedRequests,
				});
			}
			if (sum?.bytes != null) {
				bandwidthTotal.values.push({ labels: baseLabels, value: sum.bytes });
			}
			if (sum?.cachedBytes != null) {
				bandwidthCached.values.push({
					labels: baseLabels,
					value: sum.cachedBytes,
				});
			}
			if (sum?.encryptedBytes != null) {
				bandwidthSsl.values.push({
					labels: baseLabels,
					value: sum.encryptedBytes,
				});
			}
			if (sum?.threats != null) {
				threatsTotal.values.push({ labels: baseLabels, value: sum.threats });
			}
			if (sum?.pageViews != null) {
				pageviewsTotal.values.push({
					labels: baseLabels,
					value: sum.pageViews,
				});
			}
			if (uniq?.uniques != null) {
				uniquesTotal.values.push({ labels: baseLabels, value: uniq.uniques });
			}

			// Cache hit ratio
			const requests = sum?.requests ?? 0;
			const cached = sum?.cachedRequests ?? 0;
			if (requests > 0) {
				cacheHitRatio.values.push({
					labels: baseLabels,
					value: cached / requests,
				});
			}

			// Content type breakdown
			for (const ct of sum?.contentTypeMap ?? []) {
				const labels = {
					...baseLabels,
					content_type: ct.edgeResponseContentTypeName ?? "",
				};
				if (ct.requests != null) {
					requestsContentType.values.push({ labels, value: ct.requests });
				}
				if (ct.bytes != null) {
					bandwidthContentType.values.push({ labels, value: ct.bytes });
				}
			}

			// Country breakdown
			for (const c of sum?.countryMap ?? []) {
				const labels = { ...baseLabels, country: c.clientCountryName ?? "" };
				if (c.requests != null) {
					requestsCountry.values.push({ labels, value: c.requests });
				}
				if (c.bytes != null) {
					bandwidthCountry.values.push({ labels, value: c.bytes });
				}
				if (c.threats != null && c.threats > 0) {
					threatsCountry.values.push({ labels, value: c.threats });
				}
			}

			// Status code breakdown (with grouping)
			const statusGroups: Record<string, number> = {};
			for (const s of sum?.responseStatusMap ?? []) {
				const groupedStatus = groupStatusCode(s.edgeResponseStatus ?? 0);
				statusGroups[groupedStatus] =
					(statusGroups[groupedStatus] ?? 0) + (s.requests ?? 0);
			}
			for (const [status, count] of Object.entries(statusGroups)) {
				requestsStatus.values.push({
					labels: { ...baseLabels, status },
					value: count,
				});
			}

			// Browser breakdown
			for (const b of sum?.browserMap ?? []) {
				if (b.pageViews != null && b.pageViews > 0) {
					requestsBrowser.values.push({
						labels: { ...baseLabels, family: b.uaBrowserFamily ?? "" },
						value: b.pageViews,
					});
				}
			}

			// Threat types
			for (const t of sum?.threatPathingMap ?? []) {
				if (t.requests != null && t.requests > 0) {
					threatsType.values.push({
						labels: { ...baseLabels, type: t.threatPathingName ?? "" },
						value: t.requests,
					});
				}
			}

			// IP class breakdown
			for (const ip of sum?.ipClassMap ?? []) {
				if (ip.requests != null && ip.requests > 0) {
					requestsIpClass.values.push({
						labels: { ...baseLabels, ip_type: ip.ipType ?? "" },
						value: ip.requests,
					});
				}
			}

			// SSL protocol breakdown
			for (const ssl of sum?.clientSSLMap ?? []) {
				if (ssl.requests != null && ssl.requests > 0) {
					requestsSslProtocol.values.push({
						labels: {
							...baseLabels,
							ssl_protocol: ssl.clientSSLProtocol ?? "",
						},
						value: ssl.requests,
					});
				}
			}

			// HTTP version breakdown
			for (const http of sum?.clientHTTPVersionMap ?? []) {
				if (http.requests != null && http.requests > 0) {
					requestsHttpVersion.values.push({
						labels: {
							...baseLabels,
							http_version: http.clientHTTPProtocol ?? "",
						},
						value: http.requests,
					});
				}
			}

			// Firewall events and bot detection
			for (const fw of zoneData.firewallEventsAdaptiveGroups ?? []) {
				const dim = fw.dimensions;
				const ruleId = dim?.ruleId ?? "";
				const ruleName = firewallRules.get(ruleId) ?? ruleId;
				const count = fw.count ?? 0;

				if (count > 0) {
					firewallEvents.values.push({
						labels: {
							...baseLabels,
							action: dim?.action ?? "",
							source: dim?.source ?? "",
							rule: ruleName,
							host: dim?.clientRequestHTTPHost ?? "",
							country: dim?.clientCountryName ?? "",
						},
						value: count,
					});

					// Bot detection: score < 30 = likely bot
					const botScore = dim?.botScore;
					if (botScore != null && botScore < 30) {
						const scoreBucket = botScore < 10 ? "0-9" : "10-29";

						botsDetected.values.push({
							labels: {
								...baseLabels,
								bot_score: scoreBucket,
								detection_source: dim?.botScoreSrcName ?? "unknown",
							},
							value: count,
						});

						botByCountry.values.push({
							labels: {
								...baseLabels,
								country: dim?.clientCountryName ?? "",
							},
							value: count,
						});
					}
				}
			}
		}

		// Return only non-empty metrics
		return [
			requestsTotal,
			requestsCached,
			requestsSsl,
			requestsContentType,
			requestsCountry,
			requestsStatus,
			requestsBrowser,
			requestsIpClass,
			requestsSslProtocol,
			requestsHttpVersion,
			bandwidthTotal,
			bandwidthCached,
			bandwidthSsl,
			bandwidthContentType,
			bandwidthCountry,
			threatsTotal,
			threatsCountry,
			threatsType,
			pageviewsTotal,
			uniquesTotal,
			firewallEvents,
			botsDetected,
			botByCountry,
			cacheHitRatio,
		].filter((m) => m.values.length > 0);
	}

	/**
	 * Origin error rates (4xx/5xx), response duration, and error rate gauge.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Origin error metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getAdaptiveMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(AdaptiveMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const error4xx: MetricDefinition = {
			name: "cloudflare_zone_customer_error_4xx_total",
			help: "4xx error requests",
			type: "counter",
			values: [],
		};
		const error5xx: MetricDefinition = {
			name: "cloudflare_zone_customer_error_5xx_total",
			help: "5xx error requests",
			type: "counter",
			values: [],
		};
		const originDuration: MetricDefinition = {
			name: "cloudflare_zone_origin_response_duration_seconds",
			help: "Origin response duration in seconds",
			type: "gauge",
			values: [],
		};
		const originErrorRate: MetricDefinition = {
			name: "cloudflare_zone_origin_error_rate",
			help: "Origin error rate (4xx+5xx / total origin errors)",
			type: "gauge",
			values: [],
		};

		// Track totals for error rate calculation
		const zoneStats: Record<string, { errors4xx: number; errors5xx: number }> =
			{};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				const status = dim?.originResponseStatus ?? 0;
				const count = group.count ?? 0;
				const labels = {
					zone: zoneName,
					status: String(status),
					country: dim?.clientCountryName ?? "",
					host: dim?.clientRequestHTTPHost ?? "",
				};

				if (status >= 400 && status < 500 && count > 0) {
					error4xx.values.push({ labels, value: count });
					if (!zoneStats[zoneName]) {
						zoneStats[zoneName] = { errors4xx: 0, errors5xx: 0 };
					}
					zoneStats[zoneName].errors4xx += count;
				} else if (status >= 500 && count > 0) {
					error5xx.values.push({ labels, value: count });
					if (!zoneStats[zoneName]) {
						zoneStats[zoneName] = { errors4xx: 0, errors5xx: 0 };
					}
					zoneStats[zoneName].errors5xx += count;
				}

				const avgDuration = group.avg?.originResponseDurationMs;
				if (avgDuration != null) {
					// Convert milliseconds to seconds
					originDuration.values.push({ labels, value: avgDuration / 1000 });
				}
			}
		}

		// Emit origin error rate (ratio of 5xx to total errors)
		for (const [zone, stats] of Object.entries(zoneStats)) {
			const total = stats.errors4xx + stats.errors5xx;
			if (total > 0) {
				originErrorRate.values.push({
					labels: { zone },
					value: stats.errors5xx / total,
				});
			}
		}

		return [error4xx, error5xx, originDuration, originErrorRate].filter(
			(m) => m.values.length > 0,
		);
	}

	/**
	 * Requests by edge status, country, host, and edge error rate gauge.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Edge status metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getEdgeCountryMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(EdgeCountryMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const statusCountryHost: MetricDefinition = {
			name: "cloudflare_zone_requests_status_country_host_total",
			help: "Edge status by country and host",
			type: "counter",
			values: [],
		};

		const edgeErrorRate: MetricDefinition = {
			name: "cloudflare_zone_edge_error_rate",
			help: "Edge error rate (4xx+5xx / total)",
			type: "gauge",
			values: [],
		};

		// Aggregate for error rate calculation
		const zoneStats: Record<string, { total: number; errors: number }> = {};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsEdgeCountryHost ?? []) {
				const dim = group.dimensions;
				const status = dim?.edgeResponseStatus ?? 0;
				const count = group.count ?? 0;

				if (count > 0) {
					statusCountryHost.values.push({
						labels: {
							zone: zoneName,
							edge_status: String(status),
							country: dim?.clientCountryName ?? "",
							host: dim?.clientRequestHTTPHost ?? "",
						},
						value: count,
					});

					// Aggregate for error rate
					if (!zoneStats[zoneName]) {
						zoneStats[zoneName] = { total: 0, errors: 0 };
					}
					zoneStats[zoneName].total += count;
					if (status >= 400) {
						zoneStats[zoneName].errors += count;
					}
				}
			}
		}

		// Emit error rate gauges
		for (const [zone, stats] of Object.entries(zoneStats)) {
			if (stats.total > 0) {
				edgeErrorRate.values.push({
					labels: { zone },
					value: stats.errors / stats.total,
				});
			}
		}

		return [statusCountryHost, edgeErrorRate].filter(
			(m) => m.values.length > 0,
		);
	}

	/**
	 * Visits, response bytes, requests per colo.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Colo metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getColoMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(ColoMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const visits: MetricDefinition = {
			name: "cloudflare_zone_colocation_visits_total",
			help: "Visits per colo",
			type: "counter",
			values: [],
		};
		const responseBytes: MetricDefinition = {
			name: "cloudflare_zone_colocation_edge_response_bytes_total",
			help: "Edge response bytes per colo",
			type: "counter",
			values: [],
		};
		const requestsTotal: MetricDefinition = {
			name: "cloudflare_zone_colocation_requests_total",
			help: "Requests per colo",
			type: "counter",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				const labels = {
					zone: zoneName,
					colo: dim?.coloCode ?? "",
					host: dim?.clientRequestHTTPHost ?? "",
				};

				const visitsValue = group.sum?.visits;
				if (visitsValue != null && visitsValue > 0) {
					visits.values.push({ labels, value: visitsValue });
				}

				const bytesValue = group.sum?.edgeResponseBytes;
				if (bytesValue != null && bytesValue > 0) {
					responseBytes.values.push({ labels, value: bytesValue });
				}

				if (group.count != null && group.count > 0) {
					requestsTotal.values.push({ labels, value: group.count });
				}
			}
		}

		return [visits, responseBytes, requestsTotal].filter(
			(m) => m.values.length > 0,
		);
	}

	/**
	 * Error visits, bytes, requests per colo (4xx+).
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Colo error metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getColoErrorMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(ColoErrorMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const visitsError: MetricDefinition = {
			name: "cloudflare_zone_colocation_error_visits_total",
			help: "Error visits per colo",
			type: "counter",
			values: [],
		};
		const responseBytesError: MetricDefinition = {
			name: "cloudflare_zone_colocation_error_edge_response_bytes_total",
			help: "Error response bytes per colo",
			type: "counter",
			values: [],
		};
		const requestsError: MetricDefinition = {
			name: "cloudflare_zone_colocation_error_requests_total",
			help: "Error requests per colo",
			type: "counter",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				const labels = {
					zone: zoneName,
					colo: dim?.coloCode ?? "",
					host: dim?.clientRequestHTTPHost ?? "",
					status: String(dim?.edgeResponseStatus ?? 0),
				};

				const visitsValue = group.sum?.visits;
				if (visitsValue != null && visitsValue > 0) {
					visitsError.values.push({ labels, value: visitsValue });
				}

				const bytesValue = group.sum?.edgeResponseBytes;
				if (bytesValue != null && bytesValue > 0) {
					responseBytesError.values.push({ labels, value: bytesValue });
				}

				if (group.count != null && group.count > 0) {
					requestsError.values.push({ labels, value: group.count });
				}
			}
		}

		return [visitsError, responseBytesError, requestsError].filter(
			(m) => m.values.length > 0,
		);
	}

	/**
	 * Requests by HTTP method.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Request method metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getRequestMethodMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(RequestMethodMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const methodCount: MetricDefinition = {
			name: "cloudflare_zone_requests_by_method_total",
			help: "Requests by HTTP method",
			type: "counter",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsAdaptiveGroups ?? []) {
				if (group.count != null && group.count > 0) {
					methodCount.values.push({
						labels: {
							zone: zoneName,
							method: group.dimensions?.clientRequestHTTPMethodName ?? "",
						},
						value: group.count,
					});
				}
			}
		}

		return methodCount.values.length > 0 ? [methodCount] : [];
	}

	/**
	 * Events per origin with timing metrics (RTT, TTFB, TCP, TLS).
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Health check metrics.
	 * @throws {GraphQLError} When GraphQL query fails.
	 */
	private async getHealthCheckMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(HealthCheckMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new GraphQLError(
				"Failed to fetch health check metrics",
				result.error.graphQLErrors ?? [],
				{ context: { zone_ids: zoneIds } },
			);
		}

		const eventsOrigin: MetricDefinition = {
			name: "cloudflare_zone_health_check_events_origin_total",
			help: "Health check events per origin",
			type: "counter",
			values: [],
		};
		const eventsAvg: MetricDefinition = {
			name: "cloudflare_zone_health_check_events_avg",
			help: "Average health check events",
			type: "gauge",
			values: [],
		};
		const healthCheckRtt: MetricDefinition = {
			name: "cloudflare_zone_health_check_rtt_seconds",
			help: "Health check RTT to origin in seconds",
			type: "gauge",
			values: [],
		};
		const healthCheckTtfb: MetricDefinition = {
			name: "cloudflare_zone_health_check_ttfb_seconds",
			help: "Health check time to first byte in seconds",
			type: "gauge",
			values: [],
		};
		const healthCheckTcpConn: MetricDefinition = {
			name: "cloudflare_zone_health_check_tcp_connection_seconds",
			help: "Health check TCP connection time in seconds",
			type: "gauge",
			values: [],
		};
		const healthCheckTlsHandshake: MetricDefinition = {
			name: "cloudflare_zone_health_check_tls_handshake_seconds",
			help: "Health check TLS handshake time in seconds",
			type: "gauge",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);
			let totalEvents = 0;
			let groupCount = 0;

			for (const group of zoneData.healthCheckEventsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				const avg = group.avg;

				if (group.count != null && group.count > 0) {
					eventsOrigin.values.push({
						labels: {
							zone: zoneName,
							health_status: dim?.healthStatus ?? "",
							origin_ip: dim?.originIP ?? "",
							region: dim?.region ?? "",
							fqdn: dim?.fqdn ?? "",
							failure_reason: dim?.failureReason ?? "",
						},
						value: group.count,
					});
					totalEvents += group.count;
					groupCount++;

					// Timing metrics
					const baseLabels = {
						zone: zoneName,
						origin_ip: dim?.originIP ?? "",
						fqdn: dim?.fqdn ?? "",
					};

					if (avg?.rttMs != null) {
						// Convert milliseconds to seconds
						healthCheckRtt.values.push({
							labels: baseLabels,
							value: avg.rttMs / 1000,
						});
					}
					if (avg?.timeToFirstByteMs != null) {
						// Convert milliseconds to seconds
						healthCheckTtfb.values.push({
							labels: baseLabels,
							value: avg.timeToFirstByteMs / 1000,
						});
					}
					if (avg?.tcpConnMs != null) {
						// Convert milliseconds to seconds
						healthCheckTcpConn.values.push({
							labels: baseLabels,
							value: avg.tcpConnMs / 1000,
						});
					}
					if (avg?.tlsHandshakeMs != null) {
						// Convert milliseconds to seconds
						healthCheckTlsHandshake.values.push({
							labels: baseLabels,
							value: avg.tlsHandshakeMs / 1000,
						});
					}
				}
			}

			if (groupCount > 0) {
				eventsAvg.values.push({
					labels: { zone: zoneName },
					value: totalEvents / groupCount,
				});
			}
		}

		return [
			eventsOrigin,
			eventsAvg,
			healthCheckRtt,
			healthCheckTtfb,
			healthCheckTcpConn,
			healthCheckTlsHandshake,
		].filter((m) => m.values.length > 0);
	}

	/**
	 * Pool health, requests, RTT, steering policy, and origins selected.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Load balancer metrics.
	 * @throws {GraphQLError} When GraphQL query fails.
	 */
	private async getLoadBalancerMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(LoadBalancerMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new GraphQLError(
				"Failed to fetch load balancer metrics",
				result.error.graphQLErrors ?? [],
				{ context: { zone_ids: zoneIds } },
			);
		}

		const poolHealth: MetricDefinition = {
			name: "cloudflare_zone_pool_health_status",
			help: "Pool health (1=healthy, 0=unhealthy)",
			type: "gauge",
			values: [],
		};
		const poolRequests: MetricDefinition = {
			name: "cloudflare_zone_pool_requests_total",
			help: "Requests per pool",
			type: "counter",
			values: [],
		};
		const poolRtt: MetricDefinition = {
			name: "cloudflare_zone_lb_pool_rtt_seconds",
			help: "Load balancer pool RTT in seconds",
			type: "gauge",
			values: [],
		};
		const steeringPolicyInfo: MetricDefinition = {
			name: "cloudflare_zone_lb_steering_policy_info",
			help: "Load balancer steering policy (info metric)",
			type: "gauge",
			values: [],
		};
		const originsSelectedCount: MetricDefinition = {
			name: "cloudflare_zone_lb_origins_selected_count",
			help: "Number of origins selected per load balancer request",
			type: "gauge",
			values: [],
		};

		// Track seen policies to dedupe info metric
		const seenPolicies = new Set<string>();

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			// Pool requests, RTT, steering policy, origins selected from groups
			for (const group of zoneData.loadBalancingRequestsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				if (group.count != null && group.count > 0) {
					poolRequests.values.push({
						labels: {
							zone: zoneName,
							lb_name: dim?.lbName ?? "",
							pool_name: dim?.selectedPoolName ?? "",
							origin_name: dim?.selectedOriginName ?? "",
						},
						value: group.count,
					});

					// Pool RTT - convert milliseconds to seconds
					if (
						dim?.selectedPoolAvgRttMs != null &&
						dim.selectedPoolAvgRttMs > 0
					) {
						poolRtt.values.push({
							labels: {
								zone: zoneName,
								lb_name: dim?.lbName ?? "",
								pool_name: dim?.selectedPoolName ?? "",
							},
							value: dim.selectedPoolAvgRttMs / 1000,
						});
					}

					// Origins selected count
					if (dim?.numberOriginsSelected != null) {
						originsSelectedCount.values.push({
							labels: {
								zone: zoneName,
								lb_name: dim?.lbName ?? "",
								pool_name: dim?.selectedPoolName ?? "",
							},
							value: dim.numberOriginsSelected,
						});
					}

					// Steering policy info (dedupe by zone:lb_name)
					const policyKey = `${zoneName}:${dim?.lbName}`;
					if (!seenPolicies.has(policyKey) && dim?.steeringPolicy) {
						seenPolicies.add(policyKey);
						steeringPolicyInfo.values.push({
							labels: {
								zone: zoneName,
								lb_name: dim?.lbName ?? "",
								policy: dim.steeringPolicy,
							},
							value: 1,
						});
					}
				}
			}

			// Pool health from adaptive
			for (const lb of zoneData.loadBalancingRequestsAdaptive ?? []) {
				for (const pool of lb.pools ?? []) {
					poolHealth.values.push({
						labels: {
							zone: zoneName,
							lb_name: lb.lbName ?? "",
							pool_name: pool.poolName ?? "",
						},
						value: pool.healthy ? 1 : 0,
					});
				}
			}
		}

		return [
			poolHealth,
			poolRequests,
			poolRtt,
			steeringPolicyInfo,
			originsSelectedCount,
		].filter((m) => m.values.length > 0);
	}

	/**
	 * Failed jobs per zone.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Logpush zone metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getLogpushZoneMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(LogpushZoneMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const failedJobs: MetricDefinition = {
			name: "cloudflare_logpush_failed_jobs_zone_total",
			help: "Failed logpush jobs per zone",
			type: "counter",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.logpushHealthAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				if (group.count != null && group.count > 0) {
					failedJobs.values.push({
						labels: {
							zone: zoneName,
							job_id: String(dim?.jobId ?? ""),
							destination_type: dim?.destinationType ?? "",
						},
						value: group.count,
					});
				}
			}
		}

		return failedJobs.values.length > 0 ? [failedJobs] : [];
	}

	/**
	 * Origin responses by status, country, and host.
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Origin status metrics.
	 * @throws {Error} When GraphQL query fails.
	 */
	private async getOriginStatusMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(OriginStatusMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new Error(`GraphQL error: ${result.error.message}`);
		}

		const originStatusCountryHost: MetricDefinition = {
			name: "cloudflare_zone_requests_origin_status_country_host_total",
			help: "Requests by origin status, country, and host",
			type: "counter",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				const count = group.count ?? 0;
				if (count > 0) {
					originStatusCountryHost.values.push({
						labels: {
							zone: zoneName,
							origin_status: String(dim?.originResponseStatus ?? 0),
							country: dim?.clientCountryName ?? "",
							host: dim?.clientRequestHTTPHost ?? "",
						},
						value: count,
					});
				}
			}
		}

		return originStatusCountryHost.values.length > 0
			? [originStatusCountryHost]
			: [];
	}

	/**
	 * Cache miss origin response duration (rt_miss equivalent).
	 *
	 * @param zoneIds Zone IDs to query.
	 * @param zones Zone metadata for label mapping.
	 * @param timeRange Time range for the query.
	 * @returns Cache miss metrics.
	 * @throws {GraphQLError} When GraphQL query fails.
	 */
	private async getCacheMissMetrics(
		zoneIds: string[],
		zones: Zone[],
		timeRange: TimeRange,
	): Promise<MetricDefinition[]> {
		const result = await this.gql.query(CacheMissMetricsQuery, {
			zoneIDs: zoneIds,
			mintime: timeRange.mintime,
			maxtime: timeRange.maxtime,
			limit: this.config.queryLimit,
		});

		if (result.error) {
			throw new GraphQLError(
				"Failed to fetch cache miss metrics",
				result.error.graphQLErrors ?? [],
				{ context: { zone_ids: zoneIds } },
			);
		}

		const cacheMissDuration: MetricDefinition = {
			name: "cloudflare_zone_cache_miss_origin_duration_seconds",
			help: "Average origin response duration on cache miss in seconds",
			type: "gauge",
			values: [],
		};

		for (const zoneData of result.data?.viewer?.zones ?? []) {
			const zoneName = findZoneName(zoneData.zoneTag, zones);

			for (const group of zoneData.httpRequestsAdaptiveGroups ?? []) {
				const dim = group.dimensions;
				const avgDuration = group.avg?.originResponseDurationMs;

				if (avgDuration != null && group.count != null && group.count > 0) {
					// Convert milliseconds to seconds
					cacheMissDuration.values.push({
						labels: {
							zone: zoneName,
							country: dim?.clientCountryName ?? "",
							host: dim?.clientRequestHTTPHost ?? "",
						},
						value: avgDuration / 1000,
					});
				}
			}
		}

		return cacheMissDuration.values.length > 0 ? [cacheMissDuration] : [];
	}

	/**
	 * Fetches load balancer configs for a zone.
	 *
	 * @param zoneId Cloudflare zone ID.
	 * @param accountId Cloudflare account ID.
	 * @returns Promise of load balancer configs with pools.
	 */
	async getLoadBalancerConfigs(
		zoneId: string,
		accountId: string,
	): Promise<LoadBalancerWithPools[]> {
		this.logger.info("Fetching load balancer configs", { zone_id: zoneId });
		const configs: LoadBalancerWithPools[] = [];

		try {
			// Get load balancers
			for await (const lb of this.api.loadBalancers.list({ zone_id: zoneId })) {
				if (!lb.id || !lb.name) continue;

				const poolIds = lb.default_pools ?? [];

				// Fetch all pools in parallel
				const poolResults = await Promise.allSettled(
					poolIds.map((poolId) =>
						this.api.loadBalancers.pools.get(poolId, { account_id: accountId }),
					),
				);

				const pools: LoadBalancerPool[] = [];
				poolResults.forEach((result, i) => {
					const poolId = poolIds[i] ?? "unknown";

					if (result.status === "rejected") {
						const msg =
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason);
						this.logger.warn("Failed to fetch pool", {
							pool_id: poolId,
							error: msg,
						});
						return;
					}

					const parsed = LoadBalancerPoolSchema.safeParse(result.value);
					if (parsed.success) {
						pools.push(parsed.data);
					} else {
						this.logger.debug("Invalid pool schema", {
							pool_id: poolId,
							error: parsed.error.message,
						});
					}
				});

				configs.push({
					id: lb.id,
					name: lb.name,
					pools,
				});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error("Load balancers API unavailable", {
				zone_id: zoneId,
				error: msg,
			});
			// Return empty array on failure - graceful degradation
		}

		this.logger.info("Load balancer configs fetched", {
			zone_id: zoneId,
			count: configs.length,
		});
		return configs;
	}

	/**
	 * Load balancer origin weight metric from REST API.
	 *
	 * @param zones Zone metadata.
	 * @returns LB weight metrics.
	 */
	private async getLbWeightMetrics(zones: Zone[]): Promise<MetricDefinition[]> {
		const originWeight: MetricDefinition = {
			name: "cloudflare_zone_lb_origin_weight",
			help: "Load balancer origin weight (0-1 normalized)",
			type: "gauge",
			values: [],
		};

		for (const zone of zones) {
			const lbConfigs = await this.getLoadBalancerConfigs(
				zone.id,
				zone.account.id,
			);

			for (const lb of lbConfigs) {
				for (const pool of lb.pools) {
					for (const origin of pool.origins) {
						if (origin.enabled) {
							originWeight.values.push({
								labels: {
									zone: zone.name,
									lb_name: lb.name,
									pool_name: pool.name,
									origin_name: origin.name,
								},
								value: origin.weight,
							});
						}
					}
				}
			}
		}

		return originWeight.values.length > 0 ? [originWeight] : [];
	}

	/**
	 * Certificate expiry timestamps (batched).
	 *
	 * @param zones Zone metadata.
	 * @returns SSL certificate metrics.
	 */
	private async getSSLCertificateMetrics(
		zones: Zone[],
	): Promise<MetricDefinition[]> {
		const certStatus: MetricDefinition = {
			name: "cloudflare_zone_certificate_validation_status",
			help: "Certificate expiry timestamp",
			type: "gauge",
			values: [],
		};

		// Fetch all certs in parallel via DataLoader batching
		const certsResults = await Promise.all(
			zones.map((zone) =>
				this.getSSLCertificates(zone.id)
					.then((certs) => ({ zone, certs }))
					.catch(() => {
						this.logger.warn("Failed to fetch SSL certs", { zone: zone.name });
						return { zone, certs: [] as SSLCertificate[] };
					}),
			),
		);

		for (const { zone, certs } of certsResults) {
			for (const cert of certs) {
				const expiresOn = cert.expiresOn
					? new Date(cert.expiresOn).getTime() / 1000
					: 0;
				certStatus.values.push({
					labels: {
						zone: zone.name,
						type: cert.type,
						issuer: cert.issuer,
						status: cert.status,
					},
					value: expiresOn,
				});
			}
		}

		return certStatus.values.length > 0 ? [certStatus] : [];
	}

	/**
	 * Fetches SSL certificate metrics for a single zone.
	 * Used by zone-scoped MetricExporter DOs.
	 *
	 * @param zone Zone metadata.
	 * @returns Promise of SSL certificate metrics.
	 */
	async getSSLCertificateMetricsForZone(
		zone: Zone,
	): Promise<MetricDefinition[]> {
		this.logger.info("Fetching SSL certificate metrics for zone", {
			zone: zone.name,
		});

		const certStatus: MetricDefinition = {
			name: "cloudflare_zone_certificate_validation_status",
			help: "Certificate expiry timestamp",
			type: "gauge",
			values: [],
		};

		try {
			const certs = await this.getSSLCertificates(zone.id);
			for (const cert of certs) {
				const expiresOn = cert.expiresOn
					? new Date(cert.expiresOn).getTime() / 1000
					: 0;
				certStatus.values.push({
					labels: {
						zone: zone.name,
						type: cert.type,
						issuer: cert.issuer,
						status: cert.status,
					},
					value: expiresOn,
				});
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logger.warn("Failed to fetch SSL certs for zone", {
				zone: zone.name,
				error: msg,
			});
		}

		return certStatus.values.length > 0 ? [certStatus] : [];
	}

	/**
	 * Fetches LB origin weight metrics for a single zone.
	 * Used by zone-scoped MetricExporter DOs.
	 *
	 * @param zone Zone metadata.
	 * @returns Promise of LB weight metrics.
	 */
	async getLbWeightMetricsForZone(zone: Zone): Promise<MetricDefinition[]> {
		this.logger.info("Fetching LB weight metrics for zone", {
			zone: zone.name,
		});

		const originWeight: MetricDefinition = {
			name: "cloudflare_zone_lb_origin_weight",
			help: "Load balancer origin weight (0-1 normalized)",
			type: "gauge",
			values: [],
		};

		try {
			const lbConfigs = await this.getLoadBalancerConfigs(
				zone.id,
				zone.account.id,
			);

			for (const lb of lbConfigs) {
				for (const pool of lb.pools) {
					for (const origin of pool.origins) {
						if (origin.enabled) {
							originWeight.values.push({
								labels: {
									zone: zone.name,
									lb_name: lb.name,
									pool_name: pool.name,
									origin_name: origin.name,
								},
								value: origin.weight,
							});
						}
					}
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logger.warn("Failed to fetch LB configs for zone", {
				zone: zone.name,
				error: msg,
			});
		}

		return originWeight.values.length > 0 ? [originWeight] : [];
	}
}

// =============================================================================
// Singleton factory
// =============================================================================

const clientCache = new WeakMap<RateLimiter, CloudflareMetricsClient>();

type RateLimiter = {
	limit: (opts: { key: string }) => Promise<{ success: boolean }>;
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250;

/**
 * Creates rate-limited fetch wrapper with exponential backoff.
 *
 * @param rateLimiter Rate limiter instance.
 * @param logger Logger instance.
 * @returns Rate-limited fetch function.
 * @throws {Error} When rate limit exceeded after all retries.
 */
function createRateLimitedFetch(
	rateLimiter: RateLimiter,
	logger: Logger,
): typeof fetch {
	return async (input, init) => {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const { success } = await rateLimiter.limit({ key: "cf-api" });
			if (success) {
				return fetch(input, init);
			}

			if (attempt < MAX_RETRIES) {
				const delay = BASE_DELAY_MS * 2 ** attempt; // 250, 500, 1000ms
				logger.warn("Rate limited, backing off", { delay_ms: delay, attempt });
				await new Promise((r) => setTimeout(r, delay));
			}
		}

		logger.error("Rate limit exceeded after retries", {
			max_retries: MAX_RETRIES,
		});
		throw new Error("Rate limit exceeded after retries");
	};
}

/**
 * Gets or creates singleton CloudflareMetricsClient with rate limiting.
 * Uses WeakMap keyed on rate limiter for automatic GC when env is released.
 *
 * @param env Environment variables.
 * @returns CloudflareMetricsClient singleton instance.
 */
export function getCloudflareMetricsClient(env: Env): CloudflareMetricsClient {
	const existing = clientCache.get(env.CF_API_RATE_LIMITER);
	if (existing) {
		return existing;
	}

	const loggerConfig = configFromEnv(env);
	const logger = createLogger("cf_client_singleton", loggerConfig);

	logger.info("Creating CloudflareMetricsClient singleton", {
		rate_limit: "40/10s",
		log_level: loggerConfig.level,
		log_format: loggerConfig.format,
	});

	const rateLimitedFetch = createRateLimitedFetch(
		env.CF_API_RATE_LIMITER,
		logger,
	);

	const client = new CloudflareMetricsClient({
		apiToken: env.CLOUDFLARE_API_TOKEN,
		scrapeDelaySeconds: env.SCRAPE_DELAY_SECONDS,
		timeWindowSeconds: env.TIME_WINDOW_SECONDS,
		queryLimit: env.QUERY_LIMIT,
		loggerConfig,
		fetch: rateLimitedFetch,
	});

	clientCache.set(env.CF_API_RATE_LIMITER, client);
	return client;
}
