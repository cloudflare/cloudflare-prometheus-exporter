import { z } from "zod";

/** KV storage key for configuration overrides. */
const KV_KEY = "overrides";

/**
 * Zod schema for valid configuration key names.
 */
export const ConfigKeySchema = z.enum([
	// Timing/limits
	"queryLimit",
	"scrapeDelaySeconds",
	"timeWindowSeconds",
	"metricRefreshIntervalSeconds",
	// Cache TTLs
	"accountListCacheTtlSeconds",
	"zoneListCacheTtlSeconds",
	"sslCertsCacheTtlSeconds",
	"healthCheckCacheTtlSeconds",
	// Logging
	"logFormat",
	"logLevel",
	// Filters/whitelists
	"cfAccounts",
	"cfZones",
	"cfFreeTierAccounts",
	"metricsDenylist",
	"queryDenylist",
	// Output options
	"excludeHost",
	"httpStatusGroup",
	// Hostname metrics
	"hostMetricsAllowlist",
	"hostMetricsDelaySeconds",
]);

/**
 * Union type of all valid configuration key names.
 */
export type ConfigKey = z.infer<typeof ConfigKeySchema>;

/**
 * Zod schemas for individual configuration values by key.
 */
const ConfigValueSchemas = {
	queryLimit: z.number().int().positive(),
	scrapeDelaySeconds: z.number().int().nonnegative(),
	timeWindowSeconds: z.number().int().positive(),
	metricRefreshIntervalSeconds: z.number().int().positive(),
	accountListCacheTtlSeconds: z.number().int().nonnegative(),
	zoneListCacheTtlSeconds: z.number().int().nonnegative(),
	sslCertsCacheTtlSeconds: z.number().int().nonnegative(),
	healthCheckCacheTtlSeconds: z.number().int().nonnegative(),
	logFormat: z.enum(["json", "pretty"]),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	cfAccounts: z.string().nullable(),
	cfZones: z.string().nullable(),
	cfFreeTierAccounts: z.string(),
	metricsDenylist: z.string(),
	queryDenylist: z.string(),
	excludeHost: z.boolean(),
	httpStatusGroup: z.boolean(),
	hostMetricsAllowlist: z.string(),
	hostMetricsDelaySeconds: z.number().int().min(30),
} as const;

/**
 * Zod schema for partial configuration overrides (all fields optional).
 */
export const ConfigOverridesSchema = z
	.object({
		queryLimit: ConfigValueSchemas.queryLimit.optional(),
		scrapeDelaySeconds: ConfigValueSchemas.scrapeDelaySeconds.optional(),
		timeWindowSeconds: ConfigValueSchemas.timeWindowSeconds.optional(),
		metricRefreshIntervalSeconds:
			ConfigValueSchemas.metricRefreshIntervalSeconds.optional(),
		accountListCacheTtlSeconds:
			ConfigValueSchemas.accountListCacheTtlSeconds.optional(),
		zoneListCacheTtlSeconds:
			ConfigValueSchemas.zoneListCacheTtlSeconds.optional(),
		sslCertsCacheTtlSeconds:
			ConfigValueSchemas.sslCertsCacheTtlSeconds.optional(),
		healthCheckCacheTtlSeconds:
			ConfigValueSchemas.healthCheckCacheTtlSeconds.optional(),
		logFormat: ConfigValueSchemas.logFormat.optional(),
		logLevel: ConfigValueSchemas.logLevel.optional(),
		cfAccounts: ConfigValueSchemas.cfAccounts.optional(),
		cfZones: ConfigValueSchemas.cfZones.optional(),
		cfFreeTierAccounts: ConfigValueSchemas.cfFreeTierAccounts.optional(),
		metricsDenylist: ConfigValueSchemas.metricsDenylist.optional(),
		queryDenylist: ConfigValueSchemas.queryDenylist.optional(),
		excludeHost: ConfigValueSchemas.excludeHost.optional(),
		httpStatusGroup: ConfigValueSchemas.httpStatusGroup.optional(),
		hostMetricsAllowlist: ConfigValueSchemas.hostMetricsAllowlist.optional(),
		hostMetricsDelaySeconds:
			ConfigValueSchemas.hostMetricsDelaySeconds.optional(),
	})
	.readonly();

/**
 * Partial configuration overrides stored in KV.
 */
export type ConfigOverrides = z.infer<typeof ConfigOverridesSchema>;

/**
 * Zod schema for fully resolved configuration (all fields required).
 */
export const ResolvedConfigSchema = z
	.object({
		queryLimit: ConfigValueSchemas.queryLimit,
		scrapeDelaySeconds: ConfigValueSchemas.scrapeDelaySeconds,
		timeWindowSeconds: ConfigValueSchemas.timeWindowSeconds,
		metricRefreshIntervalSeconds:
			ConfigValueSchemas.metricRefreshIntervalSeconds,
		accountListCacheTtlSeconds: ConfigValueSchemas.accountListCacheTtlSeconds,
		zoneListCacheTtlSeconds: ConfigValueSchemas.zoneListCacheTtlSeconds,
		sslCertsCacheTtlSeconds: ConfigValueSchemas.sslCertsCacheTtlSeconds,
		healthCheckCacheTtlSeconds: ConfigValueSchemas.healthCheckCacheTtlSeconds,
		logFormat: ConfigValueSchemas.logFormat,
		logLevel: ConfigValueSchemas.logLevel,
		cfAccounts: ConfigValueSchemas.cfAccounts,
		cfZones: ConfigValueSchemas.cfZones,
		cfFreeTierAccounts: ConfigValueSchemas.cfFreeTierAccounts,
		metricsDenylist: ConfigValueSchemas.metricsDenylist,
		queryDenylist: ConfigValueSchemas.queryDenylist,
		excludeHost: ConfigValueSchemas.excludeHost,
		httpStatusGroup: ConfigValueSchemas.httpStatusGroup,
		hostMetricsAllowlist: ConfigValueSchemas.hostMetricsAllowlist,
		hostMetricsDelaySeconds: ConfigValueSchemas.hostMetricsDelaySeconds,
	})
	.readonly();

/**
 * Fully resolved configuration with all fields populated.
 */
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

/**
 * Optional environment variables not defined in wrangler.jsonc.
 */
type OptionalEnvVars = {
	METRICS_DENYLIST?: string;
	QUERY_DENYLIST?: string;
	CF_ACCOUNTS?: string;
	CF_ZONES?: string;
	CF_FREE_TIER_ACCOUNTS?: string;
	HEALTH_CHECK_CACHE_TTL_SECONDS?: string;
	HOST_METRICS_ALLOWLIST?: string;
};

/**
 * Gets default configuration values from environment variables.
 *
 * @param env Worker environment bindings.
 * @returns Resolved configuration with defaults applied.
 */
export function getEnvDefaults(env: Env): ResolvedConfig {
	const optionalEnv = env as Env & OptionalEnvVars;
	return {
		queryLimit: z.coerce.number().catch(10000).parse(env.QUERY_LIMIT),
		scrapeDelaySeconds: z.coerce
			.number()
			.catch(300)
			.parse(env.SCRAPE_DELAY_SECONDS),
		timeWindowSeconds: z.coerce
			.number()
			.catch(60)
			.parse(env.TIME_WINDOW_SECONDS),
		metricRefreshIntervalSeconds: z.coerce
			.number()
			.catch(60)
			.parse(env.METRIC_REFRESH_INTERVAL_SECONDS),
		accountListCacheTtlSeconds: z.coerce
			.number()
			.catch(600)
			.parse(env.ACCOUNT_LIST_CACHE_TTL_SECONDS),
		zoneListCacheTtlSeconds: z.coerce
			.number()
			.catch(1800)
			.parse(env.ZONE_LIST_CACHE_TTL_SECONDS),
		sslCertsCacheTtlSeconds: z.coerce
			.number()
			.catch(1800)
			.parse(env.SSL_CERTS_CACHE_TTL_SECONDS),
		healthCheckCacheTtlSeconds: z.coerce
			.number()
			.catch(10)
			.parse(optionalEnv.HEALTH_CHECK_CACHE_TTL_SECONDS),
		logFormat: z.enum(["json", "pretty"]).catch("pretty").parse(env.LOG_FORMAT),
		logLevel: z
			.enum(["debug", "info", "warn", "error"])
			.catch("info")
			.parse(env.LOG_LEVEL),
		cfAccounts: optionalEnv.CF_ACCOUNTS?.trim() || null,
		cfZones: optionalEnv.CF_ZONES?.trim() || null,
		cfFreeTierAccounts: optionalEnv.CF_FREE_TIER_ACCOUNTS?.trim() ?? "",
		metricsDenylist: optionalEnv.METRICS_DENYLIST?.trim() ?? "",
		queryDenylist: optionalEnv.QUERY_DENYLIST?.trim() ?? "",
		excludeHost: z.coerce.boolean().catch(false).parse(env.EXCLUDE_HOST),
		httpStatusGroup: z.coerce
			.boolean()
			.catch(false)
			.parse(env.CF_HTTP_STATUS_GROUP),
		hostMetricsAllowlist: optionalEnv.HOST_METRICS_ALLOWLIST?.trim() ?? "",
		hostMetricsDelaySeconds: z.coerce
			.number()
			.catch(60)
			.parse(env.HOST_METRICS_DELAY_SECONDS),
	};
}

/**
 * Reads configuration overrides from KV storage.
 * Returns empty object on parse errors or missing data.
 *
 * @param env Worker environment bindings.
 * @returns Configuration overrides or empty object.
 */
async function readOverrides(env: Env): Promise<ConfigOverrides> {
	const raw = await env.CONFIG_KV.get(KV_KEY);
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		const result = ConfigOverridesSchema.safeParse(parsed);
		if (!result.success) {
			console.error("Invalid config overrides in KV, using defaults", {
				error: result.error.message,
			});
			return {};
		}
		return result.data;
	} catch {
		console.error("Failed to parse config overrides from KV, using defaults");
		return {};
	}
}

/**
 * Writes configuration overrides to KV storage.
 *
 * @param env Worker environment bindings.
 * @param overrides Configuration overrides to persist.
 */
async function writeOverrides(
	env: Env,
	overrides: ConfigOverrides,
): Promise<void> {
	await env.CONFIG_KV.put(KV_KEY, JSON.stringify(overrides));
}

/**
 * Merges configuration overrides with environment defaults.
 *
 * @param defaults Default configuration from environment.
 * @param overrides Partial overrides from KV storage.
 * @returns Fully resolved configuration.
 */
function mergeConfig(
	defaults: ResolvedConfig,
	overrides: ConfigOverrides,
): ResolvedConfig {
	return {
		queryLimit: overrides.queryLimit ?? defaults.queryLimit,
		scrapeDelaySeconds:
			overrides.scrapeDelaySeconds ?? defaults.scrapeDelaySeconds,
		timeWindowSeconds:
			overrides.timeWindowSeconds ?? defaults.timeWindowSeconds,
		metricRefreshIntervalSeconds:
			overrides.metricRefreshIntervalSeconds ??
			defaults.metricRefreshIntervalSeconds,
		accountListCacheTtlSeconds:
			overrides.accountListCacheTtlSeconds ??
			defaults.accountListCacheTtlSeconds,
		zoneListCacheTtlSeconds:
			overrides.zoneListCacheTtlSeconds ?? defaults.zoneListCacheTtlSeconds,
		sslCertsCacheTtlSeconds:
			overrides.sslCertsCacheTtlSeconds ?? defaults.sslCertsCacheTtlSeconds,
		healthCheckCacheTtlSeconds:
			overrides.healthCheckCacheTtlSeconds ??
			defaults.healthCheckCacheTtlSeconds,
		logFormat: overrides.logFormat ?? defaults.logFormat,
		logLevel: overrides.logLevel ?? defaults.logLevel,
		cfAccounts:
			overrides.cfAccounts !== undefined
				? overrides.cfAccounts
				: defaults.cfAccounts,
		cfZones:
			overrides.cfZones !== undefined ? overrides.cfZones : defaults.cfZones,
		cfFreeTierAccounts:
			overrides.cfFreeTierAccounts ?? defaults.cfFreeTierAccounts,
		metricsDenylist: overrides.metricsDenylist ?? defaults.metricsDenylist,
		queryDenylist: overrides.queryDenylist ?? defaults.queryDenylist,
		excludeHost: overrides.excludeHost ?? defaults.excludeHost,
		httpStatusGroup: overrides.httpStatusGroup ?? defaults.httpStatusGroup,
		hostMetricsAllowlist:
			overrides.hostMetricsAllowlist ?? defaults.hostMetricsAllowlist,
		hostMetricsDelaySeconds:
			overrides.hostMetricsDelaySeconds ?? defaults.hostMetricsDelaySeconds,
	};
}

/**
 * Gets resolved configuration by merging KV overrides with environment defaults.
 *
 * @param env Worker environment bindings.
 * @returns Fully resolved configuration.
 */
export async function getConfig(env: Env): Promise<ResolvedConfig> {
	const defaults = getEnvDefaults(env);
	const overrides = await readOverrides(env);
	return mergeConfig(defaults, overrides);
}

/**
 * Gets a single configuration key value.
 *
 * @param env Worker environment bindings.
 * @param key Configuration key to retrieve.
 * @returns Value for the specified configuration key.
 */
export async function getConfigKey<K extends ConfigKey>(
	env: Env,
	key: K,
): Promise<ResolvedConfig[K]> {
	const config = await getConfig(env);
	return config[key];
}

/**
 * Validates a value for a specific configuration key.
 *
 * @param key Configuration key to validate against.
 * @param value Value to validate.
 * @returns Validation result with parsed data or Zod error.
 */
export function validateConfigValue(
	key: ConfigKey,
	value: unknown,
): { success: true; data: unknown } | { success: false; error: z.ZodError } {
	return ConfigValueSchemas[key].safeParse(value);
}

/**
 * Result type for setConfigKey operation.
 */
type SetConfigKeyResult =
	| { success: true; config: ResolvedConfig }
	| { success: false; error: z.ZodError };

/**
 * Sets a single configuration key override with validation.
 *
 * @param env Worker environment bindings.
 * @param key Configuration key to set.
 * @param value Value to set for the key.
 * @returns Result with updated config or validation error.
 */
export async function setConfigKey(
	env: Env,
	key: ConfigKey,
	value: unknown,
): Promise<SetConfigKeyResult> {
	const result = ConfigValueSchemas[key].safeParse(value);
	if (!result.success) {
		return { success: false, error: result.error };
	}
	const overrides = await readOverrides(env);
	const updated = { ...overrides, [key]: result.data };
	await writeOverrides(env, updated);
	return {
		success: true,
		config: mergeConfig(getEnvDefaults(env), updated),
	};
}

/**
 * Resets a single configuration key to its environment default.
 *
 * @param env Worker environment bindings.
 * @param key Configuration key to reset.
 * @returns Resolved configuration after reset.
 */
export async function resetConfigKey(
	env: Env,
	key: ConfigKey,
): Promise<ResolvedConfig> {
	const overrides = await readOverrides(env);
	const { [key]: _, ...remaining } = overrides;
	await writeOverrides(env, remaining);
	return mergeConfig(getEnvDefaults(env), remaining);
}

/**
 * Resets all configuration overrides to environment defaults.
 *
 * @param env Worker environment bindings.
 * @returns Resolved configuration with only environment defaults.
 */
export async function resetAllConfig(env: Env): Promise<ResolvedConfig> {
	await env.CONFIG_KV.delete(KV_KEY);
	return getEnvDefaults(env);
}
