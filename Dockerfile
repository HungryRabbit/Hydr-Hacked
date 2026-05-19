# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────────────────
# Builder stage
#   - installs full dependency tree (dev included, needed by `tsc`)
#   - compiles TypeScript -> dist/
#   - prunes dev deps so node_modules can be carried straight over
#   - has build tools available in case better-sqlite3 cannot find a
#     prebuilt binary for the target platform; these never reach runtime
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

ENV NODE_ENV=development \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# Native-module build deps (better-sqlite3 falls back to compiling if no
# prebuilt binary matches). Kept in the builder layer only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install deps from the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Copy only what the TypeScript build needs — avoid `COPY . .` so secrets
# (.env), local DBs, sessions, downloads, etc. never enter the image.
COPY tsconfig.json ./
COPY src ./src
COPY plugins ./plugins
COPY views ./views
COPY public ./public

RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# ──────────────────────────────────────────────────────────────────────
# Runtime stage
#   - no compilers, no package manager work, no shell access for the app
#   - dedicated non-root user owns /app and the writable subtrees
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    PORT=3067

# ca-certificates is required for outbound HTTPS (ZT/Hydracker/Movix/etc.).
# Everything else is dropped. The image already ships a `node` system
# user at uid/gid 1000 which we reuse as the unprivileged runtime user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production node_modules and built assets, owned by the runtime user.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist        ./dist
COPY --from=builder --chown=node:node /app/views       ./views
COPY --from=builder --chown=node:node /app/public      ./public
COPY --chown=node:node package.json ./

# Pre-create the directories that will be bind-mounted from the host so
# they exist with the correct owner even if compose mounts them empty.
# /app/database is only used if the LocalDB plugin is enabled.
RUN mkdir -p /app/sessions /app/images /app/database /downloads \
 && chown -R node:node /app/sessions /app/images /app/database /downloads

USER node:node

EXPOSE 3067

# --experimental-sqlite is required by the LocalDB plugin
# (plugins/localdb/index.ts imports `node:sqlite`, which is still flagged
# in Node 22 LTS). Matches the `start` script in package.json.
# Process-level signal handling is wired up in src/index.ts (SIGINT/SIGTERM).
# Zombie reaping is delegated to docker's tini via `init: true` in compose.
CMD ["node", "--experimental-sqlite", "dist/src/index.js"]
