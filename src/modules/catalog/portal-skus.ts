import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import type { Page } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { uomPrecision } from './uom';

/**
 * Story 21-7b — the client portal's SKU list: the options the "Announce a
 * shipment" form offers. Every NON-KIT SKU of ONE client — a kit's stock IS
 * its components' and receiving refuses a kit line (FR-38), so a kit on an
 * announced ASN could never be received; the announce command refuses one
 * 409 `kit-cannot-hold-stock` behind this list.
 *
 * Portal vocabulary (as on `portal/stock`): `{skuId, skuCode, skuName,
 * baseUom, uomPrecision}` — an exact key allowlist, nothing else of the
 * catalog row (no cost, no HSN, no barcode, no dimensions). `uomPrecision`
 * is the decimal places the unit admits (0 for a whole-unit UoM), the
 * form's quantity step.
 *
 * Two layers, both required (21-7): the explicit `s.client_id = $client`
 * predicate here, and the caller's transaction stamped `app.client_id`
 * (the `skus` policy filters by client — RLS).
 */
export interface PortalSkuRow {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly baseUom: string;
  readonly uomPrecision: number;
}

/** The SKU keyset: `(code, id)` ascending — its own codec. */
interface SkuCursor {
  readonly code: string;
  readonly id: string;
}

export function encodePortalSkuCursor(cursor: SkuCursor): string {
  return Buffer.from(JSON.stringify({ code: cursor.code, id: cursor.id }), 'utf8').toString('base64url');
}

export function decodePortalSkuCursor(cursor: string): SkuCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SkuCursor).code !== 'string' ||
      (parsed as SkuCursor).code === '' ||
      typeof (parsed as SkuCursor).id !== 'string' ||
      !UUID_RE.test((parsed as SkuCursor).id)
    ) {
      throw new Error('malformed portal SKU cursor');
    }
    return { code: (parsed as SkuCursor).code, id: (parsed as SkuCursor).id };
  } catch {
    throw new ProblemException(
      'invalid-cursor',
      400,
      'Malformed pagination cursor',
      'The cursor parameter is not a valid opaque page cursor.',
    );
  }
}

export async function portalSkusInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  query: { readonly cursor?: string; readonly limit: number },
): Promise<Page<PortalSkuRow>> {
  const after = query.cursor === undefined ? null : decodePortalSkuCursor(query.cursor);
  const rows = (await tx.execute(sql`
    select s.id, s.code, s.name, s.uom
    from skus s
    where s.tenant_id = ${tenantId}::uuid
      and s.client_id = ${clientId}::uuid
      and not exists (
        select 1 from kit_compositions k
        where k.tenant_id = s.tenant_id and k.kit_sku_id = s.id
      )
      ${after === null ? sql`` : sql`and (s.code, s.id) > (${after.code}::text, ${after.id}::uuid)`}
    order by s.code asc, s.id asc
    limit ${query.limit + 1}::int
  `)) as unknown as { id: string; code: string; name: string; uom: string }[];
  const kept = rows.slice(0, query.limit);
  const last = kept.at(-1);
  return {
    items: kept.map((row) => ({
      skuId: row.id,
      skuCode: row.code,
      skuName: row.name,
      baseUom: row.uom,
      uomPrecision: uomPrecision(row.uom),
    })),
    nextCursor: rows.length > query.limit && last !== undefined ? encodePortalSkuCursor({ code: last.code, id: last.id }) : null,
  };
}
