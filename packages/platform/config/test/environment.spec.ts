import { describe, expect, it } from 'vitest';

import {
  EnvironmentValidationError,
  validateCatalogWorkerEnvironment,
  validateCommandApiEnvironment,
  validatePublicQueryApiEnvironment,
} from '../src';

describe('environment validation', () => {
  it('normalizes the public query API environment', () => {
    const environment = validatePublicQueryApiEnvironment({
      NODE_ENV: 'test',
      CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      CATALOG_DATABASE_SSL: 'false',
      CORS_ORIGINS: 'http://localhost:3000, https://example.test ',
      PUBLIC_QUERY_API_PORT: '3101',
      API_DOCUMENTATION_ENABLED: 'true',
      PUBLIC_API_BASE_URL: 'https://api.medicos.test',
    });

    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      SERVICE_NAME: 'public-query-api',
      HOST: '0.0.0.0',
      PORT: 3101,
      CATALOG_DATABASE_SSL: false,
      API_DOCUMENTATION_ENABLED: true,
      PUBLIC_API_BASE_URL: 'https://api.medicos.test',
      CORS_ORIGINS: ['http://localhost:3000', 'https://example.test'],
    });
  });

  it('fails before bootstrap when a required value is invalid', () => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        CATALOG_DATABASE_URL: 'not-a-url',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it.each([
    {
      CATALOG_DATABASE_URL: 'https://example.test/catalog',
    },
    {
      CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
      CORS_ORIGINS: '*',
    },
    {
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
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        API_DOCUMENTATION_ENABLED: true,
      }).API_DOCUMENTATION_ENABLED,
    ).toBe(true);
  });

  it.each([null, 'sometimes'])('rejects an unsupported boolean input (%s)', (value) => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        API_DOCUMENTATION_ENABLED: value,
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('keeps SWAGGER_ENABLED as a backwards-compatible alias', () => {
    expect(
      validatePublicQueryApiEnvironment({
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        SWAGGER_ENABLED: 'true',
      }).API_DOCUMENTATION_ENABLED,
    ).toBe(true);
  });

  it('requires a canonical public base URL for production documentation', () => {
    expect(() =>
      validatePublicQueryApiEnvironment({
        NODE_ENV: 'production',
        CATALOG_DATABASE_URL: 'postgresql://user:password@localhost:5432/catalog',
        API_DOCUMENTATION_ENABLED: 'true',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('assigns deployment-specific service names', () => {
    expect(validateCommandApiEnvironment({}).SERVICE_NAME).toBe('command-api');
    expect(validateCatalogWorkerEnvironment({}).SERVICE_NAME).toBe('catalog-worker');
  });
});
