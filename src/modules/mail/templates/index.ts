import type { EmailTemplate } from '../mail-rules';
import { acceptInviteLinkFrom } from '../links';
import { decodeInviteParams, renderInviteEmail, type RenderedEmail } from './invite';

export type { RenderedEmail } from './invite';
export type { InviteEmailParams } from './invite';

/** What a template may use besides its stored parameters: the row's tenant, the base URL and the opened secret. */
export interface RenderContext {
  readonly tenantId: string;
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
    default: {
      const unreachable: never = template;
      throw new Error(`unknown email template ${String(unreachable)}`);
    }
  }
}
