import { istDateOf } from '../../../shared/primitives/time';
import { headerText, html, plainText } from './escape';

/**
 * Story 5-1a — the `user-invite` template: a new member's invitation (or a
 * reissue — the reactivation of a never-accepted invitee, or a resend).
 * Transactional only: no tracking pixel, no link rewriting, no unsubscribe.
 * English only (PENDING: locales).
 *
 * What is STORED (`email_messages.params`) is exactly `InviteEmailParams` —
 * no body, and never the token: the accept link is built at send time from
 * the sealed secret, then the secret is wiped.
 */
export interface InviteEmailParams {
  /** The inviting tenant's name, read in the command's transaction. */
  readonly tenantName: string;
  /** The owner who invited (or reissued); null when unknown. Also the Reply-To. */
  readonly inviterEmail: string | null;
  /** The invitee's role (`users.role`). */
  readonly role: string;
  /** A portal invite's client brand name; null for staff. */
  readonly clientName: string | null;
  /** The link's expiry (ISO instant) — shown as an IST date. */
  readonly expiresAt: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** The display name of the From header: "{tenant name} via WMS". */
  readonly fromName: string;
  /** The message's own Reply-To (the inviter); null → the deployment's `EMAIL_REPLY_TO`. */
  readonly replyTo: string | null;
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  owner: 'an Owner',
  ops_manager: 'an Ops Manager',
  operator: 'an Operator',
  accountant: 'an Accountant',
  client: 'a client-portal user',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-10-30T…Z` → `30 October 2026`, the IST calendar date. */
export function istLongDate(instant: string): string {
  const [year, month, day] = istDateOf(instant).split('-') as [string, string, string];
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** The stored parameters, re-checked at send time (a row is jsonb — never trusted blind). */
export function decodeInviteParams(raw: unknown): InviteEmailParams {
  if (typeof raw !== 'object' || raw === null) throw new Error('invite params: not an object');
  const value = raw as Record<string, unknown>;
  const text = (key: string, nullable: boolean): string | null => {
    const field = value[key];
    if (field === null && nullable) return null;
    if (typeof field !== 'string' || field === '') throw new Error(`invite params: ${key} is not a string`);
    return field;
  };
  const expiresAt = text('expiresAt', false)!;
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error('invite params: expiresAt is not an instant');
  return {
    tenantName: text('tenantName', false)!,
    inviterEmail: text('inviterEmail', true),
    role: text('role', false)!,
    clientName: text('clientName', true),
    expiresAt,
  };
}

/** Renders the invitation. `acceptUrl` carries the one-time token — built by the sender, never stored. */
export function renderInviteEmail(params: InviteEmailParams, acceptUrl: string): RenderedEmail {
  const tenant = plainText(params.tenantName);
  const client = params.clientName === null ? null : plainText(params.clientName);
  const inviter = params.inviterEmail === null ? null : plainText(params.inviterEmail);
  const roleWords = ROLE_WORDS[params.role] ?? 'a member';
  const expires = istLongDate(params.expiresAt);

  const subject = headerText(
    client === null ? `${tenant} has invited you to WMS` : `${tenant} has invited you to the ${client} portal`,
  );
  const opening =
    client === null
      ? `${inviter ?? 'An owner'} has invited you to join ${tenant} on WMS as ${roleWords}.`
      : `${tenant} has invited you to the ${client} portal${inviter === null ? '' : ` (invited by ${inviter})`}.`;
  const openingHtml =
    client === null
      ? `${html(inviter ?? 'An owner')} has invited you to join <strong>${html(tenant)}</strong> on WMS as ${html(roleWords)}.`
      : `<strong>${html(tenant)}</strong> has invited you to the <strong>${html(client)}</strong> portal${inviter === null ? '' : ` (invited by ${html(inviter)})`}.`;
  const ignore = "If you weren't expecting this invitation, you can ignore this email — nothing happens unless you accept.";

  const text = [
    opening,
    '',
    'Accept the invitation and set your password:',
    acceptUrl,
    '',
    `The link works once and expires on ${expires} (IST).`,
    '',
    ignore,
    '',
  ].join('\n');

  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>' + html(subject) + '</title></head>',
    '<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 15px; line-height: 1.5; color: #111;">',
    `<p>${openingHtml}</p>`,
    `<p><a href="${html(acceptUrl)}">Accept the invitation and set your password</a></p>`,
    `<p style="color: #555; font-size: 13px;">Or paste this link into your browser:<br>${html(acceptUrl)}</p>`,
    `<p>The link works once and expires on ${html(expires)} (IST).</p>`,
    `<p style="color: #555; font-size: 13px;">${html(ignore)}</p>`,
    '</body></html>',
  ].join('\n');

  return {
    subject,
    text,
    html: body,
    fromName: headerText(`${tenant} via WMS`, 120),
    replyTo: params.inviterEmail,
  };
}
