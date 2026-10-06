/**
 * NIC's e-way text rule (story 8-2b, moved here by 8-1d so the outbound
 * create command can refuse a legal name the e-way bill would print blank):
 * drop every character outside `A-Za-z0-9 @#-/,&.`, then truncate and trim.
 * The e-way builder (`invoicing/eway-json.ts`) re-exports it.
 */
export function nicText(value: string | null | undefined, max: number): string {
  if (value === null || value === undefined) return '';
  return value.replace(/[^A-Za-z0-9 @#\-/,&.]/g, '').slice(0, max).trim();
}
