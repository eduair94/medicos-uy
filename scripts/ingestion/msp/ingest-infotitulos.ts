import { createHash, createHmac } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { parseWindows1252DelimitedText } from '../lib/delimited-text';

export const INFOTITULOS_HEADERS = [
  'N° Caja Prof.',
  'Número de documento',
  'Nombre completo',
  'Código reclutador',
  'Título',
  'Estado',
  'Registro temporario',
] as const;

export const DEFAULT_INFOTITULOS_URL =
  'https://www.gub.uy/ministerio-salud-publica/sites/ministerio-salud-publica/files/2026-07/Infot%C3%ADtulos%20-%20Junio%202026.csv';
export const INFOTITULOS_SOURCE_CUTOFF_DATE = '2026-06-30';
export const EXPECTED_IDENTITY_CONFLICTS = 3;
export const INFOTITULOS_PUBLISHER = 'Ministerio de Salud Pública';
export const INFOTITULOS_DATASET = 'Infotítulos';
export const INFOTITULOS_LINKAGE_VERSION = 'hmac-sha256:msp-infotitulos-document:v1';

const DOCTOR_TITLE = 'DOCTOR EN MEDICINA';
const ENABLED_STATUS = 'Habilitado';
const LINKAGE_CONTEXT = 'msp:infotitulos:document:v1\u0000';
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_REDIRECT_LIMIT = 5;
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

type InfotitulosHeader = (typeof INFOTITULOS_HEADERS)[number];

export interface InfotitulosRow {
  readonly professionalFundNumber: string;
  readonly documentNumber: string;
  readonly fullName: string;
  readonly recruiterCode: string;
  readonly title: string;
  readonly status: string;
  readonly temporaryRegistration: string;
}

export interface PublicEnabledTitle {
  readonly title: string;
  readonly recruiterCode: string;
  readonly temporaryRegistration: string | null;
}

export interface PublicMspProfessional {
  readonly linkageId: string;
  readonly fullName: string;
  readonly enabledTitles: readonly PublicEnabledTitle[];
  readonly provenance: {
    readonly publisher: 'Ministerio de Salud Pública';
    readonly dataset: 'Infotítulos';
    readonly sourceCutoffDate: string;
  };
}

export interface IdentityConflictQuarantineRecord {
  readonly linkageId: string;
  readonly reason: 'IDENTITY_CONFLICT';
  readonly candidateNames: readonly string[];
  readonly enabledTitles: readonly PublicEnabledTitle[];
}

export interface IngestionAggregates {
  readonly inputRows: number;
  readonly distinctDocuments: number;
  readonly exactDuplicateRows: number;
  readonly enabledDoctorDocuments: number;
  readonly publishedProfessionals: number;
  readonly quarantinedIdentityConflicts: number;
  readonly publishedEnabledTitles: number;
  readonly quarantinedEnabledTitles: number;
}

export interface TransformedInfotitulos {
  readonly professionals: readonly PublicMspProfessional[];
  readonly quarantine: readonly IdentityConflictQuarantineRecord[];
  readonly aggregates: IngestionAggregates;
}

export interface DownloadHeaders {
  readonly contentLength?: string;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly location?: string;
  readonly retryAfter?: string;
}

export interface HttpsResponse {
  readonly statusCode: number;
  readonly headers: DownloadHeaders;
  readonly body: Buffer;
}

export interface HttpsRequestOptions {
  readonly rejectUnauthorized: boolean;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export type HttpsRequester = (url: URL, options: HttpsRequestOptions) => Promise<HttpsResponse>;

export interface DownloadOptions {
  readonly allowInsecureTls?: boolean;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly requester?: HttpsRequester;
  readonly retries?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

export interface DownloadedFile {
  readonly body: Buffer;
  readonly attempts: number;
  readonly finalUrl: string;
  readonly headers: DownloadHeaders;
}

export interface TransformOptions {
  readonly expectedIdentityConflicts?: number;
  readonly hmacKey: string;
  readonly sourceCutoffDate?: string;
}

export interface PersistSnapshotOptions {
  readonly dataDirectory: string;
  readonly download: DownloadedFile;
  readonly sourceCutoffDate?: string;
  readonly sourceUrl: string;
  readonly transformed: TransformedInfotitulos;
}

export interface PersistedSnapshot {
  readonly manifestPath: string;
  readonly professionalsPath: string;
  readonly quarantinePath: string;
  readonly rawPath: string;
  readonly snapshotId: string;
}

interface SnapshotOutputMetadata {
  readonly bytes: number;
  readonly records: number;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface MspIngestionManifest {
  readonly schemaVersion: 1;
  readonly source: {
    readonly publisher: 'Ministerio de Salud Pública';
    readonly dataset: 'Infotítulos';
    readonly requestedUrl: string;
    readonly finalUrl: string;
    readonly sourceCutoffDate: string;
    readonly etag: string | null;
    readonly lastModified: string | null;
    readonly contentType: string | null;
  };
  readonly raw: SnapshotOutputMetadata;
  readonly outputs: {
    readonly professionals: SnapshotOutputMetadata;
    readonly quarantine: SnapshotOutputMetadata;
  };
  readonly linkage: {
    readonly algorithm: 'HMAC-SHA256';
    readonly version: string;
    readonly rawIdentifiersPublished: false;
  };
  readonly quality: {
    readonly expectedIdentityConflicts: number;
    readonly actualIdentityConflicts: number;
    readonly exactHeaders: readonly InfotitulosHeader[];
  };
  readonly aggregates: IngestionAggregates;
}

class DownloadFailure extends Error {
  public readonly retryable: boolean;
  public readonly retryAfterMs: number | undefined;

  public constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = 'DownloadFailure';
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sha256(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeIdentityName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('es-UY');
}

function createLinkageId(documentNumber: string, hmacKey: string): string {
  const digest = createHmac('sha256', hmacKey)
    .update(LINKAGE_CONTEXT, 'utf8')
    .update(documentNumber, 'utf8')
    .digest('hex');

  return `msp_doc_v1_${digest}`;
}

function toInfotitulosRow(columns: readonly string[]): InfotitulosRow {
  if (columns.length !== INFOTITULOS_HEADERS.length) {
    throw new Error(
      `Expected ${INFOTITULOS_HEADERS.length} columns but received ${columns.length}`,
    );
  }

  const [
    professionalFundNumber,
    documentNumber,
    fullName,
    recruiterCode,
    title,
    status,
    temporaryRegistration,
  ] = columns;

  if (
    professionalFundNumber === undefined ||
    documentNumber === undefined ||
    fullName === undefined ||
    recruiterCode === undefined ||
    title === undefined ||
    status === undefined ||
    temporaryRegistration === undefined
  ) {
    throw new Error('Infotítulos row has missing columns');
  }

  if (documentNumber.trim().length === 0) {
    throw new Error('Infotítulos row has an empty document number');
  }
  if (fullName.trim().length === 0) {
    throw new Error('Infotítulos row has an empty full name');
  }
  if (title.trim().length === 0) {
    throw new Error('Infotítulos row has an empty title');
  }

  return {
    professionalFundNumber,
    documentNumber: documentNumber.trim(),
    fullName: fullName.trim(),
    recruiterCode: recruiterCode.trim(),
    title: title.trim(),
    status: status.trim(),
    temporaryRegistration: temporaryRegistration.trim(),
  };
}

export function validateInfotitulosHeaders(headers: readonly string[]): void {
  if (
    headers.length !== INFOTITULOS_HEADERS.length ||
    headers.some((header, index) => header !== INFOTITULOS_HEADERS[index])
  ) {
    throw new Error(
      `Unexpected Infotítulos headers. Expected exactly: ${INFOTITULOS_HEADERS.join(';')}`,
    );
  }
}

export function parseInfotitulosCsv(input: Uint8Array): InfotitulosRow[] {
  const records = parseWindows1252DelimitedText(input, { delimiter: ';' });
  const headers = records[0];

  if (headers === undefined) {
    throw new Error('Infotítulos CSV is empty');
  }

  validateInfotitulosHeaders(headers);

  return records.slice(1).map((columns, index) => {
    try {
      return toInfotitulosRow(columns);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      throw new Error(`Invalid Infotítulos data row ${index + 2}: ${message}`, {
        cause: error,
      });
    }
  });
}

function titleIdentity(title: PublicEnabledTitle): string {
  return JSON.stringify([title.title, title.recruiterCode, title.temporaryRegistration]);
}

function collectEnabledTitles(rows: readonly InfotitulosRow[]): PublicEnabledTitle[] {
  const uniqueTitles = new Map<string, PublicEnabledTitle>();

  for (const row of rows) {
    if (row.status !== ENABLED_STATUS) {
      continue;
    }

    const enabledTitle: PublicEnabledTitle = {
      title: row.title,
      recruiterCode: row.recruiterCode,
      temporaryRegistration:
        row.temporaryRegistration.length > 0 ? row.temporaryRegistration : null,
    };
    uniqueTitles.set(titleIdentity(enabledTitle), enabledTitle);
  }

  return [...uniqueTitles.values()].sort(
    (left, right) =>
      compareText(left.title, right.title) ||
      compareText(left.recruiterCode, right.recruiterCode) ||
      compareText(left.temporaryRegistration ?? '', right.temporaryRegistration ?? ''),
  );
}

export function transformInfotitulos(
  rows: readonly InfotitulosRow[],
  options: TransformOptions,
): TransformedInfotitulos {
  assertValidHmacKey(options.hmacKey);

  const sourceCutoffDate = options.sourceCutoffDate ?? INFOTITULOS_SOURCE_CUTOFF_DATE;
  const expectedIdentityConflicts =
    options.expectedIdentityConflicts ?? EXPECTED_IDENTITY_CONFLICTS;
  const rowsByDocument = new Map<string, InfotitulosRow[]>();
  const enabledDoctorDocuments = new Set<string>();
  const distinctDocuments = new Set<string>();
  const exactRows = new Set<string>();

  for (const row of rows) {
    distinctDocuments.add(row.documentNumber);
    exactRows.add(
      JSON.stringify([
        row.professionalFundNumber,
        row.documentNumber,
        row.fullName,
        row.recruiterCode,
        row.title,
        row.status,
        row.temporaryRegistration,
      ]),
    );

    const documentRows = rowsByDocument.get(row.documentNumber) ?? [];
    documentRows.push(row);
    rowsByDocument.set(row.documentNumber, documentRows);

    if (row.title === DOCTOR_TITLE && row.status === ENABLED_STATUS) {
      enabledDoctorDocuments.add(row.documentNumber);
    }
  }

  const professionals: PublicMspProfessional[] = [];
  const quarantine: IdentityConflictQuarantineRecord[] = [];

  for (const documentNumber of enabledDoctorDocuments) {
    const documentRows = rowsByDocument.get(documentNumber);

    if (documentRows === undefined) {
      throw new Error('Internal grouping error for an enabled doctor');
    }

    const candidateNames = new Map<string, string>();
    for (const row of documentRows) {
      const normalizedName = normalizeIdentityName(row.fullName);
      const currentName = candidateNames.get(normalizedName);
      if (currentName === undefined || compareText(row.fullName, currentName) < 0) {
        candidateNames.set(normalizedName, row.fullName);
      }
    }

    const exactCandidateNames = [...candidateNames.values()].sort(compareText);
    const enabledTitles = collectEnabledTitles(documentRows);
    const linkageId = createLinkageId(documentNumber, options.hmacKey);

    if (candidateNames.size > 1) {
      quarantine.push({
        linkageId,
        reason: 'IDENTITY_CONFLICT',
        candidateNames: exactCandidateNames,
        enabledTitles,
      });
      continue;
    }

    const fullName = exactCandidateNames[0];
    if (fullName === undefined) {
      throw new Error('An enabled doctor has no usable identity name');
    }

    professionals.push({
      linkageId,
      fullName,
      enabledTitles,
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate,
      },
    });
  }

  professionals.sort((left, right) => compareText(left.linkageId, right.linkageId));
  quarantine.sort((left, right) => compareText(left.linkageId, right.linkageId));

  if (quarantine.length !== expectedIdentityConflicts) {
    throw new Error(
      `Identity conflict quality gate failed: expected ${expectedIdentityConflicts}, found ${quarantine.length}`,
    );
  }

  return {
    professionals,
    quarantine,
    aggregates: {
      inputRows: rows.length,
      distinctDocuments: distinctDocuments.size,
      exactDuplicateRows: rows.length - exactRows.size,
      enabledDoctorDocuments: enabledDoctorDocuments.size,
      publishedProfessionals: professionals.length,
      quarantinedIdentityConflicts: quarantine.length,
      publishedEnabledTitles: professionals.reduce(
        (total, professional) => total + professional.enabledTitles.length,
        0,
      ),
      quarantinedEnabledTitles: quarantine.reduce(
        (total, conflict) => total + conflict.enabledTitles.length,
        0,
      ),
    },
  };
}

function headerValue(
  headers: NodeJS.Dict<string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function optionalHeader<Key extends keyof DownloadHeaders>(
  headers: NodeJS.Dict<string | string[] | undefined>,
  sourceName: string,
  targetName: Key,
): Record<Key, string> | Record<string, never> {
  const value = headerValue(headers, sourceName);
  if (value === undefined) {
    return {};
  }
  return { [targetName]: value } as Record<Key, string>;
}

export const nodeHttpsRequester: HttpsRequester = (url, options): Promise<HttpsResponse> =>
  new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(
      url,
      {
        headers: {
          Accept: 'text/csv,application/octet-stream;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': 'medicos-backend-infotitulos-ingestion/1.0',
        },
        method: 'GET',
        rejectUnauthorized: options.rejectUnauthorized,
      },
      (response) => {
        const contentLength = headerValue(response.headers, 'content-length');
        if (contentLength !== undefined && Number.parseInt(contentLength, 10) > options.maxBytes) {
          response.resume();
          rejectPromise(
            new DownloadFailure(`Response content-length exceeds ${options.maxBytes} bytes`, false),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;

        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;

          if (receivedBytes > options.maxBytes) {
            response.destroy(
              new DownloadFailure(`Response body exceeds ${options.maxBytes} bytes`, false),
            );
            return;
          }

          chunks.push(buffer);
        });

        response.on('end', () => {
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: {
              ...(contentLength === undefined ? {} : { contentLength }),
              ...optionalHeader(response.headers, 'content-type', 'contentType'),
              ...optionalHeader(response.headers, 'etag', 'etag'),
              ...optionalHeader(response.headers, 'last-modified', 'lastModified'),
              ...optionalHeader(response.headers, 'location', 'location'),
              ...optionalHeader(response.headers, 'retry-after', 'retryAfter'),
            },
            body: Buffer.concat(chunks),
          });
        });

        response.on('error', rejectPromise);
      },
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(
        new DownloadFailure(`HTTPS request timed out after ${options.timeoutMs}ms`, true),
      );
    });
    request.on('error', rejectPromise);
    request.end();
  });

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 60_000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.min(Math.max(date - Date.now(), 0), 60_000);
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isRetryableStatus(statusCode: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(statusCode);
}

function assertHttpsUrl(value: string | URL): URL {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'https:') {
    throw new DownloadFailure(`Only HTTPS URLs are allowed: ${url.href}`, false);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new DownloadFailure('Credentials in source URLs are not allowed', false);
  }
  return url;
}

async function requestFollowingRedirects(
  initialUrl: URL,
  options: Required<
    Pick<DownloadOptions, 'allowInsecureTls' | 'maxBytes' | 'maxRedirects' | 'timeoutMs'>
  >,
  requester: HttpsRequester,
): Promise<{ response: HttpsResponse; finalUrl: URL }> {
  let currentUrl = initialUrl;

  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const response = await requester(currentUrl, {
      rejectUnauthorized: !options.allowInsecureTls,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });

    if (!isRedirect(response.statusCode)) {
      return { response, finalUrl: currentUrl };
    }

    if (redirects === options.maxRedirects) {
      throw new DownloadFailure(`Exceeded redirect limit of ${options.maxRedirects}`, false);
    }

    if (response.headers.location === undefined) {
      throw new DownloadFailure(
        `HTTPS ${response.statusCode} response did not include Location`,
        false,
      );
    }

    currentUrl = assertHttpsUrl(new URL(response.headers.location, currentUrl));
  }

  throw new DownloadFailure('Unexpected redirect state', false);
}

export async function downloadHttps(
  sourceUrl: string,
  options: DownloadOptions = {},
): Promise<DownloadedFile> {
  const initialUrl = assertHttpsUrl(sourceUrl);
  const retries = options.retries ?? DEFAULT_RETRIES;
  const requester = options.requester ?? nodeHttpsRequester;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
      }));
  const requestOptions = {
    allowInsecureTls: options.allowInsecureTls ?? false,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
    maxRedirects: options.maxRedirects ?? DEFAULT_REDIRECT_LIMIT,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
    throw new RangeError('retries must be an integer between 0 and 10');
  }

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const { response, finalUrl } = await requestFollowingRedirects(
        initialUrl,
        requestOptions,
        requester,
      );

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new DownloadFailure(
          `HTTPS download failed with status ${response.statusCode}`,
          isRetryableStatus(response.statusCode),
          parseRetryAfter(response.headers.retryAfter),
        );
      }

      return {
        body: response.body,
        attempts: attempt,
        finalUrl: finalUrl.href,
        headers: response.headers,
      };
    } catch (error) {
      const failure =
        error instanceof DownloadFailure
          ? error
          : new DownloadFailure(
              error instanceof Error ? error.message : 'Unknown HTTPS error',
              true,
            );

      if (!failure.retryable || attempt > retries) {
        throw failure;
      }

      const backoffMs = failure.retryAfterMs ?? Math.min(250 * 2 ** (attempt - 1), 5_000);
      await sleep(backoffMs);
    }
  }

  throw new DownloadFailure('Unexpected retry state', false);
}

export function parseExplicitBoolean(value: string | undefined, environmentName: string): boolean {
  if (value === undefined || value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new Error(`${environmentName} must be exactly "true" or "false"`);
}

export function assertValidHmacKey(value: string | undefined): asserts value is string {
  if (value === undefined || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('MSP_LINKAGE_HMAC_KEY is required and must contain at least 32 bytes');
  }
}

function serializeNdjson(records: readonly unknown[]): Buffer {
  if (records.length === 0) {
    return Buffer.alloc(0);
  }

  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readStringPath(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

async function assertExistingManifestMatchesOutputs(
  manifestPath: string,
  expected: {
    readonly professionalsSha256: string;
    readonly quarantineSha256: string;
    readonly rawSha256: string;
  },
): Promise<void> {
  const existingManifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const matches =
    readStringPath(existingManifest, ['raw', 'sha256']) === expected.rawSha256 &&
    readStringPath(existingManifest, ['outputs', 'professionals', 'sha256']) ===
      expected.professionalsSha256 &&
    readStringPath(existingManifest, ['outputs', 'quarantine', 'sha256']) ===
      expected.quarantineSha256;

  if (!matches) {
    throw new Error(`Existing manifest does not describe the immutable outputs: ${manifestPath}`);
  }
}

async function writeImmutableFile(path: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  if (await fileExists(path)) {
    const existing = await readFile(path);
    if (!existing.equals(content)) {
      throw new Error(`Refusing to overwrite immutable snapshot file: ${path}`);
    }
    return;
  }

  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, content, { flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function outputMetadata(
  rootDirectory: string,
  path: string,
  content: Buffer,
  records: number,
): SnapshotOutputMetadata {
  return {
    bytes: content.length,
    records,
    relativePath: relative(rootDirectory, path).replaceAll('\\', '/'),
    sha256: sha256(content),
  };
}

export async function persistSnapshot(options: PersistSnapshotOptions): Promise<PersistedSnapshot> {
  const sourceCutoffDate = options.sourceCutoffDate ?? INFOTITULOS_SOURCE_CUTOFF_DATE;
  const rawSha256 = sha256(options.download.body);
  const snapshotId = `${sourceCutoffDate}-${rawSha256.slice(0, 12)}`;
  const dataDirectory = resolve(options.dataDirectory);
  const rawPath = join(
    dataDirectory,
    'raw',
    'msp',
    'infotitulos',
    snapshotId,
    basename(new URL(options.download.finalUrl).pathname) || 'infotitulos.csv',
  );
  const processedDirectory = join(dataDirectory, 'processed', 'msp', 'infotitulos', snapshotId);
  const professionalsPath = join(processedDirectory, 'professionals.ndjson');
  const quarantinePath = join(processedDirectory, 'identity-conflicts.ndjson');
  const manifestPath = join(processedDirectory, 'manifest.json');
  const professionalsContent = serializeNdjson(options.transformed.professionals);
  const quarantineContent = serializeNdjson(options.transformed.quarantine);

  await writeImmutableFile(rawPath, options.download.body);
  await writeImmutableFile(professionalsPath, professionalsContent);
  await writeImmutableFile(quarantinePath, quarantineContent);

  const expectedIdentityConflicts = EXPECTED_IDENTITY_CONFLICTS;
  const manifest: MspIngestionManifest = {
    schemaVersion: 1,
    source: {
      publisher: 'Ministerio de Salud Pública',
      dataset: 'Infotítulos',
      requestedUrl: options.sourceUrl,
      finalUrl: options.download.finalUrl,
      sourceCutoffDate,
      etag: options.download.headers.etag ?? null,
      lastModified: options.download.headers.lastModified ?? null,
      contentType: options.download.headers.contentType ?? null,
    },
    raw: outputMetadata(
      dataDirectory,
      rawPath,
      options.download.body,
      options.transformed.aggregates.inputRows,
    ),
    outputs: {
      professionals: outputMetadata(
        dataDirectory,
        professionalsPath,
        professionalsContent,
        options.transformed.professionals.length,
      ),
      quarantine: outputMetadata(
        dataDirectory,
        quarantinePath,
        quarantineContent,
        options.transformed.quarantine.length,
      ),
    },
    linkage: {
      algorithm: 'HMAC-SHA256',
      version: INFOTITULOS_LINKAGE_VERSION,
      rawIdentifiersPublished: false,
    },
    quality: {
      expectedIdentityConflicts,
      actualIdentityConflicts: options.transformed.aggregates.quarantinedIdentityConflicts,
      exactHeaders: INFOTITULOS_HEADERS,
    },
    aggregates: options.transformed.aggregates,
  };
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (await fileExists(manifestPath)) {
    await assertExistingManifestMatchesOutputs(manifestPath, {
      professionalsSha256: manifest.outputs.professionals.sha256,
      quarantineSha256: manifest.outputs.quarantine.sha256,
      rawSha256: manifest.raw.sha256,
    });
  } else {
    await writeImmutableFile(manifestPath, manifestContent);
  }

  return {
    manifestPath,
    professionalsPath,
    quarantinePath,
    rawPath,
    snapshotId,
  };
}

export async function runMspInfotitulosIngestion(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PersistedSnapshot> {
  const hmacKey = environment['MSP_LINKAGE_HMAC_KEY'];
  assertValidHmacKey(hmacKey);

  const sourceUrl = environment['MSP_INFOTITULOS_URL'] ?? DEFAULT_INFOTITULOS_URL;
  const allowInsecureTls = parseExplicitBoolean(
    environment['MSP_ALLOW_INSECURE_TLS'],
    'MSP_ALLOW_INSECURE_TLS',
  );
  const dataDirectory = environment['MSP_INGESTION_DATA_DIR'] ?? 'data';
  const download = await downloadHttps(sourceUrl, { allowInsecureTls });
  const rows = parseInfotitulosCsv(download.body);
  const transformed = transformInfotitulos(rows, {
    hmacKey,
    expectedIdentityConflicts: EXPECTED_IDENTITY_CONFLICTS,
    sourceCutoffDate: INFOTITULOS_SOURCE_CUTOFF_DATE,
  });

  return persistSnapshot({
    dataDirectory,
    download,
    sourceCutoffDate: INFOTITULOS_SOURCE_CUTOFF_DATE,
    sourceUrl,
    transformed,
  });
}

async function main(): Promise<void> {
  const snapshot = await runMspInfotitulosIngestion();
  console.log(
    JSON.stringify({
      event: 'msp_infotitulos_ingestion_completed',
      ...snapshot,
    }),
  );
}

function loadOptionalDataEnvironment(): void {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

if (require.main === module) {
  loadOptionalDataEnvironment();
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown ingestion error';
    console.error(
      JSON.stringify({
        event: 'msp_infotitulos_ingestion_failed',
        message,
      }),
    );
    process.exitCode = 1;
  });
}
