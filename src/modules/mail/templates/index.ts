import type { EmailTemplate } from '../mail-rules';
import { acceptInviteLinkFrom, resetPasswordLinkFrom, webLinkFrom } from '../links';
import { decodeInviteParams, renderInviteEmail, type RenderedEmail } from './invite';
import { decodePasswordResetParams, renderPasswordResetEmail } from './password-reset';
import { decodePasswordChangedParams, renderPasswordChangedEmail } from './password-changed';
import { decodeClientReceiptParams, renderClientReceiptEmail, type ClientAttachmentState } from './client-receipt';
import { decodeClientShipmentDocumentParams, renderClientShipmentDocumentEmail } from './client-shipment-document';
import { decodeClientDispatchParams, renderClientDispatchEmail } from './client-dispatch';

export type { RenderedEmail } from './invite';
export type { InviteEmailParams } from './invite';
export type { PasswordResetEmailParams } from './password-reset';
export type { PasswordChangedEmailParams } from './password-changed';
export type { ClientAttachmentState, ClientReceiptAttachmentState, ClientReceiptEmailParams, ClientReceiptLineParams } from './client-receipt';
export type { ClientShipmentDocumentEmailParams, ClientShipmentDocumentParcelParams, ShipmentDocumentKind } from './client-shipment-document';
export { SHIPMENT_DOCUMENT_KINDS, SHEET_PARCELS_SHOWN } from './client-shipment-document';
export type { ClientDispatchEmailParams, ClientDispatchLineParams } from './client-dispatch';
export { CLIENT_EMAIL_MAX_LINES } from './client-notice';

/** What a template may use besides its stored parameters: the row's tenant, its recipient, the base URL and the opened secret. */
export interface RenderContext {
  readonly tenantId: string;
  /** Story 6-1c — the row's `to_email` (the reset mails name the account). */
  readonly to: string;
  readonly webBaseUrl: string;
  /** The opened sealed secret (null when the row stored none). */
  readonly secret: string | null;
  /**
   * Story 5-2b (A10) — the deployment's `EMAIL_REPLY_TO` (null when unset):
   * a client notice's footer offers "reply to this email" only when some
   * Reply-To exists. Optional so a caller that renders account mail only
   * needs none.
   */
  readonly fallbackReplyTo?: string | null;
  /**
   * Story 2-9a (D5) — the receipt notice's file: what the sender attached
   * (`client-receipt` only; absent = `none`, 5-2b's bytes).
   */
  readonly attachment?: ClientAttachmentState;
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
    // Story 5-2b — the client notices: no secret; a link to the portal list.
    case 'client-receipt': {
      const receipt = decodeClientReceiptParams(params);
      // Story 2-9a (decision 18) — the link opens THAT receipt when the params name it.
      return renderClientReceiptEmail(
        receipt,
        webLinkFrom(context.webBaseUrl, '/portal/inbound', receipt.grnId === undefined ? {} : { grn: receipt.grnId }),
        context.fallbackReplyTo ?? null,
        context.attachment ?? 'none',
      );
    }
    // Story 4-4a — a shipping document or a signed sheet page; the link opens the order.
    case 'client-shipment-document': {
      const document = decodeClientShipmentDocumentParams(params);
      return renderClientShipmentDocumentEmail(
        document,
        webLinkFrom(context.webBaseUrl, '/portal/orders', document.orderId === null ? {} : { order: document.orderId }),
        context.fallbackReplyTo ?? null,
        context.attachment ?? 'none',
      );
    }
    case 'client-dispatch':
      return renderClientDispatchEmail(
        decodeClientDispatchParams(params),
        webLinkFrom(context.webBaseUrl, '/portal/orders', {}),
        context.fallbackReplyTo ?? null,
        context.attachment ?? 'none',
      );
    default: {
      const unreachable: never = template;
      throw new Error(`unknown email template ${String(unreachable)}`);
    }
  }
}
