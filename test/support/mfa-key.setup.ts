/**
 * Story 6-1b — every e2e suite boots an app that seals authenticator
 * secrets, and `MFA_ENCRYPTION_KEY` is required for that (the API refuses to
 * boot without it — `assertSecondFactorKeyConfigured`). Set once here rather
 * than at the top of each of the 70 suites; a suite that tests the missing
 * key unsets it locally.
 */
process.env.MFA_ENCRYPTION_KEY ??= 'e2e-only-mfa-encryption-key-0123456789abcdef';
