# Cloudflare Prometheus Exporter

[![Cloudflare Prometheus Exporter](https://github.com/user-attachments/assets/33794cd1-f03d-4382-9bb6-83d77cd01de5)](https://github.com/cloudflare/cloudflare-prometheus-exporter)

Export Cloudflare metrics to Prometheus. Built on Cloudflare Workers with Durable Objects for stateful metric accumulation.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/cloudflare-prometheus-exporter)

## Features

- **90+ Prometheus metrics** - requests, bandwidth, threats, workers, load balancers, SSL certs, hostname-level analytics, network analytics, Magic Transit tunnel health/traffic/SLO, Magic Firewall per-rule visibility, stream video/live, and more
- **Cloudflare Workers** - serverless edge deployment
- **Durable Objects** - stateful counter accumulation for proper Prometheus semantics
- **Background refresh** - alarms fetch data every 60s; scrapes return cached data instantly
- **Rate limiting** - 200 req/10s with exponential backoff
- **Multi-account** - automatically discovers and exports all accessible accounts/zones
- **Runtime config API** - change settings without redeployment via REST endpoints
- **Configurable** - zone filtering, metric denylist, label exclusion, custom metrics path, and more

## Quick Start

### One-Click Deploy

Click the deploy button above. Configure `CLOUDFLARE_API_TOKEN` as a secret after deployment. Configure `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` to protect the exporter with HTTP Basic Auth.

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
| `HOST_METRICS_ALLOWLIST` | - | Comma-separated hostnames for hostname-level metrics (max 50). Empty disables. Adds 1 extra GraphQL call per account per refresh cycle. `EXCLUDE_HOST=true` also disables. |
| `HOST_METRICS_DELAY_SECONDS` | 60 | Ingestion delay for hostname metrics (seconds). Lower values = fresher data for alerting but risk incomplete data. Independent from `SCRAPE_DELAY_SECONDS`. |
| `METRICS_PATH` | /metrics | Custom path for metrics endpoint |
| `BASIC_AUTH_USER` | - | Username for basic auth (secret, default: no auth, requires `BASIC_AUTH_PASSWORD`) |
| `BASIC_AUTH_PASSWORD` | - | Password for basic auth (secret, default: no auth, requires `BASIC_AUTH_USER`) |

### Creating an API Token

**Quick setup**: [Create token with pre-filled permissions](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22ssl_and_certificates%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22firewall_services%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22load_balancers%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_logs%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22magic_transit%22%2C%22type%22%3A%22read%22%7D%5D&name=Cloudflare%20Prometheus%20Exporter)

**Manual setup**:

| Permission | Access | Required |
|------------|--------|----------|
| Zone > Analytics | Read | Yes |
| Account > Account Analytics | Read | Yes |
| Account > Workers Scripts | Read | Yes |
| Zone > SSL and Certificates | Read | Optional |
| Zone > Firewall Services | Read | Optional |
| Zone > Load Balancers | Read | Optional |
| Account > Logs | Read | Optional |
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

### With Basic Auth

Set up basic auth to protect all endpoints:

```bash
wrangler secret put BASIC_AUTH_USER
wrangler secret put BASIC_AUTH_PASSWORD
```

Then configure Prometheus:

```yaml
scrape_configs:
  - job_name: 'cloudflare'
    scrape_interval: 60s
    scrape_timeout: 30s
    basic_auth:
      username: 'your-username'
      password: 'your-password'
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
| `hostMetricsAllowlist` | string | Comma-separated hostnames for hostname-level metrics |
| `hostMetricsDelaySeconds` | number | Ingestion delay for hostname metrics (seconds) |

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
| `cloudflare_zone_requests_ssl_encrypted_total` | counter | zone |
| `cloudflare_zone_requests_content_type_total` | counter | zone, content_type |
| `cloudflare_zone_requests_country_total` | counter | zone, country |
| `cloudflare_zone_requests_status_total` | counter | zone, status |
| `cloudflare_zone_requests_browser_map_page_views_total` | counter | zone, family |
| `cloudflare_zone_requests_ip_class_total` | counter | zone, ip_class |
| `cloudflare_zone_requests_ssl_protocol_total` | counter | zone, ssl_protocol |
| `cloudflare_zone_requests_http_version_total` | counter | zone, http_version |
| `cloudflare_zone_requests_origin_status_country_host_total` | counter | zone, origin_status, country, host |
| `cloudflare_zone_requests_status_country_host_total` | counter | zone, edge_status, country, host |
| `cloudflare_zone_requests_by_method_total` | counter | zone, method |

### Zone Bandwidth Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_bandwidth_total` | counter | zone |
| `cloudflare_zone_bandwidth_cached_total` | counter | zone |
| `cloudflare_zone_bandwidth_ssl_encrypted_total` | counter | zone |
| `cloudflare_zone_bandwidth_content_type_total` | counter | zone, content_type |
| `cloudflare_zone_bandwidth_country_total` | counter | zone, country |

### Zone Threat Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_threats_total` | counter | zone |
| `cloudflare_zone_threats_country_total` | counter | zone, country |
| `cloudflare_zone_threats_type_total` | counter | zone, type |

### Zone Page/Unique Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_pageviews_total` | counter | zone |
| `cloudflare_zone_uniques_total` | counter | zone |

### Colocation Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_colocation_visits_total` | counter | zone, colo, host |
| `cloudflare_zone_colocation_edge_response_bytes_total` | counter | zone, colo, host |
| `cloudflare_zone_colocation_requests_total` | counter | zone, colo, host |
| `cloudflare_zone_colocation_error_visits_total` | counter | zone, colo, host, status |
| `cloudflare_zone_colocation_error_edge_response_bytes_total` | counter | zone, colo, host, status |
| `cloudflare_zone_colocation_error_requests_total` | counter | zone, colo, host, status |

### Firewall Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_firewall_events_total` | counter | zone, action, source, rule, host, country |
| `cloudflare_zone_firewall_bots_detected_total` | counter | zone, bot_score, detection_source |

### Health Check Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_health_check_events_origin_total` | counter | zone, health_status, origin_ip, region, fqdn, failure_reason |
| `cloudflare_zone_health_check_events_avg` | gauge | zone |
| `cloudflare_zone_health_check_rtt_seconds` | gauge | zone, origin_ip, fqdn |
| `cloudflare_zone_health_check_ttfb_seconds` | gauge | zone, origin_ip, fqdn |
| `cloudflare_zone_health_check_tcp_connection_seconds` | gauge | zone, origin_ip, fqdn |
| `cloudflare_zone_health_check_tls_handshake_seconds` | gauge | zone, origin_ip, fqdn |

### Worker Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_worker_requests_total` | counter | script_name |
| `cloudflare_worker_errors_total` | counter | script_name |
| `cloudflare_worker_cpu_time_seconds` | gauge | script_name, quantile |
| `cloudflare_worker_duration_seconds` | gauge | script_name, quantile |

### Load Balancer Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_pool_health_status` | gauge | zone, lb_name, pool_name |
| `cloudflare_zone_pool_requests_total` | counter | zone, lb_name, pool_name, origin_name |
| `cloudflare_zone_lb_pool_rtt_seconds` | gauge | zone, lb_name, pool_name |
| `cloudflare_zone_lb_steering_policy_info` | gauge | zone, lb_name, policy |
| `cloudflare_zone_lb_origins_selected_count` | gauge | zone, lb_name, pool_name |
| `cloudflare_zone_lb_origin_weight` | gauge | zone, lb_name, pool_name, origin_name |

### Logpush Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_logpush_failed_jobs_account_total` | counter | account, job_id, status, destination_type |
| `cloudflare_logpush_failed_jobs_zone_total` | counter | zone, job_id, destination_type |

### Error Rate Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_customer_error_4xx_total` | counter | zone, status, country, host |
| `cloudflare_zone_customer_error_5xx_total` | counter | zone, status, country, host |
| `cloudflare_zone_edge_error_rate` | gauge | zone |
| `cloudflare_zone_origin_error_rate` | gauge | zone |
| `cloudflare_zone_origin_response_duration_seconds` | gauge | zone, status, country, host |

### Cache Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_cache_hit_ratio` | gauge | zone |
| `cloudflare_zone_cache_miss_origin_duration_seconds` | gauge | zone, country, host |

### Bot Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_bot_requests_by_country_total` | counter | zone, country |

### Magic Transit Metrics

**Tunnel Health** (from `magic-transit` query)

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_magic_transit_active_tunnels` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_healthy_tunnels` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_tunnel_failures` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_edge_colo_count` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_tunnel_failure_by_status` | gauge | account, tunnel_name, site_name, result_status |
| `cloudflare_magic_transit_tunnel_state_healthy` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_tunnel_state_degraded` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_tunnel_state_down` | gauge | account, tunnel_name, site_name |

> Tunnel state gauges follow the StateSet pattern: exactly one of `_healthy`, `_degraded`, `_down` is 1 per tunnel, the others are 0. Derived from Cloudflare health check scores (weighted average thresholded at 0.75/0.25).

**Tunnel SLO** (from `magic-transit-slo` query)

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_magic_transit_tunnel_slo_status` | gauge | account, tunnel_name, site_name, status |
| `cloudflare_magic_transit_tunnel_effective_slo` | gauge | account, tunnel_name, site_name |
| `cloudflare_magic_transit_tunnel_target_slo` | gauge | account, tunnel_name, site_name |

**Tunnel Traffic** (from `magic-transit-traffic` query)

Per-tunnel bandwidth and packet counters with ramp method visibility.

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_magic_transit_tunnel_traffic_bits_total` | counter | account, tunnel_name, direction, on_ramp, off_ramp |
| `cloudflare_magic_transit_tunnel_traffic_packets_total` | counter | account, tunnel_name, direction, on_ramp, off_ramp |

### Magic Firewall Metrics

**Per-Rule Sampled Traffic** (from `magic-firewall-samples` query)

Traffic allowed and blocked by specific Magic Firewall rules.

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_magic_firewall_rule_bits_total` | counter | account, rule_id |
| `cloudflare_magic_firewall_rule_packets_total` | counter | account, rule_id |

### Network Analytics Metrics

Traffic volume metrics across Cloudflare's Network Analytics v2 datasets. All are account-level counters with low-cardinality labels. Datasets that don't apply to an account (e.g. no Magic Transit subscription) return no data.

**Magic Transit**

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_network_analytics_magic_transit_bits_total` | counter | account, outcome, direction, ip_protocol, mitigation_system |
| `cloudflare_network_analytics_magic_transit_packets_total` | counter | account, outcome, direction, ip_protocol, mitigation_system |

**Magic Firewall**

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_network_analytics_magic_firewall_bits_total` | counter | account, outcome, direction, ip_protocol |
| `cloudflare_network_analytics_magic_firewall_packets_total` | counter | account, outcome, direction, ip_protocol |

**DDoS Defense (dosd)**

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_network_analytics_dosd_bits_total` | counter | account, outcome, direction, ip_protocol, attack_vector |
| `cloudflare_network_analytics_dosd_packets_total` | counter | account, outcome, direction, ip_protocol, attack_vector |

**Intrusion Detection (IDPS)**

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_network_analytics_idps_bits_total` | counter | account, outcome, direction, ip_protocol |
| `cloudflare_network_analytics_idps_packets_total` | counter | account, outcome, direction, ip_protocol |

**Advanced TCP Protection**

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_network_analytics_tcp_protection_bits_total` | counter | account, outcome, direction, ip_protocol |
| `cloudflare_network_analytics_tcp_protection_packets_total` | counter | account, outcome, direction, ip_protocol |

**Advanced DNS Protection**

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_network_analytics_dns_protection_bits_total` | counter | account, outcome, direction, ip_protocol |
| `cloudflare_network_analytics_dns_protection_packets_total` | counter | account, outcome, direction, ip_protocol |

### Stream Video Playback Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_stream_video_playback_count_total` | counter | account, country, media_type |
| `cloudflare_stream_video_playback_time_viewed_seconds_total` | counter | account, country, media_type |

### Stream Live Input Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_stream_live_input_segments_total` | counter | account, event_code |
| `cloudflare_stream_live_input_bit_rate_bps` | gauge | account, event_code |
| `cloudflare_stream_live_input_gop_duration_seconds` | gauge | account, event_code |
| `cloudflare_stream_live_input_upload_duration_ratio` | gauge | account, event_code |

### Hostname Metrics

Requires `HOST_METRICS_ALLOWLIST` to be set (max 50 hostnames). Disabled when `EXCLUDE_HOST=true`.

All hostname metrics are **gauge snapshots** of the **last completed minute**, designed for alerting. The ingestion delay is controlled by `HOST_METRICS_DELAY_SECONDS` (default: 60s) independently from the global `SCRAPE_DELAY_SECONDS`. Hosts with zero traffic in the minute will not emit series.

**Request counts:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cloudflare_zone_hostname_requests` | gauge | zone, host | Total requests in the last completed minute |
| `cloudflare_zone_hostname_requests_by_status` | gauge | zone, host, status | Requests by HTTP status code |
| `cloudflare_zone_hostname_cache_status` | gauge | zone, host, cache_status | Requests by cache status (hit/miss/etc.) |

**Latency (averages — primary alerting metrics):**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cloudflare_zone_hostname_edge_ttfb_seconds` | gauge | zone, host | Average edge TTFB in seconds |
| `cloudflare_zone_hostname_origin_response_duration_seconds` | gauge | zone, host | Average origin response duration in seconds |

**Latency (percentiles — separate metric families):**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cloudflare_zone_hostname_edge_ttfb_p50_seconds` | gauge | zone, host | P50 edge TTFB in seconds |
| `cloudflare_zone_hostname_edge_ttfb_p95_seconds` | gauge | zone, host | P95 edge TTFB in seconds |
| `cloudflare_zone_hostname_origin_response_duration_p50_seconds` | gauge | zone, host | P50 origin response duration in seconds |
| `cloudflare_zone_hostname_origin_response_duration_p95_seconds` | gauge | zone, host | P95 origin response duration in seconds |

### SSL Certificate Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_zone_certificate_validation_status` | gauge | zone, type, issuer, status |

### Exporter Info Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `cloudflare_exporter_up` | gauge | - |
| `cloudflare_exporter_errors_total` | counter | account_id, error_code |
| `cloudflare_accounts` | gauge | - |
| `cloudflare_zones` | gauge | - |
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
│ │(21) │ .. │(N)  │  │(21) │ .. │(N)  │  │(21) │ .. │(N)  │                     │
│ │acct │    │zone │  │acct │    │zone │  │acct │    │zone │                     │
│ └─────┘    └─────┘  └─────┘    └─────┘  └─────┘    └─────┘                     │
│                                                                                │
│  MetricExporter DOs (per account):                                             │
│  - Account-scoped (21): worker-totals, logpush-account, magic-transit,         │
│    magic-transit-slo, magic-transit-traffic, magic-firewall-samples,           │
│    network-analytics, stream-video-playback, stream-live-inputs,              │
│    http-metrics, adaptive-metrics, edge-country-metrics,                      │
│    colo-metrics, colo-error-metrics, request-method-metrics,                   │
│    health-check-metrics, load-balancer-metrics, logpush-zone,                  │
│    origin-status-metrics, cache-miss-metrics, hostname-http-metrics            │
│  - Zone-scoped (N per account, 1 per zone): ssl-certificates, lb-weight-metrics │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │              CloudflareMetricsClient (per-isolate)                      │   │
│  │  - urql Client (GraphQL)                                                │   │
│  │  - Cloudflare SDK (REST)                                                │   │
│  │  - DataLoader: firewallRulesLoader (batches Promise.all calls)          │   │
│  │  - Global Rate limiter: 200 req/10s with exponential backoff            │   │
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
│21+N │   │     │    │21+N │   │     │    │21+N │   │     │
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
│     │ Account-scoped (21 exporters):                                 │ │
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
│  Query Types (21 total):                                               │
│  ├── ACCOUNT-LEVEL (single account per query, 9):                      │
│  │   ├── worker-totals                                                 │
│  │   ├── logpush-account                                               │
│  │   ├── magic-transit                                                 │
│  │   ├── magic-transit-slo                                             │
│  │   ├── magic-transit-traffic                                         │
│  │   ├── magic-firewall-samples                                        │
│  │   ├── network-analytics                                             │
│  │   ├── stream-video-playback                                         │
│  │   └── stream-live-inputs                                            │
│  │                                                                     │
│  └── ZONE-LEVEL (all zones batched in one query, 12):                  │
│      ├── http-metrics                                                  │
│      ├── adaptive-metrics                                              │
│      ├── edge-country-metrics                                          │
│      ├── colo-metrics                                                  │
│      ├── colo-error-metrics                                            │
│      ├── request-method-metrics                                        │
│      ├── health-check-metrics                                          │
│      ├── load-balancer-metrics                                         │
│      ├── logpush-zone                                                  │
│      ├── origin-status-metrics                                         │
│      ├── cache-miss-metrics                                            │
│      └── hostname-http-metrics                                         │
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
