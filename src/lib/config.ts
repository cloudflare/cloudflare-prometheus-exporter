import z from "zod";

/**
 * Basic auth configuration state.
 */
export type BasicAuthConfig =
	| { readonly enabled: false }
	| {
			readonly enabled: true;
			readonly username: string;
			readonly password: string;
	  };

/**
 * Application configuration parsed from environment variables.
 */
export type AppConfig = {
	readonly excludeHost: boolean;
	readonly httpStatusGroup: boolean;
	readonly metricsDenylist: ReadonlySet<string>;
	readonly cfAccounts: ReadonlySet<string> | null;
	readonly cfZones: ReadonlySet<string> | null;
	readonly cfFreeTierAccounts: ReadonlySet<string>;
	readonly metricsPath: string;
	readonly disableUi: boolean;
	readonly disableConfigApi: boolean;
	readonly basicAuth: BasicAuthConfig;
};

/**
 * Parses comma-separated string into Set, trimming whitespace.
 * Returns empty Set for empty/undefined input.
 *
 * @param value Comma-separated string or undefined.
 * @returns Set of trimmed non-empty strings.
 */
function parseCommaSeparated(value: string | undefined): Set<string> {
	if (!value || value.trim() === "") {
		return new Set();
	}
	return new Set(
		value
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);
}

/**
 * Optional environment variables not defined in wrangler.jsonc vars.
 */
type OptionalEnvVars = {
	METRICS_DENYLIST?: string;
	CF_ACCOUNTS?: string;
	CF_ZONES?: string;
	CF_FREE_TIER_ACCOUNTS?: string;
	BASIC_AUTH_USER?: string;
	BASIC_AUTH_PASSWORD?: string;
};

/**
 * Parses application configuration from environment variables.
 * Uses Zod for type coercion with sensible defaults.
 *
 * @param env Worker environment bindings.
 * @returns Parsed application configuration.
 */
export function parseConfig(env: Env): AppConfig {
	const optionalEnv = env as Env & OptionalEnvVars;

	const excludeHost = z.coerce.boolean().catch(false).parse(env.EXCLUDE_HOST);
	const httpStatusGroup = z.coerce
		.boolean()
		.catch(false)
		.parse(env.CF_HTTP_STATUS_GROUP);
	const metricsPath = z
		.string()
		.min(1)
		.catch("/metrics")
		.parse(env.METRICS_PATH);
	const disableUi = z.coerce.boolean().catch(false).parse(env.DISABLE_UI);
	const disableConfigApi = z.coerce
		.boolean()
		.catch(false)
		.parse(env.DISABLE_CONFIG_API);

	const metricsDenylist = parseCommaSeparated(optionalEnv.METRICS_DENYLIST);
	const cfAccountsRaw = parseCommaSeparated(optionalEnv.CF_ACCOUNTS);
	const cfAccounts = cfAccountsRaw.size > 0 ? cfAccountsRaw : null;
	const cfZonesRaw = parseCommaSeparated(optionalEnv.CF_ZONES);
	const cfZones = cfZonesRaw.size > 0 ? cfZonesRaw : null;
	const cfFreeTierAccounts = parseCommaSeparated(
		optionalEnv.CF_FREE_TIER_ACCOUNTS,
	);

	const basicAuth = parseBasicAuthConfig(
		optionalEnv.BASIC_AUTH_USER,
		optionalEnv.BASIC_AUTH_PASSWORD,
	);

	return {
		excludeHost,
		httpStatusGroup,
		metricsDenylist,
		cfAccounts,
		cfZones,
		cfFreeTierAccounts,
		metricsPath,
		disableUi,
		disableConfigApi,
		basicAuth,
	};
}

/**
 * Parses basic auth configuration from environment variables.
 * Logs warnings if configuration is incomplete.
 *
 * @param user BASIC_AUTH_USER environment variable.
 * @param password BASIC_AUTH_PASSWORD environment variable.
 * @returns Basic auth configuration.
 */
function parseBasicAuthConfig(
	user: string | undefined,
	password: string | undefined,
): BasicAuthConfig {
	const hasUser = user !== undefined && user.trim() !== "";
	const hasPassword = password !== undefined && password.trim() !== "";

	if (hasUser && hasPassword) {
		return { enabled: true, username: user.trim(), password: password.trim() };
	}

	if (hasUser && !hasPassword) {
		console.warn(
			"[config] BASIC_AUTH_USER is set but BASIC_AUTH_PASSWORD is missing - basic auth disabled",
		);
	}

	if (!hasUser && hasPassword) {
		console.warn(
			"[config] BASIC_AUTH_PASSWORD is set but BASIC_AUTH_USER is missing - basic auth disabled",
		);
	}

	return { enabled: false };
}
