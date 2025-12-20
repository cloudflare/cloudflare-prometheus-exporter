import { DurableObject } from "cloudflare:workers";
import { getCloudflareMetricsClient } from "../cloudflare/client";
import { extractErrorInfo } from "../lib/errors";
import { filterAccountsByIds, parseCommaSeparated } from "../lib/filters";
import { createLogger, type Logger } from "../lib/logger";
import type { MetricDefinition } from "../lib/metrics";
import { serializeToPrometheus } from "../lib/prometheus";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import type { Account } from "../lib/types";
import { AccountMetricCoordinator } from "./AccountMetricCoordinator";

const STATE_KEY = "state";

type MetricCoordinatorState = {
	identifier: string;
	accounts: Account[];
	lastAccountFetch: number;
};

/**
 * Coordinates metrics collection across all Cloudflare accounts and maintains cached account list.
 */
export class MetricCoordinator extends DurableObject<Env> {
	private state: MetricCoordinatorState | undefined;

	/**
	 * Gets or creates singleton MetricCoordinator instance.
	 *
	 * @param env Worker environment bindings.
	 * @returns Initialized MetricCoordinator stub.
	 */
	static async get(env: Env) {
		const stub = env.MetricCoordinator.getByName("metric-coordinator");
		await stub.setIdentifier("metric-coordinator");
		return stub;
	}

	/**
	 * Constructs MetricCoordinator and initializes state from storage.
	 *
	 * @param ctx Durable Object state.
	 * @param env Worker environment bindings.
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state = await ctx.storage.get<MetricCoordinatorState>(STATE_KEY);
		});
	}

	/**
	 * Creates logger instance with resolved configuration.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance.
	 */
	private createLogger(config: ResolvedConfig): Logger {
		return createLogger("metric_coordinator", {
			format: config.logFormat,
			level: config.logLevel,
		});
	}

	/**
	 * Initializes coordinator state if not already set.
	 *
	 * @param id Unique identifier for this coordinator instance.
	 */
	async setIdentifier(id: string): Promise<void> {
		if (this.state !== undefined) {
			return;
		}
		this.state = { identifier: id, accounts: [], lastAccountFetch: 0 };
		await this.ctx.storage.put(STATE_KEY, this.state);
	}

	/**
	 * Gets coordinator state.
	 *
	 * @returns Current coordinator state.
	 * @throws {Error} When state not initialized.
	 */
	private getState(): MetricCoordinatorState {
		if (this.state === undefined) {
			throw new Error("State not initialized");
		}
		return this.state;
	}

	/**
	 * Refreshes accounts from Cloudflare API if cache expired.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 * @returns Cached or refreshed account list.
	 */
	private async refreshAccountsIfStale(
		config: ResolvedConfig,
		logger: Logger,
	): Promise<Account[]> {
		const state = this.getState();
		const ttlMs = config.accountListCacheTtlSeconds * 1000;

		if (
			state.accounts.length > 0 &&
			Date.now() - state.lastAccountFetch < ttlMs
		) {
			return state.accounts;
		}

		const client = getCloudflareMetricsClient(this.env);
		logger.info("Refreshing account list");
		const allAccounts = await client.getAccounts();

		// Filter accounts if whitelist is set
		const cfAccountsSet =
			config.cfAccounts !== null
				? parseCommaSeparated(config.cfAccounts)
				: null;
		const accounts =
			cfAccountsSet !== null
				? filterAccountsByIds(allAccounts, cfAccountsSet)
				: allAccounts;

		this.state = {
			...state,
			accounts,
			lastAccountFetch: Date.now(),
		};
		await this.ctx.storage.put(STATE_KEY, this.state);

		logger.info("Accounts cached", {
			total: allAccounts.length,
			filtered: accounts.length,
		});
		return accounts;
	}

	/**
	 * Collects metrics from all accounts and serializes to Prometheus format.
	 *
	 * @returns Prometheus-formatted metrics string.
	 */
	async export(): Promise<string> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);

		logger.info("Collecting metrics");
		const accounts = await this.refreshAccountsIfStale(config, logger);

		if (accounts.length === 0) {
			logger.warn("No accounts found");
			return "";
		}

		logger.info("Exporting metrics", { account_count: accounts.length });

		// Track errors by account and error code
		const errorsByAccount: Map<string, { code: string; count: number }[]> =
			new Map();

		const results = await Promise.all(
			accounts.map(async (account) => {
				try {
					const coordinator = await AccountMetricCoordinator.get(
						account.id,
						account.name,
						this.env,
					);
					return await coordinator.export();
				} catch (error) {
					const info = extractErrorInfo(error);
					logger.error("Failed to export account", {
						account_id: account.id,
						error_code: info.code,
						error: info.message,
						...(info.stack && { stack: info.stack }),
					});

					// Track error for metrics
					const accountErrors = errorsByAccount.get(account.id) ?? [];
					const existing = accountErrors.find((e) => e.code === info.code);
					if (existing) {
						existing.count++;
					} else {
						accountErrors.push({ code: info.code, count: 1 });
					}
					errorsByAccount.set(account.id, accountErrors);

					return {
						metrics: [],
						zoneCounts: {
							total: 0,
							filtered: 0,
							processed: 0,
							skippedFreeTier: 0,
						},
					};
				}
			}),
		);

		// Aggregate stats
		const zoneCounts = {
			total: 0,
			filtered: 0,
			processed: 0,
			skippedFreeTier: 0,
		};
		const allMetrics: MetricDefinition[] = [];
		for (const result of results) {
			allMetrics.push(...result.metrics);
			zoneCounts.total += result.zoneCounts.total;
			zoneCounts.filtered += result.zoneCounts.filtered;
			zoneCounts.processed += result.zoneCounts.processed;
			zoneCounts.skippedFreeTier += result.zoneCounts.skippedFreeTier;
		}

		// Add exporter info metrics
		const exporterMetrics = this.buildExporterInfoMetrics(
			accounts.length,
			zoneCounts,
			errorsByAccount,
		);

		const metricsDenylist = parseCommaSeparated(config.metricsDenylist);
		return serializeToPrometheus([...exporterMetrics, ...allMetrics], {
			denylist: metricsDenylist,
			excludeLabels: config.excludeHost ? new Set(["host"]) : undefined,
		});
	}

	/**
	 * Builds exporter health and discovery metrics.
	 *
	 * @param accountCount Number of accounts discovered.
	 * @param zoneCounts Zone counts (total, filtered, processed, skippedFreeTier).
	 * @param errorsByAccount Errors by account and error code.
	 * @returns Exporter info metrics.
	 */
	private buildExporterInfoMetrics(
		accountCount: number,
		zoneCounts: {
			total: number;
			filtered: number;
			processed: number;
			skippedFreeTier: number;
		},
		errorsByAccount: Map<string, { code: string; count: number }[]>,
	): MetricDefinition[] {
		const metrics: MetricDefinition[] = [
			{
				name: "cloudflare_exporter_up",
				help: "Exporter health",
				type: "gauge",
				values: [{ labels: {}, value: 1 }],
			},
			{
				name: "cloudflare_accounts",
				help: "Total accounts discovered",
				type: "gauge",
				values: [{ labels: {}, value: accountCount }],
			},
			{
				name: "cloudflare_zones",
				help: "Total zones before filtering",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.total }],
			},
			{
				name: "cloudflare_zones_filtered",
				help: "Zones after whitelist filter",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.filtered }],
			},
			{
				name: "cloudflare_zones_processed",
				help: "Zones successfully processed",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.processed }],
			},
			{
				name: "cloudflare_zones_skipped_free_tier",
				help: "Zones skipped due to free tier plan (no GraphQL analytics access)",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.skippedFreeTier }],
			},
		];

		// Add error metrics if any errors occurred
		if (errorsByAccount.size > 0) {
			const errorsMetric: MetricDefinition = {
				name: "cloudflare_exporter_errors_total",
				help: "Total errors during metric collection by account and error code",
				type: "counter",
				values: [],
			};

			for (const [accountId, errors] of errorsByAccount) {
				for (const { code, count } of errors) {
					errorsMetric.values.push({
						labels: { account_id: accountId, error_code: code },
						value: count,
					});
				}
			}

			metrics.push(errorsMetric);
		}

		return metrics;
	}
}
