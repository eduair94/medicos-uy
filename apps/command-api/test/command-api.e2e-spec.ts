import { configureHttpApplication, createFastifyAdapter } from '@medicos/http';
import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandApiModule } from '../src/command-api.module';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

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

  it('starts without catalog, Firebase or restricted-store credentials', async () => {
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

  it('returns RFC 9457 status 429 and ignores spoofed forwarding headers', async () => {
    const firstResponse = await app.inject({
      method: 'GET',
      url: '/rate-limit-probe',
      headers: {
        'x-forwarded-for': '203.0.113.10',
      },
    });
    const secondResponse = await app.inject({
      method: 'GET',
      url: '/rate-limit-probe',
      headers: {
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
