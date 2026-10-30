import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { orders } from '../../shared/db/schema';
import { drawDocumentPdf } from '../../shared/documents/a4-pdf';
import { MAX_LABELS_PER_PRINT } from '../../shared/labels/layout';
import { cartonLabel, labelShipperOf } from '../../shared/labels/shipping/carton-label';
import type { ShippingLabel } from '../../shared/labels/shipping/fields';
import { renderShippingLabelsPdf } from '../../shared/labels/shipping/pdf';
import { thermalSlipLabelCount, thermalSlipLabels } from '../../shared/labels/shipping/thermal-slip';
import { renderShippingLabelsZpl } from '../../shared/labels/shipping/zpl';
import { UUID_RE } from '../../shared/primitives/ids';
import { orderLabelOf } from '../../shared/primitives/order-label';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { InventoryFacade } from '../inventory/inventory.facade';
import { CatalogFacade } from '../catalog/catalog.facade';
import { assertPermission } from '../tenancy/permissions';
import { getMemberRoleIn } from '../tenancy/tenancy.service';
import { orderNotPacked } from './cartons.read';
import { packDocumentInTx, type PackDocument } from './pack-documents.read';
import { layoutPackingSlip, packDocumentFileStem, type PackingSlipAudience } from './packing-slip.layout';


export type PackFileFormat = 'pdf' | 'zpl';
export type PackFileLayout = 'a4' | 'label';

/** One downloaded document. */
export interface PackDocumentFile {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Buffer;
}

/** A parsed `?format=&layout=&cartons=` (A13, A14, A48). */
export interface PackFileQuery {
  readonly format: PackFileFormat;
  readonly layout: PackFileLayout;
  /** Unique, sorted carton numbers; null = every carton. */
  readonly cartons: readonly number[] | null;
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid request', detail);
}

/**
 * A48 — the file routes' query, parsed once: `format` and `layout` from their
 * vocabularies (each with its route's default), `zpl` + `a4` refused (an A4
 * sheet is a PDF), `cartons` a comma list of unique integers 1–200 (a zero or
 * a duplicate is 400; a number above the pack's count is 404, judged later).
 */
export function parsePackFileQuery(
  raw: { readonly format?: unknown; readonly layout?: unknown; readonly cartons?: unknown },
  defaults: { readonly format: PackFileFormat; readonly layout: PackFileLayout },
): PackFileQuery {
  const format = raw.format === undefined || raw.format === '' ? defaults.format : raw.format;
  if (format !== 'pdf' && format !== 'zpl') throw invalid('format is pdf or zpl.');
  const layout = raw.layout === undefined || raw.layout === '' ? defaults.layout : raw.layout;
  if (layout !== 'a4' && layout !== 'label') throw invalid('layout is a4 or label.');
  if (format === 'zpl' && layout === 'a4') throw invalid('The A4 layout is a PDF — send format=pdf, or layout=label for ZPL.');
  let cartons: number[] | null = null;
  if (raw.cartons !== undefined && raw.cartons !== '') {
    if (typeof raw.cartons !== 'string') throw invalid('cartons is a comma-separated list of carton numbers.');
    const parts = raw.cartons.split(',').map((part) => part.trim());
    const numbers: number[] = [];
    for (const part of parts) {
      if (!/^[1-9][0-9]{0,2}$/.test(part) || Number(part) > 200) {
        throw invalid(`cartons lists carton numbers 1 to 200 — "${part}" is not one.`);
      }
      numbers.push(Number(part));
    }
    if (new Set(numbers).size !== numbers.length) throw invalid('cartons names a carton more than once.');
    cartons = [...numbers].sort((left, right) => left - right);
  }
  return { format, layout, cartons };
}

/** The cartons a print selects — 404 for a number above the pack's count. */
function selectCartons(doc: PackDocument, wanted: readonly number[] | null): PackDocument['cartons'] {
  if (wanted === null) return doc.cartons;
  const unknown = wanted.filter((seq) => !doc.cartons.some((carton) => carton.seq === seq));
  if (unknown.length > 0) {
    throw new ProblemException(
      'not-found',
      404,
      'Carton not found',
      `Order ${doc.orderLabel} is packed in ${doc.cartonCount} carton${doc.cartonCount === 1 ? '' : 's'} — there is no carton ${unknown.join(', ')}.`,
    );
  }
  return doc.cartons.filter((carton) => wanted.includes(carton.seq));
}

function tooManyLabels(count: number, firstCartons: string): ProblemException {
  return new ProblemException(
    'too-many-labels',
    422,
    'Too many labels for one print',
    `This print is ${count} labels — at most ${MAX_LABELS_PER_PRINT} print at once. Ask for fewer cartons, e.g. cartons=${firstCartons}.`,
    { count, max: MAX_LABELS_PER_PRINT },
  );
}

/**
 * A48 — the thermal slips of `cartons` print in one go only within `MAX_LABELS_PER_PRINT`; past it,
 * 422 `too-many-labels` naming the leading cartons that fit (or the first carton alone).
 */
export function assertThermalSlipPrintFits(cartons: readonly { readonly seq: number; readonly lines: readonly unknown[] }[]): void {
  const count = cartons.reduce((sum, carton) => sum + thermalSlipLabelCount(carton.lines.length), 0);
  if (count <= MAX_LABELS_PER_PRINT) return;
  let running = 0;
  const fits: number[] = [];
  for (const carton of cartons) {
    running += thermalSlipLabelCount(carton.lines.length);
    if (running > MAX_LABELS_PER_PRINT) break;
    fits.push(carton.seq);
  }
  throw tooManyLabels(count, fits.length === 0 ? String(cartons[0]!.seq) : fits.join(','));
}

/** The 4×6 carton label of each selected carton (A16; COD on carton 1 only — decision 6). */
export function cartonLabelsOf(doc: PackDocument, cartons: PackDocument['cartons']): ShippingLabel[] {
  const shipper = labelShipperOf(doc.client.name, doc.warehouse);
  return cartons.map((carton) =>
    cartonLabel({
      shipper,
      consignee: doc.consignee,
      orderLabel: doc.orderLabel,
      clientOrderRef: doc.clientOrderRef,
      packedAt: doc.packedAt,
      repackedAt: doc.repackedAt,
      cartonNo: carton.seq,
      cartonCount: doc.cartonCount,
      weightGrams: carton.weightGrams,
      dimensionsMm: carton.dimensionsMm,
      payment: doc.payment,
      courierName: doc.shipment?.courierName ?? null,
      awb: doc.shipment?.awb ?? null,
      cartonCode: carton.code,
      // Story 4-6a (A19) — line 1 of the seam band (line 2 stays 4-10a's marks).
      ...(doc.consignmentLine === undefined || doc.consignmentLine === null ? {} : { extraLines: [doc.consignmentLine] }),
      // Story 4-9a (A24) — a pallet's word and inner count (absent on a carton: byte-identical).
      ...(carton.packageType === undefined ? {} : { packageType: carton.packageType }),
      ...(carton.innerCount === undefined ? {} : { innerCount: carton.innerCount }),
    }),
  );
}

/** The 4×6 thermal slips of each selected carton (A18), continuation labels included. */
export function thermalSlipsOf(doc: PackDocument, cartons: PackDocument['cartons']): ShippingLabel[] {
  return cartons.flatMap((carton) =>
    thermalSlipLabels({
      orderLabel: doc.orderLabel,
      cartonNo: carton.seq,
      cartonCount: doc.cartonCount,
      consigneeName: doc.consignee.contactName,
      city: doc.consignee.city,
      pincode: doc.consignee.pincode,
      rows: carton.lines.map((line) => ({ skuCode: line.skuCode, skuName: line.skuName, qty: line.qty, qtyText: line.qtyText, uom: line.uom })),
      totalsText: carton.totals,
      ...(carton.packageType === undefined ? {} : { packageType: carton.packageType }),
    }),
  );
}

/** The A4 packing slip's PDF for one audience, at the document's print instant (same instant → same bytes). */
export async function packingSlipPdf(doc: PackDocument, audience: PackingSlipAudience): Promise<Buffer> {
  return drawDocumentPdf(layoutPackingSlip(doc, { audience }), { title: `Packing slip ${doc.orderLabel}`, creationDate: doc.printedAt });
}

const PACKED_STATUSES = new Set(['ready_to_dispatch', 'dispatched']);

/**
 * Story 4-5a (A12–A14, A19, A20, A35) — the packing documents' three doors:
 * the pack station's files (the slip, ungated; the carton labels,
 * `labels.execute`), the portal's slip and the dispatch email's attachment.
 * Every door reads ONE model (`packDocumentInTx`) in a read-only transaction
 * and renders after it.
 */
@Injectable()
export class PackDocumentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(InventoryFacade) private readonly inventory: InventoryFacade,
    @Inject(CatalogFacade) private readonly catalog: CatalogFacade,
  ) {}

  /** The model, or null (unknown / not the client's / never packed). */
  async documentInTx(
    tx: TenantTx,
    tenantId: string,
    orderId: string,
    options: { readonly clientId?: string; readonly printedAt: string },
  ): Promise<PackDocument | null> {
    const read = await packDocumentInTx(
      tx,
      tenantId,
      orderId,
      {
        ledgerEvents: (t, tenant, warehouse, id) => this.inventory.ledgerEventsByOrderRefInTx(t, tenant, warehouse, id),
        batchFacts: (t, tenant, ids) => this.catalog.batchFactsByIdsInTx(t, tenant, ids),
        serialNumbers: (t, tenant, ids) => this.catalog.serialNumbersByIdsInTx(t, tenant, ids),
      },
      options,
    );
    return read?.doc ?? null;
  }

  /** Reads the staff model of an order whose status is in `allowed` — 404 unknown, 409 `order-not-packed` otherwise. */
  private async staffDocument(tenantId: string, orderId: string, allowed: ReadonlySet<string>): Promise<PackDocument> {
    if (!UUID_RE.test(orderId)) throw new ProblemException('validation-failed', 400, 'Invalid orderId', 'orderId must be a uuid.');
    const id = orderId.toLowerCase();
    return withTenantTransaction(
      this.db,
      tenantId,
      async (tx) => {
        const rows = await tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.id, id))).limit(1);
        const order = rows[0];
        if (order === undefined) throw new ProblemException('not-found', 404, 'Order not found', `No order with id "${orderId}" exists in this tenant.`);
        if (!allowed.has(order.status)) throw orderNotPacked(orderLabelOf(order), order.status);
        const doc = await this.documentInTx(tx, tenantId, id, { printedAt: nowIso() });
        if (doc === null) throw orderNotPacked(orderLabelOf(order), order.status);
        return doc;
      },
      { accessMode: 'read only' },
    );
  }

  /** A13 — `GET …/outbound/orders/{orderId}/packing-slip` (ungated: a document read). */
  async packingSlipFile(tenantId: string, orderId: string, query: PackFileQuery): Promise<PackDocumentFile> {
    const doc = await this.staffDocument(tenantId, orderId, PACKED_STATUSES);
    const stem = packDocumentFileStem(doc.orderLabel);
    if (query.layout === 'a4') {
      // The A4 slip is the whole order — a carton subset is a thermal-slip filter only (never silently ignored).
      if (query.cartons !== null) {
        throw new ProblemException('validation-failed', 400, 'Invalid query', 'cartons selects thermal slips — send layout=label, or drop cartons for the A4 slip.');
      }
      return { filename: `${stem}-packing-slip.pdf`, contentType: 'application/pdf', body: await packingSlipPdf(doc, 'staff') };
    }
    const cartons = selectCartons(doc, query.cartons);
    assertThermalSlipPrintFits(cartons);
    const labels = thermalSlipsOf(doc, cartons);
    return query.format === 'zpl'
      ? { filename: `${stem}-carton-slips.zpl`, contentType: 'text/plain; charset=us-ascii', body: Buffer.from(renderShippingLabelsZpl(labels), 'ascii') }
      : {
          filename: `${stem}-carton-slips.pdf`,
          contentType: 'application/pdf',
          body: await renderShippingLabelsPdf(labels, { layout: 'label', title: `Carton slips ${doc.orderLabel}`, creationDate: doc.printedAt }),
        };
  }

  /** A14 — authority alone, in its own transaction (the 2-10b `assertCanPrint` shape: 403 whatever was sent). */
  async assertCanPrintCartonLabels(tenantId: string, actorUserId: string): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, tenantId, actorUserId), 'labels.execute');
    });
  }

  /** A14 — `GET …/outbound/orders/{orderId}/carton-labels` (`labels.execute`; `ready_to_dispatch` only). */
  async cartonLabelsFile(tenantId: string, actorUserId: string, orderId: string, query: PackFileQuery): Promise<PackDocumentFile> {
    await this.assertCanPrintCartonLabels(tenantId, actorUserId);
    const doc = await this.staffDocument(tenantId, orderId, new Set(['ready_to_dispatch']));
    // One label per carton, at most 200 cartons — always within MAX_LABELS_PER_PRINT.
    const cartons = selectCartons(doc, query.cartons);
    const labels = cartonLabelsOf(doc, cartons);
    const stem = packDocumentFileStem(doc.orderLabel);
    return query.format === 'zpl'
      ? { filename: `${stem}-carton-labels.zpl`, contentType: 'text/plain; charset=us-ascii', body: Buffer.from(renderShippingLabelsZpl(labels), 'ascii') }
      : {
          filename: `${stem}-carton-labels.pdf`,
          contentType: 'application/pdf',
          body: await renderShippingLabelsPdf(labels, { layout: query.layout, title: `Carton labels ${doc.orderLabel}`, creationDate: doc.printedAt }),
        };
  }

  /**
   * A19 — the portal slip's read, on the facade's transaction (stamped with
   * the client — layer one); the order read carries `orders.client_id =
   * $client` (layer two). Null for unknown, another client's, or not packed
   * (one 404).
   */
  async portalPackingSlipDocumentInTx(tx: TenantTx, tenantId: string, clientId: string, orderId: string): Promise<PackDocument | null> {
    if (!UUID_RE.test(orderId)) return null;
    const rows = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId.toLowerCase()), eq(orders.clientId, clientId)))
      .limit(1);
    if (rows[0] === undefined || !PACKED_STATUSES.has(rows[0].status)) return null;
    return this.documentInTx(tx, tenantId, orderId.toLowerCase(), { clientId, printedAt: nowIso() });
  }

  /** A19 / A35 — the client-audience A4 file of a document. */
  async clientPackingSlipFile(doc: PackDocument): Promise<PackDocumentFile> {
    return { filename: `${packDocumentFileStem(doc.orderLabel)}-packing-slip.pdf`, contentType: 'application/pdf', body: await packingSlipPdf(doc, 'client') };
  }

  /**
   * A20 — the dispatch email's attachment renderer, in the CALLER'S
   * transaction (the mail registry opens it read-only and stamped with the
   * row's client). Null when the order is not that client's or not dispatched
   * — the email then goes without the file.
   */
  async packingSlipPdfInTx(
    tx: TenantTx,
    tenantId: string,
    clientId: string,
    orderId: string,
  ): Promise<{ filename: string; contentType: string; content: Uint8Array } | null> {
    if (!UUID_RE.test(orderId)) return null;
    const rows = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId.toLowerCase()), eq(orders.clientId, clientId)))
      .limit(1);
    if (rows[0] === undefined || rows[0].status !== 'dispatched') return null;
    const doc = await this.documentInTx(tx, tenantId, orderId.toLowerCase(), { clientId, printedAt: nowIso() });
    if (doc === null) return null;
    const body = await packingSlipPdf(doc, 'client');
    return { filename: `${packDocumentFileStem(doc.orderLabel)}-packing-slip.pdf`, contentType: 'application/pdf', content: new Uint8Array(body) };
  }
}
