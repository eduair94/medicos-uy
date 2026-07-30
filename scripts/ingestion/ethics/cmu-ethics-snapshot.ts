import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const CMU_ETHICS_COLLECTION_MODE = 'AUTOMATED_PUBLIC_METADATA_SNAPSHOT' as const;
export const CMU_ETHICS_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CMU_ETHICS_CASES_FILE = 'cases.ndjson' as const;
export const CMU_ETHICS_MANIFEST_FILE = 'manifest.json' as const;

export interface CmuEthicsDocumentMetadata {
  readonly label: string;
  readonly date: string | null;
}

export interface CmuEthicsSourceMetadata {
  readonly schemaVersion: 1;
  readonly sourceId: 'cmu-tribunal-etica';
  readonly publisher: 'Colegio Médico del Uruguay';
  readonly tribunal: 'Tribunal de Ética Médica';
  readonly collectionMode: typeof CMU_ETHICS_COLLECTION_MODE;
  readonly robotsUrl: string;
  readonly robotsSha256: string;
  readonly sitemapUrl: string;
  readonly sitemapLastModified: string | null;
  readonly pageMetadataOnly: true;
  readonly contentStored: false;
  readonly currentnessVerified: false;
}

export interface CmuEthicsCaseMetadata {
  readonly ethicsCaseId: string;
  readonly sourceCaseKey: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly respondentNames: readonly string[];
  readonly documents: readonly CmuEthicsDocumentMetadata[];
  readonly sourceDate: string | null;
  readonly sourceDatePrecision: 'DAY' | null;
  readonly visibility: 'ORIGINAL' | 'ANONYMIZED' | 'MIXED' | 'UNKNOWN';
  readonly outcome: 'UNKNOWN';
  readonly finalityStatus: 'UNKNOWN';
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly sourceMetadata: CmuEthicsSourceMetadata;
}

export interface CmuEthicsSnapshotManifest {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly collectorVersion: string;
  readonly collectionMode: typeof CMU_ETHICS_COLLECTION_MODE;
  readonly generatedAt: string;
  readonly policyReviewedAt: string;
  readonly source: {
    readonly origin: 'https://www.colegiomedico.org.uy';
    readonly robotsUrl: 'https://www.colegiomedico.org.uy/robots.txt';
    readonly robotsSha256: string;
    readonly sitemapUrl: 'https://www.colegiomedico.org.uy/fallos-sitemap.xml';
  };
  readonly outputs: {
    readonly cases: {
      readonly file: typeof CMU_ETHICS_CASES_FILE;
      readonly records: number;
      readonly bytes: number;
      readonly sha256: string;
      readonly semanticSha256: string;
      readonly schemaVersion: 1;
    };
  };
  readonly aggregates: {
    readonly sitemapUrlsDiscovered: number;
    readonly disallowedUrlsSkipped: number;
    readonly invalidUrlsSkipped: number;
    readonly pagesFetched: number;
    readonly pagesFailed: number;
    readonly duplicateCasesCollapsed: number;
    readonly casesEmitted: number;
  };
  readonly safeguards: {
    readonly sameOriginHttpsOnly: true;
    readonly robotsPolicyHashPinned: true;
    readonly robotsPolicyFailClosed: true;
    readonly listPageFetched: false;
    readonly uploadedDocumentsFetched: false;
    readonly documentLinksPersisted: false;
    readonly pageContentPersisted: false;
    readonly outcomeInferred: false;
    readonly finalityInferred: false;
    readonly automaticIdentityConfirmation: false;
    readonly publicExportAllowed: false;
  };
}

export interface LoadedCmuEthicsSnapshot {
  readonly cases: readonly CmuEthicsCaseMetadata[];
  readonly records: number;
  readonly semanticSha256: string;
  readonly manifestSha256: string;
  readonly policyReviewedAt: string;
}

export interface InstallCmuEthicsSnapshotOptions {
  readonly outputDirectory: string;
  readonly cases: readonly CmuEthicsCaseMetadata[];
  readonly collectorVersion: string;
  readonly generatedAt: string;
  readonly policyReviewedAt: string;
  readonly robotsSha256: string;
  readonly aggregates: CmuEthicsSnapshotManifest['aggregates'];
}

export interface InstalledCmuEthicsSnapshot {
  readonly artifactId: string;
  readonly outputDirectory: string;
  readonly casesPath: string;
  readonly manifestPath: string;
  readonly records: number;
  readonly semanticSha256: string;
}

const CASE_KEYS = [
  'ethicsCaseId',
  'sourceCaseKey',
  'title',
  'canonicalUrl',
  'respondentNames',
  'documents',
  'sourceDate',
  'sourceDatePrecision',
  'visibility',
  'outcome',
  'finalityStatus',
  'firstObservedAt',
  'lastObservedAt',
  'sourceMetadata',
] as const;

const DOCUMENT_KEYS = ['label', 'date'] as const;

const SOURCE_METADATA_KEYS = [
  'schemaVersion',
  'sourceId',
  'publisher',
  'tribunal',
  'collectionMode',
  'robotsUrl',
  'robotsSha256',
  'sitemapUrl',
  'sitemapLastModified',
  'pageMetadataOnly',
  'contentStored',
  'currentnessVerified',
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  context: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${context} has an unexpected schema`);
  }
}

function assertNonEmptyBoundedString(
  value: unknown,
  maximumLength: number,
  context: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength
  ) {
    throw new Error(`${context} must be a non-empty bounded string`);
  }
}

function assertIsoDateTime(value: unknown, context: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${context} must be a UTC ISO date-time`);
  }
}

function assertCalendarDate(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${context} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${context} is not a valid calendar date`);
  }
}

function assertOfficialUrl(value: unknown, expectedPath: RegExp, context: string): string {
  assertNonEmptyBoundedString(value, 2_048, context);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context} must be an absolute URL`);
  }
  if (
    url.origin !== 'https://www.colegiomedico.org.uy' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !expectedPath.test(url.pathname)
  ) {
    throw new Error(`${context} must be an approved CMU HTTPS URL`);
  }
  return url.toString();
}

function parseDocument(value: unknown, context: string): CmuEthicsDocumentMetadata {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  assertExactKeys(value, DOCUMENT_KEYS, context);
  assertNonEmptyBoundedString(value['label'], 240, `${context}.label`);
  if (value['date'] !== null) {
    assertCalendarDate(value['date'], `${context}.date`);
  }
  return {
    label: value['label'],
    date: value['date'],
  };
}

function parseSourceMetadata(value: unknown, context: string): CmuEthicsSourceMetadata {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  assertExactKeys(value, SOURCE_METADATA_KEYS, context);
  if (
    value['schemaVersion'] !== 1 ||
    value['sourceId'] !== 'cmu-tribunal-etica' ||
    value['publisher'] !== 'Colegio Médico del Uruguay' ||
    value['tribunal'] !== 'Tribunal de Ética Médica' ||
    value['collectionMode'] !== CMU_ETHICS_COLLECTION_MODE ||
    value['pageMetadataOnly'] !== true ||
    value['contentStored'] !== false ||
    value['currentnessVerified'] !== false
  ) {
    throw new Error(`${context} violates the fixed source metadata contract`);
  }
  assertOfficialUrl(value['robotsUrl'], /^\/robots\.txt$/u, `${context}.robotsUrl`);
  assertOfficialUrl(value['sitemapUrl'], /^\/fallos-sitemap\.xml$/u, `${context}.sitemapUrl`);
  if (typeof value['robotsSha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(value['robotsSha256'])) {
    throw new Error(`${context}.robotsSha256 must be a lowercase SHA-256`);
  }
  if (value['sitemapLastModified'] !== null) {
    assertIsoDateTime(value['sitemapLastModified'], `${context}.sitemapLastModified`);
  }
  return {
    schemaVersion: 1,
    sourceId: 'cmu-tribunal-etica',
    publisher: 'Colegio Médico del Uruguay',
    tribunal: 'Tribunal de Ética Médica',
    collectionMode: CMU_ETHICS_COLLECTION_MODE,
    robotsUrl: value['robotsUrl'] as string,
    robotsSha256: value['robotsSha256'],
    sitemapUrl: value['sitemapUrl'] as string,
    sitemapLastModified: value['sitemapLastModified'],
    pageMetadataOnly: true,
    contentStored: false,
    currentnessVerified: false,
  };
}

export function parseCmuEthicsCaseMetadata(
  value: unknown,
  lineNumber?: number,
): CmuEthicsCaseMetadata {
  const context =
    lineNumber === undefined
      ? 'CMU ethics case record'
      : `CMU ethics case record line ${lineNumber}`;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  assertExactKeys(value, CASE_KEYS, context);
  if (
    typeof value['ethicsCaseId'] !== 'string' ||
    !/^ethics_case_v1_[0-9a-f]{64}$/u.test(value['ethicsCaseId'])
  ) {
    throw new Error(`${context}.ethicsCaseId is invalid`);
  }
  if (
    typeof value['sourceCaseKey'] !== 'string' ||
    !/^\d{1,4}\/20\d{2}$/u.test(value['sourceCaseKey'])
  ) {
    throw new Error(`${context}.sourceCaseKey is invalid`);
  }
  assertNonEmptyBoundedString(value['title'], 500, `${context}.title`);
  const canonicalUrl = assertOfficialUrl(
    value['canonicalUrl'],
    /^\/fallos\/[^/]+\/$/u,
    `${context}.canonicalUrl`,
  );
  if (
    !Array.isArray(value['respondentNames']) ||
    value['respondentNames'].length > 1 ||
    value['respondentNames'].some(
      (name) => typeof name !== 'string' || name.trim() !== name || name.length > 240,
    )
  ) {
    throw new Error(`${context}.respondentNames violates the conservative extraction contract`);
  }
  if (!Array.isArray(value['documents']) || value['documents'].length > 20) {
    throw new Error(`${context}.documents must be a bounded array`);
  }
  const documents = value['documents'].map((document, index) =>
    parseDocument(document, `${context}.documents[${String(index)}]`),
  );
  if (value['sourceDate'] === null) {
    if (value['sourceDatePrecision'] !== null) {
      throw new Error(`${context} has a date precision without a source date`);
    }
  } else {
    assertCalendarDate(value['sourceDate'], `${context}.sourceDate`);
    if (value['sourceDatePrecision'] !== 'DAY') {
      throw new Error(`${context}.sourceDatePrecision must be DAY`);
    }
  }
  if (
    !['ORIGINAL', 'ANONYMIZED', 'MIXED', 'UNKNOWN'].includes(value['visibility'] as string) ||
    value['outcome'] !== 'UNKNOWN' ||
    value['finalityStatus'] !== 'UNKNOWN'
  ) {
    throw new Error(`${context} contains an unsupported inference`);
  }
  assertIsoDateTime(value['firstObservedAt'], `${context}.firstObservedAt`);
  assertIsoDateTime(value['lastObservedAt'], `${context}.lastObservedAt`);
  if (value['lastObservedAt'] < value['firstObservedAt']) {
    throw new Error(`${context} has an invalid observation interval`);
  }
  const sourceMetadata = parseSourceMetadata(value['sourceMetadata'], `${context}.sourceMetadata`);
  return {
    ethicsCaseId: value['ethicsCaseId'],
    sourceCaseKey: value['sourceCaseKey'],
    title: value['title'],
    canonicalUrl,
    respondentNames: [...(value['respondentNames'] as string[])],
    documents,
    sourceDate: value['sourceDate'],
    sourceDatePrecision: value['sourceDatePrecision'],
    visibility: value['visibility'] as CmuEthicsCaseMetadata['visibility'],
    outcome: 'UNKNOWN',
    finalityStatus: 'UNKNOWN',
    firstObservedAt: value['firstObservedAt'],
    lastObservedAt: value['lastObservedAt'],
    sourceMetadata,
  };
}

function semanticRecord(record: CmuEthicsCaseMetadata): unknown {
  return {
    ethicsCaseId: record.ethicsCaseId,
    sourceCaseKey: record.sourceCaseKey,
    title: record.title,
    canonicalUrl: record.canonicalUrl,
    respondentNames: record.respondentNames,
    documents: record.documents,
    sourceDate: record.sourceDate,
    sourceDatePrecision: record.sourceDatePrecision,
    visibility: record.visibility,
    outcome: record.outcome,
    finalityStatus: record.finalityStatus,
    sourceMetadata: record.sourceMetadata,
  };
}

export function serializeCmuEthicsCases(records: readonly CmuEthicsCaseMetadata[]): {
  readonly casesContent: string;
  readonly semanticSha256: string;
} {
  const validated = records
    .map((record, index) => parseCmuEthicsCaseMetadata(record, index + 1))
    .sort(
      (left, right) =>
        left.sourceCaseKey.localeCompare(right.sourceCaseKey, 'en') ||
        left.canonicalUrl.localeCompare(right.canonicalUrl, 'en'),
    );
  const uniqueKeys = new Set<string>();
  for (const record of validated) {
    if (uniqueKeys.has(record.sourceCaseKey)) {
      throw new Error(`Duplicate CMU source case key ${record.sourceCaseKey}`);
    }
    uniqueKeys.add(record.sourceCaseKey);
  }
  const casesContent =
    validated.length === 0
      ? ''
      : `${validated.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const semanticContent =
    validated.length === 0
      ? ''
      : `${validated.map((record) => JSON.stringify(semanticRecord(record))).join('\n')}\n`;
  return {
    casesContent,
    semanticSha256: sha256(semanticContent),
  };
}

function parseManifest(value: unknown): CmuEthicsSnapshotManifest {
  if (!isObject(value)) {
    throw new Error('CMU ethics manifest must be an object');
  }
  if (
    value['schemaVersion'] !== 1 ||
    value['collectionMode'] !== CMU_ETHICS_COLLECTION_MODE ||
    typeof value['artifactId'] !== 'string' ||
    !/^cmu-ethics-v1-[0-9a-f]{16}$/u.test(value['artifactId']) ||
    typeof value['collectorVersion'] !== 'string'
  ) {
    throw new Error('CMU ethics manifest header is invalid');
  }
  assertIsoDateTime(value['generatedAt'], 'CMU ethics manifest.generatedAt');
  assertCalendarDate(value['policyReviewedAt'], 'CMU ethics manifest.policyReviewedAt');
  const source = value['source'];
  const outputs = value['outputs'];
  const aggregates = value['aggregates'];
  const safeguards = value['safeguards'];
  if (!isObject(source) || !isObject(outputs) || !isObject(aggregates) || !isObject(safeguards)) {
    throw new Error('CMU ethics manifest sections are invalid');
  }
  const casesOutput = outputs['cases'];
  if (
    source['origin'] !== 'https://www.colegiomedico.org.uy' ||
    source['robotsUrl'] !== 'https://www.colegiomedico.org.uy/robots.txt' ||
    source['sitemapUrl'] !== 'https://www.colegiomedico.org.uy/fallos-sitemap.xml' ||
    typeof source['robotsSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(source['robotsSha256']) ||
    !isObject(casesOutput) ||
    casesOutput['file'] !== CMU_ETHICS_CASES_FILE ||
    casesOutput['schemaVersion'] !== 1 ||
    !Number.isSafeInteger(casesOutput['records']) ||
    !Number.isSafeInteger(casesOutput['bytes']) ||
    typeof casesOutput['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(casesOutput['sha256']) ||
    typeof casesOutput['semanticSha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(casesOutput['semanticSha256'])
  ) {
    throw new Error('CMU ethics manifest source or output is invalid');
  }
  const aggregateKeys: readonly (keyof CmuEthicsSnapshotManifest['aggregates'])[] = [
    'sitemapUrlsDiscovered',
    'disallowedUrlsSkipped',
    'invalidUrlsSkipped',
    'pagesFetched',
    'pagesFailed',
    'duplicateCasesCollapsed',
    'casesEmitted',
  ];
  if (
    aggregateKeys.some(
      (key) => !Number.isSafeInteger(aggregates[key]) || (aggregates[key] as number) < 0,
    ) ||
    aggregates['casesEmitted'] !== casesOutput['records']
  ) {
    throw new Error('CMU ethics manifest aggregates are invalid');
  }
  const requiredSafeguards: CmuEthicsSnapshotManifest['safeguards'] = {
    sameOriginHttpsOnly: true,
    robotsPolicyHashPinned: true,
    robotsPolicyFailClosed: true,
    listPageFetched: false,
    uploadedDocumentsFetched: false,
    documentLinksPersisted: false,
    pageContentPersisted: false,
    outcomeInferred: false,
    finalityInferred: false,
    automaticIdentityConfirmation: false,
    publicExportAllowed: false,
  };
  if (Object.entries(requiredSafeguards).some(([key, expected]) => safeguards[key] !== expected)) {
    throw new Error('CMU ethics manifest safeguards are invalid');
  }
  return value as unknown as CmuEthicsSnapshotManifest;
}

export async function installCmuEthicsSnapshotAtomically(
  options: InstallCmuEthicsSnapshotOptions,
): Promise<InstalledCmuEthicsSnapshot> {
  const outputDirectory = resolve(options.outputDirectory);
  const { casesContent, semanticSha256 } = serializeCmuEthicsCases(options.cases);
  const casesSha256 = sha256(casesContent);
  const artifactId = `cmu-ethics-v1-${sha256(
    [
      options.collectorVersion,
      options.generatedAt,
      options.policyReviewedAt,
      options.robotsSha256,
      casesSha256,
    ].join('\u0000'),
  ).slice(0, 16)}`;
  const manifest: CmuEthicsSnapshotManifest = {
    schemaVersion: 1,
    artifactId,
    collectorVersion: options.collectorVersion,
    collectionMode: CMU_ETHICS_COLLECTION_MODE,
    generatedAt: options.generatedAt,
    policyReviewedAt: options.policyReviewedAt,
    source: {
      origin: 'https://www.colegiomedico.org.uy',
      robotsUrl: 'https://www.colegiomedico.org.uy/robots.txt',
      robotsSha256: options.robotsSha256,
      sitemapUrl: 'https://www.colegiomedico.org.uy/fallos-sitemap.xml',
    },
    outputs: {
      cases: {
        file: CMU_ETHICS_CASES_FILE,
        records: options.cases.length,
        bytes: Buffer.byteLength(casesContent, 'utf8'),
        sha256: casesSha256,
        semanticSha256,
        schemaVersion: 1,
      },
    },
    aggregates: options.aggregates,
    safeguards: {
      sameOriginHttpsOnly: true,
      robotsPolicyHashPinned: true,
      robotsPolicyFailClosed: true,
      listPageFetched: false,
      uploadedDocumentsFetched: false,
      documentLinksPersisted: false,
      pageContentPersisted: false,
      outcomeInferred: false,
      finalityInferred: false,
      automaticIdentityConfirmation: false,
      publicExportAllowed: false,
    },
  };
  if (manifest.aggregates.casesEmitted !== options.cases.length) {
    throw new Error('CMU ethics aggregate count does not match emitted cases');
  }
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const stagingDirectory = await mkdtemp(join(outputParent, '.cmu-ethics-stage-'));
  try {
    await Promise.all([
      writeFile(join(stagingDirectory, CMU_ETHICS_CASES_FILE), casesContent, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(join(stagingDirectory, CMU_ETHICS_MANIFEST_FILE), manifestContent, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
    ]);
    await rename(stagingDirectory, outputDirectory);
  } catch (error: unknown) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    artifactId,
    outputDirectory,
    casesPath: join(outputDirectory, CMU_ETHICS_CASES_FILE),
    manifestPath: join(outputDirectory, CMU_ETHICS_MANIFEST_FILE),
    records: options.cases.length,
    semanticSha256,
  };
}

export async function loadCmuEthicsSnapshot(
  snapshotPath: string,
): Promise<LoadedCmuEthicsSnapshot> {
  const snapshotDirectory = resolve(snapshotPath);
  const manifestPath = join(snapshotDirectory, CMU_ETHICS_MANIFEST_FILE);
  const casesPath = join(snapshotDirectory, CMU_ETHICS_CASES_FILE);
  const [manifestContent, casesContent] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(casesPath, 'utf8'),
  ]);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestContent) as unknown;
  } catch {
    throw new Error('CMU ethics manifest is not valid JSON');
  }
  const manifest = parseManifest(rawManifest);
  if (
    Buffer.byteLength(casesContent, 'utf8') !== manifest.outputs.cases.bytes ||
    sha256(casesContent) !== manifest.outputs.cases.sha256
  ) {
    throw new Error('CMU ethics cases artifact failed integrity verification');
  }
  const lines = casesContent.length === 0 ? [] : casesContent.trimEnd().split('\n');
  if (lines.length !== manifest.outputs.cases.records) {
    throw new Error('CMU ethics cases record count does not match the manifest');
  }
  const cases = lines.map((line, index) => {
    let rawCase: unknown;
    try {
      rawCase = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`CMU ethics case record line ${String(index + 1)} is not valid JSON`);
    }
    return parseCmuEthicsCaseMetadata(rawCase, index + 1);
  });
  const serialized = serializeCmuEthicsCases(cases);
  if (serialized.semanticSha256 !== manifest.outputs.cases.semanticSha256) {
    throw new Error('CMU ethics semantic fingerprint does not match the manifest');
  }
  return {
    cases,
    records: cases.length,
    semanticSha256: serialized.semanticSha256,
    manifestSha256: sha256(manifestContent),
    policyReviewedAt: manifest.policyReviewedAt,
  };
}
