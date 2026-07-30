import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DATA_DIRECTORY_NAMES = [
  'raw',
  'processed',
  'normalized',
  'manifests',
  'logs',
  'curation',
  'validation',
] as const;

export function configuredDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    environment['DATA_INGESTION_DIR'] ??
      environment['MSP_INGESTION_DATA_DIR'] ??
      environment['INGESTION_DATA_DIR'] ??
      'data',
  );
}

export async function prepareDataDirectories(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dataDirectory = configuredDataDirectory(environment);
  await mkdir(dataDirectory, { mode: 0o700, recursive: true });
  await Promise.all(
    DATA_DIRECTORY_NAMES.map(async (name) => {
      await mkdir(resolve(dataDirectory, name), { mode: 0o700, recursive: true });
    }),
  );
  return dataDirectory;
}

async function main(): Promise<void> {
  const dataDirectory = await prepareDataDirectories();
  process.stdout.write(
    `${JSON.stringify({ event: 'data_directories_prepared', dataDirectory })}\n`,
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({ event: 'data_directories_prepare_failed', message })}\n`,
    );
    process.exitCode = 1;
  });
}
