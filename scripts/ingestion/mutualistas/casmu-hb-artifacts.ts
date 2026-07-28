import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PUBLIC_DATA_SCHEMA_VERSION = '1.0.0';

export interface ProviderRunPaths {
  readonly dataRoot: string;
  readonly rawDirectory: string;
  readonly processedDirectory: string;
  readonly latestPointer: string;
}

export interface TextFetchResult {
  readonly body: string;
  readonly contentType: string | null;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly status: number;
}

interface FetchTextOptions {
  readonly attempts?: number;
  readonly init?: RequestInit;
  readonly timeoutMs?: number;
}

export function createRunId(date = new Date()): string {
  return date.toISOString().replaceAll(/[-:.]/g, '');
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeWhitespace(value: string): string {
  return value.replaceAll('\u00a0', ' ').replaceAll(/\s+/g, ' ').trim();
}

export function normalizeMultilineText(value: string): string {
  return value
    .replaceAll('\u00a0', ' ')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .join('\n');
}

export function normalizeForMatch(value: string): string {
  return normalizeWhitespace(
    value
      .normalize('NFD')
      .replaceAll(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('es-UY')
      .replaceAll(/[^a-z0-9]+/g, ' '),
  );
}

export function normalizePhysicianForMatch(value: string): string {
  return normalizeForMatch(
    value
      .replace(/^(?:dra?|dr|lic|licda?|psic|prof|tecn|tecnica|tecnico)\.?\s+/iu, '')
      .replace(/\s*\([^)]*\).*$/u, ''),
  );
}

export function canonicalizePublicUrl(value: string, baseUrl?: string): string | null {
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
    }
    if (url.protocol !== 'https:') {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function createProviderRunPaths(
  providerSlug: string,
  runId: string,
  configuredDataRoot?: string,
): ProviderRunPaths {
  const dataRoot = path.resolve(
    process.cwd(),
    configuredDataRoot ?? process.env['INGESTION_DATA_DIR'] ?? 'data',
  );

  return {
    dataRoot,
    rawDirectory: path.join(dataRoot, 'raw', providerSlug, runId),
    processedDirectory: path.join(dataRoot, 'processed', providerSlug, runId),
    latestPointer: path.join(dataRoot, 'processed', providerSlug, 'latest.json'),
  };
}

export async function ensureRunDirectories(paths: ProviderRunPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.rawDirectory, { recursive: true }),
    mkdir(paths.processedDirectory, { recursive: true }),
  ]);
}

export async function writeFileAtomically(
  targetPath: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, targetPath);
}

export async function writeJsonAtomically(targetPath: string, value: unknown): Promise<void> {
  await writeFileAtomically(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeNdjsonAtomically(
  targetPath: string,
  records: readonly unknown[],
): Promise<void> {
  const body =
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await writeFileAtomically(targetPath, body);
}

export function relativeArtifactPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).replaceAll('\\', '/');
}

export async function fetchTextWithRetry(
  url: string,
  options: FetchTextOptions = {},
): Promise<TextFetchResult> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(options.init?.headers);
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'MedicosPublicDataResearch/0.1 (+public-source ingestion)');
    }

    try {
      const response = await fetch(url, {
        ...options.init,
        headers,
        signal: controller.signal,
      });
      const body = await response.text();
      const result: TextFetchResult = {
        body,
        contentType: response.headers.get('content-type'),
        finalUrl: response.url,
        retrievedAt: new Date().toISOString(),
        status: response.status,
      };

      if (response.status < 500 || attempt === attempts) {
        return result;
      }
      lastError = new Error(`HTTP ${response.status} while fetching ${url}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, attempt * 350);
    });
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to fetch ${url}`);
}

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}
