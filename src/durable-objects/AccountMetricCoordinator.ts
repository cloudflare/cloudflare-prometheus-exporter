import { DurableObject } from "cloudflare:workers";
import {
	ACCOUNT_LEVEL_QUERIES,
	getCloudflareMetricsClient,
	ZONE_LEVEL_QUERIES,
} from "../cloudflare/client";
import { FREE_TIER_QUERIES } from "../cloudflare/queries";
import {
	filterZonesByIds,
	isFreeTierZone,
	parseCommaSeparated,
} from "../lib/filters";
import { createLogger, type Logger } from "../lib/logger";
import type { MetricDefinition } from "../lib/metrics";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import { getTimeRange } from "../lib/time";
import type { Zone } from "../lib/types";
import { MetricExporter } from "./MetricExporter";

const STATE_KEY = "state";

// Account-scoped queries: all account-level + zone-batched (excludes zone-scoped REST queries)
const ACCOUNT_SCOPED_QUERIES = [
	...ACCOUNT_LEVEL_QUERIES,
	...ZONE_LEVEL_QUERIES.filter(
		(q) => q !== "ssl-certificates" && q !== "lb-weight-metrics",
	),
] as const;

// Zone-scoped REST queries (one DO per zone for parallelization and fault isolation)
const ZONE_SCOPED_QUERIES = ["ssl-certificates", "lb-weight-metrics"] as const;

type AccountMetricCoordinatorState = {
	accountId: string;
	accountName: string;
	zones: Zone[];
	totalZoneCount: number;
	firewallRules: Record<string, string>;
	lastZoneFetch: number;
	lastRefresh: number;
};

/**
 * Coordinates metric collection for a Cloudflare account and manages zone list caching and distributes work to MetricExporter DOs.
 */
export class AccountMetricCoordinator extends DurableObject<Env> {
	private state: AccountMetricCoordinatorState | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state =
				await ctx.storage.get<AccountMetricCoordinatorState>(STATE_KEY);
		});
	}

	/**
	 * Creates logger instance with account-specific tag.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance.
	 */
	private createLogger(config: ResolvedConfig): Logger {
		const state = this.getState();
		const tag = state.accountName.toLowerCase().replace(/[ -]/g, "_");
		return createLogger("account_coordinator", {
			format: config.logFormat,
			level: config.logLevel,
		}).child(tag);
	}

	/**
	 * Gets current coordinator state.
	 *
	 * @returns Current state.
	 * @throws {Error} When state not initialized.
	 */
	private getState(): AccountMetricCoordinatorState {
		if (this.state === undefined) {
			console.error(
				"[account_coordinator] State not initialized - initialize() must be called first",
			);
			throw new Error("State not initialized");
		}
		return this.state;
	}

	/**
	 * Gets or creates coordinator stub for account and ensures coordinator is initialized before returning.
	 *
	 * @param accountId Cloudflare account ID.
	 * @param accountName Account display name for logging.
	 * @param env Worker environment bindings.
	 * @returns Initialized coordinator stub.
	 */
	static async get(accountId: string, accountName: string, env: Env) {
		const stub = env.AccountMetricCoordinator.getByName(`account:${accountId}`);
		await stub.initialize(accountId, accountName);
		return stub;
	}

	/**
	 * Initializes coordinator state and starts alarm cycle. Idempotent safe to call multiple times.
	 *
	 * @param accountId Cloudflare account ID.
	 * @param accountName Account display name for logging.
	 */
	async initialize(accountId: string, accountName: string): Promise<void> {
		if (this.state !== undefined) {
			return;
		}

		const config = await getConfig(this.env);

		this.state = {
			accountId,
			accountName,
			zones: [],
			totalZoneCount: 0,
			firewallRules: {},
			lastZoneFetch: 0,
			lastRefresh: 0,
		};

		await this.ctx.storage.put(STATE_KEY, this.state);
		await this.ctx.storage.setAlarm(
			Date.now() + config.metricRefreshIntervalSeconds * 1000,
		);
	}

	override async alarm(): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		logger.info("Alarm fired, refreshing zones");
		await this.refresh(config, logger);
	}

	/**
	 * Refreshes zone list and pushes context to exporters. Exporters handle their own metric fetching via alarms.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private async refresh(config: ResolvedConfig, logger: Logger): Promise<void> {
		logger.info("Starting refresh");

		try {
			await this.refreshZonesAndPushContext(config, logger);

			this.state = { ...this.getState(), lastRefresh: Date.now() };
			await this.ctx.storage.put(STATE_KEY, this.state);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("Refresh failed", { error: msg });
		}

		await this.ctx.storage.setAlarm(
			Date.now() + config.metricRefreshIntervalSeconds * 1000,
		);
	}

	/**
	 * Refreshes zone list if stale then pushes context to all exporters.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 */
	private async refreshZonesAndPushContext(
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		const state = this.getState();
		const ttlMs = config.zoneListCacheTtlSeconds * 1000;
		const isStale = Date.now() - state.lastZoneFetch >= ttlMs;

		// Calculate shared time range once for all exporters in this refresh cycle
		const timeRange = getTimeRange(
			config.scrapeDelaySeconds,
			config.timeWindowSeconds,
		);

		let zones = state.zones;
		let firewallRules = state.firewallRules;

		if (isStale || zones.length === 0) {
			const client = getCloudflareMetricsClient(this.env);
			logger.info("Refreshing zones");

			const allZones = await client.getZones(state.accountId);

			// Apply zone whitelist if set
			const cfZonesSet =
				config.cfZones !== null ? parseCommaSeparated(config.cfZones) : null;
			zones =
				cfZonesSet !== null ? filterZonesByIds(allZones, cfZonesSet) : allZones;

			// Build firewall rules map
			firewallRules = {};
			const rulesResults = await Promise.all(
				zones.map((zone) =>
					client.getFirewallRules(zone.id).catch((error) => {
						const msg = error instanceof Error ? error.message : String(error);
						logger.warn("Failed to fetch firewall rules", {
							zone: zone.name,
							error: msg,
						});
						return new Map<string, string>();
					}),
				),
			);
			for (const rules of rulesResults) {
				for (const [id, name] of rules) {
					firewallRules[id] = name;
				}
			}

			this.state = {
				...state,
				zones,
				totalZoneCount: allZones.length,
				firewallRules,
				lastZoneFetch: Date.now(),
			};
			await this.ctx.storage.put(STATE_KEY, this.state);

			logger.info("Zones cached", {
				total: allZones.length,
				filtered: zones.length,
			});
		}

		// Check if this account is marked as free tier
		const cfFreeTierSet = parseCommaSeparated(config.cfFreeTierAccounts);
		const isFreeTierAccount = cfFreeTierSet.has(state.accountId);

		// Filter queries based on account tier
		const accountQueries = isFreeTierAccount
			? ACCOUNT_SCOPED_QUERIES.filter((q) =>
					FREE_TIER_QUERIES.includes(q as (typeof FREE_TIER_QUERIES)[number]),
				)
			: ACCOUNT_SCOPED_QUERIES;

		// Push zone context to account-scoped exporters AND initialize zone-scoped exporters concurrently
		await Promise.all([
			// Account-scoped exporters
			...accountQueries.map(async (query) => {
				try {
					const exporter = await MetricExporter.get(
						`account:${state.accountId}:${query}`,
						this.env,
					);
					await exporter.updateZoneContext(
						state.accountId,
						state.accountName,
						zones,
						firewallRules,
						timeRange,
					);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					logger.error("Failed to update zone context", {
						query,
						error: msg,
					});
				}
			}),
			// Zone-scoped exporters (skip for free tier accounts)
			...(isFreeTierAccount
				? []
				: zones.flatMap((zone) =>
						ZONE_SCOPED_QUERIES.map(async (query) => {
							try {
								const exporter = await MetricExporter.get(
									`zone:${zone.id}:${query}`,
									this.env,
								);
								await exporter.initializeZone(
									zone,
									state.accountId,
									state.accountName,
									timeRange,
								);
							} catch (error) {
								const msg =
									error instanceof Error ? error.message : String(error);
								logger.error("Failed to initialize zone exporter", {
									zone: zone.name,
									query,
									error: msg,
								});
							}
						}),
					)),
		]);

		logger.info("Context pushed to exporters", {
			account_scoped: accountQueries.length,
			zone_scoped: isFreeTierAccount
				? 0
				: zones.length * ZONE_SCOPED_QUERIES.length,
		});
	}

	/**
	 * Collects and aggregates metrics from all MetricExporter DOs.
	 *
	 * @returns Metrics and zone counts.
	 */
	async export(): Promise<{
		metrics: MetricDefinition[];
		zoneCounts: {
			total: number;
			filtered: number;
			processed: number;
			skippedFreeTier: number;
		};
	}> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);

		logger.info("Exporting metrics");

		// Ensure exporters have been initialized
		const staleThreshold = config.metricRefreshIntervalSeconds * 2 * 1000;
		const initialState = this.getState();
		if (
			initialState.lastRefresh === 0 ||
			Date.now() - initialState.lastRefresh > staleThreshold
		) {
			await this.refresh(config, logger);
		}

		// Re-get state after potential refresh (this.state may have been updated)
		const state = this.getState();

		// Check if this account is marked as free tier
		const cfFreeTierSet = parseCommaSeparated(config.cfFreeTierAccounts);
		const isFreeTierAccount = cfFreeTierSet.has(state.accountId);

		// Filter queries based on account tier
		const accountQueries = isFreeTierAccount
			? ACCOUNT_SCOPED_QUERIES.filter((q) =>
					FREE_TIER_QUERIES.includes(q as (typeof FREE_TIER_QUERIES)[number]),
				)
			: ACCOUNT_SCOPED_QUERIES;

		// Collect from account-scoped exporters
		const accountMetricsResults = await Promise.all(
			accountQueries.map(async (query) => {
				try {
					const exporter = await MetricExporter.get(
						`account:${state.accountId}:${query}`,
						this.env,
					);
					return await exporter.export();
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					logger.error("Failed to export account metrics", {
						query,
						error: msg,
					});
					return [];
				}
			}),
		);

		// Collect from zone-scoped exporters (skip for free tier accounts)
		const zoneMetricsResults = isFreeTierAccount
			? []
			: await Promise.all(
					state.zones.flatMap((zone) =>
						ZONE_SCOPED_QUERIES.map(async (query) => {
							try {
								const exporter = await MetricExporter.get(
									`zone:${zone.id}:${query}`,
									this.env,
								);
								return await exporter.export();
							} catch (error) {
								const msg =
									error instanceof Error ? error.message : String(error);
								logger.error("Failed to export zone metrics", {
									zone: zone.name,
									query,
									error: msg,
								});
								return [];
							}
						}),
					),
				);

		const allMetrics = [...accountMetricsResults, ...zoneMetricsResults].flat();

		// Count unique zones with metrics from all results
		const zonesWithMetrics = new Set<string>();
		for (const metric of allMetrics) {
			for (const v of metric.values) {
				const zone = v.labels.zone;
				if (zone) {
					zonesWithMetrics.add(zone);
				}
			}
		}
		const processedZones = zonesWithMetrics.size;

		// Count free tier zones
		const freeTierCount = state.zones.filter(isFreeTierZone).length;

		return {
			metrics: allMetrics,
			zoneCounts: {
				total: state.totalZoneCount,
				filtered: state.zones.length,
				processed: processedZones,
				skippedFreeTier: freeTierCount,
			},
		};
	}
}
