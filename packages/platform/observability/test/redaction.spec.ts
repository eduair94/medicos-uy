import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { SENSITIVE_LOG_PATHS, serializeSafeRequest } from '../src';

describe('log redaction policy', () => {
  it.each([
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers.x-firebase-appcheck',
    '*.token',
  ])('redacts %s', (path) => {
    expect(SENSITIVE_LOG_PATHS).toContain(path);
  });

  it('omits query strings, names, headers and tokens from actual log output', () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = pino(
      {
        redact: {
          paths: [...SENSITIVE_LOG_PATHS],
          censor: '[REDACTED]',
        },
        serializers: {
          req: serializeSafeRequest,
        },
      },
      destination,
    );

    logger.info({
      req: {
        id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7999',
        method: 'GET',
        url: '/v1/professionals?q=Ana%20Perez',
        query: {
          q: 'Ana Perez',
        },
        headers: {
          authorization: 'Bearer secret-id-token',
        },
      },
      security: {
        token: 'secret-app-check-token',
      },
    });

    const output = chunks.join('');
    const entry = JSON.parse(output) as {
      readonly req: Record<string, unknown>;
      readonly security: {
        readonly token: string;
      };
    };

    expect(entry.req).toEqual({
      id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7999',
      method: 'GET',
    });
    expect(entry.security.token).toBe('[REDACTED]');
    expect(output).not.toContain('Ana');
    expect(output).not.toContain('secret-id-token');
    expect(output).not.toContain('secret-app-check-token');
  });
});
