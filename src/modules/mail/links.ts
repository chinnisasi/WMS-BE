/**
 * Story 5-1a (decision 7) — every link the backend hands out to the web app
 * is built here, from the normalised `WEB_BASE_URL`, so the emailed accept
 * link and the copy link a response carries are the same string.
 */
export function webLinkFrom(webBaseUrl: string, path: string, query: Readonly<Record<string, string>>): string {
  const url = new URL(`${webBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** The accept-invite page (`wms-fe/src/app/accept-invite/page.tsx`): `?tenant=<id>&token=<raw>`. */
export function acceptInviteLinkFrom(webBaseUrl: string, tenantId: string, token: string): string {
  return webLinkFrom(webBaseUrl, '/accept-invite', { tenant: tenantId, token });
}
