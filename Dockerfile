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

# Story 6-2c (decision 9, A19): every base image is pinned to its multi-arch
# index digest — a mutable tag can no longer change what a rebuild runs. The
# tag stays beside the digest for the reader (and must equal .bun-version —
# test/dockerfile.spec.ts); Dependabot proposes digest refreshes weekly.

# ── dependencies: production only, from the frozen lockfile ────────────────
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    PGSSLROOTCERT=/app/certs/rds-global-bundle.pem

# Code review C19: code and dependencies stay ROOT-owned (and not writable
# by the runtime user) — the process can run its code, never rewrite it.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/provision-roles.sql ./scripts/provision-roles.sql
# Story 6-2c (decision 11): AWS's public RDS global CA bundle, root-owned.
# With ?sslmode=verify-full in a database URL, PGSSLROOTCERT (above) is the
# trust the server's certificate is verified against. Public, not a secret.
COPY certs/ ./certs/

# Non-root: the base image's `bun` user (uid 1000) only RUNS it.
USER bun
EXPOSE 3000

# Liveness only (readiness is /health/ready, for the load balancer). Alpine
# ships no curl: Bun's fetch does the probe. Story 6-2c: the worker role
# probes its heartbeat route (/api/v1/health/worker) instead.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.WMS_PROCESS_ROLE==='worker'?'/api/v1/health/worker':'/api/v1/health'),{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Writable at run time: /tmp only — the image runs under
# `--read-only --tmpfs /tmp` (story 6-2c, A15).
#
# The role: WMS_PROCESS_ROLE=api (default) serves the API on PORT;
# WMS_PROCESS_ROLE=worker runs the jobs with a health-only listener on PORT
# (GET /api/v1/health/worker — the worker task's health check).
#
# Exit codes (story 6-2c, A18): 0 graceful stop · 78 boot/config refusal
# (bad role, no jobs, heartbeat setting, DB TLS config, API with jobs in
# production, missing MFA key) · 75 the 25 s drain-timeout force exit ·
# 1 crash.
#
# SIGTERM runs the graceful shutdown (src/shared/lifecycle/shutdown.ts):
# drain, close, exit 0 — or exit 75 at the 25 s force-exit bound.
STOPSIGNAL SIGTERM
CMD ["bun", "src/main.ts"]
