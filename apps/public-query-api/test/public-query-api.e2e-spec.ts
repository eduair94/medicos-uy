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
import { GetOwnerProfessionalResearch, type OwnerProfessionalResearch } from '@medicos/research';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PublicQueryApiModule } from '../src/public-query-api.module';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const OWNER_API_KEY = 'test-owner-api-key';
const ownerApiKeyHeaders = {
  'x-api-key': OWNER_API_KEY,
} as const;
const ownerBasicHeaders = {
  authorization: `Basic ${Buffer.from(`owner:${OWNER_API_KEY}`, 'utf8').toString('base64')}`,
} as const;

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
const ownerResearch = {
  professionalId: professional.id,
  slug: professional.slug,
  analysisVersion: 'professional-research-v1',
  runStatus: 'COMPLETED',
  reportId: 'professional_research_v1_e2e',
  generatedAt: '2026-07-29T12:00:00.000Z',
  queryAmbiguity: 'NONE',
  bestFlexibilityIndex: 0,
  counts: {
    candidates: 1,
    officialRegistryRecords: 1,
    institutionalCandidates: 1,
    schedules: 1,
    webCandidates: 0,
    publicReferenceCandidates: 0,
    ethicsCandidates: 0,
  },
  notice: {
    associationsAreUnconfirmedCandidates: true,
    sourceDeclaredSpecialtyIsNotMspCredential: true,
    publishedScheduleIsNotRealtimeAvailability: true,
    absenceOfFindingsDoesNotProveAbsence: true,
    verifyWithOriginalSource: true,
    text: 'Synthetic owner-only research notice.',
  },
  dossier: {
    schemaVersion: 1,
    reportId: 'professional_research_v1_e2e',
    generatedAt: '2026-07-29T12:00:00.000Z',
    purpose: 'INTERNAL_PROFESSIONAL_RESEARCH',
    candidates: [],
  },
} as unknown as OwnerProfessionalResearch;

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
  const getOwnerProfessionalResearch = vi.fn().mockResolvedValue(ownerResearch);

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
      .overrideProvider(GetOwnerProfessionalResearch)
      .useValue({
        execute: getOwnerProfessionalResearch,
      })
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
      ownerAuthentication: {
        basicEnabled: true,
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

  it.each([
    '/v1/professionals',
    '/v1/professionals/ana-perez/research',
    '/openapi.json',
    '/docs',
    '/.well-known/api-catalog',
    '/rsd.xml',
  ])('requires owner authentication for %s', async (url) => {
    const response = await app.inject({
      method: 'GET',
      url,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['www-authenticate']).toContain('Basic realm="Medicos owner API"');
    expect(response.headers['www-authenticate']).not.toContain('Bearer realm="medicos-owner"');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      status: 401,
      detail: 'Owner authentication is required.',
    });
  });

  it('lists only the public DTO fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals?q=Ana&limit=10',
      headers: ownerApiKeyHeaders,
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
      headers: ownerApiKeyHeaders,
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
      headers: ownerApiKeyHeaders,
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

  it('returns the owner research dossier through an authenticated request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/professionals/${professional.id}/research`,
      headers: ownerApiKeyHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      professionalId: professional.id,
      counts: {
        institutionalCandidates: 1,
        schedules: 1,
      },
      notice: {
        associationsAreUnconfirmedCandidates: true,
      },
      dossier: {
        reportId: 'professional_research_v1_e2e',
      },
    });
    expect(getOwnerProfessionalResearch).toHaveBeenCalledWith(professional.id);
  });

  it('returns RFC 9457 problem details for an unknown professional', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals/missing',
      headers: ownerApiKeyHeaders,
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
      headers: ownerApiKeyHeaders,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('maps an invalid opaque cursor to a public validation error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/professionals?cursor=invalid',
      headers: ownerApiKeyHeaders,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('stack');
  });

  it('publishes a deterministic owner-authenticated OpenAPI contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json',
      headers: ownerApiKeyHeaders,
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
            readonly security?: readonly Record<string, readonly string[]>[];
          };
        }
      >;
      readonly components?: {
        readonly securitySchemes?: Record<string, unknown>;
      };
      readonly security?: readonly Record<string, readonly string[]>[];
      readonly servers?: readonly { readonly url: string }[];
    }>();

    expect(document.openapi).toBe('3.0.0');
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/health/live',
        '/health/ready',
        '/v1/professionals',
        '/v1/professionals/{idOrSlug}',
        '/v1/professionals/{idOrSlug}/research',
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
    expect(document.components?.securitySchemes).toEqual({
      ownerBasic: {
        type: 'http',
        scheme: 'basic',
        description:
          'Acceso owner para navegador. Usa el usuario configurado y la misma clave privada que X-API-Key.',
      },
      ownerApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Clave owner privada; el servidor conserva solamente su SHA-256.',
      },
    });
    expect(document.security).toEqual([{ ownerBasic: [] }, { ownerApiKey: [] }]);
    expect(document.paths['/health/live']?.get?.security).toEqual([]);
    expect(document.paths['/health/ready']?.get?.security).toEqual([]);
    expect(document.paths['/health/live']?.get?.responses?.['401']).toBeUndefined();
    expect(document.paths['/health/ready']?.get?.responses?.['401']).toBeUndefined();

    for (const [path, pathItem] of Object.entries(document.paths)) {
      if (path === '/health/live' || path === '/health/ready') {
        continue;
      }

      expect(pathItem.get?.responses?.['401']?.content).toHaveProperty('application/problem+json');
    }
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(document.servers).toEqual([
      { url: 'https://api.example.test', description: 'Servidor privado configurado' },
    ]);
  });

  it('renders Scalar with a pinned client and compatible security policy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: ownerBasicHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('@scalar/api-reference@1.63.0');
    expect(response.body).toContain('/openapi.json');
    expect(response.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('supports modern API discovery and backwards-compatible RSD', async () => {
    const catalog = await app.inject({
      method: 'GET',
      url: '/.well-known/api-catalog',
      headers: ownerApiKeyHeaders,
    });
    const catalogHead = await app.inject({
      method: 'HEAD',
      url: '/.well-known/api-catalog',
      headers: ownerApiKeyHeaders,
    });
    const rsd = await app.inject({
      method: 'GET',
      url: '/rsd.xml',
      headers: ownerApiKeyHeaders,
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
