import { randomUUID } from 'node:crypto';

import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Logger, ValidationPipe, VersioningType, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger as PinoLogger } from 'nestjs-pino';

import { registerApiDocumentation, type ApiDocumentationOptions } from './api-documentation';
import {
  createOwnerAuthenticator,
  resolveEnabledOwnerAuthenticationMethods,
  type OwnerAuthenticationConfiguration,
  type OwnerAuthenticator,
} from './owner-authentication';
import {
  asOwnerAuthenticationHeaders,
  createOwnerAuthenticationHook,
  type OwnerAuthenticationCache,
} from './owner-authentication-hook';
import { ProblemDetailsFilter } from './problem-details.filter';

import type { FastifyRequest } from 'fastify';

export interface ConfigureHttpApplicationOptions {
  readonly rateLimitMax?: number;
  readonly apiDocumentation?: Partial<ApiDocumentationOptions>;
  readonly ownerAuthentication?: {
    readonly basicEnabled?: boolean;
  };
  readonly ownerAuthenticator?: OwnerAuthenticator;
  /** @deprecated Use apiDocumentation.enabled. */
  readonly swagger?: boolean;
}

export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
  });
}

export async function createOwnerRateLimitKey(
  request: FastifyRequest,
  authenticator: OwnerAuthenticator,
  authenticationCache: OwnerAuthenticationCache,
): Promise<string> {
  const authenticated = await authenticator.authenticate(asOwnerAuthenticationHeaders(request));
  authenticationCache.set(request, authenticated);

  if (!authenticated) {
    return `anonymous:${request.ip}`;
  }

  return 'authenticated:owner';
}

export async function configureHttpApplication(
  app: NestFastifyApplication,
  options: ConfigureHttpApplicationOptions = {},
): Promise<void> {
  const config = app.get(ConfigService);
  const apiDocumentationEnabled =
    options.apiDocumentation?.enabled ??
    options.swagger ??
    config.get<boolean>('API_DOCUMENTATION_ENABLED', config.get<boolean>('SWAGGER_ENABLED', false));
  const corsOrigins = config.get<readonly string[]>('CORS_ORIGINS', []);
  const fastify = app.getHttpAdapter().getInstance();
  const ownerAuthenticationConfiguration: OwnerAuthenticationConfiguration = {
    basicEnabled: options.ownerAuthentication?.basicEnabled ?? false,
    firebaseOwnerUids: config.get<readonly string[]>('FIREBASE_OWNER_UIDS', []),
    ownerApiBasicUsername: config.get<string>('OWNER_API_BASIC_USERNAME', 'owner'),
    ...(config.get<string>('FIREBASE_PROJECT_ID') === undefined
      ? {}
      : { firebaseProjectId: config.getOrThrow<string>('FIREBASE_PROJECT_ID') }),
    ...(config.get<string>('OWNER_API_KEY_SHA256') === undefined
      ? {}
      : { ownerApiKeySha256: config.getOrThrow<string>('OWNER_API_KEY_SHA256') }),
  };
  const enabledOwnerAuthenticationMethods = resolveEnabledOwnerAuthenticationMethods(
    ownerAuthenticationConfiguration,
  );
  const ownerAuthenticator =
    options.ownerAuthenticator ?? createOwnerAuthenticator(ownerAuthenticationConfiguration);
  const ownerAuthenticationCache: OwnerAuthenticationCache = new WeakMap();

  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  app.enableVersioning({
    type: VersioningType.URI,
  });
  app.enableCors({
    credentials: false,
    origin: [...corsOrigins],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          ...(apiDocumentationEnabled ? ['https://cdn.jsdelivr.net'] : []),
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });
  await app.register(compress);
  await app.register(rateLimit, {
    allowList: (request) => request.url === '/health/live' || request.url === '/health/ready',
    global: true,
    keyGenerator: (request) =>
      createOwnerRateLimitKey(request, ownerAuthenticator, ownerAuthenticationCache),
    max: options.rateLimitMax ?? config.get<number>('HTTP_RATE_LIMIT_MAX', 100),
    timeWindow: config.get<string>('HTTP_RATE_LIMIT_WINDOW', '1 minute'),
  });

  fastify.addHook(
    'onRequest',
    createOwnerAuthenticationHook(
      ownerAuthenticator,
      enabledOwnerAuthenticationMethods,
      ownerAuthenticationCache,
    ),
  );

  if (apiDocumentationEnabled) {
    const serviceName = config.get<string>('SERVICE_NAME', 'medicos-api');
    const port = config.get<number>('PORT', 3001);
    const publicBaseUrl =
      options.apiDocumentation?.publicBaseUrl ??
      config.get<string>('PUBLIC_API_BASE_URL', `http://localhost:${port}`);

    registerApiDocumentation(app, {
      authentication: enabledOwnerAuthenticationMethods,
      enabled: true,
      publicBaseUrl,
      title: options.apiDocumentation?.title ?? serviceName,
      description:
        options.apiDocumentation?.description ??
        'API privada de consulta del directorio médico uruguayo para el propietario. Conserva procedencia, estados de verificación y advertencias; no constituye asesoramiento médico ni jurídico.',
      version: options.apiDocumentation?.version ?? '1.0.0',
      repositoryUrl:
        options.apiDocumentation?.repositoryUrl ?? 'https://github.com/eduair94/medicos-uy',
    });
  }
}

export async function bootstrapHttpApplication(
  rootModule: Type<unknown>,
  options: ConfigureHttpApplicationOptions = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(rootModule, createFastifyAdapter(), {
    bufferLogs: true,
  });

  await configureHttpApplication(app, options);

  const config = app.get(ConfigService);
  const host = config.get<string>('HOST', '0.0.0.0');
  const port = config.getOrThrow<number>('PORT');

  await app.listen({
    host,
    port,
  });

  const logger = new Logger('HttpBootstrap');
  logger.log(`Listening on ${host}:${port}`);

  return app;
}

export function reportBootstrapError(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
