# syntax=docker/dockerfile:1
#
# Multi-stage build. The builder stage installs ALL dependencies (including
# esbuild, a devDependency only needed here) and produces the dist/ bundles
# every package/app needs (see scripts/build-all.mjs) - `npm run relay`
# doesn't work without them, and dist/ is deliberately gitignored (build
# output, not source, so it's never in the build context either way). The
# runtime stage then only carries production dependencies (`npm prune
# --omit=dev` once the build step is done - esbuild's job is finished by
# then) plus the built output, on a fresh base image.

FROM node:22-alpine AS builder
WORKDIR /app

COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S quniverse && adduser -S quniverse -G quniverse
COPY --from=builder --chown=quniverse:quniverse /app .

USER quniverse
EXPOSE 8080

# Config is via environment variables (see packages/relay/src/server.js's
# ENV_MAPPING) - QU_PORT/QU_STORE_DIR/QU_BLOB_DIR/QU_APPS_DIR/
# QU_IDENTITY_MNEMONIC/QU_SERVE_SHELL/QU_REMOTE_APPS_JSON - so a deployment
# never needs to bake or bind-mount a relay.config.json just to set a port
# or data directory (see docker-compose.yml).
CMD ["node", "packages/relay/src/server.js"]
