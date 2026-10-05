import { createHash } from 'node:crypto';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import type { EwbBillObject } from './eway-json';

/**
 * The `EwayGateway` port (story 8-2b, PRD OQ3: decided "port now, transport
 * later"). Generating through a gateway is an explicit, audited command on
 * one ready bill; the export-then-record path never touches it.
 *
 * Two adapters ship: `unconfiguredEwayGateway` (production — the system
 * never calls out) and `sandboxEwayGateway` (dev/test, deterministic,
 * in-process). The `EWAY_GATEWAY` env value selects one; it is a MODE, never
 * a credential. A live GSP/NIC adapter plugs in here later and owns auth,
 * encryption, metering and the bulk→API key renames.
 *
 * CONTRACT for a live adapter: before generating, look the EWB up by
 * (GSTIN, `INV`, docNo) and return the existing one if NIC already holds it —
 * a retry after a crash (the claim expired with the call in flight) must
 * never make a duplicate.
 */

export const EWAY_GATEWAY = 'EWAY_GATEWAY' as const;

export const EWAY_GATEWAY_MODES = ['unconfigured', 'sandbox'] as const;
export type EwayGatewayMode = (typeof EWAY_GATEWAY_MODES)[number];

export interface EwayGenerateRequest {
  /** The bill row's id (the sandbox derives its number from it). */
  readonly billId: string;
  readonly bill: EwbBillObject;
}

export interface EwayGenerateResult {
  /** The 12-digit EWB number. */
  readonly ewbNo: string;
  /** ISO-8601 UTC instant. */
  readonly generatedAt: string;
  /** ISO-8601 UTC instant; null for a Part-A-only bill (no validity yet). */
  readonly validUntil: string | null;
}

export interface EwayGateway {
  /**
   * Whether this deployment can generate for the GSTIN. MUST be local — no
   * network I/O: it runs inside transactions that hold row locks (the list
   * read and the generate claim).
   */
  configuredFor(tenantId: string, gstin: string): Promise<boolean>;
  generate(tenantId: string, gstin: string, request: EwayGenerateRequest): Promise<EwayGenerateResult>;
}

/** A BUSINESS refusal (NIC said no) — the bill records `last_error`; a retry needs a fix. */
export class EwayGatewayRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EwayGatewayRefusal';
  }
}

/** A TRANSIENT failure (timeout, 5xx) — the claim is kept and expires; retry later. */
export class EwayGatewayUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EwayGatewayUnavailable';
  }
}

export function gatewayUnconfigured(): ProblemException {
  return new ProblemException(
    'gateway-unconfigured',
    501,
    'E-way gateway not configured',
    'No e-way gateway is configured on this deployment — download the NIC bulk JSON, upload it on the portal and record the EWB number here.',
  );
}

/** Production: never configured, never calls out. */
export function unconfiguredEwayGateway(): EwayGateway {
  return {
    configuredFor: async () => false,
    generate: async () => {
      throw gatewayUnconfigured();
    },
  };
}

/** The transporter name the sandbox refuses (the test hook for the 422 arm). */
export const SANDBOX_REFUSE_TRANSPORTER = 'SANDBOX-REFUSE';

const DAY_MS = 86_400_000;

/**
 * The sandbox: a deterministic 12-digit number from the bill id; validity
 * ⌈max(distance, 1) / 200⌉ days from generation (÷ 20 for over-dimensional
 * cargo) when a Part B exists — a vehicle or a transport document —
 * otherwise null (Part A only); refuses when the
 * transporter name is `SANDBOX-REFUSE`.
 */
export function sandboxEwayGateway(clock: () => string = nowIso): EwayGateway {
  return {
    configuredFor: async () => true,
    generate: async (_tenantId, _gstin, request) => {
      if (request.bill.transporterName === SANDBOX_REFUSE_TRANSPORTER) {
        throw new EwayGatewayRefusal('Sandbox refusal: the transporter is not accepted (SANDBOX-REFUSE).');
      }
      const digest = createHash('sha256').update(request.billId).digest('hex');
      const ewbNo = `1${(BigInt(`0x${digest}`) % 10n ** 11n).toString().padStart(11, '0')}`;
      const generatedAt = new Date(Date.parse(clock())).toISOString();
      // Part A only = no mode-specific Part B (no vehicle, no transport
      // document): no validity yet. Otherwise 200 km a day, 20 for an
      // over-dimensional cargo (vehicle type O).
      const partAOnly = request.bill.vehicleNo === '' && request.bill.transDocNo === '';
      const kmPerDay = request.bill.vehicleType === 'O' ? 20 : 200;
      const validUntil = partAOnly
        ? null
        : new Date(
            Date.parse(generatedAt) + Math.ceil(Math.max(request.bill.transDistance, 1) / kmPerDay) * DAY_MS,
          ).toISOString();
      return { ewbNo, generatedAt, validUntil };
    },
  };
}

/** The env selection: `EWAY_GATEWAY` = `sandbox` | `unconfigured` (default). */
export function ewayGatewayFromEnv(raw: string | undefined = process.env.EWAY_GATEWAY): EwayGateway {
  const mode = raw === undefined || raw.trim() === '' ? 'unconfigured' : raw.trim();
  if (mode === 'sandbox') return sandboxEwayGateway();
  if (mode === 'unconfigured') return unconfiguredEwayGateway();
  throw new Error(`EWAY_GATEWAY must be one of ${EWAY_GATEWAY_MODES.join(', ')} (got "${raw}")`);
}
