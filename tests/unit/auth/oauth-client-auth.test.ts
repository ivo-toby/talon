import { describe, expect, it } from 'vitest';
import { addOAuthClientCredentials } from '../../../src/auth/oauth-client-auth.js';

describe('addOAuthClientCredentials()', () => {
  it('sends a public OAuth client id in the request body', () => {
    const request = addOAuthClientCredentials(
      new URLSearchParams({ grant_type: 'authorization_code' }),
      { Accept: 'application/json' },
      { clientId: 'public-client', tokenEndpointAuthMethod: 'none' },
    );

    expect(request.body.get('client_id')).toBe('public-client');
    expect(request.headers).toEqual({ Accept: 'application/json' });
  });

  it('sends a confidential client secret in the request body when configured', () => {
    const request = addOAuthClientCredentials(
      new URLSearchParams({ grant_type: 'authorization_code' }),
      {},
      {
        clientId: 'confidential-client',
        clientSecret: 'secret',
        tokenEndpointAuthMethod: 'client_secret_post',
      },
    );

    expect(request.body.get('client_id')).toBe('confidential-client');
    expect(request.body.get('client_secret')).toBe('secret');
  });

  it('uses HTTP Basic and form-encodes client credentials', () => {
    const request = addOAuthClientCredentials(
      new URLSearchParams({ grant_type: 'authorization_code' }),
      { Accept: 'application/json' },
      {
        clientId: 'client id',
        clientSecret: 'secret:value',
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
    );

    const encodedId = new URLSearchParams({ value: 'client id' }).toString().slice('value='.length);
    const encodedSecret = new URLSearchParams({ value: 'secret:value' }).toString().slice('value='.length);
    expect(request.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${encodedId}:${encodedSecret}`).toString('base64')}`,
    );
    expect(request.body.has('client_id')).toBe(false);
    expect(request.body.has('client_secret')).toBe(false);
  });
});
