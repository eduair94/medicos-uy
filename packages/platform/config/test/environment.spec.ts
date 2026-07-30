import { describe, expect, it } from 'vitest';

import {
  EnvironmentValidationError,
  validateCatalogWorkerEnvironment,
  validateCommandApiEnvironment,
  validatePublicQueryApiEnvironment,
} from '../src';

const ownerApiKeyAuthentication = {
  OWNER_API_BASIC_USERNAME: 'owner',
  OWNER_API_KEY_SHA256: 'c64bcba7b5650a21e86aaa762fe60684b0cf4d9791120337bdb840047907fb0e', // gitleaks:allow - deterministic test fixture
} as const;
const ownerResearchDatabase = {
  OWNER_RESEARCH_DATABASE_URL: 'postgresql://owner:password@localhost:5432/research',
} as const;

describe('environment validation', () => {
  it('normalizes the public query API environment', () => {
    const environment = validatePublicQueryApiEnvironment({
      ...ownerApiKeyAuthentication,
      ...ownerResearchDatabase,
      NODE_ENV: 'test',
      CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      CATALOG_DATABASE_SSL: 'false',
      CORS_ORIGINS: 'http://localhost:3000, https://example.test ',
      PUBLIC_QUERY_API_PORT: '3101',
      PUBLIC_QUERY_API_HOST: '127.0.0.1',
      API_DOCUMENTATION_ENABLED: 'true',
      PUBLIC_API_BASE_URL: 'https://api.medicos.test',
    });

    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      SERVICE_NAME: 'public-query-api',
      HOST: '127.0.0.1',
      PORT: 3101,
      CATALOG_DATABASE_SSL: false,
      API_DOCUMENTATION_ENABLED: true,
      PUBLIC_API_BASE_URL: 'https://api.medicos.test',
      CORS_ORIGINS: ['http://localhost:3000', 'https://example.test'],
      FIREBASE_OWNER_UIDS: [],
      OWNER_API_BASIC_USERNAME: 'owner',
      OWNER_API_KEY_SHA256: ownerApiKeyAuthentication.OWNER_API_KEY_SHA256,
    });
  });

  it('fails before bootstrap when a required value is invalid', () => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        ...ownerApiKeyAuthentication,
        ...ownerResearchDatabase,
        CATALOG_DATABASE_URL: 'not-a-url',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('rejects an arbitrary public-query bind host', () => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        ...ownerApiKeyAuthentication,
        ...ownerResearchDatabase,
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        PUBLIC_QUERY_API_HOST: 'example.test',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it.each([
    {
      ...ownerApiKeyAuthentication,
      ...ownerResearchDatabase,
      CATALOG_DATABASE_URL: 'https://example.test/catalog',
    },
    {
      ...ownerApiKeyAuthentication,
      ...ownerResearchDatabase,
      CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      CORS_ORIGINS: '*',
    },
    {
      ...ownerApiKeyAuthentication,
      ...ownerResearchDatabase,
      CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      CORS_ORIGINS: 'https://example.test/private',
    },
  ])('rejects unsafe database schemes and CORS values', (environment) => {
    expect(() => validatePublicQueryApiEnvironment(environment)).toThrow(
      EnvironmentValidationError,
    );
  });

  it('accepts a native boolean input', () => {
    expect(
      validatePublicQueryApiEnvironment({
        ...ownerApiKeyAuthentication,
        ...ownerResearchDatabase,
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        API_DOCUMENTATION_ENABLED: true,
      }).API_DOCUMENTATION_ENABLED,
    ).toBe(true);
  });

  it.each([null, 'sometimes'])('rejects an unsupported boolean input (%s)', (value) => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        ...ownerApiKeyAuthentication,
        ...ownerResearchDatabase,
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        API_DOCUMENTATION_ENABLED: value,
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('keeps SWAGGER_ENABLED as a backwards-compatible alias', () => {
    expect(
      validatePublicQueryApiEnvironment({
        ...ownerApiKeyAuthentication,
        ...ownerResearchDatabase,
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        SWAGGER_ENABLED: 'true',
      }).API_DOCUMENTATION_ENABLED,
    ).toBe(true);
  });

  it('requires a canonical public base URL for production documentation', () => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        ...ownerApiKeyAuthentication,
        ...ownerResearchDatabase,
        NODE_ENV: 'production',
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        API_DOCUMENTATION_ENABLED: 'true',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('accepts Firebase owner authentication without the API-key fallback', () => {
    const environment = validatePublicQueryApiEnvironment({
      ...ownerResearchDatabase,
      CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      FIREBASE_PROJECT_ID: 'medicos-test',
      FIREBASE_OWNER_UIDS: ' owner-uid-1,owner-uid-2 ',
    });

    expect(environment).toMatchObject({
      FIREBASE_PROJECT_ID: 'medicos-test',
      FIREBASE_OWNER_UIDS: ['owner-uid-1', 'owner-uid-2'],
    });
    expect(environment.OWNER_API_KEY_SHA256).toBeUndefined();
  });

  it.each([
    {},
    {
      FIREBASE_PROJECT_ID: 'medicos-test',
    },
    {
      FIREBASE_OWNER_UIDS: 'owner-uid-1',
    },
    {
      OWNER_API_KEY_SHA256: 'plaintext-is-not-accepted',
    },
  ])('rejects missing, incomplete or plaintext owner credentials', (authentication) => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        ...authentication,
        ...ownerResearchDatabase,
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('assigns deployment-specific service names', () => {
    expect(validateCommandApiEnvironment(ownerApiKeyAuthentication).SERVICE_NAME).toBe(
      'command-api',
    );
    expect(validateCatalogWorkerEnvironment({}).SERVICE_NAME).toBe('catalog-worker');
  });
});
