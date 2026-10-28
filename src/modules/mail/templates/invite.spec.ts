import { renderEmail } from '.';
import { decodeInviteParams, istLongDate, renderInviteEmail, type InviteEmailParams } from './invite';
import { addressAllowed, normaliseWebBaseUrl } from '../mail.config';
import { acceptInviteLinkFrom } from '../links';

// Story 5-1a — the invite template (decision 6): every parameter escaped in
// the HTML, the subject a single line, the body's lines, the portal wording,
// and no tracking of any kind.

const PARAMS: InviteEmailParams = {
  tenantName: 'Acme Logistics',
  inviterEmail: 'owner@acme.in',
  role: 'ops_manager',
  clientName: null,
  // 18:30 UTC on the 29th is the 30th in IST.
  expiresAt: '2026-10-29T18:30:00.000Z',
};
const URL_ = 'https://app.wms.in/accept-invite?tenant=t-1&token=tok_en-1';

describe('the invite email (story 5-1a)', () => {
  it('a staff invite: who invited them, the role, the accept link, the expiry as an IST date, the ignore line', () => {
    const mail = renderInviteEmail(PARAMS, URL_);
    expect(mail.subject).toBe('Acme Logistics has invited you to WMS');
    expect(mail.fromName).toBe('Acme Logistics via WMS');
    expect(mail.replyTo).toBe('owner@acme.in');
    expect(mail.text).toBe(
      [
        'owner@acme.in has invited you to join Acme Logistics on WMS as an Ops Manager.',
        '',
        'Accept the invitation and set your password:',
        URL_,
        '',
        'The link works once and expires on 30 October 2026 (IST).',
        '',
        "If you weren't expecting this invitation, you can ignore this email — nothing happens unless you accept.",
        '',
      ].join('\n'),
    );
    expect(mail.html).toContain(`<a href="${URL_.replace(/&/g, '&amp;')}">Accept the invitation and set your password</a>`);
    expect(mail.html).toContain('30 October 2026 (IST)');
    expect(mail.html).toContain('you can ignore this email');
  });

  it('a portal invite says "{tenant} has invited you to the {client} portal"', () => {
    const mail = renderInviteEmail({ ...PARAMS, role: 'client', clientName: 'Brand A Apparel' }, URL_);
    expect(mail.subject).toBe('Acme Logistics has invited you to the Brand A Apparel portal');
    expect(mail.text.split('\n')[0]).toBe('Acme Logistics has invited you to the Brand A Apparel portal (invited by owner@acme.in).');
  });

  it('template injection: a tenant name carrying markup and CR/LF is escaped in the HTML, and the subject has no CR or LF', () => {
    const evil = '<a href=x>\r\nBcc: victim@x.in';
    const mail = renderInviteEmail({ ...PARAMS, tenantName: evil, clientName: '<script>alert(1)</script>', role: 'client' }, URL_);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.fromName).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<a href=x>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;a href=x&gt;');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Every anchor in the HTML is the accept link — nothing else is linked.
    expect([...mail.html.matchAll(/<a /g)]).toHaveLength(1);
  });

  it('transactional only: no tracking pixel, no image, no unsubscribe', () => {
    const mail = renderInviteEmail(PARAMS, URL_);
    expect(mail.html).not.toMatch(/<img|unsubscribe|pixel/i);
    expect(mail.text).not.toMatch(/unsubscribe/i);
  });

  it('IST dates: the day boundary is 18:30 UTC', () => {
    expect(istLongDate('2026-10-29T18:29:59.999Z')).toBe('29 October 2026');
    expect(istLongDate('2026-10-29T18:30:00.000Z')).toBe('30 October 2026');
  });

  it('renderEmail builds the accept link from the base URL and the opened secret, and refuses a missing secret or bad params', () => {
    const mail = renderEmail('user-invite', PARAMS, { tenantId: 't-1', to: 'a@x.in', webBaseUrl: 'https://app.wms.in', secret: 'tok_en-1' });
    expect(mail.text).toContain(URL_);
    expect(() => renderEmail('user-invite', PARAMS, { tenantId: 't-1', to: 'a@x.in', webBaseUrl: 'https://app.wms.in', secret: null })).toThrow();
    expect(() => renderEmail('user-invite', { ...PARAMS, tenantName: 5 }, { tenantId: 't-1', to: 'a@x.in', webBaseUrl: 'https://app.wms.in', secret: 's' })).toThrow();
    expect(() => decodeInviteParams({ ...PARAMS, expiresAt: 'soon' })).toThrow();
  });

  it('the link builder and the base URL normaliser keep a sub-path and drop the trailing slash', () => {
    expect(normaliseWebBaseUrl('https://app.wms.in/', false)).toBe('https://app.wms.in');
    expect(normaliseWebBaseUrl('https://wms.in/app/', true)).toBe('https://wms.in/app');
    expect(acceptInviteLinkFrom('https://wms.in/app', 't', 'a+b/c')).toBe('https://wms.in/app/accept-invite?tenant=t&token=a%2Bb%2Fc');
  });

  it('the allowlist matches the exact domain, case-insensitively — never a sub-domain or a look-alike', () => {
    const config = { allowlistDomains: ['example.in'] };
    expect(addressAllowed(config, 'a@EXAMPLE.in')).toBe(true);
    expect(addressAllowed(config, 'a@mail.example.in')).toBe(false);
    expect(addressAllowed(config, 'a@example.in.evil.com')).toBe(false);
    expect(addressAllowed({ allowlistDomains: null }, 'a@anything.com')).toBe(true);
  });
});
