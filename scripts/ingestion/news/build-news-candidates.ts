import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { normalizePersonName } from '../linkage/normalize-person-name';

import {
  classifyHeadline,
  createProfessionalNameIndex,
  NEWS_HEADLINE_POLICY_VERSION,
  NEWS_INDEX_COLLECTOR_VERSION,
  NEWS_ITEM_MAX_AGE_DAYS,
  NEWS_SOURCE_RIGHTS_POLICY_VERSION,
  URUGUAYAN_NEWS_INDEX_SOURCES,
  type NewsIndexSource,
} from './ingest-uruguayan-news-indexes';
import {
  buildNewsCandidates,
  NEWS_CANDIDATE_RETENTION_DAYS,
  NEWS_MATCHER_ALGORITHM_VERSION,
  newsCandidateExpiresAt,
  type ArtifactReference,
  type FactualProfessionalInput,
  type NewsCandidateAggregates,
  type NewsLinkageCandidate,
  type NormalizedNewsArticleInput,
} from './match-news-candidates';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface NewsCandidateManifest {
  readonly schemaVersion: 2;
  readonly artifactId: string;
  readonly algorithmVersion: typeof NEWS_MATCHER_ALGORITHM_VERSION;
  readonly generatedAt: string;
  readonly inputs: {
    readonly professionals: ArtifactReference & {
      readonly records: number;
      readonly formats: readonly FactualProfessionalInput['input']['format'][];
    };
    readonly articles: ArtifactReference & {
      readonly records: number;
      readonly schemaVersion: 1;
      readonly manifest: ArtifactReference;
      readonly sourceExpiresAt: string;
    };
  };
  readonly outputs: {
    readonly quarantineCandidates: ArtifactReference & {
      readonly records: number;
    };
  };
  readonly aggregates: NewsCandidateAggregates;
  readonly safeguards: {
    readonly adverseFactsInferred: false;
    readonly articleClaimsAcceptedAsFact: false;
    readonly automaticallyLinked: false;
    readonly automaticallyPublished: false;
    readonly candidateIdsContainRawPii: false;
    readonly contextualCorroborationUsed: true;
    readonly deterministicFlexibleNameMatchingUsed: true;
    readonly factsAutomaticallyConfirmed: false;
    readonly fuzzyMatchingUsed: false;
    readonly identityAutomaticallyConfirmed: false;
    readonly missingContextTreatedAsContradiction: false;
    readonly nameMatchingOnly: false;
    readonly publicExportAllowed: false;
    readonly quarantineOnly: true;
    readonly rawArticleBodyPersisted: false;
    readonly requiresHumanReview: true;
  };
  readonly retention: {
    readonly ttlDays: typeof NEWS_CANDIDATE_RETENTION_DAYS;
    readonly expiresAt: string;
    readonly sourceExpiresAt: string;
    readonly boundedBySourceExpiry: true;
    readonly disposition: 'DELETE_OR_REVALIDATE';
  };
}

interface VerifiedArticleManifest {
  readonly artifact: ArtifactReference;
  readonly sourceExpiresAt: string;
}

interface VerifiedManifestSource {
  readonly catalogSource: NewsIndexSource;
  readonly status: 'FETCHED' | 'STALE' | 'FAILED';
  readonly retrievedAt?: string;
}

export interface RunNewsCandidateBuildOptions {
  readonly now?: () => Date;
}

const ARTICLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MSP_LINKAGE_ID_PATTERN = /^msp_doc_v1_[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const FORBIDDEN_PROFESSIONAL_KEYS = [
  'documentNumber',
  'documento',
  'cedula',
  'cédula',
  'email',
  'phone',
] as const;
const SOURCE_REPORT_COMMON_KEYS = [
  'sourceId',
  'publisher',
  'format',
  'indexUrl',
  'discoveryUrl',
  'robotsUrl',
  'rightsBasis',
  'termsUrl',
  'rightsReviewedOn',
  'rightsReviewExpiresOn',
  'authorizationEvidenceSha256',
  'status',
  'errorCode',
  'finalUrl',
  'retrievedAt',
  'responseBytes',
  'responseSha256',
  'lastModified',
  'freshestPublishedAt',
  'recordsDiscovered',
  'recordsInvalid',
  'recordsRestricted',
  'recordsWithoutMentions',
  'recordsWithMentions',
  'recordsSkippedAsStale',
  'restrictedReasonCounts',
] as const;
const RESTRICTED_REASON_KEYS = [
  'ADVERSE_OR_JUDICIAL',
  'MINOR',
  'PRIVATE_HEALTH',
  'NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT',
] as const;

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredObject(record: UnknownRecord, key: string, context: string): UnknownRecord {
  const value = record[key];
  if (!isObject(value)) {
    throw new Error(`${context} has invalid ${key}`);
  }
  return value;
}

function requiredString(record: UnknownRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} has invalid ${key}`);
  }
  return value.trim();
}

function assertExactKeys(
  record: UnknownRecord,
  expectedKeys: readonly string[],
  context: string,
): void {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(record).filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !(key in record));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${context} has an invalid shape (missing=${missing.join(',') || 'none'}, unexpected=${
        unexpected.join(',') || 'none'
      })`,
    );
  }
}

function assertOnlyKeys(
  record: UnknownRecord,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${context} has unexpected keys: ${unexpected.join(',')}`);
  }
}

function requiredNonNegativeInteger(record: UnknownRecord, key: string, context: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} has invalid ${key}`);
  }
  return value as number;
}

function requiredIsoDate(record: UnknownRecord, key: string, context: string): string {
  const value = requiredString(record, key, context);
  if (!ISO_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${context} has invalid ${key}`);
  }
  return value;
}

function requiredIsoInstant(record: UnknownRecord, key: string, context: string): string {
  const value = requiredString(record, key, context);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${context} has invalid canonical ISO instant ${key}`);
  }
  return value;
}

function requiredSha256(record: UnknownRecord, key: string, context: string): string {
  const value = requiredString(record, key, context);
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${context} has invalid ${key}`);
  }
  return value;
}

function requiredHttpsUrl(record: UnknownRecord, key: string, context: string): string {
  const value = requiredString(record, key, context);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context} has invalid ${key}`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(`${context} ${key} must be an HTTPS URL without credentials`);
  }
  return url.toString();
}

function assertSafeProfessionalName(value: string, context: string): void {
  const normalized = normalizePersonName(value);
  if (normalized.split(' ').filter(Boolean).length < 2) {
    throw new Error(`${context} must contain at least two name tokens`);
  }
}

function parseDirectoryProfessional(
  value: UnknownRecord,
  rowNumber: number,
): FactualProfessionalInput {
  const context = `Directory professional row ${String(rowNumber)}`;
  if (value['schemaVersion'] !== 2) {
    throw new Error(`${context} must use schemaVersion 2`);
  }
  const opaqueProfessionalId = requiredString(value, 'internalLinkageId', context);
  if (!MSP_LINKAGE_ID_PATTERN.test(opaqueProfessionalId)) {
    throw new Error(`${context} has an invalid opaque professional id`);
  }
  const displayName = requiredString(value, 'displayName', context);
  assertSafeProfessionalName(displayName, context);
  const enabledTitles = value['enabledTitles'];
  if (
    !Array.isArray(enabledTitles) ||
    enabledTitles.length === 0 ||
    !enabledTitles.every((title) => typeof title === 'string' && title.trim().length > 0)
  ) {
    throw new Error(`${context} has no valid enabled title evidence`);
  }
  const professions = [...new Set(enabledTitles.map((title) => (title as string).trim()))].sort();
  const officialRegistry = requiredObject(value, 'officialRegistry', context);
  const publication = requiredObject(value, 'publication', context);
  if (publication['publicExportAllowed'] !== false) {
    throw new Error(`${context} is not a fail-closed factual profile`);
  }
  const datasetUrl = requiredHttpsUrl(officialRegistry, 'datasetUrl', `${context} registry`);
  const liveLookupUrl = requiredHttpsUrl(officialRegistry, 'liveLookupUrl', `${context} registry`);

  return {
    opaqueProfessionalId,
    displayName,
    context: {
      professions,
      institutions: [],
    },
    source: {
      publisher: requiredString(officialRegistry, 'publisher', `${context} registry`),
      dataset: requiredString(officialRegistry, 'dataset', `${context} registry`),
      sourceCutoffDate: requiredIsoDate(
        officialRegistry,
        'sourceCutoffDate',
        `${context} registry`,
      ),
      datasetUrl,
      liveLookupUrl,
    },
    input: {
      format: 'DIRECTORY_FACTUAL_V3',
      rowNumber,
    },
  };
}

function parseMspProfessional(value: UnknownRecord, rowNumber: number): FactualProfessionalInput {
  const context = `MSP professional row ${String(rowNumber)}`;
  for (const key of FORBIDDEN_PROFESSIONAL_KEYS) {
    if (key in value) {
      throw new Error(`${context} contains forbidden raw personal data field ${key}`);
    }
  }
  const opaqueProfessionalId = requiredString(value, 'linkageId', context);
  if (!MSP_LINKAGE_ID_PATTERN.test(opaqueProfessionalId)) {
    throw new Error(`${context} has an invalid opaque professional id`);
  }
  const displayName = requiredString(value, 'fullName', context);
  assertSafeProfessionalName(displayName, context);
  const enabledTitles = value['enabledTitles'];
  if (!Array.isArray(enabledTitles) || enabledTitles.length === 0) {
    throw new Error(`${context} has no enabled title evidence`);
  }
  const professions = [
    ...new Set(
      enabledTitles.map((enabledTitle, index) => {
        if (!isObject(enabledTitle)) {
          throw new Error(`${context} enabled title ${String(index + 1)} is not an object`);
        }
        return requiredString(
          enabledTitle,
          'title',
          `${context} enabled title ${String(index + 1)}`,
        );
      }),
    ),
  ].sort();
  const provenance = requiredObject(value, 'provenance', context);

  return {
    opaqueProfessionalId,
    displayName,
    context: {
      professions,
      institutions: [],
    },
    source: {
      publisher: requiredString(provenance, 'publisher', `${context} provenance`),
      dataset: requiredString(provenance, 'dataset', `${context} provenance`),
      sourceCutoffDate: requiredIsoDate(provenance, 'sourceCutoffDate', `${context} provenance`),
    },
    input: {
      format: 'MSP_INFOTITULOS_NORMALIZED',
      rowNumber,
    },
  };
}

export function parseFactualProfessional(
  value: unknown,
  rowNumber: number,
): FactualProfessionalInput {
  if (!isObject(value)) {
    throw new Error(`Professional row ${String(rowNumber)} is not an object`);
  }
  if ('internalLinkageId' in value || 'displayName' in value) {
    return parseDirectoryProfessional(value, rowNumber);
  }
  return parseMspProfessional(value, rowNumber);
}

export function parseNormalizedNewsArticle(
  value: unknown,
  rowNumber: number,
): NormalizedNewsArticleInput {
  const context = `Article row ${String(rowNumber)}`;
  if (!isObject(value)) {
    throw new Error(`${context} is not an object`);
  }
  assertExactKeys(
    value,
    ['schemaVersion', 'articleId', 'headline', 'extractedPersonNames', 'source', 'extraction'],
    context,
  );
  if (value['schemaVersion'] !== 1) {
    throw new Error(`${context} must use schemaVersion 1`);
  }
  const articleId = requiredString(value, 'articleId', context);
  if (!ARTICLE_ID_PATTERN.test(articleId)) {
    throw new Error(`${context} articleId must be an opaque source identifier`);
  }
  const headline = requiredString(value, 'headline', context);
  if (headline.length > 1_000) {
    throw new Error(`${context} headline exceeds 1000 characters`);
  }
  const personNames = value['extractedPersonNames'];
  if (
    !Array.isArray(personNames) ||
    personNames.length === 0 ||
    !personNames.every((name) => typeof name === 'string' && name.trim().length > 0)
  ) {
    throw new Error(`${context} has invalid extractedPersonNames`);
  }
  const normalizedNames = personNames.map((name) => normalizePersonName(name as string));
  if (
    normalizedNames.some((name) => name.split(' ').filter(Boolean).length < 2) ||
    new Set(normalizedNames).size !== normalizedNames.length
  ) {
    throw new Error(`${context} names must be unique and contain at least two tokens`);
  }
  if (classifyHeadline(headline, personNames as readonly string[]).restricted) {
    throw new Error(`${context} headline is restricted by the fail-closed news policy`);
  }

  const source = requiredObject(value, 'source', context);
  assertExactKeys(
    source,
    ['sourceId', 'publisher', 'canonicalUrl', 'publishedAt', 'retrievedAt', 'contentSha256'],
    `${context} source`,
  );
  const publishedAt = requiredIsoInstant(source, 'publishedAt', `${context} source`);
  const retrievedAt = requiredIsoInstant(source, 'retrievedAt', `${context} source`);
  if (retrievedAt < publishedAt) {
    throw new Error(`${context} retrievedAt predates publishedAt`);
  }

  const extraction = requiredObject(value, 'extraction', context);
  assertExactKeys(
    extraction,
    ['method', 'extractedAt', 'extractorVersion'],
    `${context} extraction`,
  );
  const method = requiredString(extraction, 'method', `${context} extraction`);
  if (
    method !== 'SOURCE_STRUCTURED_DATA' &&
    method !== 'DETERMINISTIC_PARSER' &&
    method !== 'HUMAN_CURATED'
  ) {
    throw new Error(`${context} has unsupported extraction method`);
  }
  const extractedAt = requiredIsoInstant(extraction, 'extractedAt', `${context} extraction`);
  if (extractedAt < retrievedAt) {
    throw new Error(`${context} extractedAt predates retrievedAt`);
  }

  return {
    schemaVersion: 1,
    articleId,
    headline,
    extractedPersonNames: personNames.map((name) => (name as string).trim()),
    source: {
      sourceId: requiredString(source, 'sourceId', `${context} source`),
      publisher: requiredString(source, 'publisher', `${context} source`),
      canonicalUrl: requiredHttpsUrl(source, 'canonicalUrl', `${context} source`),
      publishedAt,
      retrievedAt,
      contentSha256: requiredSha256(source, 'contentSha256', `${context} source`),
    },
    extraction: {
      method,
      extractedAt,
      extractorVersion: requiredString(extraction, 'extractorVersion', `${context} extraction`),
    },
    input: {
      rowNumber,
    },
  };
}

function parseNdjsonContent<T>(
  content: Buffer,
  parseRecord: (value: unknown, rowNumber: number) => T,
): readonly T[] {
  const text = content.toString('utf8');
  if (text.startsWith('\uFEFF')) {
    throw new Error('NDJSON input must not contain a byte order mark');
  }
  const lines = text.split(/\r?\n/u);
  const records: T[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      if (index !== lines.length - 1) {
        throw new Error(`NDJSON has an empty row at ${String(index + 1)}`);
      }
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`NDJSON row ${String(index + 1)} is invalid JSON`);
    }
    records.push(parseRecord(value, index + 1));
  }
  return records;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function validateManifestSourceReport(
  source: UnknownRecord,
  index: number,
  environment: NodeJS.ProcessEnv,
): VerifiedManifestSource {
  const context = `Article manifest source ${String(index + 1)}`;
  assertOnlyKeys(source, SOURCE_REPORT_COMMON_KEYS, context);
  const sourceId = requiredString(source, 'sourceId', context);
  const catalogSource = URUGUAYAN_NEWS_INDEX_SOURCES.find(({ id }) => id === sourceId);
  if (catalogSource === undefined) {
    throw new Error(`${context} is not in the production source catalog`);
  }

  const catalogFields = [
    ['publisher', catalogSource.publisher],
    ['format', catalogSource.format],
    ['indexUrl', catalogSource.indexUrl],
    ['discoveryUrl', catalogSource.discoveryUrl],
    ['robotsUrl', catalogSource.robotsUrl],
    ['rightsBasis', catalogSource.rightsBasis],
    ['termsUrl', catalogSource.termsUrl],
    ['rightsReviewedOn', catalogSource.rightsReviewedOn],
    ['rightsReviewExpiresOn', catalogSource.rightsReviewExpiresOn],
  ] as const;
  for (const [key, expected] of catalogFields) {
    if (requiredString(source, key, context) !== expected) {
      throw new Error(`${context} ${key} does not match the approved production catalog`);
    }
  }
  if (catalogSource.rightsBasis === 'TEST_FIXTURE') {
    throw new Error(`${context} test fixtures are never valid matcher inputs`);
  }
  if (catalogSource.rightsBasis === 'WRITTEN_AUTHORIZATION_REQUIRED') {
    const enableVariable = catalogSource.enableEnvironmentVariable;
    const referenceVariable = catalogSource.authorizationReferenceEnvironmentVariable;
    const allowlistVariable = catalogSource.authorizationAllowlistEnvironmentVariable;
    if (
      enableVariable === undefined ||
      referenceVariable === undefined ||
      allowlistVariable === undefined
    ) {
      throw new Error(`${context} has an incomplete production authorization gate`);
    }
    if (environment[enableVariable]?.trim().toLowerCase() !== 'true') {
      throw new Error(`${context} is not enabled by the independent authorization environment`);
    }
    const authorizationReference = environment[referenceVariable]?.trim();
    if (authorizationReference === undefined || authorizationReference.length < 8) {
      throw new Error(`${context} has no current written-authorization reference`);
    }
    const authorizationEvidenceSha256 = requiredSha256(
      source,
      'authorizationEvidenceSha256',
      context,
    );
    const approvedHashes = (environment[allowlistVariable] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      approvedHashes.length === 0 ||
      approvedHashes.some((value) => !SHA256_PATTERN.test(value)) ||
      sha256(authorizationReference) !== authorizationEvidenceSha256 ||
      !approvedHashes.includes(authorizationEvidenceSha256)
    ) {
      throw new Error(`${context} evidence is not in the independent authorization allowlist`);
    }
  } else if ('authorizationEvidenceSha256' in source) {
    throw new Error(`${context} has authorization evidence for a source that does not require it`);
  }

  const status = requiredString(source, 'status', context);
  if (status !== 'FETCHED' && status !== 'STALE' && status !== 'FAILED') {
    throw new Error(`${context} has invalid status`);
  }
  for (const key of [
    'recordsDiscovered',
    'recordsInvalid',
    'recordsRestricted',
    'recordsWithoutMentions',
    'recordsWithMentions',
    'recordsSkippedAsStale',
  ] as const) {
    requiredNonNegativeInteger(source, key, context);
  }
  const restrictedReasonCounts = requiredObject(source, 'restrictedReasonCounts', context);
  assertExactKeys(restrictedReasonCounts, RESTRICTED_REASON_KEYS, `${context} restricted reasons`);
  for (const key of RESTRICTED_REASON_KEYS) {
    requiredNonNegativeInteger(restrictedReasonCounts, key, `${context} restricted reasons`);
  }

  const hasFetchMetadata = ['finalUrl', 'retrievedAt', 'responseBytes', 'responseSha256'].some(
    (key) => key in source,
  );
  let retrievedAt: string | undefined;
  if (status !== 'FAILED' || hasFetchMetadata) {
    const finalUrl = requiredHttpsUrl(source, 'finalUrl', context);
    if (!catalogSource.allowedIndexHosts.includes(new URL(finalUrl).hostname.toLowerCase())) {
      throw new Error(`${context} finalUrl is outside its approved index hosts`);
    }
    retrievedAt = requiredIsoInstant(source, 'retrievedAt', context);
    requiredNonNegativeInteger(source, 'responseBytes', context);
    requiredSha256(source, 'responseSha256', context);
  }
  if (status === 'FAILED') {
    requiredString(source, 'errorCode', context);
  } else if ('errorCode' in source) {
    throw new Error(`${context} has an errorCode despite a non-failed status`);
  }
  if ('lastModified' in source) {
    requiredString(source, 'lastModified', context);
  }
  if ('freshestPublishedAt' in source) {
    const freshestPublishedAt = requiredIsoInstant(source, 'freshestPublishedAt', context);
    if (retrievedAt === undefined || freshestPublishedAt > retrievedAt) {
      throw new Error(`${context} freshestPublishedAt is later than retrieval`);
    }
  }

  return {
    catalogSource,
    status,
    ...(retrievedAt === undefined ? {} : { retrievedAt }),
  };
}

function verifyArticlesAgainstManifestSources(options: {
  readonly articles: readonly NormalizedNewsArticleInput[];
  readonly sourcesById: ReadonlyMap<string, VerifiedManifestSource>;
  readonly sourceGeneratedAt: string;
}): void {
  const maxAgeMilliseconds = NEWS_ITEM_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
  for (const article of options.articles) {
    const source = options.sourcesById.get(article.source.sourceId);
    if (source?.status !== 'FETCHED' || source.retrievedAt === undefined) {
      throw new Error(
        `Article ${article.articleId} is not tied to a fetched approved manifest source`,
      );
    }
    if (article.source.publisher !== source.catalogSource.publisher) {
      throw new Error(`Article ${article.articleId} publisher does not match its manifest source`);
    }
    const canonicalUrl = new URL(article.source.canonicalUrl);
    if (!source.catalogSource.allowedArticleHosts.includes(canonicalUrl.hostname.toLowerCase())) {
      throw new Error(`Article ${article.articleId} URL is outside its approved publisher hosts`);
    }
    if (article.source.retrievedAt !== source.retrievedAt) {
      throw new Error(`Article ${article.articleId} retrieval does not match its source report`);
    }
    if (article.source.retrievedAt > options.sourceGeneratedAt) {
      throw new Error(`Article ${article.articleId} retrieval is later than its manifest`);
    }
    const publishedAt = Date.parse(article.source.publishedAt);
    const retrievedAt = Date.parse(article.source.retrievedAt);
    if (publishedAt < retrievedAt - maxAgeMilliseconds || publishedAt > retrievedAt) {
      throw new Error(`Article ${article.articleId} is outside the approved collection window`);
    }
    if (
      article.extraction.method !== 'DETERMINISTIC_PARSER' ||
      article.extraction.extractorVersion !== NEWS_INDEX_COLLECTOR_VERSION ||
      article.extraction.extractedAt !== article.source.retrievedAt
    ) {
      throw new Error(`Article ${article.articleId} was not produced by the approved collector`);
    }
    const expectedContentSha256 = sha256(
      [article.headline, article.source.canonicalUrl, article.source.publishedAt].join('\u0000'),
    );
    if (article.source.contentSha256 !== expectedContentSha256) {
      throw new Error(`Article ${article.articleId} content hash is not reproducible`);
    }
    const expectedArticleId = `${source.catalogSource.publisherKey}:${sha256(
      article.source.canonicalUrl,
    ).slice(0, 40)}`;
    if (article.articleId !== expectedArticleId) {
      throw new Error(`Article ${article.articleId} is not the collector-derived opaque id`);
    }
  }
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function pathIsInside(root: string, path: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(normalizedRoot);
}

async function resolveExistingPathInside(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  const resolvedPath = await realpath(resolve(path));
  if (!pathIsInside(root, resolvedPath)) {
    throw new Error(`${label} must stay inside DATA_INGESTION_DIR`);
  }
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a file`);
  }
  return resolvedPath;
}

function resolveFuturePathInside(root: string, path: string, label: string): string {
  const resolvedPath = resolve(path);
  if (!pathIsInside(root, resolvedPath)) {
    throw new Error(`${label} must stay inside DATA_INGESTION_DIR`);
  }
  return resolvedPath;
}

async function loadAndVerifyArticleManifest(options: {
  readonly dataDirectory: string;
  readonly professionalsPath: string;
  readonly professionalsContent: Buffer;
  readonly professionalRecords: number;
  readonly distinctProfessionalNames: number;
  readonly articlesPath: string;
  readonly articlesContent: Buffer;
  readonly articleRecords: number;
  readonly articles: readonly NormalizedNewsArticleInput[];
  readonly environment: NodeJS.ProcessEnv;
  readonly configuredManifestPath?: string;
  readonly generatedAt: string;
}): Promise<VerifiedArticleManifest> {
  const manifestPath = await resolveExistingPathInside(
    options.dataDirectory,
    options.configuredManifestPath ?? join(dirname(options.articlesPath), 'manifest.json'),
    'Article manifest input',
  );
  const manifestContent = await readFile(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContent.toString('utf8')) as unknown;
  } catch {
    throw new Error('Article manifest is invalid JSON');
  }
  if (!isObject(parsed) || parsed['schemaVersion'] !== 1) {
    throw new Error('Article manifest must be a schemaVersion 1 object');
  }
  assertExactKeys(
    parsed,
    [
      'schemaVersion',
      'artifactId',
      'collectorVersion',
      'headlinePolicyVersion',
      'sourceRightsPolicyVersion',
      'generatedAt',
      'inputs',
      'sources',
      'sourcePolicy',
      'outputs',
      'aggregates',
      'collectionWindow',
      'safeguards',
      'retention',
    ],
    'Article manifest',
  );
  if (
    parsed['collectorVersion'] !== NEWS_INDEX_COLLECTOR_VERSION ||
    parsed['headlinePolicyVersion'] !== NEWS_HEADLINE_POLICY_VERSION ||
    parsed['sourceRightsPolicyVersion'] !== NEWS_SOURCE_RIGHTS_POLICY_VERSION
  ) {
    throw new Error('Article manifest policy versions are not approved by this matcher');
  }
  requiredString(parsed, 'artifactId', 'Article manifest');
  const inputs = requiredObject(parsed, 'inputs', 'Article manifest');
  assertExactKeys(inputs, ['professionals'], 'Article manifest inputs');
  const professionalInput = requiredObject(inputs, 'professionals', 'Article manifest inputs');
  assertExactKeys(
    professionalInput,
    ['relativePath', 'sha256', 'records', 'distinctNames'],
    'Article manifest professional input',
  );
  if (
    requiredString(professionalInput, 'relativePath', 'Article manifest professional input') !==
    portableRelative(options.dataDirectory, options.professionalsPath)
  ) {
    throw new Error('Article manifest professional path does not match NEWS_PROFESSIONALS_PATH');
  }
  if (
    requiredSha256(professionalInput, 'sha256', 'Article manifest professional input') !==
    sha256(options.professionalsContent)
  ) {
    throw new Error('Article manifest professional hash does not match professionals.ndjson');
  }
  if (
    requiredNonNegativeInteger(
      professionalInput,
      'records',
      'Article manifest professional input',
    ) !== options.professionalRecords ||
    requiredNonNegativeInteger(
      professionalInput,
      'distinctNames',
      'Article manifest professional input',
    ) !== options.distinctProfessionalNames
  ) {
    throw new Error('Article manifest professional counts do not match professionals.ndjson');
  }
  requiredObject(parsed, 'aggregates', 'Article manifest');

  const collectionWindow = requiredObject(parsed, 'collectionWindow', 'Article manifest');
  assertExactKeys(collectionWindow, ['maxArticleAgeDays'], 'Article manifest collectionWindow');
  if (collectionWindow['maxArticleAgeDays'] !== NEWS_ITEM_MAX_AGE_DAYS) {
    throw new Error('Article manifest collection window is not approved by this matcher');
  }

  const safeguards = requiredObject(parsed, 'safeguards', 'Article manifest');
  assertExactKeys(
    safeguards,
    [
      'articleBodiesFetched',
      'articleDescriptionsPersisted',
      'articlePagesFetched',
      'automaticIdentityConfirmation',
      'publicExportAllowed',
      'professionalIdsPersisted',
      'restrictedItemDetailsPersisted',
      'searchEnginesUsed',
      'sourceIndexesOnly',
    ],
    'Article manifest safeguards',
  );
  if (
    safeguards['articleBodiesFetched'] !== false ||
    safeguards['articleDescriptionsPersisted'] !== false ||
    safeguards['articlePagesFetched'] !== false ||
    safeguards['automaticIdentityConfirmation'] !== false ||
    safeguards['publicExportAllowed'] !== false ||
    safeguards['professionalIdsPersisted'] !== false ||
    safeguards['restrictedItemDetailsPersisted'] !== false ||
    safeguards['searchEnginesUsed'] !== false ||
    safeguards['sourceIndexesOnly'] !== true
  ) {
    throw new Error('Article manifest does not attest the required collection safeguards');
  }

  const sourcePolicy = requiredObject(parsed, 'sourcePolicy', 'Article manifest');
  assertExactKeys(
    sourcePolicy,
    ['authorizationGatedSourcesOmitted'],
    'Article manifest sourcePolicy',
  );
  const omittedSources = sourcePolicy['authorizationGatedSourcesOmitted'];
  if (
    !Array.isArray(omittedSources) ||
    !omittedSources.every((value) => typeof value === 'string' && value.length > 0) ||
    new Set(omittedSources).size !== omittedSources.length
  ) {
    throw new Error('Article manifest has invalid omitted source identifiers');
  }

  const sources = parsed['sources'];
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(isObject)) {
    throw new Error('Article manifest must contain source rights reports');
  }
  const verifiedSources = sources.map((source, index) =>
    validateManifestSourceReport(source, index, options.environment),
  );
  const sourcesById = new Map(
    verifiedSources.map((source) => [source.catalogSource.id, source] as const),
  );
  if (sourcesById.size !== verifiedSources.length) {
    throw new Error('Article manifest contains duplicate source reports');
  }
  const includedSourceIds = new Set(sourcesById.keys());
  const omittedSourceIds = new Set(omittedSources as readonly string[]);
  for (const omittedSourceId of omittedSourceIds) {
    const catalogSource = URUGUAYAN_NEWS_INDEX_SOURCES.find(({ id }) => id === omittedSourceId);
    if (
      catalogSource?.rightsBasis !== 'WRITTEN_AUTHORIZATION_REQUIRED' ||
      includedSourceIds.has(omittedSourceId)
    ) {
      throw new Error('Article manifest has an invalid omitted source partition');
    }
  }
  if (
    URUGUAYAN_NEWS_INDEX_SOURCES.some(
      ({ id }) => !includedSourceIds.has(id) && !omittedSourceIds.has(id),
    )
  ) {
    throw new Error('Article manifest does not account for the complete production source catalog');
  }
  const sourceRightsExpirations = verifiedSources.map(({ catalogSource }) =>
    new Date(
      Date.parse(`${catalogSource.rightsReviewExpiresOn}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
    ).toISOString(),
  );
  const earliestSourceRightsExpiry = sourceRightsExpirations.sort().at(0);
  if (earliestSourceRightsExpiry === undefined) {
    throw new Error('Article manifest has no source rights expiration');
  }

  const sourceGeneratedAt = requiredIsoInstant(parsed, 'generatedAt', 'Article manifest');
  const outputs = requiredObject(parsed, 'outputs', 'Article manifest');
  const articles = requiredObject(outputs, 'articles', 'Article manifest outputs');
  assertExactKeys(
    articles,
    ['relativePath', 'sha256', 'records', 'schemaVersion'],
    'Article manifest outputs.articles',
  );
  if (articles['schemaVersion'] !== 1) {
    throw new Error('Article manifest output must use schemaVersion 1');
  }
  const expectedRelativePath = portableRelative(options.dataDirectory, options.articlesPath);
  if (
    requiredString(articles, 'relativePath', 'Article manifest output') !== expectedRelativePath
  ) {
    throw new Error('Article manifest path does not match NEWS_ARTICLES_PATH');
  }
  if (
    requiredSha256(articles, 'sha256', 'Article manifest output') !==
    sha256(options.articlesContent)
  ) {
    throw new Error('Article manifest hash does not match articles.ndjson');
  }
  if (
    !Number.isSafeInteger(articles['records']) ||
    (articles['records'] as number) < 0 ||
    articles['records'] !== options.articleRecords
  ) {
    throw new Error('Article manifest record count does not match articles.ndjson');
  }

  const retention = requiredObject(parsed, 'retention', 'Article manifest');
  assertExactKeys(
    retention,
    [
      'articlesTtlDays',
      'expiresAt',
      'sourceRightsExpiresAt',
      'boundedBySourceRightsExpiry',
      'disposition',
    ],
    'Article manifest retention',
  );
  const ttlDays = retention['articlesTtlDays'];
  if (!Number.isSafeInteger(ttlDays) || (ttlDays as number) < 1 || (ttlDays as number) > 90) {
    throw new Error('Article manifest TTL must be between 1 and 90 days');
  }
  if (retention['disposition'] !== 'DELETE_ARTICLES_AND_DERIVED_NAME_LINKAGE') {
    throw new Error('Article manifest has an invalid retention disposition');
  }
  const sourceExpiresAt = requiredIsoInstant(retention, 'expiresAt', 'Article manifest retention');
  const ttlExpiresAt = new Date(
    Date.parse(sourceGeneratedAt) + (ttlDays as number) * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const sourceRightsExpiresAt = requiredIsoInstant(
    retention,
    'sourceRightsExpiresAt',
    'Article manifest retention',
  );
  if (sourceRightsExpiresAt !== earliestSourceRightsExpiry) {
    throw new Error('Article manifest rights expiration does not match its source reports');
  }
  const expectedExpiresAt = [ttlExpiresAt, sourceRightsExpiresAt].sort().at(0);
  if (sourceExpiresAt !== expectedExpiresAt) {
    throw new Error('Article manifest expiration does not match its TTL and source rights');
  }
  if (retention['boundedBySourceRightsExpiry'] !== sourceRightsExpiresAt < ttlExpiresAt) {
    throw new Error('Article manifest has an invalid source-rights retention bound');
  }
  if (sourceGeneratedAt > options.generatedAt) {
    throw new Error('Article manifest generation time is in the future');
  }
  if (sourceExpiresAt <= options.generatedAt) {
    throw new Error('Article manifest is expired; recollect or revalidate before matching');
  }
  verifyArticlesAgainstManifestSources({
    articles: options.articles,
    sourcesById,
    sourceGeneratedAt,
  });

  return {
    artifact: {
      relativePath: portableRelative(options.dataDirectory, manifestPath),
      sha256: sha256(manifestContent),
    },
    sourceExpiresAt,
  };
}

async function walkFiles(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (isObject(error) && error['code'] === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(path);
      }
      return entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

async function findLatestMspProfessionalInput(dataDirectory: string): Promise<string> {
  const root = join(dataDirectory, 'processed', 'msp', 'infotitulos');
  const matches = (await walkFiles(root))
    .filter((path) => basename(path) === 'professionals.ndjson')
    .sort((left, right) => right.localeCompare(left, 'en'));
  const selected = matches[0];
  if (selected === undefined) {
    throw new Error(
      'No MSP professionals.ndjson found. Run data:ingest:msp or set NEWS_PROFESSIONALS_PATH.',
    );
  }
  return selected;
}

async function findLatestNormalizedNewsArticlesInput(dataDirectory: string): Promise<string> {
  const root = join(dataDirectory, 'normalized', 'news');
  const manifestPaths = (await walkFiles(root)).filter(
    (path) => basename(path) === 'manifest.json',
  );
  const candidates = (
    await Promise.all(
      manifestPaths.map(async (manifestPath) => {
        try {
          const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
          if (!isObject(parsed) || typeof parsed['generatedAt'] !== 'string') {
            return undefined;
          }
          const generatedAt = Date.parse(parsed['generatedAt']);
          const outputs = parsed['outputs'];
          if (!Number.isFinite(generatedAt) || !isObject(outputs)) {
            return undefined;
          }
          const articles = outputs['articles'];
          if (!isObject(articles) || typeof articles['relativePath'] !== 'string') {
            return undefined;
          }
          const articlesPath = resolve(dataDirectory, articles['relativePath']);
          if (
            articlesPath !== join(dirname(manifestPath), 'articles.ndjson') ||
            !pathIsInside(root, articlesPath)
          ) {
            return undefined;
          }
          const metadata = await stat(articlesPath);
          return metadata.isFile()
            ? {
                articlesPath,
                generatedAt,
                manifestPath,
              }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((candidate) => candidate !== undefined)
    .sort(
      (left, right) =>
        right.generatedAt - left.generatedAt ||
        right.manifestPath.localeCompare(left.manifestPath, 'en'),
    );
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(
      'No normalized news articles.ndjson found. Run data:ingest:news-indexes or set NEWS_ARTICLES_PATH.',
    );
  }
  return selected.articlesPath;
}

function serializeNdjson(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

function validateCandidateOutput(candidates: readonly NewsLinkageCandidate[]): void {
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(`Duplicate generated candidate id: ${candidate.candidateId}`);
    }
    candidateIds.add(candidate.candidateId);
    const contextualCorroborationPresent =
      candidate.match.contextualCorroboration.matchedDimensions.length > 0;
    if (
      candidate.schemaVersion !== 2 ||
      candidate.state !== 'NEEDS_HUMAN_REVIEW' ||
      candidate.quarantine !== true ||
      candidate.linkageDecision.decision !== 'NOT_LINKED' ||
      candidate.linkageDecision.identityConfirmed !== false ||
      candidate.publicationDecision.decision !== 'NOT_PUBLISHED' ||
      candidate.publicationDecision.publicExportAllowed !== false ||
      candidate.safeguards.adverseFactInferred !== false ||
      candidate.safeguards.articleClaimsAcceptedAsFact !== false ||
      candidate.safeguards.automaticallyLinked !== false ||
      candidate.safeguards.automaticallyPublished !== false ||
      candidate.safeguards.contextualEvidenceIsIdentityProof !== false ||
      candidate.safeguards.missingContextTreatedAsContradiction !== false ||
      candidate.safeguards.nameOnlyEvidence !== !contextualCorroborationPresent ||
      candidate.safeguards.requiresHumanReview !== true
    ) {
      throw new Error(`Candidate ${candidate.candidateId} violates quarantine safeguards`);
    }
    if (
      !candidate.match.alert.codes.includes('POSSIBLE_IDENTITY_MATCH_NOT_CONFIRMED') ||
      !candidate.match.alert.codes.includes('HUMAN_REVIEW_REQUIRED') ||
      candidate.match.alert.message.trim().length === 0 ||
      (candidate.match.kind !== 'EXACT_NORMALIZED_NAME' &&
        !candidate.match.alert.codes.includes('FLEXIBLE_MATCH_HIGH_FALSE_POSITIVE_RISK'))
    ) {
      throw new Error(`Candidate ${candidate.candidateId} is missing mandatory match alerts`);
    }
    const rawPiiValues = [
      candidate.professional.displayName,
      candidate.article.headline,
      candidate.article.matchedMention,
      candidate.provenance.articleInput.canonicalUrl,
    ];
    if (rawPiiValues.some((value) => candidate.candidateId.includes(value))) {
      throw new Error(`Candidate ${candidate.candidateId} embeds raw source data`);
    }
  }
}

async function installAtomically(
  outputDirectory: string,
  candidatesContent: string,
  manifestContent: string,
): Promise<void> {
  const parent = dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  try {
    await stat(outputDirectory);
    throw new Error(`Refusing to overwrite existing news quarantine artifact: ${outputDirectory}`);
  } catch (error: unknown) {
    if (!(isObject(error) && error['code'] === 'ENOENT')) {
      throw error;
    }
  }

  const stagingDirectory = join(parent, `.${basename(outputDirectory)}.staging-${randomUUID()}`);
  if (!pathIsInside(parent, stagingDirectory)) {
    throw new Error('Unsafe news quarantine staging path');
  }
  await mkdir(stagingDirectory, { recursive: false });
  try {
    await Promise.all([
      writeFile(join(stagingDirectory, 'candidates.ndjson'), candidatesContent, {
        flag: 'wx',
      }),
      writeFile(join(stagingDirectory, 'manifest.json'), manifestContent, {
        flag: 'wx',
      }),
    ]);
    await rename(stagingDirectory, outputDirectory);
  } catch (error: unknown) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

export async function runNewsCandidateBuild(
  environment: NodeJS.ProcessEnv = process.env,
  options: RunNewsCandidateBuildOptions = {},
): Promise<{
  readonly candidatesPath: string;
  readonly manifestPath: string;
  readonly aggregates: NewsCandidateAggregates;
}> {
  const dataDirectory = await realpath(resolve(environment['DATA_INGESTION_DIR'] ?? 'data'));
  const professionalConfiguredPath = environment['NEWS_PROFESSIONALS_PATH']?.trim();
  const articleConfiguredPath = environment['NEWS_ARTICLES_PATH']?.trim();

  const professionalsPath = await resolveExistingPathInside(
    dataDirectory,
    professionalConfiguredPath === undefined || professionalConfiguredPath.length === 0
      ? await findLatestMspProfessionalInput(dataDirectory)
      : professionalConfiguredPath,
    'Professional input',
  );
  const articlesPath = await resolveExistingPathInside(
    dataDirectory,
    articleConfiguredPath === undefined || articleConfiguredPath.length === 0
      ? await findLatestNormalizedNewsArticlesInput(dataDirectory)
      : articleConfiguredPath,
    'Article input',
  );
  const [professionalsContent, articlesContent] = await Promise.all([
    readFile(professionalsPath),
    readFile(articlesPath),
  ]);
  const professionals = parseNdjsonContent(professionalsContent, parseFactualProfessional);
  const articles = parseNdjsonContent(articlesContent, parseNormalizedNewsArticle);
  if (professionals.length === 0) {
    throw new Error('Professional input is empty');
  }

  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const distinctProfessionalNames = createProfessionalNameIndex(
    professionals.map(({ displayName }) => displayName),
  ).distinctNames;
  const articleManifest = await loadAndVerifyArticleManifest({
    dataDirectory,
    professionalsPath,
    professionalsContent,
    professionalRecords: professionals.length,
    distinctProfessionalNames,
    articlesPath,
    articlesContent,
    articleRecords: articles.length,
    articles,
    environment,
    ...(environment['NEWS_ARTICLES_MANIFEST_PATH']?.trim()
      ? { configuredManifestPath: environment['NEWS_ARTICLES_MANIFEST_PATH']?.trim() }
      : {}),
    generatedAt,
  });
  const candidateExpiresAt = [newsCandidateExpiresAt(generatedAt), articleManifest.sourceExpiresAt]
    .sort()
    .at(0);
  if (candidateExpiresAt === undefined) {
    throw new Error('Could not determine news candidate expiration');
  }
  const professionalArtifact: ArtifactReference = {
    relativePath: portableRelative(dataDirectory, professionalsPath),
    sha256: sha256(professionalsContent),
  };
  const articleArtifact: ArtifactReference = {
    relativePath: portableRelative(dataDirectory, articlesPath),
    sha256: sha256(articlesContent),
  };
  const built = buildNewsCandidates({
    professionals,
    articles,
    professionalArtifact,
    articleArtifact,
    generatedAt,
    expiresAt: candidateExpiresAt,
  });
  validateCandidateOutput(built.candidates);
  const candidatesContent = serializeNdjson(built.candidates);
  parseNdjsonContent(
    candidatesContent.length === 0 ? Buffer.alloc(0) : Buffer.from(candidatesContent),
    (value) => {
      if (!isObject(value)) {
        throw new Error('Serialized news candidate is not an object');
      }
      return value;
    },
  );

  const artifactId = `news-quarantine-v2-${sha256(
    [
      NEWS_MATCHER_ALGORITHM_VERSION,
      professionalArtifact.sha256,
      articleArtifact.sha256,
      articleManifest.artifact.sha256,
    ].join('\u0000'),
  ).slice(0, 16)}`;
  const configuredOutputDirectory = environment['NEWS_CANDIDATES_OUTPUT_DIR']?.trim();
  const outputDirectory = resolveFuturePathInside(
    dataDirectory,
    configuredOutputDirectory === undefined || configuredOutputDirectory.length === 0
      ? join(dataDirectory, 'processed', 'news-linkage', artifactId)
      : configuredOutputDirectory,
    'News candidate output',
  );
  const candidatesPath = join(outputDirectory, 'candidates.ndjson');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const formats = [...new Set(professionals.map(({ input }) => input.format))].sort();
  const manifest: NewsCandidateManifest = {
    schemaVersion: 2,
    artifactId,
    algorithmVersion: NEWS_MATCHER_ALGORITHM_VERSION,
    generatedAt,
    inputs: {
      professionals: {
        ...professionalArtifact,
        records: professionals.length,
        formats,
      },
      articles: {
        ...articleArtifact,
        records: articles.length,
        schemaVersion: 1,
        manifest: articleManifest.artifact,
        sourceExpiresAt: articleManifest.sourceExpiresAt,
      },
    },
    outputs: {
      quarantineCandidates: {
        relativePath: portableRelative(dataDirectory, candidatesPath),
        records: built.candidates.length,
        sha256: sha256(candidatesContent),
      },
    },
    aggregates: built.aggregates,
    safeguards: {
      adverseFactsInferred: false,
      articleClaimsAcceptedAsFact: false,
      automaticallyLinked: false,
      automaticallyPublished: false,
      candidateIdsContainRawPii: false,
      contextualCorroborationUsed: true,
      deterministicFlexibleNameMatchingUsed: true,
      factsAutomaticallyConfirmed: false,
      fuzzyMatchingUsed: false,
      identityAutomaticallyConfirmed: false,
      missingContextTreatedAsContradiction: false,
      nameMatchingOnly: false,
      publicExportAllowed: false,
      quarantineOnly: true,
      rawArticleBodyPersisted: false,
      requiresHumanReview: true,
    },
    retention: {
      ttlDays: NEWS_CANDIDATE_RETENTION_DAYS,
      expiresAt: candidateExpiresAt,
      sourceExpiresAt: articleManifest.sourceExpiresAt,
      boundedBySourceExpiry: true,
      disposition: 'DELETE_OR_REVALIDATE',
    },
  };
  await installAtomically(
    outputDirectory,
    candidatesContent,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    candidatesPath,
    manifestPath,
    aggregates: built.aggregates,
  };
}

async function main(): Promise<void> {
  const result = await runNewsCandidateBuild();
  console.log(JSON.stringify({ event: 'news_candidates_completed', ...result }));
}

function loadOptionalDataEnvironment(): void {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error: unknown) {
    if (!(isObject(error) && error['code'] === 'ENOENT')) {
      throw error;
    }
  }
}

if (require.main === module) {
  loadOptionalDataEnvironment();
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
