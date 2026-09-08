import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { tenants, users } from '../../shared/db/schema';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { SESSION_TTL_SECONDS, signTenantSession, tenantSessionSecret } from './jwt-session';
import { verifyPassword } from './passwords';

export interface SignInInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Minimal sign-in (spec decision): verifies the password and issues a
 * short-lived HS256 session token carrying `sub` + `tenant_id`. No refresh,
 * no role enforcement — 1.5 owns permissions. Not a state change, so no
 * idempotency key applies. The email lookup is cross-tenant by nature
 * (the caller has no tenant scope yet); the table owner reads it directly.
 */
@Injectable()
export class SignInCommand {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(command: SignInInput): Promise<{
    accessToken: string;
    tokenType: 'Bearer';
    expiresInSeconds: number;
    tenant: { id: string; name: string };
  }> {
    const userRows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, command.email))
      .limit(1);
    const user = userRows[0];
    const ok = user !== undefined && (await verifyPassword(command.password, user.passwordHash));
    if (user === undefined || !ok) {
      // One message for unknown email and wrong password — no enumeration.
      throw new ProblemException(
        'unauthenticated',
        401,
        'Authentication required',
        'Unknown email or wrong password.',
      );
    }
    const tenantRows = await this.db
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
    };
  }
}