import type { EmailTemplate } from '../mail-rules';
import { acceptInviteLinkFrom, resetPasswordLinkFrom } from '../links';
import { decodeInviteParams, renderInviteEmail, type RenderedEmail } from './invite';
import { decodePasswordResetParams, renderPasswordResetEmail } from './password-reset';
import { decodePasswordChangedParams, renderPasswordChangedEmail } from './password-changed';

export type { RenderedEmail } from './invite';
export type { InviteEmailParams } from './invite';
export type { PasswordResetEmailParams } from './password-reset';
export type { PasswordChangedEmailParams } from './password-changed';

/** What a template may use besides its stored parameters: the row's tenant, its recipient, the base URL and the opened secret. */
export interface RenderContext {
  readonly tenantId: string;
  /** Story 6-1c — the row's `to_email` (the reset mails name the account). */
  readonly to: string;
  readonly webBaseUrl: string;
  /** The opened sealed secret (null when the row stored none). */
  readonly secret: string | null;
}

/**
 * Story 5-1a — renders a stored row's template. Throws when the parameters
 * no longer decode, or a template that needs a secret has none (the sender
 * fails the row `render`). Exhaustive over `EMAIL_TEMPLATES`.
 */
export function renderEmail(template: EmailTemplate, params: unknown, context: RenderContext): RenderedEmail {
  switch (template) {
    case 'user-invite': {
      if (context.secret === null) throw new Error('user-invite needs its sealed token');
      return renderInviteEmail(
        decodeInviteParams(params),
        acceptInviteLinkFrom(context.webBaseUrl, context.tenantId, context.secret),
      );
    }
    case 'password-reset': {
      // Story 6-1c — the link IS the token: no secret, no mail.
      if (context.secret === null) throw new Error('password-reset needs its sealed token');
      return renderPasswordResetEmail(
        decodePasswordResetParams(params),
        context.to,
        resetPasswordLinkFrom(context.webBaseUrl, context.secret),
      );
    }
    case 'password-changed':
      return renderPasswordChangedEmail(decodePasswordChangedParams(params), context.to);
    default: {
      const unreachable: never = template;
      throw new Error(`unknown email template ${String(unreachable)}`);
    }
  }
}
