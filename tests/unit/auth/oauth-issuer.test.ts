import { describe, expect, it } from 'vitest';
import {
  isHttpsUrlWithoutUserInfoOrFragment,
  isOAuthIssuerIdentifier,
} from '../../../src/auth/oauth-issuer.js';

describe('OAuth URL validation', () => {
  it('requires an absolute HTTPS URL without user-info or a fragment', () => {
    expect(isHttpsUrlWithoutUserInfoOrFragment('https://mcp.example.com/resource?scope=read')).toBe(true);
    expect(isHttpsUrlWithoutUserInfoOrFragment('http://mcp.example.com/resource')).toBe(false);
    expect(isHttpsUrlWithoutUserInfoOrFragment('https://user:pass@mcp.example.com/resource')).toBe(false);
    expect(isHttpsUrlWithoutUserInfoOrFragment('https://@mcp.example.com/resource')).toBe(false);
    expect(isHttpsUrlWithoutUserInfoOrFragment('https://mcp.example.com/resource#')).toBe(false);
  });

  it('rejects issuer query and fragment delimiters, including empty components', () => {
    expect(isOAuthIssuerIdentifier('https://identity.example.com/tenant')).toBe(true);
    expect(isOAuthIssuerIdentifier('https://identity.example.com/tenant?mode=1')).toBe(false);
    expect(isOAuthIssuerIdentifier('https://identity.example.com/tenant?')).toBe(false);
    expect(isOAuthIssuerIdentifier('https://identity.example.com/tenant#')).toBe(false);
  });
});
