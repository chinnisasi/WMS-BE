import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { goodsReceiptLines, lpns, skus } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { fromMilli } from '../../shared/primitives/quantity';
import { istDateOf, nowIso } from '../../shared/primitives/time';
import { isBarcodable } from '../../shared/labels/code128';
import {
  MAX_LABELS_PER_PRINT,
  lpnLabelText,
  maxCodeLengthFor,
  type LabelFormat,
  type LabelLayout,
  type LabelSize,
  type LabelTarget,
} from '../../shared/labels/layout';
import { renderLabelsPdf } from '../../shared/labels/pdf';
import { renderLabelsZpl } from '../../shared/labels/zpl';
import { CatalogFacade } from '../catalog/catalog.facade';
import { getClientsInTx } from '../clients/clients.facade';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { grnHeaderInTx } from './lpn.command';

/**
 * Story 2-10b — LPN labels: a receipt's licence plates rendered as ZPL or PDF
 * through 2-10a's shared renderer (`src/shared/labels`). The `BinLabelsService`
 * shape: a READ — no idempotency key, no audit row, no outbox event. One
 * tenant transaction reads everything (authority first), then every refusal
 * is thrown before a byte is rendered.
 *
 * What prints: `lpnIds` (a reprint — each of this receipt, none voided), or a
 * line's non-voided LPNs, or (neither) every non-voided LPN of the receipt —
 * in code order. A placed LPN still prints (a damaged label's reprint).
 */

/** A5 — one print renders at most this many labels; the web chunks above it. */
export const MAX_LPN_LABELS = MAX_LABELS_PER_PRINT;
/** A listing refusal carries at most this many codes; the detail counts the rest. */
export const MAX_LISTED_LPN_CODES = 50;

export interface LpnLabelsRequest {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly grnId: string;
  /** At most one of `lpnIds` / `grnLineId` (the controller enforces it). */
  readonly lpnIds?: readonly string[] | undefined;
  readonly grnLineId?: string | undefined;
  readonly format: LabelFormat;
  readonly layout: LabelLayout;
  /** The label size — `label` layout only. */
  readonly size: LabelSize;
}

export interface LpnLabelsFile {
  readonly contentType: string;
  readonly filename: string;
  readonly body: Buffer;
  readonly count: number;
}

/**
 * `lpn-labels-<GRN>-<YYYYMMDD>.<ext>`: the IST date, and the GRN code folded
 * to `[A-Za-z0-9._-]` (every other character becomes `-`) — the 2-10a fold.
 * The web builds the same name (the header is not readable cross-origin).
 */
export function lpnLabelsFilename(grnCode: string, format: LabelFormat, instant: string): string {
  const grn = grnCode.replace(/[^A-Za-z0-9._-]/g, '-');
  return `lpn-labels-${grn}-${istDateOf(instant).replace(/-/g, '')}.${format}`;
}

function listingRefusal(code: string, status: number, title: string, lead: string, offenders: readonly { code: string; seq: number }[]): ProblemException {
  const codes = [...offenders].sort((a, b) => a.seq - b.seq).map((row) => row.code);
  const shown = codes.slice(0, MAX_LISTED_LPN_CODES);
  const more = codes.length - shown.length;
  return new ProblemException(code, status, title, `${lead}: ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}.`, { lpnCodes: shown });
}

@Injectable()
export class LpnLabelsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // The batch codes and expiries (catalog-owned, AD-6).
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

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

  async render(request: LpnLabelsRequest): Promise<LpnLabelsFile> {
    const { tenantId } = request;
    const read = await withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, request.actorUserId), 'labels.execute');
      const grn = await grnHeaderInTx(tx, tenantId, request.grnId.toLowerCase());
      const columns = {
        id: lpns.id,
        seq: lpns.seq,
        code: lpns.code,
        skuId: lpns.skuId,
        batchId: lpns.batchId,
        clientId: lpns.clientId,
        qty: lpns.qty,
        status: lpns.status,
      };
      let rows: { id: string; seq: number; code: string; skuId: string; batchId: string | null; clientId: string; qty: number; status: string }[];
      if (request.lpnIds !== undefined) {
        const ids = request.lpnIds.map((id) => id.toLowerCase());
        rows = await tx
          .select(columns)
          .from(lpns)
          .where(and(eq(lpns.tenantId, tenantId), eq(lpns.grnId, grn.id), inArray(lpns.id, ids)));
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((row) => row.id));
          const missing = ids.filter((id) => !found.has(id));
          throw new ProblemException(
            'not-found',
            404,
            'Not found',
            `${missing.length} of the LPN ids ${missing.length === 1 ? 'is' : 'are'} not an LPN of goods receipt "${grn.code}": ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` +${missing.length - 10} more` : ''}.`,
          );
        }
      } else {
        const scope = [eq(lpns.tenantId, tenantId), eq(lpns.grnId, grn.id), ne(lpns.status, 'voided')];
        if (request.grnLineId !== undefined) {
          const lineId = request.grnLineId.toLowerCase();
          const line = await tx
            .select({ id: goodsReceiptLines.id })
            .from(goodsReceiptLines)
            .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.grnId, grn.id), eq(goodsReceiptLines.id, lineId)))
            .limit(1);
          if (line[0] === undefined) {
            throw new ProblemException('not-found', 404, 'Not found', `No line with id "${lineId}" exists on goods receipt "${grn.code}".`);
          }
          scope.push(eq(lpns.grnLineId, lineId));
        }
        // ONE read bounded at MAX + 1 — the rows checked are the rows printed.
        rows = await tx.select(columns).from(lpns).where(and(...scope)).orderBy(asc(lpns.seq)).limit(MAX_LPN_LABELS + 1);
        if (rows.length === 0) {
          throw new ProblemException(
            'no-lpns-to-print',
            404,
            'No LPNs to print',
            request.grnLineId !== undefined
              ? 'This line has no LPN that is not voided — create labels first.'
              : 'This goods receipt has no LPN that is not voided — create labels first.',
          );
        }
        if (rows.length > MAX_LPN_LABELS) {
          const [{ n }] = (await tx.select({ n: sql<string>`count(*)::bigint` }).from(lpns).where(and(...scope))) as [{ n: string }];
          const count = Number(n);
          throw new ProblemException(
            'too-many-labels',
            422,
            'Too many labels',
            `This print would render ${count} labels; one print takes at most ${MAX_LPN_LABELS}. Print them in parts.`,
            { count },
          );
        }
      }

      const skuRows = await tx
        .select({ id: skus.id, code: skus.code, uom: skus.uom })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, [...new Set(rows.map((row) => row.skuId))])));
      const batchFacts = await this.catalog.batchFactsByIdsInTx(
        tx,
        tenantId,
        [...new Set(rows.map((row) => row.batchId).filter((id): id is string => id !== null))],
      );
      // The clients' codes through ONE by-ids facade read (AD-6); the tenant's own prints no client line.
      const clientFacts = await getClientsInTx(tx, tenantId, rows.map((row) => row.clientId));
      return { grn, rows, skuById: new Map(skuRows.map((row) => [row.id, row])), batchFacts, clientFacts };
    });

    const { rows } = read;
    const target: LabelTarget = request.layout === 'a4' ? { layout: 'a4' } : { layout: 'label', size: request.size };

    // The refusals, before a byte, each listing every offender.
    const voided = rows.filter((row) => row.status === 'voided');
    if (voided.length > 0) {
      throw listingRefusal('lpn-voided', 422, 'Voided LPNs cannot be printed', 'These LPNs are voided and never print again', voided);
    }
    const maxLength = maxCodeLengthFor(target);
    const tooLong = rows.filter((row) => !isBarcodable(row.code) || row.code.length > maxLength);
    if (tooLong.length > 0) {
      const where = target.layout === 'a4' ? 'an A4 sheet cell' : `a ${target.size} label`;
      throw listingRefusal(
        'lpn-code-too-long-for-label',
        422,
        'LPN codes too long for the label',
        `These LPN codes are longer than ${where} can carry at a scannable bar width (${maxLength} characters at most) — pick a larger label`,
        tooLong,
      );
    }

    const lines = [...rows]
      .sort((a, b) => a.seq - b.seq)
      .map((row) => {
        const sku = read.skuById.get(row.skuId);
        const batch = row.batchId === null ? undefined : read.batchFacts.get(row.batchId);
        const client = read.clientFacts.get(row.clientId);
        return lpnLabelText({
          code: row.code,
          skuCode: sku?.code ?? '',
          qty: fromMilli(row.qty),
          uom: sku?.uom ?? '',
          grnCode: read.grn.code,
          batchCode: batch?.code ?? null,
          expiryDate: batch?.expiryDate == null ? null : istDateOf(batch.expiryDate),
          clientCode: client === undefined || client.systemOwned ? null : client.code,
        });
      });
    const filename = lpnLabelsFilename(read.grn.code, request.format, nowIso());
    if (request.format === 'zpl') {
      return {
        contentType: 'text/plain; charset=us-ascii',
        filename,
        body: Buffer.from(renderLabelsZpl(lines, request.size), 'ascii'),
        count: lines.length,
      };
    }
    return {
      contentType: 'application/pdf',
      filename,
      body: await renderLabelsPdf(lines, request.layout === 'a4' ? { layout: 'a4', title: 'LPN labels' } : { layout: 'label', size: request.size, title: 'LPN labels' }),
      count: lines.length,
    };
  }
}
