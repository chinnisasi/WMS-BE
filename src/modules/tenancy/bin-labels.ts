import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { bins, zones } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { istDateOf, nowIso } from '../../shared/primitives/time';
import { isBarcodable } from '../../shared/labels/code128';
import {
  MAX_LABELS_PER_PRINT,
  maxCodeLengthFor,
  type BinLabel,
  type LabelFormat,
  type LabelLayout,
  type LabelSize,
  type LabelTarget,
} from '../../shared/labels/layout';
import { renderBinLabelsPdf } from '../../shared/labels/pdf';
import { renderBinLabelsZpl } from '../../shared/labels/zpl';
import { getClientInTx, listClientsInTx } from '../clients/clients.facade';
import { assertPermission } from './permissions';
import { getMemberRoleIn, getWarehouseCodeInTx } from './tenancy.service';

/**
 * Story 2-10a — bin labels: the bins of a warehouse rendered as ZPL or PDF.
 *
 * A READ: printing changes no state, so there is no idempotency key, no
 * audit row and no outbox event (decision 5). One tenant transaction reads
 * everything — authority first (`labels.execute`), then the warehouse, the
 * bins (by id, or a zone's printable bins), their zones' codes and the
 * dedicated clients' codes through the clients facade (AD-6, never a join).
 * Then, before a byte is rendered, the refusals in matrix order — retired,
 * system, not barcodable, too long — each listing every offender. Then the
 * sort (decision 7) and the render.
 */

/** Decision 11 — a zone print is bounded; a list of ids is bounded by the DTO. */
export const MAX_BIN_LABELS = MAX_LABELS_PER_PRINT;
/** A listing refusal carries at most this many codes; the detail counts the rest. */
export const MAX_LISTED_BIN_CODES = 50;

export interface BinLabelsRequest {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
  /** Exactly one of `binIds` / `zoneId` (the controller enforces it). */
  readonly binIds?: readonly string[] | undefined;
  readonly zoneId?: string | undefined;
  readonly format: LabelFormat;
  readonly layout: LabelLayout;
  /** The label size — `label` layout only. */
  readonly size: LabelSize;
}

export interface BinLabelsFile {
  readonly contentType: string;
  readonly filename: string;
  readonly body: Buffer;
  readonly count: number;
}

interface BinFacts {
  readonly id: string;
  readonly code: string;
  readonly zoneId: string;
  readonly storageClass: string;
  readonly dedicatedClientId: string | null;
  readonly retiredAt: string | null;
  readonly systemOwned: boolean;
}

const collator = new Intl.Collator('en', { numeric: true });

/** Decision 7: numeric collation on the code, then plain code comparison, then id. */
export function compareBinsForLabels(a: { code: string; id: string }, b: { code: string; id: string }): number {
  return (
    collator.compare(a.code, b.code) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Decision 12 — `bin-labels-<WH>-<YYYYMMDD>.<ext>`: the IST date, and the
 * warehouse code folded to `[A-Za-z0-9._-]` (every other character becomes
 * `-`). The web builds the same name (the header is not readable
 * cross-origin); this copy goes in `Content-Disposition`.
 */
export function binLabelsFilename(warehouseCode: string, format: LabelFormat, instant: string): string {
  const wh = warehouseCode.replace(/[^A-Za-z0-9._-]/g, '-');
  return `bin-labels-${wh}-${istDateOf(instant).replace(/-/g, '')}.${format}`;
}

export { maxCodeLengthFor };

function listingRefusal(code: string, status: number, title: string, lead: string, offenders: readonly BinFacts[]): ProblemException {
  const codes = [...offenders].sort(compareBinsForLabels).map((b) => b.code);
  const shown = codes.slice(0, MAX_LISTED_BIN_CODES);
  const more = codes.length - shown.length;
  const listed = shown.map((c) => JSON.stringify(c)).join(', ');
  return new ProblemException(code, status, title, `${lead}: ${listed}${more > 0 ? ` +${more} more` : ''}.`, {
    binCodes: shown,
  });
}

function notFound(detail: string): ProblemException {
  return new ProblemException('not-found', 404, 'Not found', detail);
}

@Injectable()
export class BinLabelsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Authority alone, in its own transaction — the controller calls it before
   * any body or path 400, so a role without `labels.execute` gets 403
   * whatever it sent. `render` re-checks inside its own transaction.
   */
  async assertCanPrint(tenantId: string, actorUserId: string): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'labels.execute');
    });
  }

  async render(request: BinLabelsRequest): Promise<BinLabelsFile> {
    const { tenantId, warehouseId } = request;
    const read = await withTenantTransaction(this.db, tenantId, async (tx) => {
      // Authority first: an unauthorised caller learns nothing about what exists.
      assertPermission(await getMemberRoleIn(tx, tenantId, request.actorUserId), 'labels.execute');
      const warehouseCode = await getWarehouseCodeInTx(tx, tenantId, warehouseId);

      const columns = {
        id: bins.id,
        code: bins.code,
        zoneId: bins.zoneId,
        storageClass: bins.storageClass,
        dedicatedClientId: bins.dedicatedClientId,
        retiredAt: bins.retiredAt,
        systemOwned: bins.systemOwned,
      };
      let rows: BinFacts[];
      if (request.binIds !== undefined) {
        // Uuids compare case-insensitively; the controller refused a case-only duplicate.
        const binIds = request.binIds.map((id) => id.toLowerCase());
        rows = await tx
          .select(columns)
          .from(bins)
          .where(and(eq(bins.tenantId, tenantId), eq(bins.warehouseId, warehouseId), inArray(bins.id, binIds)));
        if (rows.length !== binIds.length) {
          const found = new Set(rows.map((r) => r.id));
          const missing = binIds.filter((id) => !found.has(id));
          throw notFound(
            `${missing.length} of the bin ids ${missing.length === 1 ? 'is' : 'are'} not a bin of this warehouse: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` +${missing.length - 10} more` : ''}.`,
          );
        }
      } else {
        const zoneId = request.zoneId!;
        const zone = await tx
          .select({ id: zones.id })
          .from(zones)
          .where(and(eq(zones.tenantId, tenantId), eq(zones.warehouseId, warehouseId), eq(zones.id, zoneId)))
          .limit(1);
        if (zone.length === 0) throw notFound('No zone with this id exists in this warehouse.');
        // Decision 6: a zone print takes its non-retired, non-system bins and skips the rest silently.
        const printable = and(
          eq(bins.tenantId, tenantId),
          eq(bins.warehouseId, warehouseId),
          eq(bins.zoneId, zoneId),
          sql`${bins.retiredAt} is null`,
          eq(bins.systemOwned, false),
        );
        // ONE read bounded at MAX + 1 — the rows checked are the rows printed
        // (a count and a second select could disagree under a concurrent write).
        rows = await tx.select(columns).from(bins).where(printable).limit(MAX_BIN_LABELS + 1);
        if (rows.length === 0) {
          throw new ProblemException(
            'no-bins-to-print',
            404,
            'No bins to print',
            'This zone has no printable bins — it is empty, or every bin in it is retired or a system bin.',
          );
        }
        if (rows.length > MAX_BIN_LABELS) {
          // Only the refusal counts them all, for its message.
          const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(bins).where(printable)) as [{ n: number }];
          throw new ProblemException(
            'too-many-labels',
            422,
            'Too many labels',
            `This zone has ${n} printable bins; one print takes at most ${MAX_BIN_LABELS}. Select the bins to print instead.`,
            { count: n },
          );
        }
      }

      const zoneIds = [...new Set(rows.map((r) => r.zoneId))];
      const zoneRows =
        zoneIds.length === 0
          ? []
          : await tx
              .select({ id: zones.id, code: zones.code })
              .from(zones)
              .where(and(eq(zones.tenantId, tenantId), inArray(zones.id, zoneIds)));
      const zoneCodes = new Map(zoneRows.map((z) => [z.id, z.code]));

      // The dedicated clients' codes through the clients facade (AD-6).
      const clientCodes = new Map<string, string>();
      const clientIds = [...new Set(rows.map((r) => r.dedicatedClientId).filter((id): id is string => id !== null))];
      if (clientIds.length > 0) {
        for (const client of await listClientsInTx(tx, tenantId)) clientCodes.set(client.id, client.code);
        // The list is capped; a client beyond the cap is read one by one.
        for (const id of clientIds) {
          if (!clientCodes.has(id)) clientCodes.set(id, (await getClientInTx(tx, tenantId, id)).code);
        }
      }
      return { warehouseCode, rows, zoneCodes, clientCodes };
    });

    const { rows } = read;
    const target: LabelTarget = request.layout === 'a4' ? { layout: 'a4' } : { layout: 'label', size: request.size };

    // The refusals, in matrix order, each listing every offender.
    const retired = rows.filter((r) => r.retiredAt !== null);
    if (retired.length > 0) {
      throw listingRefusal('bin-retired', 422, 'Retired bins cannot be printed', 'These bins are retired and take no stock, so they get no label', retired);
    }
    const system = rows.filter((r) => r.systemOwned);
    if (system.length > 0) {
      throw listingRefusal(
        'bin-not-printable',
        422,
        'System bins cannot be printed',
        'These are system bins (Receiving, QC hold, in transit, returns) — no handheld scan accepts them, so they get no label',
        system,
      );
    }
    const unbarcodable = rows.filter((r) => !isBarcodable(r.code));
    if (unbarcodable.length > 0) {
      throw listingRefusal(
        'bin-code-not-barcodable',
        422,
        'Bin codes cannot be barcoded',
        'These bin codes carry a character a Code 128 barcode cannot (printable ASCII only, with no leading or trailing space)',
        unbarcodable,
      );
    }
    const maxLength = maxCodeLengthFor(target);
    const tooLong = rows.filter((r) => r.code.length > maxLength);
    if (tooLong.length > 0) {
      const where = target.layout === 'a4' ? 'an A4 sheet cell' : `a ${target.size} label`;
      throw listingRefusal(
        'bin-code-too-long-for-label',
        422,
        'Bin codes too long for the label',
        `These bin codes are longer than ${where} can carry at a scannable bar width (${maxLength} characters at most)`,
        tooLong,
      );
    }

    const labels: BinLabel[] = [...rows].sort(compareBinsForLabels).map((r) => ({
      code: r.code,
      zoneCode: read.zoneCodes.get(r.zoneId) ?? '',
      warehouseCode: read.warehouseCode,
      storageClass: r.storageClass,
      clientCode: r.dedicatedClientId === null ? null : (read.clientCodes.get(r.dedicatedClientId) ?? null),
    }));
    const filename = binLabelsFilename(read.warehouseCode, request.format, nowIso());
    if (request.format === 'zpl') {
      return {
        contentType: 'text/plain; charset=us-ascii',
        filename,
        body: Buffer.from(renderBinLabelsZpl(labels, request.size), 'ascii'),
        count: labels.length,
      };
    }
    return {
      contentType: 'application/pdf',
      filename,
      body: await renderBinLabelsPdf(labels, request.layout === 'a4' ? { layout: 'a4' } : { layout: 'label', size: request.size }),
      count: labels.length,
    };
  }
}
