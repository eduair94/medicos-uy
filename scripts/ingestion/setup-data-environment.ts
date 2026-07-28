import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_INFOTITULOS_URL =
  'https://www.gub.uy/ministerio-salud-publica/sites/ministerio-salud-publica/files/2026-07/Infot%C3%ADtulos%20-%20Junio%202026.csv';

interface DataEnvironmentOptions {
  readonly destinationPath?: string;
  readonly generateSecret?: () => string;
}

export async function createDataEnvironment(options: DataEnvironmentOptions = {}): Promise<string> {
  const destinationPath = resolve(options.destinationPath ?? '.env.data.local');
  const secret = (options.generateSecret ?? (() => randomBytes(48).toString('base64url')))();
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Generated MSP linkage secret must contain at least 32 bytes');
  }

  const content = [
    '# Generated locally. This file is ignored by Git; move the secret to a secret manager in production.',
    `MSP_LINKAGE_HMAC_KEY=${secret}`,
    'MSP_ALLOW_INSECURE_TLS=false',
    'DATA_INGESTION_DIR=data',
    'MSP_INGESTION_DATA_DIR=data',
    'INGESTION_DATA_DIR=data',
    `MSP_INFOTITULOS_URL=${DEFAULT_INFOTITULOS_URL}`,
    '',
  ].join('\n');

  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });

  return destinationPath;
}

async function main(): Promise<void> {
  const path = await createDataEnvironment();
  console.log(JSON.stringify({ event: 'data_environment_created', path, secretPrinted: false }));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown setup error';
    console.error(JSON.stringify({ event: 'data_environment_setup_failed', message }));
    process.exitCode = 1;
  });
}
