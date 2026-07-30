import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configuredDataDirectory,
  DATA_DIRECTORY_NAMES,
  prepareDataDirectories,
} from './prepare-data-directories';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('prepareDataDirectories', () => {
  it('creates the bounded internal data tree idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medicos-data-tree-'));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, 'private-data');
    const environment = {
      DATA_INGESTION_DIR: dataDirectory,
    };

    await expect(prepareDataDirectories(environment)).resolves.toBe(resolve(dataDirectory));
    await expect(prepareDataDirectories(environment)).resolves.toBe(resolve(dataDirectory));
    await Promise.all(
      DATA_DIRECTORY_NAMES.map(async (name) => {
        await expect(access(join(dataDirectory, name))).resolves.toBeUndefined();
      }),
    );
  });

  it('uses one common precedence order for every ingestion adapter', () => {
    expect(
      configuredDataDirectory({
        DATA_INGESTION_DIR: 'canonical',
        MSP_INGESTION_DATA_DIR: 'msp',
        INGESTION_DATA_DIR: 'legacy',
      }),
    ).toBe(resolve('canonical'));
    expect(configuredDataDirectory({ MSP_INGESTION_DATA_DIR: 'msp' })).toBe(resolve('msp'));
    expect(configuredDataDirectory({ INGESTION_DATA_DIR: 'legacy' })).toBe(resolve('legacy'));
  });
});
