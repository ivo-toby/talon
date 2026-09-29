import type { OAuthTokenEndpointAuthMethod } from '../mcp/mcp-types.js';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
}

export interface OAuthClientRequest {
  body: URLSearchParams;
  headers: Record<string, string>;
}

export function isOAuthTokenEndpointAuthMethod(
  value: unknown,
): value is OAuthTokenEndpointAuthMethod {
  return value === 'none'
    || value === 'client_secret_post'
    || value === 'client_secret_basic';
}

/** Add OAuth client credentials using the configured token-endpoint method. */
export function addOAuthClientCredentials(
  body: URLSearchParams,
  headers: Record<string, string>,
  credentials: OAuthClientCredentials,
): OAuthClientRequest {
  const nextBody = new URLSearchParams(body);
  const nextHeaders = { ...headers };

  switch (credentials.tokenEndpointAuthMethod) {
    case 'none':
      if (credentials.clientSecret !== undefined) {
        throw new Error('token endpoint auth method "none" cannot use a client secret');
      }
      nextBody.set('client_id', credentials.clientId);
      break;
    case 'client_secret_post':
      if (!credentials.clientSecret) {
        throw new Error('token endpoint auth method "client_secret_post" requires a client secret');
      }
      nextBody.set('client_id', credentials.clientId);
      nextBody.set('client_secret', credentials.clientSecret);
      break;
    case 'client_secret_basic':
      if (!credentials.clientSecret) {
        throw new Error('token endpoint auth method "client_secret_basic" requires a client secret');
      }
      nextHeaders.Authorization = `Basic ${encodeClientCredentials(credentials.clientId, credentials.clientSecret)}`;
      break;
  }

  return { body: nextBody, headers: nextHeaders };
}

function encodeClientCredentials(clientId: string, clientSecret: string): string {
  const encodedClientId = new URLSearchParams({ value: clientId }).toString().slice('value='.length);
  const encodedClientSecret = new URLSearchParams({ value: clientSecret }).toString().slice('value='.length);
  return Buffer.from(`${encodedClientId}:${encodedClientSecret}`).toString('base64');
}
