import { UUID_RE } from './ids';
import { ProblemException } from '../problem-details/problem.exception';

/**
 * Story 4-4a (A7) — the courier of a client-arranged shipment or a handover:
 * a transporter partner (staff master data, frozen as `TransporterSnapshotV1`
 * by the command) OR a free-text name, exactly one. The name is trimmed and
 * bounded at 100 code points. Pure; refuses 400 `validation-failed`.
 */
export const MAX_COURIER_NAME_LENGTH = 100;

export interface CourierInput {
  readonly transporterId?: string | null | undefined;
  readonly courierName?: string | null | undefined;
}

export interface NormalizedCourier {
  readonly transporterId: string | null;
  readonly courierName: string | null;
}

export function normalizeCourierInput(input: CourierInput | null | undefined): NormalizedCourier {
  const rawId = input?.transporterId;
  const rawName = input?.courierName;
  const transporterId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim().toLowerCase() : null;
  const courierName = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : null;
  if ((transporterId === null) === (courierName === null)) {
    throw courierProblem('Name the courier: choose a transporter (transporterId) or type its name (courierName) — exactly one.');
  }
  if (transporterId !== null && !UUID_RE.test(transporterId)) {
    throw courierProblem('transporterId must be a uuid.');
  }
  if (courierName !== null && [...courierName].length > MAX_COURIER_NAME_LENGTH) {
    throw courierProblem(`courierName must be at most ${MAX_COURIER_NAME_LENGTH} characters.`);
  }
  return { transporterId, courierName };
}

function courierProblem(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid courier', detail);
}
