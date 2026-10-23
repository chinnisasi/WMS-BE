import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Story 6-2c (decision 11, A14) — the committed RDS CA bundle
 * (`certs/rds-global-bundle.pem`, AWS's public global bundle). Only the CA
 * the deploy depends on is checked — ap-south-1's RSA2048 G1 (#219's
 * `rds-ca-rsa2048-g1`) — and it must have at least 180 days left, so a
 * refresh is due long before connections fail (refresh owner and cadence:
 * PENDING, deploy).
 */
const MIN_DAYS_LEFT = 180;

describe('the RDS CA bundle (story 6-2c)', () => {
  const pem = readFileSync(join(__dirname, '..', 'certs', 'rds-global-bundle.pem'), 'utf8');
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];

  it('is exactly the bundle downloaded 2026-10-23 (integrity pin — a refresh updates both values deliberately)', () => {
    expect(createHash('sha256').update(readFileSync(join(__dirname, '..', 'certs', 'rds-global-bundle.pem'))).digest('hex')).toBe(
      '90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b',
    );
    expect(certificates).toHaveLength(114);
  });

  it('holds the ap-south-1 RSA2048 G1 root CA, a CA, with at least 180 days left', () => {
    const targets = certificates
      .map((text) => new X509Certificate(text))
      .filter((cert) => cert.subject.includes('ap-south-1') && cert.subject.includes('RSA2048 G1'));
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target!.ca).toBe(true);
    const daysLeft = (Date.parse(target!.validTo) - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThanOrEqual(MIN_DAYS_LEFT);
    expect(Date.parse(target!.validFrom)).toBeLessThan(Date.now());
  });
});
