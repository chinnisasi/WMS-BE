import { headerText, html, plainText } from './escape';
import { istLongDateTime, type RenderedEmail } from './invite';

/**
 * Story 6-1c — the `password-changed` notice, queued in the transaction
 * that completes a reset. No secret and no link: it only tells the owner of
 * the mailbox that it happened, so a reset they did not make is noticed.
 */
export interface PasswordChangedEmailParams {
  readonly tenantName: string;
  /** When the password changed (ISO instant, the database clock) — shown in IST. */
  readonly changedAt: string;
}

export function decodePasswordChangedParams(raw: unknown): PasswordChangedEmailParams {
  if (typeof raw !== 'object' || raw === null) throw new Error('password-changed params: not an object');
  const value = raw as Record<string, unknown>;
  const tenantName = value.tenantName;
  const changedAt = value.changedAt;
  if (typeof tenantName !== 'string' || tenantName === '') throw new Error('password-changed params: tenantName is not a string');
  if (typeof changedAt !== 'string' || Number.isNaN(Date.parse(changedAt))) {
    throw new Error('password-changed params: changedAt is not an instant');
  }
  return { tenantName, changedAt };
}

export function renderPasswordChangedEmail(params: PasswordChangedEmailParams, to: string): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const email = plainText(to);
  const when = istLongDateTime(params.changedAt);
  const subject = headerText(`Your ${tenant} password was changed`);
  const opening = `The password for ${email} at ${tenant} was changed at ${when} (IST).`;
  const signedOut = 'Every device was signed out.';
  const warning = "If this wasn't you, contact your administrator.";
  const text = [opening, signedOut, '', warning, ''].join('\n');
  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>' + html(subject) + '</title></head>',
    '<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: #111;">',
    `<p>The password for <strong>${html(email)}</strong> at <strong>${html(tenant)}</strong> was changed at ${html(when)} (IST). ${html(signedOut)}</p>`,
    `<p>${html(warning)}</p>`,
    '</body></html>',
  ].join('\n');
  return { subject, text, html: body, fromName: headerText(`${tenant} via WMS`, 120), replyTo: null };
}
