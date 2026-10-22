# syntax=docker/dockerfile:1
#
# Story 6-2a — the wms-be production image (decision 4). ONE image for every
# process (decision 2): the API task and the worker task run it unchanged and
# differ only by environment — the worker sets the `*_POLL_MS` variables, the
# API leaves them unset (docs/design/DEPLOY.md). The deploy's one-shot
# migrate task runs it too:
#   bun run db:migrate:deploy && bun run db:provision-roles
#
# No secrets are baked in: every key, password and URL comes from the task's
# environment at run time.

ARG BUN_VERSION=1.4.0

# ── dependencies: production only, from the frozen lockfile ────────────────
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json tsconfig.build.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun drizzle ./drizzle
COPY --chown=bun:bun scripts/provision-roles.sql ./scripts/provision-roles.sql

# Non-root: the base image's `bun` user (uid 1000).
USER bun
EXPOSE 3000

# Liveness only (readiness is /health/ready, for the load balancer). Alpine
# ships no curl: Bun's fetch does the probe.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM runs the graceful shutdown (src/shared/lifecycle/shutdown.ts):
# drain, close, exit 0 — or exit 1 at the 25 s force-exit bound.
STOPSIGNAL SIGTERM
CMD ["bun", "src/main.ts"]
