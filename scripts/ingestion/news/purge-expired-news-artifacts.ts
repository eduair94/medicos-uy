import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface NewsArtifactPurgeRecord {
  readonly artifactDirectory: string;
  readonly expiresAt: string;
  readonly action: 'WOULD_DELETE' | 'DELETED';
}

export interface PurgeExpiredNewsArtifactsOptions {
  readonly dataDirectory: string;
  readonly apply: boolean;
  readonly now?: () => Date;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(normalizedRoot);
}

function canonicalInstant(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a canonical ISO instant`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`${context} must be a canonical ISO instant`);
  }
  return value;
}

async function artifactDirectories(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (isObject(error) && error['code'] === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'),
    )
    .map((entry) => join(root, entry.name));
}

async function expiresAtForArtifact(artifactDirectory: string): Promise<string> {
  const manifestPath = join(artifactDirectory, 'manifest.json');
  const metadata = await stat(manifestPath);
  if (!metadata.isFile()) {
    throw new Error(`News artifact manifest is not a file: ${manifestPath}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch {
    throw new Error(`News artifact manifest is invalid JSON: ${manifestPath}`);
  }
  if (!isObject(manifest) || !isObject(manifest['retention'])) {
    throw new Error(`News artifact manifest has no retention object: ${manifestPath}`);
  }
  return canonicalInstant(
    manifest['retention']['expiresAt'],
    `${manifestPath} retention.expiresAt`,
  );
}

export async function purgeExpiredNewsArtifacts(
  options: PurgeExpiredNewsArtifactsOptions,
): Promise<readonly NewsArtifactPurgeRecord[]> {
  const dataDirectory = await realpath(resolve(options.dataDirectory));
  const evaluatedAt = (options.now ?? (() => new Date()))().toISOString();
  const roots = [
    join(dataDirectory, 'normalized', 'news'),
    join(dataDirectory, 'processed', 'news-linkage'),
  ];
  const records: NewsArtifactPurgeRecord[] = [];

  for (const configuredRoot of roots) {
    const directories = await artifactDirectories(configuredRoot);
    for (const configuredDirectory of directories) {
      const artifactDirectory = await realpath(configuredDirectory);
      if (
        !isInside(configuredRoot, artifactDirectory) ||
        !isInside(dataDirectory, artifactDirectory)
      ) {
        throw new Error(
          `Refusing to purge news artifact outside its fixed root: ${artifactDirectory}`,
        );
      }
      const expiresAt = await expiresAtForArtifact(artifactDirectory);
      if (expiresAt > evaluatedAt) {
        continue;
      }
      if (options.apply) {
        await rm(artifactDirectory, {
          recursive: true,
          force: false,
        });
      }
      records.push({
        artifactDirectory,
        expiresAt,
        action: options.apply ? 'DELETED' : 'WOULD_DELETE',
      });
    }
  }
  return records;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error: unknown) {
    if (!(isObject(error) && error['code'] === 'ENOENT')) {
      throw error;
    }
  }
  const apply = process.argv.slice(2).includes('--apply');
  const dataDirectory = process.env['DATA_INGESTION_DIR'] ?? 'data';
  const records = await purgeExpiredNewsArtifacts({
    dataDirectory,
    apply,
  });
  console.log(
    JSON.stringify({
      event: 'expired_news_artifacts_purged',
      mode: apply ? 'APPLY' : 'DRY_RUN',
      artifacts: records,
    }),
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
