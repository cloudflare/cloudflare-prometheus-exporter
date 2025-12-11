# Stage 1: Install dependencies with bun
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies using bun
RUN bun install --frozen-lockfile

# Stage 2: Runtime with Node.js LTS
FROM node:24-slim AS runtime

WORKDIR /app

# Install CA certificates for TLS and wrangler globally
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g wrangler

# Copy dependencies from bun stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY package.json wrangler.jsonc tsconfig.json ./
COPY src ./src

# Expose the default wrangler dev port
EXPOSE 8787

# Create entrypoint script that generates .dev.vars from environment variables
# Wrangler expects secrets in .dev.vars file, not shell env vars
RUN printf '#!/bin/sh\n\
    # Generate .dev.vars from environment variables\n\
    : > .dev.vars\n\
    env | grep -E "^(CLOUDFLARE_|CF_)" | while read -r line; do\n\
    echo "$line" >> .dev.vars\n\
    done\n\
    exec wrangler dev --local --ip 0.0.0.0 "$@"\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
