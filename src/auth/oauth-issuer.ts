/**
 * RFC 8414 issuer identifiers are HTTPS URLs without query or fragment
 * components. Reject user-info too; it has no place in a trusted issuer.
 */
export function isOAuthIssuerIdentifier(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!isHttpsUrlWithoutUserInfoOrFragment(value)) return false;
  return !value.includes('?');
}

/** Require TLS and reject URL user-info/fragments for OAuth endpoints and resources. */
export function isHttpsUrlWithoutUserInfoOrFragment(value: string): boolean {
  const authority = /^https:\/\/([^/?#]*)/iu.exec(value)?.[1];
  if (!authority || authority.includes('@') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:'
      && url.username.length === 0
      && url.password.length === 0
      && url.hash.length === 0
    );
  } catch {
    return false;
  }
}
