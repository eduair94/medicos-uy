import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { purgeExpiredNewsArtifacts } from './purge-expired-news-artifacts';

const temporaryDirectories: string[] = [];
const NOW = new Date('2026-07-27T15:00:00.000Z');

async function createArtifact(
  dataDirectory: string,
  relativeDirectory: string,
  expiresAt: string,
): Promise<string> {
  const directory = join(dataDirectory, relativeDirectory);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'payload.ndjson'), '{}\n'),
    writeFile(
      join(directory, 'manifest.json'),
      `${JSON.stringify({
        retention: {
          expiresAt,
        },
      })}\n`,
    ),
  ]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe('purgeExpiredNewsArtifacts', () => {
  it('reports expired artifacts in dry-run and deletes only them in apply mode', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-purge-'));
    temporaryDirectories.push(dataDirectory);
    const expired = await createArtifact(
      dataDirectory,
      'normalized/news/expired',
      '2026-07-27T15:00:00.000Z',
    );
    const current = await createArtifact(
      dataDirectory,
      'processed/news-linkage/current',
      '2026-07-27T15:00:00.001Z',
    );

    await expect(
      purgeExpiredNewsArtifacts({
        dataDirectory,
        apply: false,
        now: () => NOW,
      }),
    ).resolves.toEqual([
      {
        artifactDirectory: expired,
        expiresAt: '2026-07-27T15:00:00.000Z',
        action: 'WOULD_DELETE',
      },
    ]);
    await expect(readFile(join(expired, 'manifest.json'), 'utf8')).resolves.toContain('expiresAt');

    await expect(
      purgeExpiredNewsArtifacts({
        dataDirectory,
        apply: true,
        now: () => NOW,
      }),
    ).resolves.toEqual([
      {
        artifactDirectory: expired,
        expiresAt: '2026-07-27T15:00:00.000Z',
        action: 'DELETED',
      },
    ]);
    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(current)).resolves.toMatchObject({});
  });

  it('fails closed on an invalid retention manifest', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-purge-invalid-'));
    temporaryDirectories.push(dataDirectory);
    const directory = join(dataDirectory, 'normalized', 'news', 'invalid');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), '{"retention":{"expiresAt":"tomorrow"}}\n');

    await expect(
      purgeExpiredNewsArtifacts({
        dataDirectory,
        apply: true,
        now: () => NOW,
      }),
    ).rejects.toThrow('canonical ISO instant');
    await expect(stat(directory)).resolves.toMatchObject({});
  });
});
