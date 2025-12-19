import { DurableObject } from "cloudflare:workers";
import {
	getCloudflareMetricsClient,
	isAccountLevelQuery,
	isZoneLevelQuery,
} from "../cloudflare/client";
import { isPaidTierGraphQLQuery } from "../cloudflare/queries";
import { partitionZonesByTier } from "../lib/filters";
import { createLogger, type Logger } from "../lib/logger";
import type { MetricDefinition, MetricValue } from "../lib/metrics";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import { getTimeRange, metricKey } from "../lib/time";
import {
	type CounterState,
	MetricExporterIdSchema,
	type MetricExporterIdString,
	type TimeRange,
	type Zone,
} from "../lib/types";

const STATE_KEY = "state";

type MetricExporterState = {
	// Core identity
	scopeType: "account" | "zone";
	scopeId: string;
	queryName: string;

	// Metric storage
	counters: Record<string, CounterState>;
	metrics: MetricDefinition[];
	lastIngest: number;

	// Context for fetching (account-scoped)
	accountId: string;
	accountName: string;
	zones: Zone[];
	firewallRules: Record<string, string>;

	// Context for fetching (zone-scoped)
	zoneMetadata: Zone | null;

	// Refresh state
	refreshInterval: number;
	lastRefresh: number;
	lastError: string | null;

	// SSL cert cache (zone-scoped only)
	lastSslFetch: number;
};

/**
 * Durable Object that fetches and exports Prometheus metrics for a specific query scope.
 * Handles counter accumulation, alarm-based refresh scheduling, and metric caching.
 */
export class MetricExporter extends DurableObject<Env> {
	private state: MetricExporterState | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state = await ctx.storage.get<MetricExporterState>(STATE_KEY);
		});
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

		const config = await getConfig(this.env);
		const parsed = MetricExporterIdSchema.parse(id);

		this.state = {
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
			lastSslFetch: 0,
		};

		await this.ctx.storage.put(STATE_KEY, this.state);
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

		this.state = {
			...state,
			accountId,
			accountName,
			zones,
			firewallRules,
		};
		await this.ctx.storage.put(STATE_KEY, this.state);

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

		this.state = {
			...state,
			accountId,
			accountName,
			zoneMetadata: zone,
		};
		await this.ctx.storage.put(STATE_KEY, this.state);

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
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		logger.info("Alarm fired, refreshing");
		const timeRange = getTimeRange(
			config.scrapeDelaySeconds,
			config.timeWindowSeconds,
		);
		await this.refreshWithTimeRange(timeRange, config, logger);
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

		try {
			let metrics: MetricDefinition[];

			if (state.scopeType === "account") {
				metrics = await this.fetchAccountScopedMetrics(
					client,
					state,
					timeRange,
					logger,
				);
			} else {
				metrics = await this.fetchZoneScopedMetrics(client, state);
			}

			const processed = this.processCounters(metrics, state.counters);

			this.state = {
				...state,
				metrics: processed.metrics,
				counters: processed.counters,
				lastRefresh: Date.now(),
				lastSslFetch:
					state.scopeType === "zone" ? Date.now() : state.lastSslFetch,
				lastError: null,
			};
			await this.ctx.storage.put(STATE_KEY, this.state);

			logger.info("Refresh complete", {
				metric_count: metrics.length,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("Refresh failed", { error: msg });
			this.state = { ...state, lastError: msg };
			await this.ctx.storage.put(STATE_KEY, this.state);
		}

		await this.scheduleNextAlarm(config);
	}

	/**
	 * Schedule the next alarm with jitter for time range alignment.
	 *
	 * @param config Resolved runtime configuration.
	 */
	private async scheduleNextAlarm(config: ResolvedConfig): Promise<void> {
		const intervalMs = config.metricRefreshIntervalSeconds * 1000;

		// Get the start of the current minute interval
		const now = Date.now();
		const startOfInterval = Math.floor(now / intervalMs) * intervalMs;

		// Add the jitter (1-5s) to the NEXT interval start
		// This ensures we always fire at ":01-05" of every interval
		const jitter = 1000 + Math.random() * 4000;
		const nextAlarm = startOfInterval + intervalMs + jitter;

		await this.ctx.storage.setAlarm(nextAlarm);
	}

	/**
	 * Fetch account-scoped metrics from Cloudflare API.
	 * Handles both account-level and zone-batched queries.
	 *
	 * @param client Cloudflare metrics client.
	 * @param state Current exporter state.
	 * @param timeRange Time range for metrics queries.
	 * @param logger Logger instance.
	 * @returns Array of metric definitions.
	 */
	private async fetchAccountScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
		timeRange: TimeRange,
		logger: Logger,
	): Promise<MetricDefinition[]> {
		const { queryName, accountId, accountName, zones, firewallRules } = state;

		// Account-level queries (worker-totals, logpush-account, magic-transit)
		if (isAccountLevelQuery(queryName)) {
			return client.getAccountMetrics(
				queryName,
				accountId,
				accountName,
				timeRange,
			);
		}

		// Zone-batched queries - fetch all zones in one GraphQL call
		if (isZoneLevelQuery(queryName)) {
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
					return [];
				}
			}

			const zoneIds = zonesToQuery.map((z) => z.id);
			return client.getZoneMetrics(
				queryName,
				zoneIds,
				zonesToQuery,
				firewallRules,
				timeRange,
			);
		}

		// Unknown query - should not happen if IDs are constructed correctly
		console.error("Unknown query type", { queryName });
		return [];
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

	/**
	 * Return cached accumulated metrics.
	 *
	 * @returns Current snapshot of metrics with accumulated counter values.
	 */
	async export(): Promise<MetricDefinition[]> {
		const state = this.getState();
		return state.metrics;
	}

	/**
	 * Process raw metrics and accumulate counter values.
	 *
	 * @param rawMetrics Raw metrics from Cloudflare API.
	 * @param existingCounters Existing counter state.
	 * @returns Processed metrics with accumulated counter values and updated counter state.
	 */
	private processCounters(
		rawMetrics: MetricDefinition[],
		existingCounters: Record<string, CounterState>,
	): { metrics: MetricDefinition[]; counters: Record<string, CounterState> } {
		const newCounters: Record<string, CounterState> = { ...existingCounters };

		const metrics = rawMetrics.map((metric) => {
			if (metric.type !== "counter") {
				return metric;
			}

			const processedValues: MetricValue[] = metric.values.map((value) => {
				const key = metricKey(metric.name, value.labels);
				newCounters[key] = this.updateCounter(newCounters[key], value.value);
				return { labels: value.labels, value: newCounters[key].accumulated };
			});

			return { ...metric, values: processedValues };
		});

		return { metrics, counters: newCounters };
	}

	/**
	 * Update counter state with a new raw value.
	 * Cloudflare API returns window-based totals, so we simply add them.
	 *
	 * @param existing Existing counter state or undefined for new counter.
	 * @param rawValue Window total from API to add to accumulated value.
	 * @returns Updated counter state with accumulated value.
	 */
	private updateCounter(
		existing: CounterState | undefined,
		rawValue: number,
	): CounterState {
		if (!existing) {
			return { accumulated: rawValue };
		}
		return { accumulated: existing.accumulated + rawValue };
	}
}
