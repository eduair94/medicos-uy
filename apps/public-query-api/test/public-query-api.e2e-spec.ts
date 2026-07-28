import {
  PROFESSIONAL_CREDENTIALS_READER,
  type ProfessionalCredentialsReader,
} from '@medicos/credentials';
import { READINESS_PROBES } from '@medicos/health';
import { configureHttpApplication, createFastifyAdapter } from '@medicos/http';
import {
  InvalidProfessionalCursorError,
  PROFESSIONAL_FINDER,
  PROFESSIONAL_SEARCH,
  type ProfessionalFinder,
  type ProfessionalSearch,
} from '@medicos/professionals';
import { APPROVED_EVIDENCE_FINDER, type ApprovedEvidenceFinder } from '@medicos/provenance';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PublicQueryApiModule } from '../src/public-query-api.module';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const professional = {
  id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc8',
  slug: 'ana-perez',
  displayName: 'Ana Pérez',
};
const evidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7cc9';
const registeredTitleId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7cca';
const nameEvidence = {
  confidence: 'DETERMINISTIC' as const,
  source: {
    kind: 'GOVERNMENT_OPEN_DATA' as const,
    name: 'Synthetic MSP fixture',
    canonicalUrl: 'https://example.invalid/open-data',
    licenseUrl: 'https://example.invalid/license',
    reuseBasis: 'OPEN_DATA_LICENSE' as const,
    policyId: 'synthetic-policy-v1',
    validUntil: '2026-08-27T12:00:00.000Z',
  },
  canonicalUrl: 'https://example.invalid/open-data/medicos.csv',
  observedAt: '2026-07-26T12:00:00.000Z',
  sourceCutoffDate: '2026-07-01',
  validUntil: '2026-08-26T12:00:00.000Z',
  attribution: 'Synthetic contract fixture',
};

describe('public query API', () => {
  let app: NestFastifyApplication;
  const searchPublic = vi.fn<ProfessionalSearch['searchPublic']>((criteria) => {
    if (criteria.cursor === 'invalid') {
      return Promise.reject(new InvalidProfessionalCursorError());
    }

    return Promise.resolve({
      items: [professional],
    });
  });
  const findPublicByIdOrSlug = vi.fn<ProfessionalFinder['findPublicByIdOrSlug']>((idOrSlug) =>
    Promise.resolve(
      ['ana-perez', professional.id].includes(idOrSlug)
        ? {
            ...professional,
            currentNameEvidenceId: evidenceId,
          }
        : undefined,
    ),
  );
  const findApprovedById = vi
    .fn<ApprovedEvidenceFinder['findApprovedById']>()
    .mockResolvedValue(nameEvidence);
  const findPublicCredentials = vi
    .fn<ProfessionalCredentialsReader['findPublicByProfessionalId']>()
    .mockResolvedValue([
      {
        id: registeredTitleId,
        title: 'Doctor en Medicina',
        temporaryRegistration: 'NONE',
        evidenceId,
      },
    ]);

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [PublicQueryApiModule],
    })
      .overrideProvider(PROFESSIONAL_SEARCH)
      .useValue({
        searchPublic,
      } satisfies ProfessionalSearch)
      .overrideProvider(PROFESSIONAL_FINDER)
      .useValue({
        findPublicByIdOrSlug,
      } satisfies ProfessionalFinder)
      .overrideProvider(APPROVED_EVIDENCE_FINDER)
      .useValue({
        findApprovedById,
      } satisfies ApprovedEvidenceFinder)
      .overrideProvider(PROFESSIONAL_CREDENTIALS_READER)
      .useValue({
        findPublicByProfessionalId: findPublicCredentials,
      } satisfies ProfessionalCredentialsReader)
      .overrideProvider(READINESS_PROBES)
      .useValue([
        {
          name: 'catalog-database',
          check: async () => Promise.reject(new Error('database unavailable')),
        },
      ])
      .compile();

    app = moduleReference.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
      bufferLogs: true,
    });
    await configureHttpApplication(app, {
      apiDocumentation: {
        enabled: true,
        publicBaseUrl: 'https://api.example.test',
        repositoryUrl: 'https://github.com/example/medicos',
        title: 'Synthetic medical directory',
        version: '1.0.0-test',
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes a dependency-free liveness endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'public-query-api',
    });
  });

  it('fails readiness without leaking the dependency error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).not.toContain('database unavailable');
  });

  it('lists only the public DTO fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals?q=Ana&limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [professional],
    });
    expect(searchPublic).toHaveBeenLastCalledWith({
      query: 'Ana',
      limit: 10,
    });
  });

  it('resolves a professional by slug', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals/ana-perez',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...professional,
      nameEvidence,
    });
    expect(findApprovedById).toHaveBeenCalledWith(evidenceId);
  });

  it('returns only approved registered titles for a public professional', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/professionals/${professional.id}/credentials`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      professionalId: professional.id,
      registeredTitles: [
        {
          id: registeredTitleId,
          title: 'Doctor en Medicina',
          registrationState: 'ENABLED',
          temporaryRegistration: 'NONE',
          evidence: nameEvidence,
        },
      ],
    });
    expect(findPublicCredentials).toHaveBeenCalledWith(professional.id);
  });

  it('returns RFC 9457 problem details for an unknown professional', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json<{
      readonly traceId: string;
    }>();

    expect(problem).toMatchObject({
      type: 'about:blank',
      status: 404,
      instance: '/v1/professionals/missing',
    });
    expect(problem.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers['x-request-id']).toBe(problem.traceId);
  });

  it('rejects unknown query fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals?unexpected=true',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('maps an invalid opaque cursor to a public validation error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals?cursor=invalid',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('stack');
  });

  it('publishes a deterministic OpenAPI contract without fake authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    const document = response.json<{
      readonly openapi: string;
      readonly paths: Record<
        string,
        {
          readonly get?: {
            readonly operationId?: string;
            readonly parameters?: readonly { readonly name: string }[];
            readonly responses?: Record<string, { readonly content?: Record<string, unknown> }>;
          };
        }
      >;
      readonly components?: {
        readonly securitySchemes?: Record<string, unknown>;
      };
      readonly servers?: readonly { readonly url: string }[];
    }>();

    expect(document.openapi).toBe('3.0.0');
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/health/live',
        '/health/ready',
        '/v1/professionals',
        '/v1/professionals/{idOrSlug}',
        '/v1/professionals/{professionalId}/credentials',
      ].sort(),
    );
    expect(document.paths['/v1/professionals']?.get?.operationId).toBe('searchProfessionals');
    expect(
      document.paths['/v1/professionals']?.get?.parameters?.map((parameter) => parameter.name),
    ).toEqual(['q', 'cursor', 'limit']);
    expect(document.paths['/v1/professionals']?.get?.responses?.['400']?.content).toHaveProperty(
      'application/problem+json',
    );
    expect(document.components?.securitySchemes).toBeUndefined();
    expect(document.servers).toEqual([
      { url: 'https://api.example.test', description: 'Servidor público configurado' },
    ]);
  });

  it('renders Scalar with a pinned client and compatible security policy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('@scalar/api-reference@1.63.0');
    expect(response.body).toContain('/openapi.json');
    expect(response.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');
  });

  it('supports modern API discovery and backwards-compatible RSD', async () => {
    const catalog = await app.inject({
      method: 'GET',
      url: '/.well-known/api-catalog',
    });
    const catalogHead = await app.inject({
      method: 'HEAD',
      url: '/.well-known/api-catalog',
    });
    const rsd = await app.inject({
      method: 'GET',
      url: '/rsd.xml',
    });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers['content-type']).toContain('application/linkset+json');
    expect(catalog.headers['content-type']).toContain('https://www.rfc-editor.org/info/rfc9727');
    expect(catalog.json()).toMatchObject({
      linkset: [
        {
          anchor: 'https://api.example.test/v1/professionals',
        },
      ],
    });
    expect(catalogHead.statusCode).toBe(200);
    expect(catalogHead.body).toBe('');
    expect(catalogHead.headers.link).toContain('rel="service-desc"');
    expect(rsd.statusCode).toBe(200);
    expect(rsd.headers['content-type']).toContain('application/rsd+xml');
    expect(rsd.body).toContain('apiLink="https://api.example.test/openapi.json"');
  });
});
