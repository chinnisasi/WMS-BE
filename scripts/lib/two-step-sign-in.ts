/**
 * Story 6-1b — the web sign-in from a script (the demo seed, the load
 * tests). An owner's sign-in takes two steps: the password (sent with
 * `X-WMS-Second-Factor: 1`, or the server answers 409 `client-outdated`), then
 * a code from an authenticator. A script has no phone, so it holds the
 * authenticator itself: the secret from the enrolment step, the codes from
 * the exported TOTP (`totpAt`), one step per sign-in (the server accepts each
 * step once; t−1…t+1), waiting for the clock when it has spent them all.
 *
 * Only for scripts. The demo seed prints the `otpauthUri` and the backup codes
 * so a person can add the same account to a real authenticator app.
 */
import { base32Decode, totpAt, totpStepOf, TOTP_STEP_SECONDS } from '../../src/modules/tenancy/second-factor';

export interface Enrolment {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly backupCodes: readonly string[];
}

interface Held {
  readonly secret: Buffer;
  lastStep: number;
  enrolment: Enrolment | null;
}

const held = new Map<string, Held>();

/** The enrolment this process made for the email (the seed prints it), if any. */
export function enrolmentOf(email: string): Enrolment | null {
  return held.get(email.trim().toLowerCase())?.enrolment ?? null;
}

async function nextCode(entry: Held): Promise<string> {
  for (;;) {
    const now = totpStepOf();
    const step = Math.max(now - 1, entry.lastStep + 1);
    if (step <= now + 1) {
      entry.lastStep = step;
      return totpAt(entry.secret, step);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, (now + 1) * TOTP_STEP_SECONDS * 1000 - Date.now() + 50)));
  }
}

async function post(apiBase: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

/**
 * Signs in through both steps and answers the session body (the 6-1a sign-in
 * shape). `apiBase` is the API root including `/api/v1`. Throws on any refusal.
 */
export async function signInTwoStep(apiBase: string, email: string, password: string): Promise<{ accessToken: string } & Record<string, unknown>> {
  const first = await post(apiBase, '/tenants/sign-in', { email, password }, { 'X-WMS-Second-Factor': '1' });
  if (first.status !== 200) throw new Error(`sign-in ${email}: ${first.status} ${JSON.stringify(first.body)}`);
  if (first.body === null || !Object.hasOwn(first.body as object, 'challenge')) return first.body;
  const key = email.trim().toLowerCase();
  if (first.body.challenge === 'enroll') {
    held.set(key, { secret: base32Decode(first.body.secret as string), lastStep: 0, enrolment: null });
  }
  const entry = held.get(key);
  if (entry === undefined) throw new Error(`sign-in ${email}: two-factor sign-in is set up, but not by this process — it has no authenticator for it`);
  const second = await post(apiBase, '/tenants/sign-in/second-factor', { challengeToken: first.body.challengeToken, code: await nextCode(entry) });
  if (second.status !== 200) throw new Error(`sign-in ${email} (second step): ${second.status} ${JSON.stringify(second.body)}`);
  if (first.body.challenge === 'enroll') {
    entry.enrolment = {
      secret: first.body.secret as string,
      otpauthUri: first.body.otpauthUri as string,
      backupCodes: (second.body.backupCodes as string[] | undefined) ?? [],
    };
  }
  return second.body;
}
