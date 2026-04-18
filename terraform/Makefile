# Terraform deployment helper for cloudflare-prometheus-exporter.
#
# The Worker bundle must be built before `terraform apply` runs (the
# cloudflare_workers_script resource uploads a file, it does not compile).
# This Makefile ties the two steps together so operators never forget.
#
# Usage:
#   make init     # terraform init
#   make build    # build the Worker bundle via wrangler
#   make plan     # build + terraform plan
#   make apply    # build + terraform apply
#   make destroy  # terraform destroy (no build needed)
#   make fmt      # terraform fmt
#   make validate # terraform validate
#   make check    # fmt check + validate (CI-friendly)
#   make clean    # remove ../dist

# Resolve paths relative to this Makefile so `make` works from any cwd.
MAKEFILE_DIR  := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
REPO_ROOT     := $(realpath $(MAKEFILE_DIR)/..)
DIST_DIR      := $(REPO_ROOT)/dist
BUNDLE        := $(DIST_DIR)/worker.js

# Allow override, e.g. `make apply TF=tofu`.
TF            ?= terraform
WRANGLER      ?= bunx wrangler

.PHONY: init build plan apply destroy fmt validate check clean

init:
	$(TF) -chdir=$(MAKEFILE_DIR) init

$(BUNDLE):
	cd $(REPO_ROOT) && $(WRANGLER) deploy --dry-run --outdir=dist

build: $(BUNDLE)

plan: build
	$(TF) -chdir=$(MAKEFILE_DIR) plan

apply: build
	$(TF) -chdir=$(MAKEFILE_DIR) apply

destroy:
	$(TF) -chdir=$(MAKEFILE_DIR) destroy

fmt:
	$(TF) -chdir=$(MAKEFILE_DIR) fmt -recursive

validate:
	$(TF) -chdir=$(MAKEFILE_DIR) init -backend=false
	$(TF) -chdir=$(MAKEFILE_DIR) validate

check:
	$(TF) -chdir=$(MAKEFILE_DIR) fmt -check -recursive
	$(TF) -chdir=$(MAKEFILE_DIR) init -backend=false
	$(TF) -chdir=$(MAKEFILE_DIR) validate

clean:
	rm -rf $(DIST_DIR)
