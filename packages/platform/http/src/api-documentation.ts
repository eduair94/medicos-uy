import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';

import type { EnabledOwnerAuthenticationMethods } from './owner-authentication';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export const OPENAPI_DOCUMENT_PATH = '/openapi.json' as const;
export const SCALAR_DOCUMENTATION_PATH = '/docs' as const;
export const API_CATALOG_PATH = '/.well-known/api-catalog' as const;
export const LEGACY_RSD_PATH = '/rsd.xml' as const;
export const LEGACY_WELL_KNOWN_RSD_PATH = '/.well-known/rsd.xml' as const;

const API_CATALOG_PROFILE = 'https://www.rfc-editor.org/info/rfc9727';
const SCALAR_CDN_URL = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.63.0' as const;

export interface ApiDocumentationOptions {
  readonly authentication: EnabledOwnerAuthenticationMethods;
  readonly enabled: boolean;
  readonly publicBaseUrl: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly repositoryUrl: string;
}

export interface ApiCatalogDocument {
  readonly linkset: readonly [
    {
      readonly anchor: string;
      readonly 'service-desc': readonly [
        {
          readonly href: string;
          readonly type: string;
        },
      ];
      readonly 'service-doc': readonly [
        {
          readonly href: string;
          readonly type: string;
        },
      ];
      readonly 'service-meta': readonly [
        {
          readonly href: string;
          readonly type: string;
        },
      ];
      readonly status: readonly [
        {
          readonly href: string;
          readonly type: string;
        },
        {
          readonly href: string;
          readonly type: string;
        },
      ];
    },
  ];
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function createApiCatalog(publicBaseUrl: string): ApiCatalogDocument {
  const baseUrl = withoutTrailingSlash(publicBaseUrl);

  return {
    linkset: [
      {
        anchor: `${baseUrl}/v1/professionals`,
        'service-desc': [
          {
            href: `${baseUrl}${OPENAPI_DOCUMENT_PATH}`,
            type: 'application/json',
          },
        ],
        'service-doc': [
          {
            href: `${baseUrl}${SCALAR_DOCUMENTATION_PATH}`,
            type: 'text/html',
          },
        ],
        'service-meta': [
          {
            href: `${baseUrl}${LEGACY_RSD_PATH}`,
            type: 'application/rsd+xml',
          },
        ],
        status: [
          {
            href: `${baseUrl}/health/live`,
            type: 'application/json',
          },
          {
            href: `${baseUrl}/health/ready`,
            type: 'application/json',
          },
        ],
      },
    ],
  };
}

export function createDiscoveryLinkHeader(publicBaseUrl: string): string {
  const baseUrl = withoutTrailingSlash(publicBaseUrl);

  return [
    `<${baseUrl}${API_CATALOG_PATH}>; rel="api-catalog"; type="application/linkset+json"`,
    `<${baseUrl}${OPENAPI_DOCUMENT_PATH}>; rel="service-desc"; type="application/json"`,
    `<${baseUrl}${SCALAR_DOCUMENTATION_PATH}>; rel="service-doc"; type="text/html"`,
  ].join(', ');
}

export function createLegacyRsdDocument(options: {
  readonly publicBaseUrl: string;
  readonly title: string;
  readonly repositoryUrl: string;
}): string {
  const baseUrl = escapeXml(withoutTrailingSlash(options.publicBaseUrl));
  const title = escapeXml(options.title);
  const repositoryUrl = escapeXml(options.repositoryUrl);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsd version="1.0" xmlns="http://archipelago.phrasewise.com/rsd">',
    '  <service>',
    `    <engineName>${title}</engineName>`,
    `    <engineLink>${repositoryUrl}</engineLink>`,
    `    <homePageLink>${baseUrl}${SCALAR_DOCUMENTATION_PATH}</homePageLink>`,
    '    <apis>',
    `      <api name="OpenAPI" preferred="true" apiLink="${baseUrl}${OPENAPI_DOCUMENT_PATH}" blogID="">`,
    '        <settings>',
    `          <setting name="documentation" value="${baseUrl}${SCALAR_DOCUMENTATION_PATH}" />`,
    `          <setting name="apiCatalog" value="${baseUrl}${API_CATALOG_PATH}" />`,
    '        </settings>',
    '      </api>',
    '    </apis>',
    '  </service>',
    '</rsd>',
    '',
  ].join('\n');
}

export function createOpenApiDocument(
  app: NestFastifyApplication,
  options: ApiDocumentationOptions,
): OpenAPIObject {
  const baseUrl = withoutTrailingSlash(options.publicBaseUrl);
  const builder = new DocumentBuilder()
    .setTitle(options.title)
    .setDescription(options.description)
    .setVersion(options.version)
    .setLicense('MIT', `${options.repositoryUrl}/blob/main/LICENSE`)
    .setTermsOfService(`${options.repositoryUrl}/blob/main/docs/PRIVACY_PUBLICATION_GATE.md`)
    .setExternalDoc('Referencia interactiva con Scalar', `${baseUrl}/docs`)
    .addServer(baseUrl, 'Servidor privado configurado');

  if (options.authentication.basic) {
    builder
      .addBasicAuth(
        {
          type: 'http',
          scheme: 'basic',
          description:
            'Acceso owner para navegador. Usa el usuario configurado y la misma clave privada que X-API-Key.',
        },
        'ownerBasic',
      )
      .addSecurityRequirements('ownerBasic');
  }

  if (options.authentication.ownerApiKey) {
    builder
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Clave owner privada; el servidor conserva solamente su SHA-256.',
        },
        'ownerApiKey',
      )
      .addSecurityRequirements('ownerApiKey');
  }

  if (options.authentication.firebaseBearer) {
    builder
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Firebase ID token',
          description: 'Firebase ID token de un UID owner autorizado.',
        },
        'firebaseBearer',
      )
      .addSecurityRequirements('firebaseBearer');
  }

  const configuration = builder
    .addTag('professionals', 'Búsqueda y detalle de profesionales publicados')
    .addTag('credentials', 'Títulos habilitantes publicados con evidencia')
    .build();

  const document = SwaggerModule.createDocument(app, configuration, {
    deepScanRoutes: true,
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
  });
  document.info.contact = {
    name: 'Proyecto Directorio Médico Uruguay',
    url: `${options.repositoryUrl}/issues`,
  };

  const operationMethods = [
    'delete',
    'get',
    'head',
    'options',
    'patch',
    'post',
    'put',
    'trace',
  ] as const;
  const unauthorizedResponse = {
    description: 'Owner authentication is required.',
    content: {
      'application/problem+json': {
        schema: {
          $ref: '#/components/schemas/ProblemDetailsResponseDto',
        },
      },
    },
  } as const;

  for (const [path, pathItem] of Object.entries(document.paths)) {
    const publicHealthPath = path === '/health/live' || path === '/health/ready';

    for (const method of operationMethods) {
      const operation = pathItem[method];

      if (operation === undefined) {
        continue;
      }

      if (publicHealthPath) {
        operation.security = [];
        delete operation.responses['401'];
        continue;
      }

      operation.responses['401'] = unauthorizedResponse;
    }
  }

  return document;
}

export function registerApiDocumentation(
  app: NestFastifyApplication,
  options: ApiDocumentationOptions,
): OpenAPIObject {
  const fastify = app.getHttpAdapter().getInstance();
  const document = createOpenApiDocument(app, options);
  const apiCatalog = createApiCatalog(options.publicBaseUrl);
  const discoveryLink = createDiscoveryLinkHeader(options.publicBaseUrl);
  const rsdDocument = createLegacyRsdDocument(options);

  fastify.addHook('onSend', (_request, reply, _payload, done) => {
    void reply.header('link', discoveryLink);
    done();
  });

  fastify.get(OPENAPI_DOCUMENT_PATH, async (_request, reply) => {
    void reply.header('cache-control', 'private, no-store').type('application/json; charset=utf-8');
    return document;
  });

  fastify.get(API_CATALOG_PATH, async (_request, reply) => {
    void reply
      .header('cache-control', 'private, no-store')
      .type(`application/linkset+json; profile="${API_CATALOG_PROFILE}"`);
    return apiCatalog;
  });

  for (const path of [LEGACY_RSD_PATH, LEGACY_WELL_KNOWN_RSD_PATH] as const) {
    fastify.get(path, async (_request, reply) => {
      void reply
        .header('cache-control', 'private, no-store')
        .type('application/rsd+xml; charset=utf-8');
      return rsdDocument;
    });
  }

  app.use(
    SCALAR_DOCUMENTATION_PATH,
    apiReference({
      cdn: SCALAR_CDN_URL,
      hideClientButton: false,
      layout: 'modern',
      pageTitle: `${options.title} | API`,
      persistAuth: false,
      showDeveloperTools: 'always',
      telemetry: false,
      theme: 'default',
      url: OPENAPI_DOCUMENT_PATH,
      withFastify: true,
    }),
  );

  return document;
}
