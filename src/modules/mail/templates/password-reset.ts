import { headerText, html, plainText } from './escape';
import { istLongDateTime, type RenderedEmail } from './invite';

/**
 * Story 6-1c — the `password-reset` template: a link to set a new password.
 * Transactional only (no tracking, no link rewriting, no unsubscribe).
 *
 * What is STORED (`email_messages.params`) is exactly `PasswordResetEmailParams`
 * — never the token: the link is built at send time from the sealed secret
 * (`renderEmail` refuses a row without one), then the secret is wiped. The
 * recipient's address is the row's own `to_email`.
 */
export interface PasswordResetEmailParams {
  /** The account's tenant name, read in the request's transaction. */
  readonly tenantName: string;
  /** The link's expiry (ISO instant) — shown as an IST date and time. */
  readonly expiresAt: string;
}

export function decodePasswordResetParams(raw: unknown): PasswordResetEmailParams {
  if (typeof raw !== 'object' || raw === null) throw new Error('password-reset params: not an object');
  const value = raw as Record<string, unknown>;
  const tenantName = value.tenantName;
  const expiresAt = value.expiresAt;
  if (typeof tenantName !== 'string' || tenantName === '') throw new Error('password-reset params: tenantName is not a string');
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('password-reset params: expiresAt is not an instant');
  }
  return { tenantName, expiresAt };
}

/** Renders the reset mail. `resetUrl` carries the one-time token in its fragment — built by the sender, never stored. */
export function renderPasswordResetEmail(params: PasswordResetEmailParams, to: string, resetUrl: string): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const email = plainText(to);
  const expires = istLongDateTime(params.expiresAt);
  const subject = headerText(`Reset your ${tenant} password`);
  const opening = `Someone asked to reset the password for ${email} at ${tenant}.`;
  const validity = `The link works once and expires at ${expires} (IST).`;
  const ignore = "If this wasn't you, ignore this email — your password stays the same.";
  const text = [opening, '', 'Set a new password:', resetUrl, '', validity, '', ignore, ''].join('\n');
  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>' + html(subject) + '</title></head>',
    '<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: #111;">',
    `<p>Someone asked to reset the password for <strong>${html(email)}</strong> at <strong>${html(tenant)}</strong>.</p>`,
    `<p><a href="${html(resetUrl)}">Set a new password</a></p>`,
    `<p style="color: #555; font-size: 13px;">Or paste this link into your browser:<br>${html(resetUrl)}</p>`,
    `<p>${html(validity)}</p>`,
    `<p style="color: #555; font-size: 13px;">${html(ignore)}</p>`,
    '</body></html>',
  ].join('\n');
  // Reply-To null: the deployment's `EMAIL_REPLY_TO` applies (A17).
  return { subject, text, html: body, fromName: headerText(`${tenant} via WMS`, 120), replyTo: null };
}
