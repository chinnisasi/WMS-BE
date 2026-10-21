import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { Page } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { ROLE_CAPABILITIES } from '../tenancy/permissions';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import {
  GateInCommand,
  gateInClock,
  gateInNotFound,
  type AmendGateInCommand,
  type CreateGateInCommand,
  type GateInSnapshot,
  type GateInUnloadSnapshot,
  type GateOutCommand,
  type UnloadGateInCommand,
} from './gate-in.command';
import {
  gateInDetailInTx,
  listGateInsInTx,
  type GateInDetailView,
  type GateInEntryView,
  type ListGateInsQuery,
} from './gate-in.read';

/**
 * Story 2-3a — the gate-in's public seam (AD-6): the api shell's only way to
 * the gate-in commands and reads. `gate_ins` and `gate_in_documents` are
 * inbound-exclusive; receiving reads them through `gate-in.read.ts` inside
 * this module.
 */
@Injectable()
export class GateInFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GateInCommand) private readonly command: GateInCommand,
  ) {}

  create(command: CreateGateInCommand, idempotencyKey: string): Promise<GateInSnapshot> {
    return this.command.create(command, idempotencyKey);
  }

  amend(command: AmendGateInCommand, idempotencyKey: string): Promise<GateInSnapshot> {
    return this.command.amend(command, idempotencyKey);
  }

  unload(command: UnloadGateInCommand, idempotencyKey: string): Promise<GateInUnloadSnapshot> {
    return this.command.unload(command, idempotencyKey);
  }

  gateOut(command: GateOutCommand, idempotencyKey: string): Promise<GateInSnapshot> {
    return this.command.gateOut(command, idempotencyKey);
  }

  /** One warehouse's gate-ins (any staff role — a read is never gated); the phone masked. */
  list(tenantId: string, query: ListGateInsQuery): Promise<Page<GateInEntryView>> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertWarehouseInTenant(tx, tenantId, query.warehouseId);
      return listGateInsInTx(tx, tenantId, query, gateInClock.now());
    });
  }

  /**
   * One gate-in's detail. The driver's FULL phone only for a caller whose
   * current role (re-read here, never a token claim) holds `gate.manage`;
   * masked for everyone else (decision 10). 404 when absent.
   */
  get(tenantId: string, actorUserId: string, gateInId: string): Promise<GateInDetailView> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // A non-member reads masked (a ProblemException); any other error — a DB
      // failure, which leaves the transaction aborted — propagates.
      const role = await getMemberRoleIn(tx, tenantId, actorUserId).catch((err: unknown) => {
        if (err instanceof ProblemException) return null;
        throw err;
      });
      const phone = role !== null && ROLE_CAPABILITIES[role].has('gate.manage') ? 'full' : 'masked';
      const detail = await gateInDetailInTx(tx, tenantId, gateInId, phone, gateInClock.now());
      if (detail === null) throw gateInNotFound();
      return detail;
    });
  }
}
