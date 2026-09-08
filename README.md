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
bun test             # unit + api e2e suite (jest under the hood; bun's runner also passes)
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

Copy `.env.example` → `.env`: `PORT`, `DATABASE_URL`.
