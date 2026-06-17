import { DurableObject } from "cloudflare:workers";
import z from "zod";
import {
	getCloudflareMetricsClient,
	isAccountLevelQuery,
	isZoneLevelQuery,
} from "../cloudflare/client";
import { isPaidTierGraphQLQuery } from "../cloudflare/queries";
import { runAlarmWithRecovery } from "../lib/alarm-recovery";
import {
	chunkedDurableObjectStorage,
	loadChunkedValue,
	saveChunkedValue,
} from "../lib/chunked-storage";
import { accumulateCounterMetrics } from "../lib/counters";
import { parseCommaSeparated, partitionZonesByTier } from "../lib/filters";
import { configFromEnv, createLogger, type Logger } from "../lib/logger";
import { getMetricRefreshDelaySeconds } from "../lib/metric-refresh";
import {
	type MetricDefinition,
	MetricDefinitionSchema,
	mergeMetricDefinitions,
} from "../lib/metrics";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import { getTimeRange } from "../lib/time";
import {
	CounterStateSchema,
	MetricExporterIdSchema,
	type MetricExporterIdString,
	type TimeRange,
	type Zone,
	ZoneSchema,
} from "../lib/types";

const STATE_KEY = "state";
const ALARM_RECOVERY_DELAY_MS = 60 * 1000;

/**
 * Maximum allowed hostnames in HOST_METRICS_ALLOWLIST.
 * Limits GraphQL variable size and prevents cardinality explosion.
 */
const MAX_HOSTNAME_ALLOWLIST_SIZE = 50;

const MetricExporterStateSchema = z.object({
	// Core identity
	scopeType: z.enum(["account", "zone"]),
	scopeId: z.string(),
	queryName: z.string(),

	// Metric storage
	counters: z.record(z.string(), CounterStateSchema),
	metrics: z.array(MetricDefinitionSchema),
	lastIngest: z.number(),

	// Context for fetching (account-scoped)
	accountId: z.string(),
	accountName: z.string(),
	zones: z.array(ZoneSchema),
	firewallRules: z.record(z.string(), z.string()),

	// Context for fetching (zone-scoped)
	zoneMetadata: ZoneSchema.nullable(),

	// Refresh state
	refreshInterval: z.number(),
	lastRefresh: z.number(),
	lastError: z.string().nullable(),
	zoneRetryAfter: z.record(z.string(), z.number()).default({}),

	// SSL cert cache (zone-scoped only)
	lastSslFetch: z.number(),
});

type MetricExporterState = z.infer<typeof MetricExporterStateSchema>;

type MetricFetchResult = {
	metrics: MetricDefinition[];
	partialErrors: unknown[];
	failedScopes: ReadonlySet<string>;
	zoneRetryAfter: Record<string, number>;
};

/**
 * Durable Object that fetches and exports Prometheus metrics for a specific query scope.
 * Handles counter accumulation, alarm-based refresh scheduling, and metric caching.
 */
export class MetricExporter extends DurableObject<Env> {
	private state: MetricExporterState | undefined;
	private stateLoadFailed = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			try {
				await this.loadState();
			} catch {
				// Keep the object alive so alarm() can schedule indefinite recovery.
				this.stateLoadFailed = true;
			}
		});
	}

	/** Load and validate state from Durable Object storage. */
	private async loadState(): Promise<void> {
		this.state = await loadChunkedValue(
			chunkedDurableObjectStorage(this.ctx.storage),
			STATE_KEY,
			MetricExporterStateSchema,
		);
		this.stateLoadFailed = false;
	}

	/** Retry constructor load failures from inside the protected alarm path. */
	private async retryFailedStateLoad(): Promise<void> {
		if (!this.stateLoadFailed) return;
		await this.loadState();
	}

	/**
	 * Create a logger instance with context from the exporter's state.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance with scope type, scope ID, and query name context.
	 */
	private createLogger(config: ResolvedConfig): Logger {
		const state = this.getState();
		return createLogger("metric_exporter", {
			format: config.logFormat,
			level: config.logLevel,
		})
			.child(state.scopeType)
			.child(state.scopeId)
			.child(state.queryName);
	}

	/**
	 * Get the current state or throw if not initialized.
	 *
	 * @returns Current state.
	 * @throws {Error} When state is undefined.
	 */
	private getState(): MetricExporterState {
		if (this.state === undefined) {
			console.error(
				"State not initialized - initialize() must be called first",
			);
			throw new Error("State not initialized");
		}
		return this.state;
	}

	/**
	 * Get or create a MetricExporter instance by ID, ensuring it's initialized.
	 *
	 * @param id Composite ID in format "scopeType:scopeId:queryName".
	 * @param env Worker environment bindings.
	 * @returns Initialized MetricExporter stub.
	 */
	static async get(id: MetricExporterIdString, env: Env) {
		const stub = env.MetricExporter.getByName(id);
		await stub.initialize(id);
		return stub;
	}

	/**
	 * Initialize the exporter state from a composite ID.
	 * Idempotent - skips if already initialized.
	 *
	 * @param id Composite ID string to parse into scope type, scope ID, and query name.
	 * @throws {ZodError} When ID format is invalid.
	 */
	async initialize(id: string): Promise<void> {
		if (this.state !== undefined) {
			return;
		}
		if (this.stateLoadFailed) {
			await this.loadState();
			if (this.state !== undefined) return;
		}

		const config = await getConfig(this.env);
		const parsed = MetricExporterIdSchema.parse(id);

		const initializedState: MetricExporterState = {
			scopeType: parsed.scopeType,
			scopeId: parsed.scopeId,
			queryName: parsed.queryName,
			counters: {},
			metrics: [],
			lastIngest: 0,
			accountId: "",
			accountName: "",
			zones: [],
			firewallRules: {},
			zoneMetadata: null,
			refreshInterval: config.metricRefreshIntervalSeconds,
			lastRefresh: 0,
			lastError: null,
			zoneRetryAfter: {},
			lastSslFetch: 0,
		};

		await this.saveState(initializedState);
		this.state = initializedState;
	}

	/**
	 * Update zone context for account-scoped exporters.
	 * Called by AccountMetricCoordinator after zone list refresh.
	 * Triggers immediate fetch on first context push.
	 *
	 * @param accountId Cloudflare account ID.
	 * @param accountName Account display name.
	 * @param zones List of zones in the account.
	 * @param firewallRules Map of firewall rule IDs to descriptions.
	 * @param timeRange Shared time range for metrics queries.
	 */
	async updateZoneContext(
		accountId: string,
		accountName: string,
		zones: Zone[],
		firewallRules: Record<string, string>,
		timeRange: TimeRange,
	): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		const state = this.getState();

		if (state.scopeType !== "account") {
			logger.warn("updateZoneContext called on non-account exporter");
			return;
		}

		const isFirstContext =
			state.zones.length === 0 && zones.length > 0 && state.lastRefresh === 0;

		const updatedState: MetricExporterState = {
			...state,
			accountId,
			accountName,
			zones,
			firewallRules,
		};
		await this.saveState(updatedState);
		this.state = updatedState;

		logger.info("Zone context updated", { zone_count: zones.length });

		// On first context push, fetch immediately then schedule recurring alarm
		if (isFirstContext) {
			await this.refreshWithTimeRange(timeRange, config, logger);
		}
	}

	/**
	 * Initialize zone-scoped exporter with zone metadata.
	 * Called by AccountMetricCoordinator when ensuring zone exporters exist.
	 * Triggers immediate fetch on first initialization.
	 *
	 * @param zone Zone metadata including ID, name, and plan.
	 * @param accountId Cloudflare account ID that owns the zone.
	 * @param accountName Account display name.
	 * @param timeRange Shared time range for metrics queries.
	 */
	async initializeZone(
		zone: Zone,
		accountId: string,
		accountName: string,
		timeRange: TimeRange,
	): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		const state = this.getState();

		if (state.scopeType !== "zone") {
			logger.warn("initializeZone called on non-zone exporter");
			return;
		}

		const isFirstInit = state.zoneMetadata === null && state.lastRefresh === 0;

		const updatedState: MetricExporterState = {
			...state,
			accountId,
			accountName,
			zoneMetadata: zone,
		};
		await this.saveState(updatedState);
		this.state = updatedState;

		logger.info("Zone metadata set", { zone: zone.name });

		// On first init, fetch immediately then schedule recurring alarm
		if (isFirstInit) {
			await this.refreshWithTimeRange(timeRange, config, logger);
		}
	}

	/**
	 * Durable Object alarm handler.
	 * Triggers metric refresh and reschedules next alarm with jitter.
	 */
	override async alarm(): Promise<void> {
		let logger: Logger | undefined;

		await runAlarmWithRecovery({
			run: async () => {
				logger = createLogger("metric_exporter_alarm", configFromEnv(this.env));
				await this.retryFailedStateLoad();
				const config = await getConfig(this.env);
				logger = this.createLogger(config);
				logger.info("Alarm fired, refreshing");
				const timeRange = getTimeRange(
					config.scrapeDelaySeconds,
					config.timeWindowSeconds,
				);
				await this.refreshWithTimeRange(timeRange, config, logger);
			},
			getLogger: () => logger,
			scheduleRecoveryAlarm: () =>
				this.ctx.storage.setAlarm(Date.now() + ALARM_RECOVERY_DELAY_MS),
		});
	}

	/**
	 * Public method for coordinator to trigger refresh with shared time range.
	 * Called by AccountMetricCoordinator to ensure all exporters use the same time window.
	 *
	 * @param timeRange Shared time range calculated by coordinator.
	 */
	async triggerRefresh(timeRange: TimeRange): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		await this.refreshWithTimeRange(timeRange, config, logger);
	}

	/**
	 * Refresh metrics from Cloudflare API using the provided time range.
	 * Handles account-scoped and zone-scoped queries, processes counters, and schedules next alarm.
	 *
	 * @param timeRange Time range for metrics queries.
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance for logging.
	 */
	private async refreshWithTimeRange(
		timeRange: TimeRange,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		const state = this.getState();

		// Skip if zone context not yet pushed (account-scoped needs zones)
		if (state.scopeType === "account" && state.zones.length === 0) {
			logger.info("Skipping refresh - no zone context yet");
			await this.scheduleNextAlarm(config);
			return;
		}

		// Skip if zone metadata not set (zone-scoped)
		if (state.scopeType === "zone" && state.zoneMetadata === null) {
			logger.info("Skipping refresh - no zone metadata yet");
			await this.scheduleNextAlarm(config);
			return;
		}

		// For zone-scoped (SSL certs), check cache TTL
		if (state.scopeType === "zone") {
			const cacheAgeMs = Date.now() - state.lastSslFetch;
			const cacheTtlMs = config.sslCertsCacheTtlSeconds * 1000;
			if (state.lastSslFetch > 0 && cacheAgeMs < cacheTtlMs) {
				logger.debug("SSL cert cache fresh, skipping fetch", {
					age_seconds: Math.floor(cacheAgeMs / 1000),
					ttl_seconds: config.sslCertsCacheTtlSeconds,
				});
				await this.scheduleNextAlarm(config);
				return;
			}
		}

		const client = getCloudflareMetricsClient(this.env);
		let nextRefreshDelaySeconds = config.metricRefreshIntervalSeconds;

		try {
			let result: MetricFetchResult;

			if (state.scopeType === "account") {
				result = await this.fetchAccountScopedMetrics(
					client,
					state,
					timeRange,
					config,
					logger,
				);
			} else {
				result = {
					metrics: await this.fetchZoneScopedMetrics(client, state),
					partialErrors: [],
					failedScopes: new Set(),
					zoneRetryAfter: {},
				};
			}

			const ingestId = new Date(timeRange.maxtime).getTime();
			const processed = accumulateCounterMetrics(
				result.metrics,
				state.counters,
				{
					ingestId,
					ageMissingCounters: state.lastIngest !== ingestId,
					failedScopes: result.failedScopes,
				},
			);
			const currentState = this.getState();
			const refreshedState: MetricExporterState = {
				...currentState,
				metrics: processed.metrics,
				counters: processed.counters,
				lastIngest: ingestId,
				lastRefresh: Date.now(),
				lastSslFetch:
					state.scopeType === "zone" ? Date.now() : currentState.lastSslFetch,
				lastError: null,
				zoneRetryAfter: result.zoneRetryAfter,
			};
			await this.saveState(refreshedState);
			this.state = refreshedState;

			logger.info("Refresh complete", {
				metric_count: result.metrics.length,
				partial_failure_count: result.partialErrors.length,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			nextRefreshDelaySeconds = getMetricRefreshDelaySeconds(
				error,
				config.metricRefreshIntervalSeconds,
			);
			logger.error("Refresh failed", {
				error: msg,
				retry_seconds: nextRefreshDelaySeconds,
			});
			const errorState: MetricExporterState = {
				...this.getState(),
				lastError: msg,
			};
			await this.saveState(errorState);
			this.state = errorState;
		}

		await this.scheduleNextAlarm(config, nextRefreshDelaySeconds);
	}

	/**
	 * Schedule the next alarm with jitter for time range alignment.
	 *
	 * @param config Resolved runtime configuration.
	 */
	private async scheduleNextAlarm(
		config: ResolvedConfig,
		delaySeconds: number = config.metricRefreshIntervalSeconds,
	): Promise<void> {
		const intervalMs = config.metricRefreshIntervalSeconds * 1000;
		const delayMs = delaySeconds * 1000;
		const now = Date.now();
		const jitter = 1000 + Math.random() * 4000;
		const nextAlarm =
			delaySeconds === config.metricRefreshIntervalSeconds
				? Math.floor(now / intervalMs) * intervalMs + intervalMs + jitter
				: now + delayMs + jitter;

		await this.ctx.storage.setAlarm(nextAlarm);
	}

	/**
	 * Fetch account-scoped metrics from Cloudflare API.
	 * Handles both account-level and zone-batched queries.
	 *
	 * @param client Cloudflare metrics client.
	 * @param state Current exporter state.
	 * @param timeRange Time range for metrics queries.
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 * @returns Array of metric definitions.
	 */
	private async fetchAccountScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
		timeRange: TimeRange,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<MetricFetchResult> {
		const { queryName, accountId, accountName, zones, firewallRules } = state;

		// Account-level queries (worker-totals, logpush-account, magic-transit)
		if (isAccountLevelQuery(queryName)) {
			return {
				metrics: await client.getAccountMetrics(
					queryName,
					accountId,
					accountName,
					timeRange,
				),
				partialErrors: [],
				failedScopes: new Set(),
				zoneRetryAfter: {},
			};
		}

		// Zone-batched queries - fetch all zones in one GraphQL call
		if (isZoneLevelQuery(queryName)) {
			// Hostname metrics guardrails: parse allowlist once for both guard + query
			let hostMetricsAllowlist: ReadonlySet<string> | undefined;
			let hostMetricsDelaySeconds: number | undefined;
			if (queryName === "hostname-http-metrics") {
				const parsed = parseCommaSeparated(config.hostMetricsAllowlist);
				// Normalize to lowercase per spec
				const normalized = new Set([...parsed].map((h) => h.toLowerCase()));
				if (normalized.size === 0) {
					logger.debug("Hostname metrics disabled: empty allowlist");
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
				if (normalized.size > MAX_HOSTNAME_ALLOWLIST_SIZE) {
					logger.error("Hostname allowlist exceeds maximum size", {
						size: normalized.size,
						max: MAX_HOSTNAME_ALLOWLIST_SIZE,
					});
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
				// excludeHost strips host labels from all metrics in prometheus.ts,
				// which would collapse distinct hostnames into duplicate gauge series
				// (max-dedup keeps only the highest value, losing per-host granularity).
				if (config.excludeHost) {
					logger.warn(
						"Hostname metrics disabled: excludeHost=true strips host labels",
					);
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
				hostMetricsAllowlist = normalized;
				hostMetricsDelaySeconds = config.hostMetricsDelaySeconds;
			}

			// Filter out free tier zones for paid-tier GraphQL queries
			let zonesToQuery = zones;
			if (isPaidTierGraphQLQuery(queryName)) {
				const { paid, free } = partitionZonesByTier(zones);

				if (free.length > 0) {
					logger.info("Skipping free tier zones for paid-tier query", {
						skipped_zones: free.map((z) => z.name),
						processing_zones: paid.length,
					});
				}

				zonesToQuery = paid;

				if (zonesToQuery.length === 0) {
					logger.info("No paid tier zones to query");
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
			}

			// Cloudflare GraphQL API limits queries to 10 zones (zonesHardLimit).
			// Chunk zones and merge results to support accounts with >10 zones.
			const ZONES_PER_CHUNK = 10;

			if (zonesToQuery.length <= ZONES_PER_CHUNK) {
				const zoneIds = zonesToQuery.map((z) => z.id);
				return {
					metrics: await client.getZoneMetrics(
						queryName,
						zoneIds,
						zonesToQuery,
						firewallRules,
						timeRange,
						hostMetricsAllowlist,
						hostMetricsDelaySeconds,
					),
					partialErrors: [],
					failedScopes: new Set(),
					zoneRetryAfter: {},
				};
			}

			const chunkResults: MetricDefinition[][] = [];
			const partialErrors: unknown[] = [];
			const failedScopes = new Set<string>();
			const currentZoneIds = new Set(zonesToQuery.map((zone) => zone.id));
			const now = Date.now();
			const zoneRetryAfter: Record<string, number> = {};
			for (const [zoneId, retryAfter] of Object.entries(state.zoneRetryAfter)) {
				if (currentZoneIds.has(zoneId) && retryAfter > now) {
					zoneRetryAfter[zoneId] = retryAfter;
				}
			}
			const queryableZones = zonesToQuery.filter((zone) => {
				const retryAfter = zoneRetryAfter[zone.id] ?? 0;
				if (retryAfter <= now) return true;
				failedScopes.add(zone.name);
				logger.debug("Skipping zone during product-access backoff", {
					query: queryName,
					zone: zone.name,
					retry_after: new Date(retryAfter).toISOString(),
				});
				return false;
			});
			let firstChunkError: unknown;
			let longestRetryError: unknown;
			let longestRetrySeconds = config.metricRefreshIntervalSeconds;
			for (let i = 0; i < queryableZones.length; i += ZONES_PER_CHUNK) {
				const chunkZones = queryableZones.slice(i, i + ZONES_PER_CHUNK);
				const chunkIds = chunkZones.map((z) => z.id);

				try {
					const metrics = await client.getZoneMetrics(
						queryName,
						chunkIds,
						chunkZones,
						firewallRules,
						timeRange,
						hostMetricsAllowlist,
						hostMetricsDelaySeconds,
					);
					for (const zoneId of chunkIds) delete zoneRetryAfter[zoneId];
					chunkResults.push(metrics);
				} catch (error) {
					firstChunkError ??= error;
					partialErrors.push(error);
					for (const zone of chunkZones) failedScopes.add(zone.name);
					const retrySeconds = getMetricRefreshDelaySeconds(
						error,
						config.metricRefreshIntervalSeconds,
					);
					if (retrySeconds > longestRetrySeconds) {
						longestRetrySeconds = retrySeconds;
						longestRetryError = error;
					}
					if (retrySeconds > config.metricRefreshIntervalSeconds) {
						for (const zoneId of chunkIds) {
							zoneRetryAfter[zoneId] = now + retrySeconds * 1000;
						}
					}
					// Log and continue — partial results from other chunks are still valuable.
					logger.error("Zone chunk query failed", {
						query: queryName,
						chunk_index: Math.floor(i / ZONES_PER_CHUNK),
						chunk_size: chunkZones.length,
						total_zones: zonesToQuery.length,
						failed_zones: chunkZones.map((z) => z.name),
						error: error instanceof Error ? error.message : String(error),
						retry_seconds: retrySeconds,
					});
				}
			}

			if (chunkResults.length === 0 && firstChunkError !== undefined) {
				throw longestRetryError ?? firstChunkError;
			}
			return {
				metrics: mergeMetricDefinitions(...chunkResults),
				partialErrors,
				failedScopes,
				zoneRetryAfter,
			};
		}

		// Unknown query - should not happen if IDs are constructed correctly
		console.error("Unknown query type", { queryName });
		return {
			metrics: [],
			partialErrors: [],
			failedScopes: new Set(),
			zoneRetryAfter: {},
		};
	}

	/**
	 * Fetch zone-scoped metrics from Cloudflare API.
	 * Handles SSL certificates and load balancer weight metrics.
	 *
	 * @param client Cloudflare metrics client.
	 * @param state Current exporter state.
	 * @returns Array of metric definitions.
	 */
	private async fetchZoneScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
	): Promise<MetricDefinition[]> {
		const { queryName, zoneMetadata } = state;

		if (zoneMetadata === null) {
			return [];
		}

		switch (queryName) {
			case "ssl-certificates":
				return client.getSSLCertificateMetricsForZone(zoneMetadata);
			case "lb-weight-metrics":
				return client.getLbWeightMetricsForZone(zoneMetadata);
			default:
				console.error("Unknown zone-scoped query", { queryName });
				return [];
		}
	}

	/** Persist state in bounded storage chunks before publishing it in memory. */
	private async saveState(state: MetricExporterState): Promise<void> {
		await saveChunkedValue(
			chunkedDurableObjectStorage(this.ctx.storage),
			STATE_KEY,
			state,
		);
	}

	/**
	 * Return cached accumulated metrics.
	 *
	 * @returns Current snapshot of metrics with accumulated counter values.
	 */
	async export(): Promise<MetricDefinition[]> {
		const state = this.getState();
		return state.metrics;
	}
}
