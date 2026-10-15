# WMS-BE

WMS backend — NestJS 12 modular monolith (api + jobs shells) with Drizzle migrations on Postgres. Package manager is **bun** everywhere.

## Layout

```
src/
  api/        api shell — the only HTTP surface (health, echo, OpenAPI document)
  jobs/       jobs shell — background/relay workers (outbox relay lands in 1.2+)
  modules/    13 spine modules (ARCHITECTURE-SPINE.md §Structural Seed):
              tenancy, catalog, inventory, inbound, putaway, outbound,
              movements, replenishment, channels, compliance, reporting,
              carriers, notifications
  shared/     primitives (ids/time/money/quantity/pagination), problem-details,
              idempotency + event-bus/outbox seams, Drizzle db layer
drizzle/      generated SQL migrations (committed)
openapi/      exported OpenAPI document (generated — the API contract)
```

Modules own their tables exclusively and communicate only through interfaces and domain events — never each other's tables. No domain schemas exist yet; tenants/zones/bins/SKUs start in stories 1.2–1.4.

## Commands

```sh
bun install
bun run dev          # api on :3000 (bun --watch)
bun run start        # api without watch
bun run lint         # eslint
bun run test         # unit + api e2e suite (jest)
bun run typecheck    # tsc over src/ and test/ (no emit)
bun run build        # tsc → dist/
bun run db:generate  # drizzle-kit generate (after editing src/shared/db/schema.ts)
bun run db:migrate   # apply pending migrations (needs DATABASE_URL)
bun run openapi:export  # write openapi/openapi.json — the API contract
```

## Conventions (AD-9)

- UUIDv7 ids (`src/shared/primitives/ids.ts`), ISO-8601 UTC timestamps, integer base-UoM quantities, integer paise, GST basis points.
- Every error response is RFC 9457 problem-details (`application/problem+json`) with a machine-readable `code` — clients branch on `code`, never prose.
- Every list endpoint uses opaque cursor pagination (keyset on `created_at` + `id`); offset pagination and infinite scroll are banned.
- Every mutating endpoint carries a client-generated ULID idempotency key, de-duped tenant-scoped in the same transaction as the write (seam in `src/shared/idempotency/`; storage lands with the first mutating endpoint).

## API contract (AD-8)

- Base path: `/api/v1`
- OpenAPI document: served at `GET /api/v1/openapi.json` (Swagger UI at `/api/docs`), exported to `openapi/openapi.json` by `bun run openapi:export`
- Consumers (wms-fe web, mobile app) generate typed clients from this document — no hand-written API types on the consuming side
- Only endpoints so far: `GET /health`, `POST /echo`, `GET /openapi.json`

## Environment

Copy `.env.example` → `.env`: `PORT`, `DATABASE_URL`, `JWT_SECRET` (session signing, length-validated), `DATABASE_AUTH_URL` (optional BYPASSRLS connection, falls back to `DATABASE_URL`), and `CORS_ORIGIN` (browser-client origin allow-list, comma-separated — default `http://localhost:3001`, the web dev server).

### Background workers

Every jobs-shell worker is env-gated OFF unless its poll variable is set (milliseconds; unset or `0` = off). `.env.example` documents each one. Among them:

- `OUTBOX_RELAY_POLL_MS` — the outbox relay. Without it every outbox-driven flow (invoices, e-way bills, channel writeback, the notification panel) silently stalls.
- `LEDGER_INTEGRITY_POLL_MS` (story 9-3c, AD-16; recommended `3600000`) — the ledger integrity check, per warehouse: baselines the pre-0026 prefix once (events written before migration 0026 verify with `quantity_delta / 1000`), anchors the hash chain's tail in chunks of `LEDGER_ANCHOR_MAX_RANGE` (default 10,000) up to `LEDGER_ANCHOR_CHUNKS_PER_TICK` (default 10) per tick, re-verifies one anchored range in rotation, and copies anchors to WORM storage. A break is a severity-1 error log and one owner panel entry (`ledger-chain-break`), open until an owner acknowledges it. Off, nothing is anchored and the web's Ledger integrity section reads "Not yet checked". At most `MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK` (default 50) warehouses per tick, a rotating window past that.
  - **WORM storage** — `LEDGER_ANCHOR_WORM=none` (default: anchors stay in Postgres only) or `s3`: S3 Object Lock in COMPLIANCE mode, `AWS_REGION` (default `ap-south-1`), `LEDGER_ANCHOR_S3_BUCKET` (required), `LEDGER_ANCHOR_RETENTION_DAYS` (default 2,557 — 7 years). Credentials come from the AWS SDK default chain. **Provision outside this repo:** a bucket in ap-south-1 created with Object Lock enabled, and an app role allowed `s3:PutObject`, `s3:PutObjectRetention`, `s3:GetObject` and `s3:GetObjectVersion` on `ledger-anchors/*` plus `s3:ListBucket` on the bucket (without it a missing object answers 403, which reads as transient rather than a WORM break). Retention is capped at 36,500 days at boot. A missing bucket, bad region or bad retention fails the boot; a bucket without Object Lock is only discovered at the first put, which then fails and retries every tick.
- `AUDIT_EXPORT_POLL_MS` (story 9-3b) — writes the owner's requested audit exports (gzipped CSV, up to 1,000,000 events) and expires finished ones after 7 days. Off, a requested export stays `queued` and the web reads "Preparing…". The worker proves its snapshot with `pg_stat_activity` (IMPLEMENTATION-GUIDE §7d), so its database role must see every app session.
  - **Session visibility (required).** The app role must hold `pg_read_all_stats`; `scripts/provision-roles.sql` grants it. An existing deployment needs only `grant pg_read_all_stats to wms_app;`. One role for every connection is **not** a substitute: a hidden autovacuum worker still refuses. Without the grant the export (and the storage snapshots, `STORAGE_SNAPSHOT_POLL_MS`) refuses and logs `session-visibility`, naming the role and printing the exact `GRANT`; each worker, when enabled, also checks once at boot and logs one warning if the grant is missing (the boot never fails on it). On PG16+ the grant needs ADMIN OPTION on `pg_read_all_stats`, so on a managed Postgres the master user runs it; verify on the target with `select pg_has_role('wms_app', 'pg_read_all_stats', 'USAGE');` (must be `t`).
  - **The grant's side effect.** The app role can read every session's query text in `pg_stat_activity`. Parameterized queries show only `$n` placeholders (postgres.js sends values out of band), and no `.unsafe()` in `src` inlines a value. A narrower alternative was considered and not taken (human decision): a `SECURITY DEFINER` function returning only `min(xact_start)` and the hidden count.
  - **Long transactions hold both jobs back.** Every session is now visible, so any transaction open since before a snapshot instant — an idle-in-transaction psql, a long `pg_dump` — holds the audit export claim and the storage snapshot days back until it ends. Set `idle_in_transaction_session_timeout` on interactive/operator roles, and time backups so a long `pg_dump` does not span IST midnight (a storage day's end), or accept that day's delay; an export requested during a backup waits for it to finish.
