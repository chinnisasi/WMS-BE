/**
 * Story 1-2a — the ONE email-address rule a client contact is held to, shared
 * by the DTO (`@IsEmailAddress()`) and the command (the boundary a non-HTTP
 * caller meets): class-validator's own `isEmail`, over the NORMALIZED value
 * (trimmed, lower-cased), within the column ceiling. A standalone file (the
 * `gstin.ts` pattern) so a DTO imports the rule without its module's
 * command graph.
 */
import { ValidateBy, isEmail, type ValidationOptions } from 'class-validator';

/** The column ceiling (RFC 5321's path limit) — the 0077 CHECK's. */
export const EMAIL_MAX_LENGTH = 254;

/** Trim + lower-case — the stored form (`client_contacts_email_format`). */
export function normalizeEmailAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether a NORMALIZED value is an email address this system stores: ASCII
 * only (no UTF-8 local part, no internationalised domain). JavaScript's
 * `toLowerCase` and Postgres's `lower()` disagree on some non-ASCII letters,
 * so a non-ASCII address could pass here and then fail the
 * `client_contacts_email_format` CHECK as an unmapped 500; ASCII lower-cases
 * identically on both sides.
 */
export function isEmailAddress(value: string): boolean {
  return (
    value.length <= EMAIL_MAX_LENGTH &&
    ASCII_ONLY.test(value) &&
    isEmail(value, { allow_utf8_local_part: false })
  );
}

const ASCII_ONLY = /^[\x21-\x7e]+$/;

/** The DTO face of `isEmailAddress` (apply after a trim + lower-case transform). */
export function IsEmailAddress(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isEmailAddress',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isEmailAddress(value),
        defaultMessage: () => `$property must be an email address of at most ${EMAIL_MAX_LENGTH} characters`,
      },
    },
    options,
  );
}
