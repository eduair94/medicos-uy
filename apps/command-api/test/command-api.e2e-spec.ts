import { configureHttpApplication, createFastifyAdapter } from '@medicos/http';
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandApiModule } from '../src/command-api.module';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const ownerApiKeyHeaders = {
  'x-api-key': 'test-owner-api-key',
} as const;
const ownerBasicHeaders = {
  authorization: `Basic ${Buffer.from('owner:test-owner-api-key', 'utf8').toString('base64')}`,
} as const;

@Controller({
  path: 'rate-limit-probe',
  version: VERSION_NEUTRAL,
})
class RateLimitProbeController {
  @Get()
  public get(): {
    readonly status: 'ok';
  } {
    return {
      status: 'ok',
    };
  }
}

describe('command API foundation', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({
      controllers: [RateLimitProbeController],
      imports: [CommandApiModule],
    }).compile();

    app = moduleReference.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), {
      bufferLogs: true,
    });
    await configureHttpApplication(app, {
      apiDocumentation: {
        enabled: false,
      },
      rateLimitMax: 1,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts with the owner API-key bootstrap and without Firebase credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'command-api',
      checks: [],
    });
  });

  it('keeps health endpoints outside the global rate limiter', async () => {
    const firstResponse = await app.inject({
      method: 'GET',
      url: '/health/live',
    });
    const secondResponse = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
  });

  it('protects non-health routes before Nest route resolution', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/private-auth-probe',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('does not accept HTTP Basic on the command API', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/basic-auth-probe',
      headers: ownerBasicHeaders,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('returns RFC 9457 status 429 and ignores spoofed forwarding headers', async () => {
    const firstResponse = await app.inject({
      method: 'GET',
      url: '/rate-limit-probe',
      headers: {
        ...ownerApiKeyHeaders,
        'x-forwarded-for': '203.0.113.10',
      },
    });
    const secondResponse = await app.inject({
      method: 'GET',
      url: '/rate-limit-probe',
      headers: {
        ...ownerApiKeyHeaders,
        'x-forwarded-for': '198.51.100.20',
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.headers['content-type']).toContain('application/problem+json');
    expect(secondResponse.json()).toMatchObject({
      status: 429,
      detail: 'Too many requests.',
    });
  });
});
