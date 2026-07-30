import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  ApiKeyOwnerCredentialVerifier,
  BasicOwnerCredentialVerifier,
  createOwnerAuthenticator,
  FirebaseOwnerCredentialVerifier,
  OwnerAuthenticator,
  createOwnerAuthenticationHook,
  resolveEnabledOwnerAuthenticationMethods,
  type FirebaseIdTokenVerifier,
} from '../src';

const OWNER_API_KEY = 'unit-test-owner-key';
// This deterministic digest is a test fixture, not password storage.
// codeql[js/insufficient-password-hash]
const OWNER_API_KEY_SHA256 = createHash('sha256').update(OWNER_API_KEY, 'utf8').digest('hex');

describe('owner authentication', () => {
  it('accepts the API key only when its constant-time SHA-256 comparison succeeds', async () => {
    const verifier = new ApiKeyOwnerCredentialVerifier(OWNER_API_KEY_SHA256);

    await expect(verifier.verify({ 'x-api-key': OWNER_API_KEY })).resolves.toBe(true);
    await expect(verifier.verify({ 'x-api-key': 'wrong-key' })).resolves.toBe(false);
    await expect(verifier.verify({ 'x-api-key': [OWNER_API_KEY] })).resolves.toBe(false);
    await expect(verifier.verify({})).resolves.toBe(false);
  });

  it('supports browser Basic auth with an exact username and the same hashed secret', async () => {
    const verifier = new BasicOwnerCredentialVerifier('owner', OWNER_API_KEY_SHA256);
    const ownerAuthorization = `Basic ${Buffer.from(`owner:${OWNER_API_KEY}`, 'utf8').toString(
      'base64',
    )}`;
    const wrongUsername = `Basic ${Buffer.from(`other:${OWNER_API_KEY}`, 'utf8').toString(
      'base64',
    )}`;

    await expect(verifier.verify({ authorization: ownerAuthorization })).resolves.toBe(true);
    await expect(verifier.verify({ authorization: wrongUsername })).resolves.toBe(false);
    await expect(verifier.verify({ authorization: 'Basic not-valid-base64=' })).resolves.toBe(
      false,
    );
  });

  it('verifies Firebase ID tokens with revocation checking and an owner UID allowlist', async () => {
    const verifyIdToken = vi
      .fn<FirebaseIdTokenVerifier>()
      .mockResolvedValueOnce({ uid: 'owner-uid' })
      .mockResolvedValueOnce({ uid: 'other-uid' });
    const verifier = new FirebaseOwnerCredentialVerifier({
      projectId: 'medicos-test',
      ownerUids: ['owner-uid'],
      verifyIdToken,
    });

    await expect(verifier.verify({ authorization: 'Bearer valid-token' })).resolves.toBe(true);
    await expect(verifier.verify({ authorization: 'Bearer another-token' })).resolves.toBe(false);
    expect(verifyIdToken).toHaveBeenNthCalledWith(1, 'valid-token', true);
    expect(verifyIdToken).toHaveBeenNthCalledWith(2, 'another-token', true);
  });

  it('fails closed when Firebase rejects a token or no verifier is configured', async () => {
    const verifyIdToken = vi
      .fn<FirebaseIdTokenVerifier>()
      .mockRejectedValue(new Error('provider detail must not escape'));
    const firebaseVerifier = new FirebaseOwnerCredentialVerifier({
      projectId: 'medicos-test',
      ownerUids: ['owner-uid'],
      verifyIdToken,
    });
    const authenticator = new OwnerAuthenticator([firebaseVerifier]);

    await expect(
      authenticator.authenticate({ authorization: 'Bearer rejected-token' }),
    ).resolves.toBe(false);
    expect(() => new OwnerAuthenticator([])).toThrow(
      'Owner authentication cannot start without a credential verifier.',
    );
  });

  it('accepts any configured owner method and rejects missing credentials', async () => {
    const authenticator = new OwnerAuthenticator([
      new ApiKeyOwnerCredentialVerifier(OWNER_API_KEY_SHA256),
      new BasicOwnerCredentialVerifier('owner', OWNER_API_KEY_SHA256),
    ]);
    const basicAuthorization = `Basic ${Buffer.from(`owner:${OWNER_API_KEY}`, 'utf8').toString(
      'base64',
    )}`;

    await expect(authenticator.authenticate({ 'x-api-key': OWNER_API_KEY })).resolves.toBe(true);
    await expect(authenticator.authenticate({ authorization: basicAuthorization })).resolves.toBe(
      true,
    );
    await expect(authenticator.authenticate({})).resolves.toBe(false);
  });

  it('enables Basic independently from the API-key transport', async () => {
    const configuration = {
      basicEnabled: false,
      firebaseOwnerUids: [],
      ownerApiBasicUsername: 'owner',
      ownerApiKeySha256: OWNER_API_KEY_SHA256,
    } as const;
    const authenticator = createOwnerAuthenticator(configuration);
    const basicAuthorization = `Basic ${Buffer.from(`owner:${OWNER_API_KEY}`, 'utf8').toString(
      'base64',
    )}`;

    expect(resolveEnabledOwnerAuthenticationMethods(configuration)).toEqual({
      basic: false,
      firebaseBearer: false,
      ownerApiKey: true,
    });
    await expect(authenticator.authenticate({ authorization: basicAuthorization })).resolves.toBe(
      false,
    );
    await expect(authenticator.authenticate({ 'x-api-key': OWNER_API_KEY })).resolves.toBe(true);
  });

  it('reports only Firebase when it is the sole configured owner method', () => {
    expect(
      resolveEnabledOwnerAuthenticationMethods({
        basicEnabled: true,
        firebaseOwnerUids: ['owner-uid'],
        firebaseProjectId: 'medicos-test',
        ownerApiBasicUsername: 'owner',
      }),
    ).toEqual({
      basic: false,
      firebaseBearer: true,
      ownerApiKey: false,
    });
  });

  it('terminates the request before a protected handler even with an asynchronous onSend hook', async () => {
    const authenticator = new OwnerAuthenticator([
      new ApiKeyOwnerCredentialVerifier(OWNER_API_KEY_SHA256),
    ]);
    const application = Fastify();
    const protectedHandler = vi.fn(() => ({
      sensitive: true,
    }));

    application.addHook(
      'onRequest',
      createOwnerAuthenticationHook(authenticator, {
        basic: false,
        firebaseBearer: false,
        ownerApiKey: true,
      }),
    );
    application.addHook('onSend', async (_request, _reply, payload) => {
      await Promise.resolve();
      return payload;
    });
    // This isolated test exercises hook termination; production bootstrap registers rate limiting.
    // codeql[js/missing-rate-limiting]
    application.get('/protected', protectedHandler);

    try {
      const response = await application.inject({
        method: 'GET',
        url: '/protected',
      });

      expect(response.statusCode).toBe(401);
      expect(protectedHandler).not.toHaveBeenCalled();
    } finally {
      await application.close();
    }
  });
});
