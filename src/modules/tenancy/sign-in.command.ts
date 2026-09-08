import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AUTH_DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { tenants, users } from '../../shared/db/schema';
import type { UserRole, UserStatus } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { SESSION_TTL_SECONDS, signTenantSession, tenantSessionSecret } from './jwt-session';
import { DUMMY_HASH, verifyPassword } from './passwords';

export interface SignInInput {
  readonly email: string;
  readonly password: string;
}

/** The signed-in user's shape in the sign-in response (Story 1.5). */
export interface SignInUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: string;
}

/**
 * Minimal sign-in (spec decision): verifies the password and issues a
 * short-lived HS256 session token carrying `sub` + `tenant_id`. No refresh;
 * the token stays transport-only with **no role claim** — authority is
 * re-read from the DB at every command service entry (Story 1.5). Not a state
 * change, so no idempotency key applies.
 *
 * The email lookup is cross-tenant by nature (the caller has no tenant scope
 * yet), so it reads through the AUTH_DATABASE connection — a BYPASSRLS role
 * (review loop 1 decision); the fail-closed RLS policies would hide every row
 * from the scoped app role. The auth connection is read-only here and never
 * sees tenant-scoped query paths.
 *
 * Story 1.5: the response carries `user {id, email, role, status}` (the FE
 * session needs the role for surface gating — reads only; the command-path
 * authority is the DB read), and an `invited` user is rejected with 403
 * `invite-pending` until they accept their invite and set a password.
 */
@Injectable()
export class SignInCommand {
  constructor(@Inject(AUTH_DATABASE) private readonly authDb: Database) {}

  async execute(command: SignInInput): Promise<{
    accessToken: string;
    tokenType: 'Bearer';
    expiresInSeconds: number;
    tenant: { id: string; name: string };
    user: SignInUser;
  }> {
    const email = command.email.trim().toLowerCase();
    const userRows = await this.authDb
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = userRows[0];
    if (user?.status === 'invited') {
      // An invited user has no password yet (a DUMMY_HASH sentinel that no
      // credential verifies) — the 403 invite-pending must fire for ANY
      // password, but still pay one scrypt round against the sentinel so the
      // rejection is time-indistinguishable from the 401 paths (no
      // enumeration of pending invites via timing).
      await verifyPassword(command.password, DUMMY_HASH);
      throw new ProblemException(
        'invite-pending',
        403,
        'Invitation not yet accepted',
        'This account is still pending — accept the invitation and set a password first.',
      );
    }
    // Always pay one scrypt round — unknown email vs wrong password must be
    // indistinguishable in body *and* in time (no enumeration).
    const ok = await verifyPassword(command.password, user?.passwordHash ?? DUMMY_HASH);
    if (user === undefined || !ok) {
      // One message for unknown email and wrong password — no enumeration.
      throw new ProblemException(
        'unauthenticated',
        401,
        'Authentication required',
        'Unknown email or wrong password.',
      );
    }
    const tenantRows = await this.authDb
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId))
      .limit(1);
    const tenant = tenantRows[0]!;

    return {
      accessToken: signTenantSession(user.tenantId, user.id, tenantSessionSecret()),
      tokenType: 'Bearer',
      expiresInSeconds: SESSION_TTL_SECONDS,
      tenant: { id: tenant.id, name: tenant.name },
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status as UserStatus,
        createdAt: user.createdAt,
      },
    };
  }
}