import type { InventoryFacade, ReservationSnapshot } from '../inventory/inventory.facade';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 4-2c — acceptance's reservation path, extracted so the order create
 * (`OrderCommandService`) and the backorder allocation
 * (`AllocationCommandService`) grant through ONE definition: a plain line's
 * `min(qty, ATP)` with bounded race re-probes, and the 11.4 kit block's
 * all-or-nothing rule. The plain grant is byte-for-byte what `reserveLine`
 * did; the kit block adds one thing the create's inline loop lacked (code
 * review C37): a fault thrown mid-block releases the siblings it already
 * granted (the create's outer catch releases only the kits it had finished,
 * so there is no double release).
 */

/** The owner type of every order-line hold (the line id is the owner id). */
export const ORDER_LINE_OWNER_TYPE = 'order';

/** Every acceptance (and allocation) hold's TTL: 7 days. */
export const ORDER_LINE_RESERVATION_TTL_SECONDS = 7 * 24 * 3600;

/** Bounded re-probes after a lost grant race (409 `unavailable`). */
export const MAX_GRANT_ATTEMPTS = 4;

export interface LineGrantRequest {
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly skuId: string;
  /** Milli-units — the most the line wants. */
  readonly quantity: number;
  /** The order line's id (the hold's owner). */
  readonly ownerId: string;
  /**
   * Story 4-2c (A6) — grant only when ATP covers the WHOLE quantity (an
   * inactive SKU sells existing stock only; a kit component). False: the
   * plain line's `min(qty, ATP)`.
   */
  readonly wholeOnly?: boolean;
}

function codeOf(error: ProblemException): string | undefined {
  const response = error.getResponse();
  return typeof response === 'object' && response !== null ? (response as { code?: string }).code : undefined;
}

/**
 * One line's hold: `min(qty, ATP)` (or the whole quantity only, `wholeOnly`).
 * A grant that loses a stock race (409 `unavailable`) re-probes, at most
 * `MAX_GRANT_ATTEMPTS` times; a line with nothing left to reserve gets NO
 * hold (null). A 503 (store down) and every other fault propagate.
 */
export async function grantLineHold(inventory: InventoryFacade, request: LineGrantRequest): Promise<ReservationSnapshot | null> {
  for (let attempt = 0; attempt < MAX_GRANT_ATTEMPTS; attempt += 1) {
    const atp = await inventory.atp(request.tenantId, request.warehouseId, request.skuId);
    if (request.wholeOnly === true && atp.atp < request.quantity) {
      return null;
    }
    const target = Math.min(request.quantity, atp.atp);
    if (target <= 0) {
      return null; // the fixed backorder policy: the shortfall is the line's status
    }
    try {
      return await inventory.grantReservation({
        tenantId: request.tenantId,
        warehouseId: request.warehouseId,
        skuId: request.skuId,
        ownerType: ORDER_LINE_OWNER_TYPE,
        ownerId: request.ownerId,
        quantity: target,
        ttlSeconds: ORDER_LINE_RESERVATION_TTL_SECONDS,
      });
    } catch (err) {
      const raceLoser = err instanceof ProblemException && err.getStatus() === 409 && codeOf(err) === 'unavailable';
      if (!raceLoser) {
        throw err;
      }
      if (attempt < MAX_GRANT_ATTEMPTS - 1) {
        continue; // re-probe: a concurrent grant consumed units mid-grant
      }
      return null;
    }
  }
  return null;
}

export interface KitComponentGrant {
  readonly skuId: string;
  /** Milli-units — the component line's full quantity. */
  readonly quantity: number;
  readonly ownerId: string;
}

/**
 * The 11.4 kit block: components grant in order through `grantLineHold`, and
 * a kit may not hold PART of anything — a hold below a component's full
 * quantity is a shortfall too, so every sibling this attempt granted is
 * released (`release`, the caller's cause-labelled release) and the kit
 * gets nothing (null). A fault mid-block releases what it granted and
 * propagates.
 */
export async function grantKitBlock(
  inventory: InventoryFacade,
  scope: { readonly tenantId: string; readonly warehouseId: string },
  components: readonly KitComponentGrant[],
  release: (holds: readonly ReservationSnapshot[]) => Promise<void>,
): Promise<ReservationSnapshot[] | null> {
  const holds: ReservationSnapshot[] = [];
  try {
    for (const component of components) {
      const reservation = await grantLineHold(inventory, {
        tenantId: scope.tenantId,
        warehouseId: scope.warehouseId,
        skuId: component.skuId,
        quantity: component.quantity,
        ownerId: component.ownerId,
      });
      if (reservation === null) {
        await release(holds);
        return null;
      }
      // Pushed BEFORE the shortfall check: the partial hold is a real
      // journal row — it must release with its siblings, never orphan.
      holds.push(reservation);
      if (reservation.quantity < component.quantity) {
        await release(holds);
        return null;
      }
    }
  } catch (err) {
    await release(holds);
    throw err;
  }
  return holds;
}
