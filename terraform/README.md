# Terraform deployment (sample)

Reference Terraform configuration for customers who prefer managing this
exporter as code instead of with `wrangler deploy`. Uses the official
[`cloudflare/cloudflare`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
provider (v5+).

This is a **starting point**, not a published reusable module. Read
`main.tf` before running it — the header comment documents every
assumption.

## Contents

| File                       | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `main.tf`                  | Provider, variables, resources, outputs                     |
| `Makefile`                 | Ties the Worker build step to `terraform plan` / `apply`    |
| `terraform.tfvars.example` | Copy to `terraform.tfvars` and fill in                      |
| `.terraform-version`       | Pins Terraform version for `tfenv` / `asdf` users           |
| `.gitignore`               | Keeps state, tfvars, and `.terraform/` out of git           |

## What it provisions

- `cloudflare_workers_kv_namespace.config_kv` — the `CONFIG_KV` namespace
- `cloudflare_workers_script.exporter` — the Worker, with all Durable Object
  bindings (SQLite-backed), rate-limiter binding, `vars`, and the
  `CLOUDFLARE_API_TOKEN` secret
- `cloudflare_workers_custom_domain.exporter` — **optional**, created only
  when `var.custom_domain` is set

## Prerequisites

1. Terraform 1.9+ (see `.terraform-version`) or OpenTofu 1.6+
2. Bun + Wrangler installed locally (to produce the bundle)
3. A Cloudflare API token with at least these scopes:
   - Account :: Workers Scripts :: Edit (deploy)
   - Account :: Workers KV Storage :: Edit (manage KV)
   - Account :: Account Analytics :: Read (runtime)
   - Account :: Account Settings :: Read (runtime)
   - Zone :: Analytics :: Read (All zones, runtime)
   - Zone :: Zone :: Read (All zones, runtime)

## Usage

### One-shot (recommended)

The Makefile handles the build + apply in one command:

```sh
cd terraform
cp terraform.tfvars.example terraform.tfvars   # then edit
make init
make apply
```

`make apply` will:
1. Build the Worker bundle via `bunx wrangler deploy --dry-run --outdir=dist`
2. Run `terraform apply`

Other targets: `make plan`, `make destroy`, `make fmt`, `make validate`,
`make check` (fmt + validate, CI-friendly), `make clean`.

### Manual

If you'd rather drive each step yourself:

```sh
# From the repo root:
bun install
bunx wrangler deploy --dry-run --outdir=dist

cd terraform
cp terraform.tfvars.example terraform.tfvars   # then edit
terraform init
terraform plan
terraform apply
```

## Updating the Worker

Any time the source changes, rebuild the bundle and re-apply. With the
Makefile this is just `make apply` again. The `content_sha256 =
filesha256(...)` line in `main.tf` ensures Terraform detects the change and
uploads the new version.

## Optional features

### Custom domain

Set `custom_domain` + `custom_domain_zone_id` in `terraform.tfvars` to
attach a hostname like `metrics.example.com`. The zone must already exist in
your Cloudflare account. After `apply`, the `metrics_url` output gives you
the exact URL to point Prometheus at.

### Tail log forwarding

Set `tail_consumers` to forward this Worker's logs to another Worker (e.g.
a log-shipper that writes to your SIEM or observability backend). See
[Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/).

### Separate deploy vs. runtime API tokens

By default the same token is used for Terraform (deploy) and the Worker
(runtime). For least-privilege setups, set `cloudflare_api_token_runtime`
to a token with only `Account Analytics :: Read` + `Zone Analytics :: Read`
and narrow `cloudflare_api_token` to `Workers Scripts :: Edit` +
`Workers KV Storage :: Edit`.

## Durable Object migrations

The config creates the three DO classes on first deploy with
`new_tag = "v1"`. If a future version of this project renames or deletes
any of those classes, you'll need to update the `migrations` block in
`main.tf` accordingly (set `old_tag = "v1"`, bump `new_tag = "v2"`, add
`renamed_classes` / `deleted_classes`). See the Cloudflare docs on
[Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

## Zone routes (alternative to custom domain)

If you'd rather use a pattern-based route instead of a custom domain, add
this resource to `main.tf`:

```hcl
resource "cloudflare_workers_route" "exporter" {
  zone_id     = "<your zone id>"
  pattern     = "metrics.example.com/*"
  script_name = cloudflare_workers_script.exporter.script_name
}
```

Custom domain is preferred for new deployments; routes exist for
compatibility with older setups.

## State / secrets

The API token ends up in Terraform state because it is passed as a
`secret_text` binding on the Worker. Use a remote backend with encryption
at rest (Terraform Cloud, S3 + KMS, GCS with CMEK, etc.) and restrict read
access. A typical S3 backend looks like:

```hcl
terraform {
  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "cloudflare-prometheus-exporter/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "my-terraform-locks"
  }
}
```

Add this to a new `backend.tf` (kept separate so it's easy to swap per
environment) and re-run `terraform init`.
