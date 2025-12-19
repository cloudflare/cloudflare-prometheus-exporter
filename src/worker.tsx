import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { LandingPage } from "./components/LandingPage";
import { AccountMetricCoordinator } from "./durable-objects/AccountMetricCoordinator";
import { MetricCoordinator } from "./durable-objects/MetricCoordinator";
import { MetricExporter } from "./durable-objects/MetricExporter";
import { type AppConfig, parseConfig } from "./lib/config";
import { checkHealth, healthResponse } from "./lib/health";
import { configFromEnv, createLogger } from "./lib/logger";
import {
	ConfigKeySchema,
	getConfig,
	getConfigKey,
	getEnvDefaults,
	resetAllConfig,
	resetConfigKey,
	setConfigKey,
} from "./lib/runtime-config";

export { MetricCoordinator, AccountMetricCoordinator, MetricExporter };

type Variables = { config: AppConfig };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Parse config middleware
app.use("*", async (c, next) => {
	c.set("config", parseConfig(c.env));
	await next();
});

// Basic auth middleware
app.use("*", async (c, next) => {
	const { basicAuth } = c.var.config;

	if (!basicAuth.enabled) {
		return next();
	}

	const authHeader = c.req.header("Authorization");

	if (!authHeader || !authHeader.startsWith("Basic ")) {
		return c.text("Unauthorized", 401, {
			"WWW-Authenticate": 'Basic realm="Cloudflare Exporter"',
		});
	}

	const base64Credentials = authHeader.slice(6);
	let credentials: string;
	try {
		credentials = atob(base64Credentials);
	} catch {
		return c.text("Unauthorized", 401, {
			"WWW-Authenticate": 'Basic realm="Cloudflare Exporter"',
		});
	}

	const [username, password] = credentials.split(":");

	if (username !== basicAuth.username || password !== basicAuth.password) {
		return c.text("Unauthorized", 401, {
			"WWW-Authenticate": 'Basic realm="Cloudflare Exporter"',
		});
	}

	return next();
});

// Disable guards
app.use("*", async (c, next) => {
	const path = c.req.path;
	if (c.var.config.disableUi && path === "/") {
		return c.text("Not Found", 404);
	}
	if (c.var.config.disableConfigApi && path.startsWith("/config")) {
		return c.text("Not Found", 404);
	}
	await next();
});

// Dynamic metrics path middleware (runs before routing)
app.get(env.METRICS_PATH, async (c) => {
	const logger = createLogger("worker", configFromEnv(c.env)).withContext({
		request_id: crypto.randomUUID(),
	});
	logger.info("Metrics request received");

	try {
		const coordinator = await MetricCoordinator.get(c.env);
		const output = await coordinator.export();
		logger.info("Metrics exported successfully");
		return c.text(output, 200, {
			"Content-Type": "text/plain; charset=utf-8",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("Failed to collect metrics", { error: message });
		return c.text(`Error collecting metrics: ${message}`, 500);
	}
});

// Routes
app.get("/", (c) => c.html(<LandingPage config={c.var.config} />));

app.get("/health", async (c) => {
	const health = await checkHealth(c.env);
	return healthResponse(health);
});

// Config API routes
app.get("/config", async (c) => {
	const config = await getConfig(c.env);
	return c.json(config);
});

app.get("/config/defaults", (c) => {
	const defaults = getEnvDefaults(c.env);
	return c.json(defaults);
});

app.get("/config/:key", async (c) => {
	const keyResult = ConfigKeySchema.safeParse(c.req.param("key"));
	if (!keyResult.success) {
		return c.json({ error: "Invalid config key" }, 400);
	}
	const value = await getConfigKey(c.env, keyResult.data);
	return c.json({ key: keyResult.data, value });
});

app.put("/config/:key", async (c) => {
	const keyResult = ConfigKeySchema.safeParse(c.req.param("key"));
	if (!keyResult.success) {
		return c.json({ error: "Invalid config key" }, 400);
	}
	const body = await c.req.json<{ value: unknown }>().catch(() => null);
	if (!body || !("value" in body)) {
		return c.json({ error: "Request body must contain 'value'" }, 400);
	}
	const result = await setConfigKey(c.env, keyResult.data, body.value);
	if (!result.success) {
		return c.json(
			{ error: "Invalid value", details: result.error.issues },
			400,
		);
	}
	return c.json(result.config);
});

app.delete("/config/:key", async (c) => {
	const keyResult = ConfigKeySchema.safeParse(c.req.param("key"));
	if (!keyResult.success) {
		return c.json({ error: "Invalid config key" }, 400);
	}
	const config = await resetConfigKey(c.env, keyResult.data);
	return c.json(config);
});

app.delete("/config", async (c) => {
	const config = await resetAllConfig(c.env);
	return c.json(config);
});

app.notFound((c) => c.text("Not Found", 404));

export default app;
