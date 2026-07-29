import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SENSITIVE_LOG_PATHS = [
  'authorization',
  'cookie',
  'token',
  'idToken',
  'appCheckToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-api-key',
  'req.headers.x-firebase-appcheck',
  'res.headers.set-cookie',
  '*.authorization',
  '*.cookie',
  '*.apiKey',
  '*.token',
  '*.idToken',
  '*.appCheckToken',
] as const;

interface SafeRequestLog {
  readonly id?: string;
  readonly method?: string;
}

interface SafeResponseLog {
  readonly statusCode: number;
}

interface SafeErrorLog {
  readonly type: string;
}

export function serializeSafeRequest(request: IncomingMessage): SafeRequestLog {
  const requestId: unknown = (request as IncomingMessage & { readonly id?: unknown }).id;

  return {
    ...(typeof requestId === 'string' ? { id: requestId } : {}),
    ...(request.method === undefined ? {} : { method: request.method }),
  };
}

export function serializeSafeResponse(response: ServerResponse): SafeResponseLog {
  return {
    statusCode: response.statusCode,
  };
}

export function serializeSafeError(error: Error): SafeErrorLog {
  return {
    type: error.name,
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): Params => ({
        pinoHttp: {
          level: config.get<string>('LOG_LEVEL', 'info'),
          redact: {
            paths: [...SENSITIVE_LOG_PATHS],
            censor: '[REDACTED]',
          },
          serializers: {
            err: serializeSafeError,
            req: serializeSafeRequest,
            res: serializeSafeResponse,
          },
          wrapSerializers: false,
          customProps: () => ({
            environment: config.get<string>('NODE_ENV', 'development'),
            service: config.get<string>('SERVICE_NAME', 'unknown-service'),
          }),
          autoLogging: {
            ignore: (request) => request.url === '/health/live',
          },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class ObservabilityModule {}
