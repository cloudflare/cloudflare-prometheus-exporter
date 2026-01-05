# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-05
**Change:** p

## OVERVIEW

Cloudflare Prometheus exporter: Worker + Durable Objects fetching CF metrics via GraphQL/REST, exposing Prometheus format. Stack: Hono, gql.tada, Zod, urql.

## STRUCTURE

```
src/
  worker.tsx           # Entry: Hono app + DO exports
  durable-objects/     # 3 DOs: MetricCoordinator → AccountMetricCoordinator → MetricExporter
  lib/                 # Shared: types, config, prometheus serialization, logging
  cloudflare/          # CF API client + GraphQL queries
    gql/               # Generated: schema.gql, graphql-env.d.ts (DO NOT EDIT)
  components/          # Landing page JSX (Hono JSX, not React)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add metric query | `src/cloudflare/queries.ts` + `src/cloudflare/client.ts` | Add to enum, implement in client |
| Modify DO state | `src/durable-objects/*.ts` | Each DO has typed state, persisted via `ctx.storage` |
| Config options | `src/lib/runtime-config.ts` | KV overrides + env defaults, Zod-validated |
| Prometheus output | `src/lib/prometheus.ts` | `serializeToPrometheus()` |
| GraphQL types | Run `bun run gql:generate` | Regenerates `src/cloudflare/gql/` |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `MetricCoordinator` | DO | `durable-objects/MetricCoordinator.ts` | Singleton, owns account list, delegates to AccountMetricCoordinator |
| `AccountMetricCoordinator` | DO | `durable-objects/AccountMetricCoordinator.ts` | Per-account, manages zone list + MetricExporter DOs |
| `MetricExporter` | DO | `durable-objects/MetricExporter.ts` | Per-query scope, fetches + caches metrics, handles counter accumulation |
| `CloudflareMetricsClient` | Class | `cloudflare/client.ts` | GraphQL + REST client, DataLoader batching |
| `getConfig` | Fn | `lib/runtime-config.ts` | Merges KV overrides with env defaults |
| `serializeToPrometheus` | Fn | `lib/prometheus.ts` | MetricDefinition[] → text format |

## CONVENTIONS

**TypeScript (strict mode enforced):**
- `noUncheckedIndexedAccess: true` - index access returns `T | undefined`
- `verbatimModuleSyntax: true` - explicit type imports required
- Zod for runtime validation at boundaries

**Formatting (Biome):**
- Tabs, double quotes
- Auto-organize imports

**DO Patterns:**
- State loaded in `blockConcurrencyWhile` constructor
- Alarms for refresh scheduling (jitter applied)
- Static `get()` factory ensures initialization

## ANTI-PATTERNS (THIS PROJECT)

**Type assertions exist but constrained:**
- `env as Env & OptionalEnvVars` in config files (widening for optional vars)
- Avoid adding new `as` casts

**console.error in DOs:**
- Some DOs use `console.error` instead of logger for uninitialized state errors
- New code should use `createLogger()`

**Silent catches:**
- `worker.tsx:98` - `.catch(() => null)` for JSON parse
- Acceptable for input validation; avoid for business logic

**Generated files - DO NOT EDIT:**
- `src/cloudflare/gql/graphql-env.d.ts`
- `src/cloudflare/gql/schema.gql`
- `worker-configuration.d.ts`

## UNIQUE STYLES

**DO ID format:** `"scope:id:queryName"` (e.g., `"account:abc123:http-metrics"`)

**Metric types:** Only `counter` and `gauge` (no histogram/summary)

**Free tier handling:** `CF_FREE_TIER_ACCOUNTS` env var, zones filtered from paid-tier GraphQL queries

**Counter accumulation:** Cloudflare returns window totals; DOs accumulate for Prometheus monotonic semantics

## COMMANDS

```bash
bun run dev          # Local dev (wrangler dev)
bun run deploy       # Deploy to CF
bun run check        # Biome lint + format check
bun run format       # Auto-format
bun run gql:generate # Regenerate GraphQL types
bun run cf-typegen   # Regenerate worker-configuration.d.ts
```

## NOTES

**No tests:** Project lacks test infrastructure

**Docker:** For local Prometheus scraping only, not production deployment

**Rate limiting:** `CF_API_RATE_LIMITER` binding (40 req/10s) - applied to Cloudflare API calls

**Dual config:** wrangler.jsonc `vars` + optional env vars + KV runtime overrides
