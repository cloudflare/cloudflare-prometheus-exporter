# Cloudflare Prometheus Exporter

[![Cloudflare Prometheus Exporter](https://github.com/user-attachments/assets/33794cd1-f03d-4382-9bb6-83d77cd01de5)](https://github.com/cloudflare/cloudflare-prometheus-exporter)

Export Cloudflare metrics to Prometheus. Built on Cloudflare Workers with Durable Objects for stateful metric accumulation.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/cloudflare-prometheus-exporter)

## Features

- **58 Prometheus metrics** - requests, bandwidth, threats, workers, load balancers, SSL certs, and more
- **Cloudflare Workers** - serverless edge deployment
- **Durable Objects** - stateful counter accumulation for proper Prometheus semantics
- **Background refresh** - alarms fetch data every 60s; scrapes return cached data instantly
- **Rate limiting** - 40 req/10s with exponential backoff
- **Multi-account** - automatically discovers and exports all accessible accounts/zones
- **Runtime config API** - change settings without redeployment via REST endpoints
- **Configurable** - zone filtering, metric denylist, label exclusion, custom metrics path, and more

## Quick Start

### One-Click Deploy

Click the deploy button above. Configure `CLOUDFLARE_API_TOKEN` as a secret after deployment.

### Manual Deployment

```bash
git clone https://github.com/cloudflare/cloudflare-prometheus-exporter.git
cd cloudflare-prometheus-exporter
bun install
wrangler secret put CLOUDFLARE_API_TOKEN
bun run deploy
```

## Configuration

Configuration is resolved in order: **KV overrides** → **env vars** → **defaults**. Use the [Runtime Config API](#runtime-config-api) for dynamic changes without redeployment.

### Environment Variables

Set in `wrangler.jsonc` or via `wrangler secret put`:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFLARE_API_TOKEN` | - | Cloudflare API token (secret) |
| `QUERY_LIMIT` | 10000 | Max results per GraphQL query |
| `SCRAPE_DELAY_SECONDS` | 300 | Delay before fetching metrics (data propagation) |
| `TIME_WINDOW_SECONDS` | 60 | Query time window |
| `METRIC_REFRESH_INTERVAL_SECONDS` | 60 | Background refresh interval |
| `LOG_LEVEL` | info | Log level (debug/info/warn/error) |
| `LOG_FORMAT` | json | Log format (pretty/json) |
| `ACCOUNT_LIST_CACHE_TTL_SECONDS` | 600 | Account list cache TTL |
| `ZONE_LIST_CACHE_TTL_SECONDS` | 1800 | Zone list cache TTL |
| `SSL_CERTS_CACHE_TTL_SECONDS` | 1800 | SSL cert cache TTL |
| `HEALTH_CHECK_CACHE_TTL_SECONDS` | 10 | Health check cache TTL |
| `EXCLUDE_HOST` | false | Exclude host labels from metrics |
| `CF_HTTP_STATUS_GROUP` | false | Group HTTP status codes (2xx, 4xx, etc.) |
| `DISABLE_UI` | false | Disable landing page (returns 404) |
| `DISABLE_CONFIG_API` | false | Disable config API endpoints (returns 404) |
| `METRICS_DENYLIST` | - | Comma-separated list of metrics to exclude |
| `CF_ACCOUNTS` | - | Comma-separated account IDs to include (default: all) |
| `CF_ZONES` | - | Comma-separated zone IDs to include (default: all) |
| `CF_FREE_TIER_ACCOUNTS` | - | Comma-separated account IDs using free tier (skips paid-tier metrics) |
| `METRICS_PATH` | /metrics | Custom path for metrics endpoint |

### Creating an API Token

**Quick setup**: [Create token with pre-filled permissions](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22ssl_certificates%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22firewall_services%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22load_balancers%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22logpush%22%2C%22type%22%3A%22read%22%7D%5D&name=Cloudflare%20Prometheus%20Exporter)

**Manual setup**:

| Permission | Access | Required |
|------------|--------|----------|
| Zone > Analytics | Read | Yes |
| Account > Account Analytics | Read | Yes |
| Account > Workers Scripts | Read | Yes |
| Zone > SSL and Certificates | Read | Optional |
| Zone > Firewall Services | Read | Optional |
| Zone > Load Balancers | Read | Optional |
| Account > Logpush | Read | Optional |
| Account > Magic Transit | Read | Optional |

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Landing page (disable: `DISABLE_UI`) |
| `/metrics` | GET | Prometheus metrics |
| `/health` | GET | Health check (`{"status":"healthy"}`) |
| `/config` | GET | Get all runtime config (disable: `DISABLE_CONFIG_API`) |
| `/config` | DELETE | Reset all config to env defaults (disable: `DISABLE_CONFIG_API`) |
| `/config/:key` | GET | Get single config value (disable: `DISABLE_CONFIG_API`) |
| `/config/:key` | PUT | Set config override (persisted in KV) (disable: `DISABLE_CONFIG_API`) |
| `/config/:key` | DELETE | Reset config key to env default (disable: `DISABLE_CONFIG_API`) |

## Prometheus Configuration

```yaml
scrape_configs:
  - job_name: 'cloudflare'
    scrape_interval: 60s
    scrape_timeout: 30s
    static_configs:
      - targets: ['your-worker.your-subdomain.workers.dev']
```

## Runtime Config API

Override configuration at runtime without redeployment. Overrides persist in KV and take precedence over `wrangler.jsonc` env vars.

### Config Keys

| Key | Type | Description |
|-----|------|-------------|
| `queryLimit` | number | Max results per GraphQL query |
| `scrapeDelaySeconds` | number | Delay before fetching metrics |
| `timeWindowSeconds` | number | Query time window |
| `metricRefreshIntervalSeconds` | number | Background refresh interval |
| `accountListCacheTtlSeconds` | number | Account list cache TTL |
| `zoneListCacheTtlSeconds` | number | Zone list cache TTL |
| `sslCertsCacheTtlSeconds` | number | SSL cert cache TTL |
| `healthCheckCacheTtlSeconds` | number | Health check cache TTL |
| `logFormat` | `"json"` \| `"pretty"` | Log format |
| `logLevel` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | Log level |
| `cfAccounts` | string \| null | Comma-separated account IDs (null = all) |
| `cfZones` | string \| null | Comma-separated zone IDs (null = all) |
| `cfFreeTierAccounts` | string | Comma-separated free tier account IDs |
| `metricsDenylist` | string | Comma-separated metrics to exclude |
| `excludeHost` | boolean | Exclude host labels |
| `httpStatusGroup` | boolean | Group HTTP status codes |

### Examples

```bash
# Get all config
curl https://your-worker.workers.dev/config

# Get single value
curl https://your-worker.workers.dev/config/logLevel

# Set override
curl -X PUT https://your-worker.workers.dev/config/logLevel \
  -H "Content-Type: application/json" \
  -d '{"value": "debug"}'

# Filter to specific zones
curl -X PUT https://your-worker.workers.dev/config/cfZones \
  -H "Content-Type: application/json" \
  -d '{"value": "zone-id-1,zone-id-2"}'

# Reset to env default
curl -X DELETE https://your-worker.workers.dev/config/logLevel

# Reset all overrides
curl -X DELETE https://your-worker.workers.dev/config
```

## Available Metrics

### Zone Request Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_requests_total` | counter | zone |
| `cloudflare_zone_requests_cached` | gauge | zone |
| `cloudflare_zone_requests_ssl_encrypted` | counter | zone |
| `cloudflare_zone_requests_content_type` | counter | zone, content_type |
| `cloudflare_zone_requests_country` | counter | zone, country, region |
| `cloudflare_zone_requests_status` | counter | zone, status |
| `cloudflare_zone_requests_browser_map_page_views_count` | counter | zone, family |
| `cloudflare_zone_requests_ip_class` | counter | zone, ip_class |
| `cloudflare_zone_requests_ssl_protocol` | counter | zone, ssl_protocol |
| `cloudflare_zone_requests_http_version` | counter | zone, http_version |
| `cloudflare_zone_requests_origin_status_country_host` | counter | zone, origin_status, country, host |
| `cloudflare_zone_requests_status_country_host` | counter | zone, edge_status, country, host |
| `cloudflare_zone_request_method_count` | counter | zone, method |

### Zone Bandwidth Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_bandwidth_total` | counter | zone |
| `cloudflare_zone_bandwidth_cached` | counter | zone |
| `cloudflare_zone_bandwidth_ssl_encrypted` | counter | zone |
| `cloudflare_zone_bandwidth_content_type` | counter | zone, content_type |
| `cloudflare_zone_bandwidth_country` | counter | zone, country |

### Zone Threat Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_threats_total` | counter | zone |
| `cloudflare_zone_threats_country` | counter | zone, country |
| `cloudflare_zone_threats_type` | counter | zone, type |

### Zone Page/Unique Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_pageviews_total` | counter | zone |
| `cloudflare_zone_uniques_total` | counter | zone |

### Colocation Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_colocation_visits` | counter | zone, colo, host |
| `cloudflare_zone_colocation_edge_response_bytes` | counter | zone, colo, host |
| `cloudflare_zone_colocation_requests_total` | counter | zone, colo, host |
| `cloudflare_zone_colocation_visits_error` | counter | zone, colo, host, status |
| `cloudflare_zone_colocation_edge_response_bytes_error` | counter | zone, colo, host, status |
| `cloudflare_zone_colocation_requests_total_error` | counter | zone, colo, host, status |

### Firewall Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_firewall_events_count` | counter | zone, action, source, rule, host, country |
| `cloudflare_zone_firewall_bots_detected` | counter | zone, bot_score, detection_ids |

### Health Check Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_health_check_events_origin_count` | counter | zone, health_status, origin_ip, region, fqdn, failure_reason |
| `cloudflare_zone_health_check_events_avg` | gauge | zone |
| `cloudflare_zone_health_check_rtt_ms` | gauge | zone, origin_ip, fqdn |
| `cloudflare_zone_health_check_ttfb_ms` | gauge | zone, origin_ip, fqdn |
| `cloudflare_zone_health_check_tcp_conn_ms` | gauge | zone, origin_ip, fqdn |
| `cloudflare_zone_health_check_tls_handshake_ms` | gauge | zone, origin_ip, fqdn |

### Worker Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_worker_requests_count` | counter | script_name |
| `cloudflare_worker_errors_count` | counter | script_name |
| `cloudflare_worker_cpu_time` | gauge | script_name, quantile |
| `cloudflare_worker_duration` | gauge | script_name, quantile |

### Load Balancer Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_pool_health_status` | gauge | zone, lb_name, pool_name |
| `cloudflare_zone_pool_requests_total` | counter | zone, lb_name, pool_name, origin_name |
| `cloudflare_zone_lb_pool_rtt_ms` | gauge | zone, lb_name, pool_name |
| `cloudflare_zone_lb_steering_policy_info` | gauge | zone, lb_name, policy |
| `cloudflare_zone_lb_origins_selected_count` | gauge | zone, lb_name, pool_name |
| `cloudflare_zone_lb_origin_weight` | gauge | zone, lb_name, pool_name, origin_name |

### Logpush Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_logpush_failed_jobs_account_count` | counter | account, job_id, destination_type |
| `cloudflare_logpush_failed_jobs_zone_count` | counter | zone, job_id, destination_type |

### Error Rate Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_customer_error_4xx_rate` | counter | zone, status, country, host |
| `cloudflare_zone_customer_error_5xx_rate` | counter | zone, status, country, host |
| `cloudflare_zone_edge_error_rate` | gauge | zone, status |
| `cloudflare_zone_origin_error_rate` | gauge | zone, status |
| `cloudflare_zone_origin_response_duration_ms` | gauge | zone, status, country, host |

### Cache Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_cache_hit_ratio` | gauge | zone |
| `cloudflare_zone_cache_miss_origin_duration_ms` | gauge | zone, country, host |

### Bot Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_bot_request_by_country` | counter | zone, country |

### Magic Transit Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_magic_transit_active_tunnels` | gauge | account |
| `cloudflare_magic_transit_healthy_tunnels` | gauge | account |
| `cloudflare_magic_transit_tunnel_failures` | gauge | account |
| `cloudflare_magic_transit_edge_colo_count` | gauge | account |

### SSL Certificate Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_certificate_validation_status` | gauge | zone, type, issuer, status |

### Exporter Info Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_exporter_up` | gauge | - |
| `cloudflare_exporter_errors_total` | counter | account_id, error_code |
| `cloudflare_accounts_total` | gauge | - |
| `cloudflare_zones_total` | gauge | - |
| `cloudflare_zones_filtered` | gauge | - |
| `cloudflare_zones_processed` | gauge | - |
| `cloudflare_zones_skipped_free_tier` | gauge | - |

## Free Tier Zone Limitations

Zones on Cloudflare's Free plan don't have access to the GraphQL Analytics API. The exporter automatically detects and skips free tier zones for metrics that require this API.

**Free tier zones still export:**
- `cloudflare_zone_certificate_validation_status` (SSL certificates)
- `cloudflare_zone_lb_origin_weight` (Load balancer weights, if configured)

**Monitor skipped zones:**
```
cloudflare_zones_skipped_free_tier
```

For mixed accounts (enterprise + free zones), only free zones are skipped—paid zones continue to export all metrics.

## Architecture


```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              WORKER ISOLATE                                    │
│  ┌────────────────┐                                                            │
│  │  Worker.fetch  │◄─── HTTP /metrics, /health, /config                        │
│  │ (HTTP handler) │                                                            │
│  └───────┬────────┘                                                            │
│          │                                                                     │
│          │ RPC (stub.export())                                                 │
│          ▼                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │ CONFIG_KV: Runtime config overrides (merged with env defaults)         │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
└──────────┼─────────────────────────────────────────────────────────────────────┘
           │
           │
           ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                         DURABLE OBJECT ISOLATES                                │
│                                                                                │
│  Each DO runs in its own V8 isolate with:                                      │
│  - Own CloudflareMetricsClient instance (per-isolate singleton)                │
│  - Own persistent storage                                                      │
│  - Own alarm scheduler                                                         │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │              MetricCoordinator (1 global instance)                      │   │
│  │  ID: "metric-coordinator"                                               │   │
│  │  State: accounts[], lastAccountFetch                                    │   │
│  │  Cache TTL: 600s (account list)                                         │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                               │ RPC                                            │
│                  ┌────────────┼────────────┐                                   │
│                  ▼            ▼            ▼                                   │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                   │
│  │ AccountMetric   │ │ AccountMetric   │ │ AccountMetric   │                   │
│  │ Coordinator     │ │ Coordinator     │ │ Coordinator     │                   │
│  │ account:acct1   │ │ account:acct2   │ │ account:acct3   │                   │
│  │ Alarm: 60s      │ │ Alarm: 60s      │ │ Alarm: 60s      │                   │
│  │ Zone TTL: 1800s │ │ Zone TTL: 1800s │ │ Zone TTL: 1800s │                   │
│  └───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘                   │
│          │ RPC               │                   │                             │
│   ┌──────┴─────┐      ┌──────┴─────┐      ┌──────┴─────┐                       │
│   ▼            ▼      ▼            ▼      ▼            ▼                       │
│ ┌─────┐    ┌─────┐  ┌─────┐    ┌─────┐  ┌─────┐    ┌─────┐                     │
│ │Exprt│    │Exprt│  │Exprt│    │Exprt│  │Exprt│    │Exprt│                     │
│ │(13) │ .. │(N)  │  │(13) │ .. │(N)  │  │(13) │ .. │(N)  │                     │
│ │acct │    │zone │  │acct │    │zone │  │acct │    │zone │                     │
│ └─────┘    └─────┘  └─────┘    └─────┘  └─────┘    └─────┘                     │
│                                                                                │
│  MetricExporter DOs (per account):                                             │
│  - Account-scoped (13): worker-totals, logpush-account, magic-transit,         │
│    http-metrics, adaptive-metrics, edge-country-metrics, colo-metrics,         │
│    colo-error-metrics, request-method-metrics, health-check-metrics,           │
│    load-balancer-metrics, logpush-zone, origin-status-metrics                  │
│  - Zone-scoped (N per account, 1 per zone): ssl-certificates                   │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │              CloudflareMetricsClient (per-isolate)                      │   │
│  │  - urql Client (GraphQL)                                                │   │
│  │  - Cloudflare SDK (REST)                                                │   │
│  │  - DataLoader: firewallRulesLoader (batches Promise.all calls)          │   │
│  │  - Global Rate limiter: 40 req/10s with exponential backoff             │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Request Path: Prometheus Scrape (GET /metrics)

```
┌──────────┐  GET /metrics   ┌────────┐
│Prometheus│────────────────▶│ Worker │
│  Server  │                 │ .fetch │
└──────────┘                 └───┬────┘
                                │
          ┌──────────────────────┴──────────────────────┐
          │            MetricCoordinator                │
          │                                             │
          │  1. Check account cache (TTL: 600s)         │
          │  2. If stale → getAccounts()                │
          │  3. Fan out to AccountMetricCoordinators    │
          └─────────────────────┬───────────────────────┘
                               │
       ┌────────────────────────┼────────────────────────┐
       │                        │                        │
       ▼                        ▼                        ▼
┌────────────────┐    ┌────────────────┐    ┌────────────────┐
│ AccountMetric  │    │ AccountMetric  │    │ AccountMetric  │
│ Coordinator    │    │ Coordinator    │    │ Coordinator    │
│ (Account A)    │    │ (Account B)    │    │ (Account C)    │
│                │    │                │    │                │
│ 1. Check if    │    │                │    │                │
│    refresh()   │    │  (parallel)    │    │  (parallel)    │
│    needed      │    │                │    │                │
│ 2. Fan out to  │    │                │    │                │
│    exporters   │    │                │    │                │
└───────┬────────┘    └───────┬────────┘    └───────┬────────┘
        │                     │                     │
  ┌─────┴─────┐         ┌─────┴─────┐         ┌─────┴─────┐
  ▼           ▼         ▼           ▼         ▼           ▼
┌─────┐   ┌─────┐    ┌─────┐   ┌─────┐    ┌─────┐   ┌─────┐
│Exprt│...│Exprt│    │Exprt│...│Exprt│    │Exprt│...│Exprt│
│13+N │   │     │    │13+N │   │     │    │13+N │   │     │
│     │   │     │    │     │   │     │    │     │   │     │
│ ret │   │ ret │    │ ret │   │ ret │    │ ret │   │ ret │
│cache│   │cache│    │cache│   │cache│    │cache│   │cache│
└──┬──┘   └──┬──┘    └──┬──┘   └──┬──┘    └──┬──┘   └──┬──┘
   │         │          │         │          │         │
   └────┬────┘          └────┬────┘          └────┬────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  FAN-IN: Merge  │
                   │  all metrics +  │
                   │  serialize to   │
                   │  Prometheus fmt │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  HTTP Response  │
                   │  text/plain     │
                   └─────────────────┘

┌──────────────────────────────────────────────────────────┐
│ NOTE: Request path is FAST - just reads cached metrics   │
│ No network calls to Cloudflare API during scrape         │
│ (unless account list cache is stale)                     │
└──────────────────────────────────────────────────────────┘
```

### Background Refresh Path: Alarm-Driven Metric Fetching

```
┌──────────────────────────────────────────────┐
│           ALARM TRIGGERS                     │
│ AccountMetricCoordinator: every 60s          │
│ MetricExporter: every 60s + 1-5s fixed jitter│
└──────────────────────────────────────────────┘
```

**AccountMetricCoordinator.alarm()**

```
┌────────────────────────────────────────────────────────────────────────┐
│                 AccountMetricCoordinator.refresh()                     │
│                                                                        │
│  1. Check zone cache (TTL: 1800s / 30 min)                             │
│                                                                        │
│  2. If stale:                                                          │
│     ┌────────────────────────────────────────────────────────────────┐ │
│     │  REST: getZones(accountId)                                     │ │
│     │           └─► DataLoader batches if multiple calls same tick   │ │
│     └────────────────────────────────────────────────────────────────┘ │
│     ┌────────────────────────────────────────────────────────────────┐ │
│     │  REST: getFirewallRules(zoneId) × N zones (parallel)           │ │
│     │           └─► DataLoader batches parallel calls                │ │
│     └────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  3. Push context to MetricExporter DOs:                                │
│     ┌────────────────────────────────────────────────────────────────┐ │
│     │ Account-scoped (13 exporters):                                 │ │
│     │   exporter.updateZoneContext(accountId, accountName, zones)    │ │
│     │                                                                │ │
│     │ Zone-scoped (N exporters, 1 per zone):                         │ │
│     │   exporter.initializeZone(zone, accountId, accountName)        │ │
│     └────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  4. Schedule next alarm (60s)                                          │
└────────────────────────────────────────────────────────────────────────┘
```

**MetricExporter.alarm()**

```
┌────────────────────────────────────────────────────────────────────────┐
│           MetricExporter.refresh() for account-scoped queries          │
│                                                                        │
│  Query Types (13 total):                                               │
│  ├── ACCOUNT-LEVEL (single account per query, 3):                      │
│  │   ├── worker-totals                                                 │
│  │   ├── logpush-account                                               │
│  │   └── magic-transit                                                 │
│  │                                                                     │
│  └── ZONE-LEVEL (all zones batched in one query, 10):                  │
│      ├── http-metrics                                                  │
│      ├── adaptive-metrics                                              │
│      ├── edge-country-metrics                                          │
│      ├── colo-metrics                                                  │
│      ├── colo-error-metrics                                            │
│      ├── request-method-metrics                                        │
│      ├── health-check-metrics                                          │
│      ├── load-balancer-metrics                                         │
│      ├── logpush-zone                                                  │
│      └── origin-status-metrics                                         │
│                                                                        │
│  After fetch: Process counters → Cache metrics → Schedule next alarm   │
│  Jitter: 1-5s fixed (tighter clustering for time range alignment)      │
└────────────────────────────────────────────────────────────────────────┘
```

## Development

```bash
bun install          # Install dependencies
bun run dev          # Run locally (port 8787)
bun run check        # Lint + format check
bun run deploy       # Deploy to Cloudflare
```

## Tech Stack

- **[Hono](https://hono.dev/)** - Web framework
- **[urql](https://formidable.com/open-source/urql/)** - GraphQL client
- **[gql.tada](https://gql-tada.0no.co/)** - Type-safe GraphQL
- **[Zod](https://zod.dev/)** - Schema validation
- **[DataLoader](https://github.com/graphql/dataloader)** - Request batching
- **[Cloudflare SDK](https://developers.cloudflare.com/api/)** - REST API client
- **[Cloudflare KV](https://developers.cloudflare.com/kv/)** - Runtime config persistence

## License

MIT
