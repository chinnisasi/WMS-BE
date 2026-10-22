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
bun run db:migrate:deploy [--dry-run] [--allow-locking=<index-or-migration>[,…]]  # the guarded deploy migrator (story 6-2a)
bun run db:provision-roles  # scripts/provision-roles.sql, as the owner, every deploy
bun run openapi:export  # write openapi/openapi.json — the API contract
docker build -t wms-be .  # the production image: API, worker and migrate task alike
```

**Deploying (story 6-2a):** one image for every process, `GET /api/v1/health/ready` for the load balancer, SIGTERM drains and exits 0, and `db:migrate:deploy` refuses an index build on a large table until it is pre-built CONCURRENTLY. The runbook — processes, every environment variable, the deploy order, the CONCURRENTLY table — is the meta repo's `docs/design/DEPLOY.md`.

## Demo data

`bun run seed:demo` creates one fresh, fully populated demo tenant, so the web app (and a paired handheld) shows every built feature with realistic data. It drives the **real HTTP API** of a running backend — every record goes through the command layer, ledger, idempotency, audit and outbox; nothing is written to the database directly. Each run registers a new tenant with timestamp-suffixed emails, so it is safe to re-run.

**Prerequisites**

1. `docker compose up -d` — Postgres (`:55432`) and Valkey (`:56379`).
2. `bun run db:migrate`.
3. `.env` from `.env.example`, with real values for `JWT_SECRET`, `DEVICE_ENCRYPTION_KEY` (device enrollment) and `CARRIER_ENCRYPTION_KEY` (the sandbox carrier connection), plus these workers on — each one turns part of the seed into visible state:

   | Variable | Demo value | What it makes visible |
   |---|---|---|
   | `OUTBOX_RELAY_POLL_MS` | `2000` | GST invoices and e-way bills (raised on dispatch), the notification panel |
   | `EWAY_GATEWAY` | `sandbox` | the e-way bill is *generated* (12-digit EWB number); unset, it stays queued with Part B |
   | `REPLENISHMENT_SCHEDULER_POLL_MS` | `15000` | reorder breaches and the near-expiry batch alert (the seed waits up to 90 s for them) |
   | `AUDIT_EXPORT_POLL_MS` | `10000` | the owner's audit export reaches `ready` |
   | `LEDGER_INTEGRITY_POLL_MS` | `60000` | Ledger integrity reads anchored/verified instead of "Not yet checked" |
   | `RESERVATION_REAPER_POLL_MS`, `OUTBOX_RECONCILE_POLL_MS` | `2000` | normal hold expiry and reconciliation |
   | `STORAGE_SNAPSHOT_POLL_MS` | `300000` | the 3PL client's storage usage (from the next IST day) |
   | `LICENCE_EXPIRY_POLL_MS` | `60000` (dev/demo only — `3600000` in production) | the owner's "Licence expiring" / "Licence expired" panel entries |

**Start order:** backend first (`bun run start` on `:3000`), then the seed, then the web app (wms-fe on `:3001`):

```sh
bun run seed:demo
bun run seed:demo -- --base-url http://localhost:3000/api/v1 --web-url http://localhost:3001
```

**What you get:** two warehouses (Bengaluru DC with ambient, dry and chilled zones; Mumbai FC); a 16-SKU catalog via the CSV import (kg, batch-tracked, serial-tracked, catch-weight, a variant product, a kit, a hazard class, HSN/GST, reorder points); a PO received on an enrolled handheld (batches, a short line, an over-receipt pending review), a blind catch-weight receipt, putaway and a QC hold; an immediate adjustment and two left pending owner approval; a submitted count with an open variance and an open count task; one transfer received and one in transit; a temperature excursion; orders at every stage (dispatched, labelled and manifested; ready to dispatch; picked; in a planned wave; accepted; backordered); GST invoices (incl. the kit order priced by hand — kits always park `awaiting-data`, see PENDING) and a generated e-way bill; an RMA received on the handheld with condition grades and one refused entry in the review queue, plus an open RMA; a 3PL client brand (GlowCo) with tax details, its own SKUs, an active rate card, a partly received ASN, a dispatched order and a client-portal login; and an audit export request.

**What it prints:** a per-step `OK` / `SKIPPED` line as it goes (a failing step never aborts the run — dependants skip with the reason), then a summary: the web URL, the tenant name and id, the warehouses, every login (owner, ops manager, operator, accountant, GlowCo portal — all with password `Demo@12345`), the enrolled demo device (badge-in PIN `2468`), and a fresh one-time **enrollment code** for pairing a real handheld (15-minute TTL — mint another in web Settings → Devices if it lapses; you choose your own PIN at enrollment and badge in with the operator's email).

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
- `LICENCE_EXPIRY_POLL_MS` (story 1-6c; recommended `3600000`) — the drug and FSSAI licence expiry sweep: per tenant with a licence inside its 60-day window, one owner panel entry (`licence-expiry`) when an active licence is 60 days from its `validUntil` and one more once it has passed (IST dates), each once per term. It skips withdrawn licences, departed clients, historical records and a licence a successor covers. Off, no expiry warning is raised (the Licences tab still shows the server's badge).
- `AUDIT_EXPORT_POLL_MS` (story 9-3b) — writes the owner's requested audit exports (gzipped CSV, up to 1,000,000 events) and expires finished ones after 7 days. Off, a requested export stays `queued` and the web reads "Preparing…". The worker proves its snapshot with `pg_stat_activity` (IMPLEMENTATION-GUIDE §7d), so its database role must see every app session.
  - **Session visibility (required).** The app role must hold `pg_read_all_stats`; `scripts/provision-roles.sql` grants it. An existing deployment needs only `grant pg_read_all_stats to wms_app;`. One role for every connection is **not** a substitute: a hidden autovacuum worker still refuses. Without the grant the export (and the storage snapshots, `STORAGE_SNAPSHOT_POLL_MS`) refuses and logs `session-visibility`, naming the role and printing the exact `GRANT`; each worker, when enabled, also checks once at boot and logs one warning if the grant is missing (the boot never fails on it). On PG16+ the grant needs ADMIN OPTION on `pg_read_all_stats`, so on a managed Postgres the master user runs it; verify on the target with `select pg_has_role('wms_app', 'pg_read_all_stats', 'USAGE');` (must be `t`).
  - **The grant's side effect.** The app role can read every session's query text in `pg_stat_activity`. Parameterized queries show only `$n` placeholders (postgres.js sends values out of band), and the one `.unsafe()` in `src` that inlines a value is the role provisioning's `ALTER ROLE … PASSWORD`, which carries a SCRAM-SHA-256 **verifier** (never the password — story 6-2a, C1), run by the migrate task as the owner. A narrower alternative was considered and not taken (human decision): a `SECURITY DEFINER` function returning only `min(xact_start)` and the hidden count.
  - **Long transactions hold both jobs back.** Every session is now visible, so any transaction open since before a snapshot instant — an idle-in-transaction psql, a long `pg_dump` — holds the audit export claim and the storage snapshot days back until it ends. Set `idle_in_transaction_session_timeout` on interactive/operator roles, and time backups so a long `pg_dump` does not span IST midnight (a storage day's end), or accept that day's delay; an export requested during a backup waits for it to finish.
