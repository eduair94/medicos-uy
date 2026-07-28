import { describe, expect, it } from 'vitest';

import {
  API_CATALOG_PATH,
  createApiCatalog,
  createDiscoveryLinkHeader,
  createLegacyRsdDocument,
  OPENAPI_DOCUMENT_PATH,
  SCALAR_DOCUMENTATION_PATH,
} from '../src/api-documentation';

describe('API documentation discovery', () => {
  it('creates an RFC 9727 Linkset catalog with machine and human documentation', () => {
    expect(createApiCatalog('https://api.example.test/')).toEqual({
      linkset: [
        {
          anchor: 'https://api.example.test/v1/professionals',
          'service-desc': [
            {
              href: `https://api.example.test${OPENAPI_DOCUMENT_PATH}`,
              type: 'application/json',
            },
          ],
          'service-doc': [
            {
              href: `https://api.example.test${SCALAR_DOCUMENTATION_PATH}`,
              type: 'text/html',
            },
          ],
          'service-meta': [
            {
              href: 'https://api.example.test/rsd.xml',
              type: 'application/rsd+xml',
            },
          ],
          status: [
            {
              href: 'https://api.example.test/health/live',
              type: 'application/json',
            },
            {
              href: 'https://api.example.test/health/ready',
              type: 'application/json',
            },
          ],
        },
      ],
    });
  });

  it('advertises the catalog, OpenAPI contract and Scalar reference through Link relations', () => {
    const header = createDiscoveryLinkHeader('https://api.example.test');

    expect(header).toContain(`<https://api.example.test${API_CATALOG_PATH}>; rel="api-catalog"`);
    expect(header).toContain(
      `<https://api.example.test${OPENAPI_DOCUMENT_PATH}>; rel="service-desc"`,
    );
    expect(header).toContain(
      `<https://api.example.test${SCALAR_DOCUMENTATION_PATH}>; rel="service-doc"`,
    );
  });

  it('escapes configured values in the backwards-compatible RSD document', () => {
    const document = createLegacyRsdDocument({
      publicBaseUrl: 'https://api.example.test',
      title: 'Médicos & Salud',
      repositoryUrl: 'https://example.test/repository?a=1&b=2',
    });

    expect(document).toContain('<engineName>Médicos &amp; Salud</engineName>');
    expect(document).toContain(
      '<engineLink>https://example.test/repository?a=1&amp;b=2</engineLink>',
    );
    expect(document).toContain('apiLink="https://api.example.test/openapi.json"');
  });
});
