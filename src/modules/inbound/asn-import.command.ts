import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { advanceShipmentNotices, auditEvents } from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_SHEET_UPLOAD_BYTES, importTooLarge, readSheet, type SheetFile } from '../../shared/import/sheet-reader';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { existingWarehouseCodesInTx, getWarehouseCodeInTx } from '../tenancy/tenancy.service';
import {
  assertSingleClientInTx,
  getClientLabelsInTx,
  getClientsByCodesInTx,
  getClientsInTx,
  assertClientTakesWorkInTx,
} from '../clients/clients.facade';
import { CatalogFacade, assertSkusTakeWorkInTx, type SkuByCode } from '../catalog/catalog.facade';
import { kitCannotHoldStock } from '../catalog/kit.store';
import {
  assertAsnAuthorityInTx,
  assertAsnClientInTx,
  assertAsnCodeShape,
  assertLineShape,
  ASN_LINE_KIND,
  duplicateAsnCode,
  emitAsnEvent,
  insertAsnInTx,
  replayAsnKeyInTx,
  writeAsnKeyInTx,
} from './asn.command';
import {
  ASN_IMPORT_COLUMNS,
  ASN_IMPORT_REQUIRED_COLUMNS,
  MAX_ASN_IMPORT_ROWS,
  assertAsnImportCount,
  groupAsnImportRows,
  quantityToMilli,
  readAsnImportRows,
  repeatedSkus,
  resolveAsnGroups,
  rowDisagreements,
  rowError,
  type AsnImportGroup,
  type AsnImportRow,
  type AsnImportRowError,
  type AsnImportRowErrorCode,
} from './asn-import.parse';

export interface ImportAsnsCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The warehouse the ASN card is showing — every ASN of the file lands here. */
  readonly warehouseId: string;
  /** Check file: validate and report, write nothing (no key, no replay, no audit). */
  readonly dryRun: boolean;
  readonly file: SheetFile;
}

/** One ASN the import created — or, on a dry run, would create. */
export interface AsnImportAsn {
  /** Null on a dry run. */
  readonly asnId: string | null;
  readonly asnCode: string;
  readonly clientId: string;
  /** The client as people read it — the tenant's own reads "<tenant name> (your company)". */
  readonly clientLabel: string;
  readonly lineCount: number;
  /** The spreadsheet row of the ASN's first line. */
  readonly firstRow: number;
}

/** The response — and, for an import, the idempotency snapshot. */
export interface AsnImportResponse {
  /** The import's audit target; null on a dry run. */
  readonly importId: string | null;
  readonly dryRun: boolean;
  readonly warehouseId: string;
  readonly fileSha256: string;
  /** Data rows read (blank rows not counted). */
  readonly rowCount: number;
  /** ASNs the file describes. */
  readonly asnCount: number;
  /** ASNs created (dry run: ready to create). */
  readonly acceptedCount: number;
  /** ASNs refused whole. */
  readonly refusedCount: number;
  readonly asns: readonly AsnImportAsn[];
  /** Every refused row, in sheet order, with its own `sku` and `quantity` cells. */
  readonly errors: readonly (AsnImportRowError & { readonly sku: string | null; readonly quantity: string | null })[];
}

const KNOWN_COLUMNS: ReadonlySet<string> = new Set(ASN_IMPORT_COLUMNS);

/** A group that passed every rule, ready to insert. */
interface AcceptedGroup {
  readonly group: AsnImportGroup;
  readonly clientId: string;
  readonly clientCode: string;
  readonly clientLabel: string;
  readonly expectedAt: string | null;
  readonly lines: readonly { readonly skuId: string; readonly announcedQty: number }[];
}

/** Story 1-4b — the `extensions.skuCodes` of a `sku-inactive` refusal. */
function skuCodesOf(error: unknown): string[] {
  if (!(error instanceof ProblemException)) return [];
  const body = error.getResponse() as { extensions?: { skuCodes?: unknown } };
  const codes = body.extensions?.skuCodes;
  return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === 'string') : [];
}

function problemOf(error: unknown): { code: string; detail: string } | null {
  if (!(error instanceof ProblemException)) return null;
  const body = error.getResponse() as { code?: string; detail?: string; title?: string };
  return { code: body.code ?? 'unknown', detail: body.detail ?? body.title ?? error.message };
}

/**
 * The ASN import (2026-10-17): announce many ASNs from one CSV or XLSX file,
 * one row per ASN line, grouped by (client, `asn_code`). Two steps on one
 * route: Check file (`dryRun`) validates and writes nothing; Import creates
 * every valid ASN, each exactly as the operator create would — the same
 * rules, its own `asn.created` outbox event and audit row (`reference` = the
 * bare key) — and refuses every ASN with any bad row whole.
 *
 * Order: fingerprint `{fileSha256, warehouseId}` (above the transaction) →
 * `asn.manage` + the portal refusal → replay (an import only — a dry run
 * takes no key) → size cap → parse → the warehouse (404) → resolve clients,
 * warehouses and SKUs by code → group → validate each group with the
 * operator create's shared checks → dry run returns. Import: each valid
 * group inserts in its own SAVEPOINT (a concurrent create of the same code
 * raises 23505, which aborts only that savepoint — the ASN is refused
 * `duplicate-asn-code` and the run carries on) → one `asn_import.executed`
 * audit row (target `asn_import` → `importId`) → ONE idempotency key whose
 * snapshot is the response (counts and the file's SHA-256 included — the
 * audit row's `reference` is that key).
 */
@Injectable()
export class AsnImportCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  async execute(command: ImportAsnsCommand, idempotencyKey: string | null): Promise<AsnImportResponse> {
    if (!command.dryRun && idempotencyKey === null) {
      throw new Error('AsnImportCommand: an import needs its Idempotency-Key');
    }
    const fileSha256 = createHash('sha256').update(command.file.buffer).digest('hex');
    // The fingerprint is the file's bytes and the target warehouse — never the
    // parsed rows (the catalog import's convention).
    const payloadHash = hashCommandPayload({ fileSha256, warehouseId: command.warehouseId });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority FIRST — before the file is even read (the catalog import's
      // parse-before-authority inversion is not copied).
      await assertAsnAuthorityInTx(tx, command.tenantId, command.actorUserId);
      if (!command.dryRun) {
        const replay = await replayAsnKeyInTx(tx, command.tenantId, idempotencyKey!, payloadHash);
        if (replay !== null) {
          return replay as AsnImportResponse;
        }
      }

      if (command.file.size > MAX_SHEET_UPLOAD_BYTES) {
        throw importTooLarge(`The file is ${command.file.size} bytes — the cap is ${MAX_SHEET_UPLOAD_BYTES} bytes.`);
      }
      const sheet = await readSheet(command.file, {
        knownColumns: KNOWN_COLUMNS,
        requiredColumns: ASN_IMPORT_REQUIRED_COLUMNS,
        maxRows: MAX_ASN_IMPORT_ROWS,
        unknownColumns: 'ignore',
        rowNumbers: 'sheet',
        missingColumns: 'all',
        dateCells: 'ist-wall-clock',
        numberCells: 'excel-display',
      });
      const warehouseCode = await getWarehouseCodeInTx(tx, command.tenantId, command.warehouseId);

      const read = readAsnImportRows(sheet);
      const errors: AsnImportRowError[] = [...read.errors];
      const refusedRows = new Set(read.errors.map((error) => error.rowNumber));
      const refuse = (row: AsnImportRow, code: AsnImportRowErrorCode, detail: string): void => {
        errors.push(rowError(row.rowNumber, row.asnCode, code, detail));
        refusedRows.add(row.rowNumber);
      };

      // ── resolve every code the file names, in bulk ─────────────────────
      const rows = read.rows;
      const clients = await getClientsByCodesInTx(
        tx,
        command.tenantId,
        rows.map((row) => row.client),
      );
      const skus = await this.catalog.getSkusByCodesInTx(
        tx,
        command.tenantId,
        rows.map((row) => row.sku),
      );
      const selectedWarehouse = warehouseCode.toUpperCase();
      const otherWarehouses = await existingWarehouseCodesInTx(
        tx,
        command.tenantId,
        rows.map((row) => row.warehouse).filter((code) => code.toUpperCase() !== selectedWarehouse),
      );

      // ── group: (code, client cell), then settle each ASN's client — a
      //    blank client is the SKUs' client, so it joins that ASN ───────
      // Story 1-1: a code may be held by several clients — every holder is
      // offered to the resolver, which settles each ASN's client.
      const resolution = resolveAsnGroups(
        groupAsnImportRows(rows),
        (cell) => clients.get(cell.toUpperCase())?.id ?? null,
        (row) => (skus.get(row.sku) ?? []).map((sku) => sku.clientId),
      );
      // A row's SKU WITHIN its ASN's client: that client's SKU when it holds
      // the code; otherwise the first holder (another client's — refused
      // `sku-client-mismatch` / `mixed-client` by the attribution rule).
      const skuOf = (row: AsnImportRow, clientId: string | null): SkuByCode | undefined => {
        const holders = skus.get(row.sku) ?? [];
        return (clientId === null ? undefined : holders.find((sku) => sku.clientId === clientId)) ?? holders[0];
      };
      for (const error of resolution.errors) {
        errors.push(error);
        refusedRows.add(error.rowNumber);
      }
      const groups = resolution.groups;
      assertAsnImportCount(groups.length);

      // The codes already used by each client (the `(tenant, client, code)`
      // unique index's pre-check — the insert's 23505 stays the arbiter).
      const used = await this.usedCodes(
        tx,
        command.tenantId,
        groups.filter((entry) => entry.clientId !== null).map((entry) => ({ clientId: entry.clientId!, asnCode: entry.group.asnCode })),
      );
      const clientIdsInPlay = [...new Set(groups.map((entry) => entry.clientId).filter((id): id is string => id !== null))];
      const labels = await getClientLabelsInTx(tx, command.tenantId, clientIdsInPlay);
      // Every client in play by id — a blank-client ASN's client is named by
      // no cell, and its code must never fall back to a uuid.
      const clientFacts = await getClientsInTx(tx, command.tenantId, clientIdsInPlay);

      // ── validate each group with the operator create's rules ───────────
      const accepted: AcceptedGroup[] = [];
      for (const { group, clientId, clientRequired } of groups) {
        const firstRow = group.rows[0]!;
        const groupErrors: AsnImportRowError[] = [];
        const lines: { skuId: string; announcedQty: number }[] = [];

        // Row by row — first failure wins on a row (its cell refusals ran first).
        // Story 1-1: an ASN whose client cannot be settled (`clientRequired`)
        // has no client to resolve its codes in — it reports `client-required`
        // only (below), never kit or precision refusals against an arbitrary
        // holder's SKU.
        for (const row of clientRequired ? [] : group.rows) {
          if (refusedRows.has(row.rowNumber)) continue;
          if (row.client !== '' && !clients.has(row.client.toUpperCase())) {
            refuse(row, 'unknown-client', `No client with code "${row.client}" exists in this tenant.`);
            continue;
          }
          if (row.warehouse !== '' && row.warehouse.toUpperCase() !== selectedWarehouse) {
            if (otherWarehouses.has(row.warehouse.toUpperCase())) {
              refuse(
                row,
                'wrong-warehouse',
                `warehouse "${row.warehouse}" is another warehouse — this import announces into ${warehouseCode}; leave the column blank or switch warehouse.`,
              );
            } else {
              refuse(row, 'unknown-warehouse', `No warehouse with code "${row.warehouse}" exists in this tenant.`);
            }
            continue;
          }
          const sku = skuOf(row, clientId);
          if (sku === undefined) {
            refuse(row, 'unknown-sku', `No SKU with code "${row.sku}" exists in this tenant.`);
            continue;
          }
          if (sku.isKit) {
            // The create's refusal words (`assertNoKitLinesInTx` → kitCannotHoldStock).
            refuse(row, 'kit-cannot-hold-stock', problemOf(kitCannotHoldStock(ASN_LINE_KIND, [sku.code]))!.detail);
            continue;
          }
          const quantity = quantityToMilli(row.quantity, sku.uom, sku.uomPrecision);
          if (!quantity.ok) {
            refuse(row, quantity.code, quantity.detail);
            continue;
          }
          lines.push({ skuId: sku.id, announcedQty: quantity.milli });
        }

        // The ASN's own shape — the create's shared checks, their words.
        try {
          assertAsnCodeShape(group.asnCode);
        } catch (error) {
          groupErrors.push(rowError(firstRow.rowNumber, group.asnCode, 'invalid-asn-code', this.detailOf(error)));
        }
        try {
          assertLineShape(group.rows);
        } catch (error) {
          groupErrors.push(rowError(firstRow.rowNumber, group.asnCode, 'too-many-lines', this.detailOf(error)));
        }
        groupErrors.push(...rowDisagreements(group, warehouseCode), ...repeatedSkus(group));

        // Client attribution over the SKUs that resolved — the create's rule.
        const known = (clientRequired ? [] : group.rows)
          .map((row) => ({ row, sku: skuOf(row, clientId) }))
          .filter((entry): entry is { row: AsnImportRow; sku: SkuByCode } => entry.sku !== undefined);
        const subjectClients = [...new Set(known.map((entry) => entry.sku.clientId))];
        if (clientRequired) {
          // Story 1-1 — every code of this blank-client ASN is held by more
          // than one client: name the client in the file.
          const holders = [...new Set(group.rows.flatMap((row) => (skus.get(row.sku) ?? []).map((sku) => sku.clientId)))];
          const holderLabels = await getClientLabelsInTx(tx, command.tenantId, holders);
          groupErrors.push(
            rowError(
              firstRow.rowNumber,
              group.asnCode,
              'client-required',
              `ASN "${group.asnCode}" names no client, and its SKU codes are held by more than one client ` +
                `(${holders.map((id) => holderLabels.get(id) ?? id).sort().join(', ')}) — fill the client column.`,
            ),
          );
        } else if (known.length > 0) {
          try {
            if (clientId === null) {
              // A blank client whose SKUs span clients (or an unknown client
              // cell, already refused): `mixed-client` when they span.
              if (firstRow.client === '') {
                await assertSingleClientInTx(tx, command.tenantId, subjectClients, `Advance shipment notice "${group.asnCode}"`);
              }
            } else {
              await assertAsnClientInTx(tx, command.tenantId, clientId, group.asnCode, subjectClients);
            }
          } catch (error) {
            const problem = problemOf(error);
            if (problem === null) throw error;
            if (problem.code === 'sku-client-mismatch') {
              for (const entry of known.filter((candidate) => candidate.sku.clientId !== clientId)) {
                groupErrors.push(rowError(entry.row.rowNumber, group.asnCode, 'sku-client-mismatch', problem.detail));
              }
            } else if (problem.code === 'mixed-client') {
              groupErrors.push(rowError(firstRow.rowNumber, group.asnCode, 'mixed-client', problem.detail));
            } else {
              throw error;
            }
          }
        }

        // Story 1-2a — a departed client takes no new ASN, whichever way the
        // group's client was settled (a named client cell or the SKUs' own):
        // a row error on the group's first row, under FOR KEY SHARE.
        if (clientId !== null) {
          try {
            await assertClientTakesWorkInTx(tx, command.tenantId, clientId);
          } catch (error) {
            const problem = problemOf(error);
            if (problem === null || problem.code !== 'client-departed') throw error;
            groupErrors.push(rowError(firstRow.rowNumber, group.asnCode, 'client-departed', problem.detail));
          }
        }

        // Story 1-4b — an inactive SKU takes no new ASN: every row of the
        // group naming one gets `sku-inactive` (the client-departed
        // precedent), after the client checks (decision 13), under the SKU
        // rows' FOR KEY SHARE.
        if (known.length > 0) {
          try {
            await assertSkusTakeWorkInTx(tx, command.tenantId, known.map((entry) => entry.sku.id));
          } catch (error) {
            const problem = problemOf(error);
            if (problem === null || problem.code !== 'sku-inactive') throw error;
            const inactiveCodes = new Set(skuCodesOf(error));
            for (const entry of known.filter((candidate) => inactiveCodes.has(candidate.sku.code))) {
              groupErrors.push(
                rowError(
                  entry.row.rowNumber,
                  group.asnCode,
                  'sku-inactive',
                  `SKU "${entry.sku.code}" is inactive — an inactive SKU takes no new ASNs. Reactivate it first.`,
                ),
              );
            }
          }
        }

        if (clientId !== null && used.has(`${clientId}\u0000${group.asnCode}`)) {
          groupErrors.push(
            rowError(
              firstRow.rowNumber,
              group.asnCode,
              'duplicate-asn-code',
              problemOf(duplicateAsnCode(group.asnCode, labels.get(clientId) ?? clientId))!.detail,
            ),
          );
        }

        errors.push(...groupErrors);
        const clean = groupErrors.length === 0 && group.rows.every((row) => !refusedRows.has(row.rowNumber));
        if (clean && clientId !== null) {
          accepted.push({
            group,
            clientId,
            clientCode: clientFacts.get(clientId)!.code,
            clientLabel: labels.get(clientId) ?? clientId,
            expectedAt: firstRow.expectedAt ?? null,
            lines,
          });
        }
      }

      // The refused row's own sku and quantity cells ride each error, so the
      // report identifies the line (null when the cell was blank).
      const cellsOf = new Map(sheet.map((row) => [row.rowNumber, row.values]));
      const cell = (rowNumber: number, column: string): string | null => {
        const value = (cellsOf.get(rowNumber)?.[column] ?? '').trim();
        return value === '' ? null : value;
      };
      const respond = (importId: string | null, asns: AsnImportAsn[], extra: readonly AsnImportRowError[]): AsnImportResponse => {
        const all = [...errors, ...extra]
          .map((error, index) => ({ error, index }))
          .sort((a, b) => a.error.rowNumber - b.error.rowNumber || a.index - b.index)
          .map(({ error }) => ({ ...error, sku: cell(error.rowNumber, 'sku'), quantity: cell(error.rowNumber, 'quantity') }));
        return {
          importId,
          dryRun: command.dryRun,
          warehouseId: command.warehouseId,
          fileSha256,
          rowCount: sheet.length,
          asnCount: groups.length,
          acceptedCount: asns.length,
          refusedCount: groups.length - asns.length,
          asns,
          errors: all,
        };
      };
      const entryOf = (entry: AcceptedGroup, asnId: string | null): AsnImportAsn => ({
        asnId,
        asnCode: entry.group.asnCode,
        clientId: entry.clientId,
        clientLabel: entry.clientLabel,
        lineCount: entry.lines.length,
        firstRow: entry.group.rows[0]!.rowNumber,
      });

      if (command.dryRun) {
        // Check file: nothing is written — no ASN, no key, no audit row.
        return respond(null, accepted.map((entry) => entryOf(entry, null)), []);
      }

      // ── import: one savepoint per ASN ──────────────────────────────────
      const key = idempotencyKey!;
      const created: AsnImportAsn[] = [];
      const raced: AsnImportRowError[] = [];
      for (const entry of accepted) {
        try {
          const asnId = await tx.transaction(async (savepoint) => {
            const id = await insertAsnInTx(savepoint, {
              tenantId: command.tenantId,
              clientId: entry.clientId,
              clientCode: entry.clientCode,
              warehouseId: command.warehouseId,
              asnCode: entry.group.asnCode,
              expectedAt: entry.expectedAt,
              lines: entry.lines,
            });
            await emitAsnEvent(savepoint, this.outbox, {
              tenantId: command.tenantId,
              actorUserId: command.actorUserId,
              asnId: id,
              type: 'asn.created',
              reference: key,
            });
            return id;
          });
          created.push(entryOf(entry, asnId));
        } catch (error) {
          // A concurrent create committed the same code after the pre-check:
          // the 23505 aborted only this ASN's savepoint.
          const problem = problemOf(error);
          if (problem === null || problem.code !== 'duplicate-asn-code') throw error;
          raced.push(rowError(entry.group.rows[0]!.rowNumber, entry.group.asnCode, 'duplicate-asn-code', problem.detail));
        }
      }

      const importId = uuidv7();
      const response = respond(importId, created, raced);
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'asn_import.executed',
        targetType: 'asn_import',
        targetId: importId,
        reference: key,
        occurredAt: nowIso(),
      });
      await writeAsnKeyInTx(tx, command.tenantId, key, payloadHash, response);
      return response;
    });
  }

  private detailOf(error: unknown): string {
    const problem = problemOf(error);
    if (problem === null) throw error;
    return problem.detail;
  }

  /** `clientId\0asnCode` for every (client, code) pair already used in this tenant. */
  private async usedCodes(
    tx: TenantTx,
    tenantId: string,
    pairs: readonly { readonly clientId: string; readonly asnCode: string }[],
  ): Promise<Set<string>> {
    if (pairs.length === 0) return new Set();
    const rows = await tx
      .select({ clientId: advanceShipmentNotices.clientId, asnCode: advanceShipmentNotices.asnCode })
      .from(advanceShipmentNotices)
      .where(
        and(
          eq(advanceShipmentNotices.tenantId, tenantId),
          inArray(advanceShipmentNotices.clientId, [...new Set(pairs.map((pair) => pair.clientId))]),
          inArray(advanceShipmentNotices.asnCode, [...new Set(pairs.map((pair) => pair.asnCode))]),
        ),
      );
    return new Set(rows.map((row) => `${row.clientId}\u0000${row.asnCode}`));
  }
}
