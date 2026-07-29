import { describe, expect, it } from 'vitest';

import { createOwnerRateLimitKey } from '../src/bootstrap-http';
import { OwnerAuthenticator, type OwnerAuthenticationHeaders } from '../src/owner-authentication';

import type { FastifyRequest } from 'fastify';

function request(headers: FastifyRequest['headers'], ip = '127.0.0.1'): FastifyRequest {
  return {
    headers,
    ip,
  } as FastifyRequest;
}

function authenticatorFor(validCredential: string): OwnerAuthenticator {
  return new OwnerAuthenticator([
    {
      isPresented: () => true,
      verify: (headers: OwnerAuthenticationHeaders) =>
        Promise.resolve(
          headers['x-api-key'] === validCredential ||
            headers.authorization === `Bearer ${validCredential}`,
        ),
    },
  ]);
}

describe('createOwnerRateLimitKey', () => {
  it('isolates a verified owner bucket from the shared tunnel IP', async () => {
    const authenticator = authenticatorFor('high-entropy-owner-secret');
    const authenticationCache = new WeakMap<FastifyRequest, boolean>();
    const anonymousRequest = request({});
    const ownerRequest = request({
      'x-api-key': 'high-entropy-owner-secret',
    });

    const anonymous = await createOwnerRateLimitKey(
      anonymousRequest,
      authenticator,
      authenticationCache,
    );
    const owner = await createOwnerRateLimitKey(ownerRequest, authenticator, authenticationCache);

    expect(anonymous).toBe('anonymous:127.0.0.1');
    expect(owner).toBe('authenticated:owner');
    expect(authenticationCache.get(anonymousRequest)).toBe(false);
    expect(authenticationCache.get(ownerRequest)).toBe(true);
  });

  it('shares the anonymous bucket across arbitrary invalid credentials', async () => {
    const authenticator = authenticatorFor('valid-owner-secret');
    const authenticationCache = new WeakMap<FastifyRequest, boolean>();
    const invalidApiKeyRequest = request({
      'x-api-key': 'attacker-controlled-api-key',
    });
    const invalidBearerRequest = request({
      authorization: 'Bearer attacker-controlled-token',
    });

    await expect(
      createOwnerRateLimitKey(invalidApiKeyRequest, authenticator, authenticationCache),
    ).resolves.toBe('anonymous:127.0.0.1');
    await expect(
      createOwnerRateLimitKey(invalidBearerRequest, authenticator, authenticationCache),
    ).resolves.toBe('anonymous:127.0.0.1');
    expect(authenticationCache.get(invalidApiKeyRequest)).toBe(false);
    expect(authenticationCache.get(invalidBearerRequest)).toBe(false);
  });

  it('uses one stable owner bucket for every verified authentication method', async () => {
    const authenticator = authenticatorFor('owner-secret');
    const authenticationCache = new WeakMap<FastifyRequest, boolean>();
    const apiKeyRequest = request({
      'x-api-key': 'owner-secret',
    });
    const bearerRequest = request({
      authorization: 'Bearer owner-secret',
    });

    const firstApiKey = await createOwnerRateLimitKey(
      apiKeyRequest,
      authenticator,
      authenticationCache,
    );
    const secondApiKey = await createOwnerRateLimitKey(
      apiKeyRequest,
      authenticator,
      authenticationCache,
    );
    const bearer = await createOwnerRateLimitKey(bearerRequest, authenticator, authenticationCache);

    expect(firstApiKey).toBe('authenticated:owner');
    expect(secondApiKey).toBe(firstApiKey);
    expect(bearer).toBe(firstApiKey);
  });

  it('cannot vary an invalid API key when another credential authenticates', async () => {
    const authenticator = authenticatorFor('valid-owner-secret');
    const authenticationCache = new WeakMap<FastifyRequest, boolean>();
    const firstRequest = request({
      authorization: 'Bearer valid-owner-secret',
      'x-api-key': 'invalid-value-one',
    });
    const secondRequest = request({
      authorization: 'Bearer valid-owner-secret',
      'x-api-key': 'invalid-value-two',
    });

    await expect(
      createOwnerRateLimitKey(firstRequest, authenticator, authenticationCache),
    ).resolves.toBe('authenticated:owner');
    await expect(
      createOwnerRateLimitKey(secondRequest, authenticator, authenticationCache),
    ).resolves.toBe('authenticated:owner');
  });
});
