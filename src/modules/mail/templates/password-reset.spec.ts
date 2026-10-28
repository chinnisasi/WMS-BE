import { renderEmail } from '.';
import { resetPasswordLinkFrom } from '../links';
import { istLongDateTime } from './invite';

// Story 6-1c — the two reset mails: the fragment link, the IST time, every
// parameter escaped, a single-line subject, no Reply-To of their own.
describe('the password-reset and password-changed mails (story 6-1c)', () => {
  const ctx = { tenantId: 't-1', to: 'priya@acme.in', webBaseUrl: 'https://app.wms.in', secret: 'id-1.sec_ret-1' };

  it('the link carries the token in the fragment, never the query', () => {
    const link = resetPasswordLinkFrom('https://app.wms.in', 'id-1.sec_ret-1');
    expect(link).toBe('https://app.wms.in/reset-password#token=id-1.sec_ret-1');
    expect(new URL(link).search).toBe('');
  });

  it('istLongDateTime: the IST wall clock, day before month', () => {
    expect(istLongDateTime('2026-10-24T08:35:00.000Z')).toBe('24 October 2026, 14:05');
    expect(istLongDateTime('2026-10-29T18:45:00.000Z')).toBe('30 October 2026, 00:15');
  });

  it('password-reset: the account, the tenant, the link, the expiry and the ignore line', () => {
    const mail = renderEmail('password-reset', { tenantName: 'Acme Logistics', expiresAt: '2026-10-24T08:35:00.000Z' }, ctx);
    expect(mail.subject).toBe('Reset your Acme Logistics password');
    expect(mail.fromName).toBe('Acme Logistics via WMS');
    expect(mail.replyTo).toBeNull();
    expect(mail.text).toBe(
      [
        'Someone asked to reset the password for priya@acme.in at Acme Logistics.',
        '',
        'Set a new password:',
        'https://app.wms.in/reset-password#token=id-1.sec_ret-1',
        '',
        'The link works once and expires at 24 October 2026, 14:05 (IST).',
        '',
        "If this wasn't you, ignore this email — your password stays the same.",
        '',
      ].join('\n'),
    );
    expect(mail.html).toContain('<a href="https://app.wms.in/reset-password#token=id-1.sec_ret-1">Set a new password</a>');
  });

  it('password-reset needs its secret; bad params fail to render', () => {
    expect(() => renderEmail('password-reset', { tenantName: 'A', expiresAt: '2026-10-24T08:35:00.000Z' }, { ...ctx, secret: null })).toThrow();
    expect(() => renderEmail('password-reset', { tenantName: 5, expiresAt: '2026-10-24T08:35:00.000Z' }, ctx)).toThrow();
    expect(() => renderEmail('password-reset', { tenantName: 'A', expiresAt: 'soon' }, ctx)).toThrow();
  });

  it('password-changed: no secret, no link; the time; everyone signed out; who to contact', () => {
    const mail = renderEmail('password-changed', { tenantName: 'Acme Logistics', changedAt: '2026-10-24T08:35:00.000Z' }, { ...ctx, secret: null });
    expect(mail.subject).toBe('Your Acme Logistics password was changed');
    expect(mail.text).toBe(
      [
        'The password for priya@acme.in at Acme Logistics was changed at 24 October 2026, 14:05 (IST).',
        'Every device was signed out.',
        '',
        "If this wasn't you, contact your administrator.",
        '',
      ].join('\n'),
    );
    expect(mail.html).not.toContain('href');
    expect(() => renderEmail('password-changed', { tenantName: 'A' }, ctx)).toThrow();
  });

  it('a hostile tenant name or address is escaped in the HTML and flattened in the subject', () => {
    const evil = { tenantName: 'Evil <b>\r\nBcc: x@y.in', expiresAt: '2026-10-24T08:35:00.000Z' };
    const mail = renderEmail('password-reset', evil, { ...ctx, to: 'a<script>@x.in' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;b&gt;');
  });
});
