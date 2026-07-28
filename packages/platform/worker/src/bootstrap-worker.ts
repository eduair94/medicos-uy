import { Logger, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

export async function bootstrapWorkerApplication(rootModule: Type<unknown>): Promise<void> {
  const app = await NestFactory.createApplicationContext(rootModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));

  const logger = new Logger('WorkerBootstrap');
  logger.log('Worker application context initialized');

  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      logger.log(`Received ${signal}; shutting down`);
      resolve();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  await app.close();
}

export function reportWorkerBootstrapError(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
