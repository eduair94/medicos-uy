import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  configureHttpApplication,
  createFastifyAdapter,
  createOpenApiDocument,
} from '@medicos/http';
import { NestFactory } from '@nestjs/core';
import { format } from 'prettier';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const OUTPUT_PATH = resolve('openapi/public-api.json');

function configureDeterministicEnvironment(): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'https://app.example.invalid',
    API_DOCUMENTATION_ENABLED: 'false',
    PUBLIC_QUERY_API_PORT: '3001',
    PUBLIC_API_BASE_URL: 'https://api.example.invalid',
    CATALOG_DATABASE_URL: 'postgresql://contract:contract@127.0.0.1:9/medicos_openapi_contract',
    CATALOG_DATABASE_POOL_MAX: '1',
    CATALOG_DATABASE_SSL: 'false',
    OWNER_RESEARCH_DATABASE_URL:
      'postgresql://contract:contract@127.0.0.1:9/medicos_openapi_contract',
    OWNER_RESEARCH_DATABASE_POOL_MAX: '1',
    OWNER_API_BASIC_USERNAME: 'owner',
    OWNER_API_KEY_SHA256: 'c64bcba7b5650a21e86aaa762fe60684b0cf4d9791120337bdb840047907fb0e', // gitleaks:allow - deterministic contract fixture
  });
}

export async function generatePublicOpenApiDocument(): Promise<string> {
  configureDeterministicEnvironment();
  const { PublicQueryApiModule } =
    await import('../../apps/public-query-api/src/public-query-api.module.js');
  const app = await NestFactory.create<NestFastifyApplication>(
    PublicQueryApiModule,
    createFastifyAdapter(),
    {
      abortOnError: false,
      bufferLogs: true,
      logger: false,
    },
  );

  try {
    await configureHttpApplication(app, {
      apiDocumentation: {
        enabled: false,
      },
      ownerAuthentication: {
        basicEnabled: true,
      },
    });
    await app.init();
    const document = createOpenApiDocument(app, {
      authentication: {
        basic: true,
        firebaseBearer: false,
        ownerApiKey: true,
      },
      enabled: true,
      publicBaseUrl: 'https://api.example.invalid',
      title: 'Directorio Médico Uruguay',
      description:
        'API privada, de solo lectura, del directorio médico uruguayo. Los datos y candidatos pueden estar desactualizados y deben verificarse en su fuente original.',
      version: '1.0.0',
      repositoryUrl: 'https://github.com/eduair94/medicos-uy',
    });

    return format(JSON.stringify(document), {
      endOfLine: 'lf',
      parser: 'json',
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
    });
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const generated = await generatePublicOpenApiDocument();

  if (process.argv.includes('--check')) {
    let committed: string;
    try {
      committed = await readFile(OUTPUT_PATH, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('openapi/public-api.json is missing; run pnpm openapi:generate.', {
          cause: error,
        });
      }

      throw error;
    }

    if (committed !== generated) {
      throw new Error(
        'The committed OpenAPI contract is stale; run pnpm openapi:generate and review the diff.',
      );
    }
    process.stdout.write('OpenAPI contract is current.\n');
    return;
  }

  await mkdir(resolve('openapi'), {
    recursive: true,
  });
  await writeFile(OUTPUT_PATH, generated, 'utf8');
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
