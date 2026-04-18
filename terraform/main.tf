################################################################################
# Cloudflare Prometheus Exporter — Terraform Deployment (sample)
#
# This is a reference configuration intended as a starting point for customers
# who prefer managing Cloudflare infrastructure as code instead of using the
# `wrangler deploy` CLI.
#
# What this file provisions:
#   - A KV namespace (CONFIG_KV) used for runtime configuration overrides
#   - The Worker script itself, with:
#       * All Durable Object bindings (MetricCoordinator,
#         AccountMetricCoordinator, MetricExporter) using SQLite storage
#       * A rate-limiter binding (CF_API_RATE_LIMITER, 200 req / 10s)
#       * All plain-text `vars` from wrangler.jsonc (with defaults that match)
#       * The CLOUDFLARE_API_TOKEN secret binding (sensitive)
#
# What this file DOES NOT do:
#   - Build the Worker bundle. Terraform uploads a pre-built artifact; the
#     included Makefile runs the build for you (`make apply`), or run
#     `bun install && bunx wrangler deploy --dry-run --outdir=dist`
#     manually before `terraform apply`. The resulting file must be at the
#     path referenced by `var.worker_script_path`.
#   - Configure Prometheus scraping. That is the operator's responsibility.
#
# Optional features (opt-in via variables):
#   - Custom domain: set `var.custom_domain` + `var.custom_domain_zone_id`
#     to attach e.g. metrics.example.com to the Worker.
#   - Tail consumers: set `var.tail_consumers` to forward Worker logs to
#     another Worker (e.g. your log-shipping Worker).
#
# API token requirements:
#   Create an API token at https://dash.cloudflare.com/profile/api-tokens
#   with AT LEAST these permissions:
#     - Account :: Workers Scripts :: Edit           (deploy)
#     - Account :: Workers KV Storage :: Edit        (manage KV namespace)
#     - Account :: Account Analytics :: Read         (exporter's own fetches)
#     - Account :: Account Settings :: Read          (exporter's own fetches)
#     - Zone    :: Analytics :: Read (All zones)     (exporter's own fetches)
#     - Zone    :: Zone :: Read (All zones)          (exporter's own fetches)
#   NOTE: The same token is used both by Terraform (to deploy) and by the
#   Worker at runtime (to query the Cloudflare API). In stricter setups you
#   may want to split these into two separate tokens and pass the runtime
#   token in a separate variable — see `var.cloudflare_api_token_runtime`
#   below for how to do that.
#
# Durable Object migrations:
#   On first deploy, the `migrations` block below creates the three DO
#   classes with `new_tag = "v1"`. If you later rename/delete DO classes you
#   MUST update this block: set `old_tag = "v1"`, bump `new_tag = "v2"`, and
#   add `renamed_classes` / `deleted_classes` as appropriate. Failing to do
#   this will cause `terraform apply` to be rejected by the Cloudflare API.
################################################################################

terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

################################################################################
# Variables
################################################################################

variable "cloudflare_account_id" {
  description = "Cloudflare account ID to deploy the Worker into."
  type        = string
}

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token used by Terraform to deploy the Worker AND (by
    default) by the Worker at runtime to query the Cloudflare API. See the
    header of this file for required permissions. Treat as secret.
  EOT
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token_runtime" {
  description = <<-EOT
    Optional: override the token used by the Worker at runtime. If left null,
    `var.cloudflare_api_token` is reused. Use this if you want the deploy
    token (Workers Scripts/KV edit) to be separate from the runtime token
    (analytics read-only).
  EOT
  type        = string
  sensitive   = true
  default     = null
}

variable "worker_name" {
  description = "Name of the Worker script. Used in the *.workers.dev URL."
  type        = string
  default     = "cloudflare-prometheus-exporter"
}

variable "worker_script_path" {
  description = <<-EOT
    Absolute or module-relative path to the built Worker JavaScript bundle.
    The default resolves to <repo>/dist/worker.js regardless of the cwd
    Terraform was invoked from. Produce the bundle with `make build` or
    `bunx wrangler deploy --dry-run --outdir=dist`.
  EOT
  type        = string
  default     = ""
}

variable "kv_namespace_title" {
  description = "Human-readable name for the CONFIG_KV namespace."
  type        = string
  default     = "cloudflare-prometheus-exporter-config"
}

# --- Runtime configuration vars (defaults match wrangler.jsonc) --------------

variable "query_limit" {
  type    = number
  default = 10000
}

variable "scrape_delay_seconds" {
  type    = number
  default = 300
}

variable "time_window_seconds" {
  type    = number
  default = 60
}

variable "metric_refresh_interval_seconds" {
  type    = number
  default = 60
}

variable "log_format" {
  type    = string
  default = "json"
  validation {
    condition     = contains(["json", "text"], var.log_format)
    error_message = "log_format must be \"json\" or \"text\"."
  }
}

variable "log_level" {
  type    = string
  default = "info"
  validation {
    condition     = contains(["trace", "debug", "info", "warn", "error", "fatal"], var.log_level)
    error_message = "log_level must be one of trace, debug, info, warn, error, fatal."
  }
}

variable "account_list_cache_ttl_seconds" {
  type    = number
  default = 600
}

variable "zone_list_cache_ttl_seconds" {
  type    = number
  default = 1800
}

variable "ssl_certs_cache_ttl_seconds" {
  type    = number
  default = 1800
}

variable "host_metrics_allowlist" {
  description = "Comma-separated list of hostnames to collect per-host metrics for (max 50)."
  type        = string
  default     = ""
}

variable "host_metrics_delay_seconds" {
  type    = number
  default = 60
}

variable "exclude_host" {
  type    = bool
  default = false
}

variable "cf_http_status_group" {
  type    = bool
  default = false
}

variable "metrics_path" {
  type    = string
  default = "/metrics"
}

variable "disable_ui" {
  type    = bool
  default = false
}

variable "disable_config_api" {
  type    = bool
  default = false
}

# --- Optional allowlists (not set in wrangler.jsonc, exposed here for IaC) ---

variable "cf_accounts" {
  description = "Optional comma-separated allowlist of Cloudflare account IDs to scrape."
  type        = string
  default     = null
}

variable "cf_zones" {
  description = "Optional comma-separated allowlist of Cloudflare zone IDs to scrape."
  type        = string
  default     = null
}

variable "cf_free_tier_accounts" {
  description = "Optional comma-separated list of account IDs that are on the free plan (skips paid-tier GraphQL queries)."
  type        = string
  default     = null
}

variable "metrics_denylist" {
  description = "Optional comma-separated list of Prometheus metric names to exclude from output."
  type        = string
  default     = null
}

# --- Optional: custom domain ------------------------------------------------
#
# If both `custom_domain` and `custom_domain_zone_id` are set, a
# cloudflare_workers_custom_domain is created, attaching the Worker to the
# given hostname. The zone must already exist in your Cloudflare account.
# If either is null, no custom domain is created and the Worker is only
# reachable via workers.dev.

variable "custom_domain" {
  description = <<-EOT
    Hostname to attach to the Worker (e.g. "metrics.example.com"). Must be
    the zone apex or a subdomain of `custom_domain_zone_id`. Leave null to
    skip custom domain creation.
  EOT
  type        = string
  default     = null
}

variable "custom_domain_zone_id" {
  description = <<-EOT
    Cloudflare zone ID that contains `custom_domain`. Required if
    `custom_domain` is set; ignored otherwise.
  EOT
  type        = string
  default     = null

  validation {
    condition     = !(var.custom_domain != null && var.custom_domain_zone_id == null)
    error_message = "custom_domain_zone_id is required when custom_domain is set."
  }
}

# --- Optional: tail consumers (log forwarding) ------------------------------
#
# Tail consumers are other Workers that receive this Worker's logs in real
# time. Typical use: a log-shipping Worker that forwards to your SIEM or
# observability backend. See:
#   https://developers.cloudflare.com/workers/observability/logs/tail-workers/

variable "tail_consumers" {
  description = <<-EOT
    List of Workers that should consume this Worker's tail logs. Each entry
    must set `service` (Worker name); `environment` and `namespace` are
    optional. Leave empty to disable log forwarding.
  EOT
  type = list(object({
    service     = string
    environment = optional(string)
    namespace   = optional(string)
  }))
  default = []
}

################################################################################
# Locals
################################################################################

locals {
  runtime_token = coalesce(var.cloudflare_api_token_runtime, var.cloudflare_api_token)

  # Resolve the bundle path so Terraform works regardless of cwd.
  # If the caller passed an explicit path, honor it; otherwise default to
  # <repo-root>/dist/worker.js relative to this module.
  resolved_script_path = (
    var.worker_script_path == ""
    ? "${path.module}/../dist/worker.js"
    : var.worker_script_path
  )

  # plain_text bindings: every var from wrangler.jsonc, stringified.
  plain_text_bindings = {
    QUERY_LIMIT                     = tostring(var.query_limit)
    SCRAPE_DELAY_SECONDS            = tostring(var.scrape_delay_seconds)
    TIME_WINDOW_SECONDS             = tostring(var.time_window_seconds)
    METRIC_REFRESH_INTERVAL_SECONDS = tostring(var.metric_refresh_interval_seconds)
    LOG_FORMAT                      = var.log_format
    LOG_LEVEL                       = var.log_level
    ACCOUNT_LIST_CACHE_TTL_SECONDS  = tostring(var.account_list_cache_ttl_seconds)
    ZONE_LIST_CACHE_TTL_SECONDS     = tostring(var.zone_list_cache_ttl_seconds)
    SSL_CERTS_CACHE_TTL_SECONDS     = tostring(var.ssl_certs_cache_ttl_seconds)
    HOST_METRICS_ALLOWLIST          = var.host_metrics_allowlist
    HOST_METRICS_DELAY_SECONDS      = tostring(var.host_metrics_delay_seconds)
    EXCLUDE_HOST                    = tostring(var.exclude_host)
    CF_HTTP_STATUS_GROUP            = tostring(var.cf_http_status_group)
    METRICS_PATH                    = var.metrics_path
    DISABLE_UI                      = tostring(var.disable_ui)
    DISABLE_CONFIG_API              = tostring(var.disable_config_api)
  }

  # Optional plain_text bindings — only included when the caller sets them.
  optional_plain_text_bindings = merge(
    var.cf_accounts == null ? {} : { CF_ACCOUNTS = var.cf_accounts },
    var.cf_zones == null ? {} : { CF_ZONES = var.cf_zones },
    var.cf_free_tier_accounts == null ? {} : { CF_FREE_TIER_ACCOUNTS = var.cf_free_tier_accounts },
    var.metrics_denylist == null ? {} : { METRICS_DENYLIST = var.metrics_denylist },
  )

  all_plain_text_bindings = merge(local.plain_text_bindings, local.optional_plain_text_bindings)
}

################################################################################
# KV namespace (CONFIG_KV)
################################################################################

resource "cloudflare_workers_kv_namespace" "config_kv" {
  account_id = var.cloudflare_account_id
  title      = var.kv_namespace_title
}

################################################################################
# Worker script
################################################################################

resource "cloudflare_workers_script" "exporter" {
  account_id  = var.cloudflare_account_id
  script_name = var.worker_name

  # Pre-built bundle. Produce with `make build` or:
  #   bunx wrangler deploy --dry-run --outdir=dist
  content_file   = local.resolved_script_path
  content_sha256 = filesha256(local.resolved_script_path)
  main_module    = "worker.js"

  compatibility_date  = "2025-12-09"
  compatibility_flags = ["nodejs_compat"]

  observability = {
    enabled = true
  }

  # Tail consumers (log forwarding). Empty list = no forwarding.
  tail_consumers = [
    for c in var.tail_consumers : {
      service     = c.service
      environment = c.environment
      namespace   = c.namespace
    }
  ]

  # First-time creation of the three Durable Object classes, all SQLite-backed.
  # IMPORTANT: once deployed, do NOT remove or rename classes without adjusting
  # this block (set old_tag = "v1", new_tag = "v2", add renamed/deleted lists).
  migrations = {
    new_tag = "v1"
    new_sqlite_classes = [
      "MetricCoordinator",
      "AccountMetricCoordinator",
      "MetricExporter",
    ]
  }

  bindings = concat(
    # --- KV ---------------------------------------------------------------
    [
      {
        name         = "CONFIG_KV"
        type         = "kv_namespace"
        namespace_id = cloudflare_workers_kv_namespace.config_kv.id
      },
    ],

    # --- Durable Objects --------------------------------------------------
    [
      {
        name       = "MetricCoordinator"
        type       = "durable_object_namespace"
        class_name = "MetricCoordinator"
      },
      {
        name       = "AccountMetricCoordinator"
        type       = "durable_object_namespace"
        class_name = "AccountMetricCoordinator"
      },
      {
        name       = "MetricExporter"
        type       = "durable_object_namespace"
        class_name = "MetricExporter"
      },
    ],

    # --- Rate limiter -----------------------------------------------------
    [
      {
        name         = "CF_API_RATE_LIMITER"
        type         = "ratelimit"
        namespace_id = "1"
        simple = {
          limit  = 200
          period = 10
        }
      },
    ],

    # --- Secret: Cloudflare API token used by the Worker at runtime ------
    [
      {
        name = "CLOUDFLARE_API_TOKEN"
        type = "secret_text"
        text = local.runtime_token
      },
    ],

    # --- Plain-text vars (from wrangler.jsonc + optional extras) ---------
    [
      for k, v in local.all_plain_text_bindings : {
        name = k
        type = "plain_text"
        text = v
      }
    ],
  )
}

################################################################################
# Custom domain (optional)
################################################################################

resource "cloudflare_workers_custom_domain" "exporter" {
  count = var.custom_domain == null ? 0 : 1

  account_id = var.cloudflare_account_id
  zone_id    = var.custom_domain_zone_id
  hostname   = var.custom_domain
  service    = cloudflare_workers_script.exporter.script_name
}

################################################################################
# Outputs
################################################################################

output "worker_name" {
  description = "Name of the deployed Worker script."
  value       = cloudflare_workers_script.exporter.script_name
}

output "config_kv_namespace_id" {
  description = "ID of the CONFIG_KV namespace. Useful if importing into another state file."
  value       = cloudflare_workers_kv_namespace.config_kv.id
}

output "workers_dev_hint" {
  description = "If workers.dev is enabled for your account, the Worker is reachable at https://<worker_name>.<your-subdomain>.workers.dev."
  value       = "https://${cloudflare_workers_script.exporter.script_name}.<your-subdomain>.workers.dev"
}

output "metrics_url" {
  description = "URL Prometheus should scrape, if a custom domain is configured."
  value = (
    var.custom_domain == null
    ? null
    : "https://${var.custom_domain}${var.metrics_path}"
  )
}
