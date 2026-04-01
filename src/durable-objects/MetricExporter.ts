import { DurableObject } from "cloudflare:workers";
import {
	getCloudflareMetricsClient,
	isAccountLevelQuery,
	isZoneLevelQuery,
} from "../cloudflare/client";
import { isPaidTierGraphQLQuery } from "../cloudflare/queries";
import { parseCommaSeparated, partitionZonesByTier } from "../lib/filters";
import { createLogger, type Logger } from "../lib/logger";
import {
	type MetricDefinition,
	type MetricValue,
	mergeMetricDefinitions,
} from "../lib/metrics";
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
const METRICS_CHUNK_PREFIX = "mx:";
const COUNTERS_CHUNK_PREFIX = "cx:";

/**
 * Maximum bytes per storage chunk. Cloudflare Durable Objects enforce a 128 KiB
 * per-value limit. We stay well below it to leave room for encoding overhead.
 */
const MAX_CHUNK_BYTES = 100_000;

/**
 * Maximum allowed hostnames in HOST_METRICS_ALLOWLIST.
 * Limits GraphQL variable size and prevents cardinality explosion.
 */
const MAX_HOSTNAME_ALLOWLIST_SIZE = 50;

type MetricExporterState = {
	// Core identity
	scopeType: "account" | "zone";
	scopeId: string;
	queryName: string;

	// Metric storage (held in memory; persisted in separate chunks)
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

	// Auto-disable: stops retrying when the API persistently denies access
	disabledReason: string | null;

	// SSL cert cache (zone-scoped only)
	lastSslFetch: number;
};

/**
 * Fields excluded from persistence because they are either chunked separately
 * (metrics/counters) or transient context repopulated via RPC every cycle
 * (zones/firewallRules/zoneMetadata). Excluding them shrinks the persisted
 * state dramatically and eliminates redundant serialization across 21+ DOs.
 */
type TransientFields =
	| "metrics"
	| "counters"
	| "zones"
	| "firewallRules"
	| "zoneMetadata";

/**
 * Shape stored at STATE_KEY. Large and transient fields are excluded to keep
 * each storage entry well below the 128 KiB Durable Object limit and to
 * avoid redundant serialization of zone context that is already held by
 * AccountMetricCoordinator.
 */
type PersistedState = Omit<MetricExporterState, TransientFields> & {
	metricsChunks: number;
	countersChunks: number;
};

/**
 * Read a chunked value back from storage.
 * Chunks were written as plain JSON string segments with keys `${prefix}0`,
 * `${prefix}1`, …, `${prefix}${count - 1}`.
 */
async function readChunks<T>(
	storage: DurableObjectStorage,
	prefix: string,
	count: number,
	fallback: T,
): Promise<T> {
	if (count === 0) return fallback;
	const keys = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
	const map = await storage.get<string>(keys);
	const json = keys.map((k) => map.get(k) ?? "").join("");
	if (!json) return fallback;
	return JSON.parse(json) as T;
}

/**
 * Durable Object that fetches and exports Prometheus metrics for a specific query scope.
 * Handles counter accumulation, alarm-based refresh scheduling, and metric caching.
 */
export class MetricExporter extends DurableObject<Env> {
	private state: MetricExporterState | undefined;
	/** Tracks how many chunks are currently stored for each large field. */
	private chunkCounts = { metrics: 0, counters: 0 };

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.get<
				PersistedState | MetricExporterState
			>(STATE_KEY);
			if (stored === undefined) return;

			// Transient fields are not persisted — restore defaults.
			// They'll be repopulated via updateZoneContext() / initializeZone().
			const transientDefaults = {
				zones: [] as Zone[],
				firewallRules: {} as Record<string, string>,
				zoneMetadata: null as Zone | null,
			};

			if (
				"metricsChunks" in stored &&
				typeof stored.metricsChunks === "number"
			) {
				// Chunked format
				this.chunkCounts = {
					metrics: stored.metricsChunks,
					counters: stored.countersChunks,
				};
				const { metricsChunks: _mc, countersChunks: _cc, ...base } = stored;
				this.state = {
					...base,
					...transientDefaults,
					metrics: await readChunks<MetricDefinition[]>(
						ctx.storage,
						METRICS_CHUNK_PREFIX,
						stored.metricsChunks,
						[],
					),
					counters: await readChunks<Record<string, CounterState>>(
						ctx.storage,
						COUNTERS_CHUNK_PREFIX,
						stored.countersChunks,
						{},
					),
				};
			} else {
				// Legacy inline format — will be migrated on next saveState()
				const legacy = stored as MetricExporterState;
				this.state = {
					...legacy,
					...transientDefaults,
					disabledReason: legacy.disabledReason ?? null,
				};
			}
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
			disabledReason: null,
			lastSslFetch: 0,
		};

		await this.saveState(this.state);
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

		// Zones are transient (not persisted), so after a restart they're always
		// empty. Trigger an immediate refresh whenever zones go from empty to
		// populated to bootstrap the alarm cycle.
		const needsBootstrap = state.zones.length === 0 && zones.length > 0;

		this.state = {
			...state,
			accountId,
			accountName,
			zones,
			firewallRules,
		};
		await this.saveState(this.state);

		logger.info("Zone context updated", { zone_count: zones.length });

		if (needsBootstrap) {
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

		// zoneMetadata is transient (not persisted), so after a restart it's
		// always null. Bootstrap the alarm cycle whenever metadata arrives.
		const needsBootstrap = state.zoneMetadata === null;

		this.state = {
			...state,
			accountId,
			accountName,
			zoneMetadata: zone,
		};
		await this.saveState(this.state);

		logger.info("Zone metadata set", { zone: zone.name });

		if (needsBootstrap) {
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

		// Skip permanently disabled exporters (e.g., account lacks API access)
		if (state.disabledReason !== null) {
			logger.debug("Skipping refresh - disabled", {
				reason: state.disabledReason,
			});
			await this.scheduleNextAlarm(config);
			return;
		}

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
					config,
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
			await this.saveState(this.state);

			logger.info("Refresh complete", {
				metric_count: metrics.length,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);

			// Auto-disable on persistent access denial to stop retry spam
			if (msg.includes("does not have access")) {
				const reason = `API access denied: ${msg}`;
				logger.warn("Disabling exporter - account lacks API access", {
					query: state.queryName,
					reason,
				});
				this.state = {
					...state,
					lastError: msg,
					disabledReason: reason,
				};
			} else {
				logger.error("Refresh failed", { error: msg });
				this.state = { ...state, lastError: msg };
			}
			await this.saveState(this.state);
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
	 * Persist state using chunked storage. Metrics and counters are stored
	 * as separate chunked string values to stay under the 128 KiB limit.
	 *
	 * @param state Full in-memory state to persist.
	 */
	private async saveState(state: MetricExporterState): Promise<void> {
		const [metricsChunks, countersChunks] = await Promise.all([
			this.writeChunks(
				METRICS_CHUNK_PREFIX,
				state.metrics,
				this.chunkCounts.metrics,
			),
			this.writeChunks(
				COUNTERS_CHUNK_PREFIX,
				state.counters,
				this.chunkCounts.counters,
			),
		]);
		this.chunkCounts = { metrics: metricsChunks, counters: countersChunks };

		const {
			metrics: _m,
			counters: _c,
			zones: _z,
			firewallRules: _fr,
			zoneMetadata: _zm,
			...base
		} = state;
		const persisted: PersistedState = {
			...base,
			metricsChunks,
			countersChunks,
		};
		await this.ctx.storage.put(STATE_KEY, persisted);
	}

	/**
	 * Write a value to storage as a sequence of string chunks, each at most
	 * MAX_CHUNK_BYTES bytes, and delete any leftover chunks from a previous
	 * write that had more chunks.
	 */
	private async writeChunks(
		prefix: string,
		data: unknown,
		prevCount: number,
	): Promise<number> {
		const json = JSON.stringify(data);
		const newCount = Math.max(1, Math.ceil(json.length / MAX_CHUNK_BYTES));

		const entries: Record<string, string> = {};
		for (let i = 0; i < newCount; i++) {
			entries[`${prefix}${i}`] = json.slice(
				i * MAX_CHUNK_BYTES,
				(i + 1) * MAX_CHUNK_BYTES,
			);
		}
		await this.ctx.storage.put(entries);

		// Delete stale chunks from a previous save that had more chunks
		if (prevCount > newCount) {
			const staleKeys = Array.from(
				{ length: prevCount - newCount },
				(_, i) => `${prefix}${newCount + i}`,
			);
			await this.ctx.storage.delete(staleKeys);
		}

		return newCount;
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
			// Hostname metrics guardrails: parse allowlist once for both guard + query
			let hostMetricsAllowlist: ReadonlySet<string> | undefined;
			let hostMetricsDelaySeconds: number | undefined;
			if (queryName === "hostname-http-metrics") {
				const parsed = parseCommaSeparated(config.hostMetricsAllowlist);
				// Normalize to lowercase per spec
				const normalized = new Set([...parsed].map((h) => h.toLowerCase()));
				if (normalized.size === 0) {
					logger.debug("Hostname metrics disabled: empty allowlist");
					return [];
				}
				if (normalized.size > MAX_HOSTNAME_ALLOWLIST_SIZE) {
					logger.error("Hostname allowlist exceeds maximum size", {
						size: normalized.size,
						max: MAX_HOSTNAME_ALLOWLIST_SIZE,
					});
					return [];
				}
				// excludeHost strips host labels from all metrics in prometheus.ts,
				// which would collapse distinct hostnames into duplicate gauge series
				// (max-dedup keeps only the highest value, losing per-host granularity).
				if (config.excludeHost) {
					logger.warn(
						"Hostname metrics disabled: excludeHost=true strips host labels",
					);
					return [];
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
					return [];
				}
			}

			// Cloudflare GraphQL API limits queries to 10 zones (zonesHardLimit).
			// Chunk zones and merge results to support accounts with >10 zones.
			const ZONES_PER_CHUNK = 10;

			if (zonesToQuery.length <= ZONES_PER_CHUNK) {
				const zoneIds = zonesToQuery.map((z) => z.id);
				return client.getZoneMetrics(
					queryName,
					zoneIds,
					zonesToQuery,
					firewallRules,
					timeRange,
					hostMetricsAllowlist,
					hostMetricsDelaySeconds,
				);
			}

			const chunkResults: MetricDefinition[][] = [];
			for (let i = 0; i < zonesToQuery.length; i += ZONES_PER_CHUNK) {
				const chunkZones = zonesToQuery.slice(i, i + ZONES_PER_CHUNK);
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
					chunkResults.push(metrics);
				} catch (error) {
					// Log and continue — partial results from other chunks are still valuable.
					// Missing zones don't increment their counters this cycle;
					// processCounters() accumulates per (name, labels) key so existing
					// counter values are preserved. Next alarm retries all chunks.
					logger.error("Zone chunk query failed", {
						query: queryName,
						chunk_index: Math.floor(i / ZONES_PER_CHUNK),
						chunk_size: chunkZones.length,
						total_zones: zonesToQuery.length,
						failed_zones: chunkZones.map((z) => z.name),
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			return mergeMetricDefinitions(...chunkResults);
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
		// Start empty — only counters present in the current fetch survive.
		// This prunes stale entries (removed LBs, rotated hosts, gone colos)
		// and bounds memory to current metric cardinality.
		const newCounters: Record<string, CounterState> = {};

		const metrics = rawMetrics.map((metric) => {
			if (metric.type !== "counter") {
				return metric;
			}

			const processedValues: MetricValue[] = metric.values.map((value) => {
				const key = metricKey(metric.name, value.labels);
				newCounters[key] = this.updateCounter(
					existingCounters[key],
					value.value,
				);
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
