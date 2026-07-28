import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDataEnvironment } from './setup-data-environment';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('createDataEnvironment', () => {
  it('creates a local environment without exposing a weak linkage key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'medicos-data-env-'));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, '.env.data.local');

    const result = await createDataEnvironment({
      destinationPath,
      generateSecret: () => 'synthetic-secret-'.repeat(4),
    });
    const content = await readFile(result, 'utf8');

    expect(content).toContain(`MSP_LINKAGE_HMAC_KEY=${'synthetic-secret-'.repeat(4)}`);
    expect(content).toContain('MSP_ALLOW_INSECURE_TLS=false');
    expect(content).toContain('DATA_INGESTION_DIR=data');
    expect(content).toContain('INGESTION_DATA_DIR=data');
  });

  it('refuses to overwrite an existing secret file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'medicos-data-env-'));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, '.env.data.local');
    const options = {
      destinationPath,
      generateSecret: () => 'synthetic-secret-'.repeat(4),
    };

    await createDataEnvironment(options);

    await expect(createDataEnvironment(options)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
