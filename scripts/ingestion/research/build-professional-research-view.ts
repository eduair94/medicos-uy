import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildProfessionalResearchView,
  evaluateResearchPersonName,
  institutionalSourceRecordKey,
  type CuratedPublicReference,
  type ProfessionalResearchViewV1,
  type ResearchInstitutionalLinkageCandidate,
  type ResearchMspProfessional,
  type ResearchScheduleRecord,
  type WebEnrichmentCandidate,
} from '../../../packages/modules/discovery/src';

import { cmuEthicsBlockedCoverage } from './restricted-source-coverage';

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface ArtifactSelection {
  readonly content: Buffer;
  readonly path: string;
  readonly records: number;
  readonly sha256: string;
}

export interface MspSelection extends ArtifactSelection {
  readonly professionals: readonly ResearchMspProfessional[];
  readonly manifestContent: Buffer;
  readonly manifestPath: string;
}

export interface LinkageSelection extends ArtifactSelection {
  readonly candidates: readonly ResearchInstitutionalLinkageCandidate[];
  readonly manifest: UnknownRecord;
  readonly manifestContent: Buffer;
  readonly manifestPath: string;
}

export interface WebSelection {
  readonly candidates: readonly WebEnrichmentCandidate[];
  readonly candidatesPath: string;
  readonly content: Buffer;
  readonly manifestContent: Buffer;
  readonly manifestPath: string;
  readonly records: number;
  readonly sha256: string;
}

interface ParsedArguments {
  readonly query: {
    readonly mode: 'NAME' | 'OPAQUE_MSP_ID';
    readonly value: string;
  };
  readonly outputDirectory?: string;
  readonly referencesPath?: string;
}

export interface InputDescriptor {
  readonly relativePath: string;
  readonly records: number;
  readonly sha256: string;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredObject(record: UnknownRecord, key: string, context: string): UnknownRecord {
  const value = record[key];
  if (!isObject(value)) {
    throw new Error(`${context}.${key} must be an object`);
  }
  return value;
}

function requiredString(record: UnknownRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredStringArray(
  record: UnknownRecord,
  key: string,
  context: string,
  allowEmpty = false,
): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${context}.${key} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
  }
  return value.map((item) => (item as string).trim());
}

function requiredNonNegativeInteger(record: UnknownRecord, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context}.${key} must be a non-negative integer`);
  }
  return value;
}

function assertIsoInstant(value: string, context: string): void {
  if (!Number.isFinite(Date.parse(value)) || !value.includes('T')) {
    throw new Error(`${context} must be an ISO timestamp`);
  }
}

function assertIsoDate(value: string, context: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${context} must be an ISO date`);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function walk(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

function parseNdjson<T>(
  content: Buffer,
  parser: (value: unknown, rowNumber: number) => T | undefined,
): readonly T[] {
  const result: T[] = [];
  const lines = content.toString('utf8').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid NDJSON at row ${String(index + 1)}`, { cause: error });
    }
    const parsed = parser(value, index + 1);
    if (parsed !== undefined) {
      result.push(parsed);
    }
  }
  return result;
}

function parseMspProfessional(value: unknown, rowNumber: number): ResearchMspProfessional {
  const context = `MSP row ${String(rowNumber)}`;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  for (const forbidden of ['document', 'documento', 'cedula', 'cédula', 'ci']) {
    if (forbidden in value) {
      throw new Error(`${context} contains forbidden raw identity field ${forbidden}`);
    }
  }
  const linkageId = requiredString(value, 'linkageId', context);
  if (!/^msp_doc_v1_[a-f0-9]{64}$/u.test(linkageId)) {
    throw new Error(`${context}.linkageId is not an opaque MSP identifier`);
  }
  const enabledTitlesValue = value['enabledTitles'];
  if (!Array.isArray(enabledTitlesValue)) {
    throw new Error(`${context}.enabledTitles must be an array`);
  }
  const enabledTitles = enabledTitlesValue.map((title, index) => {
    const titleContext = `${context}.enabledTitles[${String(index)}]`;
    if (!isObject(title)) {
      throw new Error(`${titleContext} must be an object`);
    }
    const temporaryRegistration = title['temporaryRegistration'];
    if (!(temporaryRegistration === null || typeof temporaryRegistration === 'string')) {
      throw new Error(`${titleContext}.temporaryRegistration is invalid`);
    }
    return {
      title: requiredString(title, 'title', titleContext),
      recruiterCode: requiredString(title, 'recruiterCode', titleContext),
      temporaryRegistration,
    };
  });
  const provenance = requiredObject(value, 'provenance', context);
  const sourceCutoffDate = requiredString(provenance, 'sourceCutoffDate', `${context}.provenance`);
  assertIsoDate(sourceCutoffDate, `${context}.provenance.sourceCutoffDate`);
  return {
    linkageId,
    fullName: requiredString(value, 'fullName', context),
    enabledTitles,
    provenance: {
      publisher: requiredString(provenance, 'publisher', `${context}.provenance`),
      dataset: requiredString(provenance, 'dataset', `${context}.provenance`),
      sourceCutoffDate,
    },
  };
}

function parseLinkageCandidate(
  value: unknown,
  rowNumber: number,
): ResearchInstitutionalLinkageCandidate {
  const context = `linkage row ${String(rowNumber)}`;
  if (!isObject(value) || value['schemaVersion'] !== 2) {
    throw new Error(`${context} must use schemaVersion 2`);
  }
  if (value['publicationDecision'] !== 'not_merged' || value['requiresHumanReview'] !== true) {
    throw new Error(`${context} violates the fail-closed linkage decision`);
  }
  const status = value['status'];
  if (
    ![
      'ambiguous_exact_name',
      'exact_name_and_title_consistent',
      'exact_name_only',
      'unmatched',
    ].includes(typeof status === 'string' ? status : '')
  ) {
    throw new Error(`${context}.status is unsupported`);
  }
  const providerIdentity = requiredObject(value, 'providerIdentity', context);
  const basis = providerIdentity['basis'];
  if (!['institution_and_exact_name', 'source_professional_id'].includes(String(basis))) {
    throw new Error(`${context}.providerIdentity.basis is unsupported`);
  }
  const sourceProfessionalId = providerIdentity['sourceProfessionalId'];
  if (!(sourceProfessionalId === null || typeof sourceProfessionalId === 'string')) {
    throw new Error(`${context}.providerIdentity.sourceProfessionalId is invalid`);
  }
  const sourceRecordsValue = value['sourceRecords'];
  const mspCandidatesValue = value['mspCandidates'];
  if (!Array.isArray(sourceRecordsValue) || !Array.isArray(mspCandidatesValue)) {
    throw new Error(`${context} must contain sourceRecords and mspCandidates arrays`);
  }
  const sourceRecords = sourceRecordsValue.map((sourceRecord, index) => {
    if (!isObject(sourceRecord)) {
      throw new Error(`${context}.sourceRecords[${String(index)}] must be an object`);
    }
    return {
      sourceFile: requiredString(
        sourceRecord,
        'sourceFile',
        `${context}.sourceRecords[${String(index)}]`,
      ).replaceAll('\\', '/'),
      recordId: requiredString(
        sourceRecord,
        'recordId',
        `${context}.sourceRecords[${String(index)}]`,
      ),
    };
  });
  const mspCandidates = mspCandidatesValue.map((candidate, index) => {
    if (!isObject(candidate)) {
      throw new Error(`${context}.mspCandidates[${String(index)}] must be an object`);
    }
    return {
      linkageId: requiredString(
        candidate,
        'linkageId',
        `${context}.mspCandidates[${String(index)}]`,
      ),
      fullName: requiredString(candidate, 'fullName', `${context}.mspCandidates[${String(index)}]`),
      enabledTitles: requiredStringArray(
        candidate,
        'enabledTitles',
        `${context}.mspCandidates[${String(index)}]`,
        true,
      ),
    };
  });
  return {
    schemaVersion: 2,
    candidateId: requiredString(value, 'candidateId', context),
    status: status as ResearchInstitutionalLinkageCandidate['status'],
    publicationDecision: 'not_merged',
    providerIdentity: {
      institution: requiredString(providerIdentity, 'institution', `${context}.providerIdentity`),
      basis: basis as ResearchInstitutionalLinkageCandidate['providerIdentity']['basis'],
      sourceProfessionalId,
      normalizedName: requiredString(
        providerIdentity,
        'normalizedName',
        `${context}.providerIdentity`,
      ),
    },
    sourceDisplayNames: requiredStringArray(value, 'sourceDisplayNames', context),
    sourceRecords,
    sourceSpecialties: requiredStringArray(value, 'sourceSpecialties', context, true),
    mspCandidates,
    identityEvidence: requiredStringArray(value, 'identityEvidence', context, true),
    requiresHumanReview: true,
  };
}

function parseScheduleRecord(
  value: unknown,
  rowNumber: number,
): ResearchScheduleRecord | undefined {
  if (!isObject(value) || value['scheduleType'] !== 'published_consultation_roster') {
    return undefined;
  }
  const context = `schedule row ${String(rowNumber)}`;
  if (
    value['schemaVersion'] !== 1 ||
    value['appointmentAvailability'] !== 'not_observed' ||
    !Array.isArray(value['weeklySchedule'])
  ) {
    throw new Error(`${context} violates the published schedule contract`);
  }
  const source = requiredObject(value, 'source', context);
  const venue = requiredObject(value, 'venue', context);
  const evidence = requiredObject(value, 'evidence', context);
  const observedAt = requiredString(value, 'observedAt', context);
  assertIsoInstant(observedAt, `${context}.observedAt`);
  for (const [index, entry] of value['weeklySchedule'].entries()) {
    if (!isObject(entry)) {
      throw new Error(`${context}.weeklySchedule[${String(index)}] must be an object`);
    }
    requiredString(entry, 'dayOfWeek', `${context}.weeklySchedule[${String(index)}]`);
    requiredString(entry, 'sourceLabel', `${context}.weeklySchedule[${String(index)}]`);
    requiredString(entry, 'value', `${context}.weeklySchedule[${String(index)}]`);
  }
  requiredString(source, 'id', `${context}.source`);
  requiredString(source, 'institution', `${context}.source`);
  const sourceUrl = requiredString(source, 'url', `${context}.source`);
  if (!sourceUrl.startsWith('https://')) {
    throw new Error(`${context}.source.url must use HTTPS`);
  }
  requiredString(venue, 'name', `${context}.venue`);
  const rawSnapshotSha256 = requiredString(evidence, 'rawSnapshotSha256', `${context}.evidence`);
  if (!/^[a-f0-9]{64}$/u.test(rawSnapshotSha256)) {
    throw new Error(`${context}.evidence.rawSnapshotSha256 is invalid`);
  }
  requiredNonNegativeInteger(evidence, 'sourceRowNumber', `${context}.evidence`);
  requiredString(evidence, 'rawSnapshotPath', `${context}.evidence`);
  requiredString(value, 'recordId', context);
  requiredString(value, 'sourceProfessionalId', context);
  requiredString(value, 'sourceProfessionalLabel', context);
  requiredString(value, 'professionalName', context);
  requiredString(value, 'specialty', context);
  return value as unknown as ResearchScheduleRecord;
}

function parseWebCandidate(value: unknown, rowNumber: number, now: Date): WebEnrichmentCandidate {
  const context = `web candidate row ${String(rowNumber)}`;
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    value['state'] !== 'NEEDS_HUMAN_REVIEW' ||
    value['quarantine'] !== true
  ) {
    throw new Error(`${context} violates the quarantine contract`);
  }
  const linkage = requiredObject(value, 'linkageDecision', context);
  const fact = requiredObject(value, 'factDecision', context);
  const publication = requiredObject(value, 'publicationDecision', context);
  const retention = requiredObject(value, 'retention', context);
  if (
    linkage['decision'] !== 'NOT_LINKED' ||
    linkage['identityConfirmed'] !== false ||
    fact['factConfirmed'] !== false ||
    publication['decision'] !== 'NOT_PUBLISHED' ||
    publication['publicExportAllowed'] !== false
  ) {
    throw new Error(`${context} has an unsafe decision`);
  }
  const expiresAt = requiredString(retention, 'expiresAt', `${context}.retention`);
  assertIsoInstant(expiresAt, `${context}.retention.expiresAt`);
  if (Date.parse(expiresAt) < now.getTime()) {
    throw new Error(`${context} is expired and must be revalidated`);
  }
  requiredObject(value, 'subject', context);
  requiredObject(value, 'claim', context);
  requiredObject(value, 'match', context);
  requiredObject(value, 'provenance', context);
  return value as unknown as WebEnrichmentCandidate;
}

function containsForbiddenReferenceContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenReferenceContent(item));
  }
  if (!isObject(value)) {
    return false;
  }
  const forbiddenKeys = new Set(['body', 'content', 'html', 'rawText', 'snippet', 'quote']);
  return Object.entries(value).some(
    ([key, nested]) => forbiddenKeys.has(key) || containsForbiddenReferenceContent(nested),
  );
}

export function parseCuratedPublicReference(
  value: unknown,
  rowNumber: number,
): CuratedPublicReference {
  const context = `public reference row ${String(rowNumber)}`;
  if (!isObject(value) || value['schemaVersion'] !== 1) {
    throw new Error(`${context} must use schemaVersion 1`);
  }
  if (containsForbiddenReferenceContent(value)) {
    throw new Error(`${context} contains copied or raw source content`);
  }
  const referenceId = requiredString(value, 'referenceId', context);
  if (!/^public_reference_v1_[a-f0-9]{64}$/u.test(referenceId)) {
    throw new Error(`${context}.referenceId is invalid`);
  }
  const referenceKind = requiredString(value, 'referenceKind', context);
  if (
    ![
      'CRAWLED_SOURCE_METADATA',
      'PUBLIC_METADATA_REFERENCE',
      'MANUAL_REFERENCE_NO_AUTOMATED_FETCH',
      'CONTEXT_CORROBORATION_ONLY',
    ].includes(referenceKind)
  ) {
    throw new Error(`${context}.referenceKind is unsupported`);
  }
  const canonicalUrl = requiredString(value, 'canonicalUrl', context);
  const parsedUrl = new URL(canonicalUrl);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`${context}.canonicalUrl must use HTTPS`);
  }
  const observedNames = requiredStringArray(value, 'observedNames', context, true);
  const corroboratesReferenceIds = requiredStringArray(
    value,
    'corroboratesReferenceIds',
    context,
    true,
  );
  if (referenceKind === 'CONTEXT_CORROBORATION_ONLY') {
    if (observedNames.length !== 0 || corroboratesReferenceIds.length === 0) {
      throw new Error(`${context} context-only references must not name a person`);
    }
  } else if (observedNames.length === 0) {
    throw new Error(`${context} must contain at least one observed name`);
  }
  const claim = requiredObject(value, 'claim', context);
  const relationship = requiredString(claim, 'relationship', `${context}.claim`);
  if (
    ![
      'MEDICAL_STUDENT_PRESENTATION',
      'ACADEMIC_RESEARCH_COAUTHOR',
      'SPECIALTY_MONOGRAPH_POSTER_COAUTHOR',
      'RESEARCH_PROJECT_APPROVAL_CONTEXT',
    ].includes(relationship)
  ) {
    throw new Error(`${context}.claim.relationship is unsupported`);
  }
  requiredString(value, 'publisher', context);
  requiredString(value, 'title', context);
  requiredString(claim, 'factualSummary', `${context}.claim`);
  requiredStringArray(claim, 'institutionContext', `${context}.claim`, true);
  requiredStringArray(claim, 'doesNotEstablish', `${context}.claim`);
  const access = requiredObject(value, 'access', context);
  const accessMode = requiredString(access, 'mode', `${context}.access`);
  if (
    ![
      'ALLOWLISTED_PUBLIC_PAGE',
      'PUBLIC_METADATA_ONLY',
      'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH',
      'OFFICIAL_CONTEXT_DOCUMENT',
    ].includes(accessMode)
  ) {
    throw new Error(`${context}.access.mode is unsupported`);
  }
  if (access['contentStored'] !== false || typeof access['automatedFetchAllowed'] !== 'boolean') {
    throw new Error(`${context}.access must explicitly forbid stored content`);
  }
  requiredString(access, 'rightsNote', `${context}.access`);
  const decision = requiredObject(value, 'decision', context);
  if (
    decision['identityConfirmed'] !== false ||
    decision['factConfirmed'] !== false ||
    decision['linkageDecision'] !== 'NOT_LINKED' ||
    decision['publicationDecision'] !== 'NOT_PUBLISHED' ||
    decision['publicExportAllowed'] !== false ||
    decision['requiresHumanReview'] !== true
  ) {
    throw new Error(`${context}.decision must remain fail-closed`);
  }
  const isLinkedIn = ['linkedin.com', 'www.linkedin.com', 'es.linkedin.com'].includes(
    parsedUrl.hostname.toLowerCase(),
  );
  if (
    isLinkedIn &&
    (referenceKind !== 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH' ||
      access['automatedFetchAllowed'] !== false ||
      accessMode !== 'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH')
  ) {
    throw new Error(`${context} LinkedIn references must never authorize automated fetching`);
  }
  const sourceDate = requiredString(value, 'sourceDate', context);
  const sourceDatePrecision = requiredString(value, 'sourceDatePrecision', context);
  if (!['DAY', 'MONTH', 'YEAR'].includes(sourceDatePrecision)) {
    throw new Error(`${context}.sourceDatePrecision is unsupported`);
  }
  const validSourceDate =
    (sourceDatePrecision === 'DAY' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(sourceDate) &&
      Number.isFinite(Date.parse(`${sourceDate}T00:00:00Z`))) ||
    (sourceDatePrecision === 'MONTH' && /^\d{4}-\d{2}$/u.test(sourceDate)) ||
    (sourceDatePrecision === 'YEAR' && /^\d{4}$/u.test(sourceDate));
  if (!validSourceDate) {
    throw new Error(`${context}.sourceDate does not match its declared precision`);
  }
  return value as unknown as CuratedPublicReference;
}

function parseArguments(argv: readonly string[], environment: NodeJS.ProcessEnv): ParsedArguments {
  let name: string | undefined;
  let opaqueId: string | undefined;
  let outputDirectory = environment['PROFESSIONAL_RESEARCH_OUTPUT_DIR']?.trim();
  let referencesPath = environment['PROFESSIONAL_RESEARCH_REFERENCES_PATH']?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    const value = argv[index + 1];
    if (
      argument === '--name' ||
      argument === '--id' ||
      argument === '--output' ||
      argument === '--references'
    ) {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === '--name') {
        name = value.trim();
      } else if (argument === '--id') {
        opaqueId = value.trim();
      } else if (argument === '--output') {
        outputDirectory = value.trim();
      } else {
        referencesPath = value.trim();
      }
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${argument ?? ''}`);
  }
  if ((name === undefined) === (opaqueId === undefined)) {
    throw new Error('Exactly one of --name or --id is required');
  }
  if (name !== undefined && name.length < 3) {
    throw new Error('--name must contain at least three characters');
  }
  if (opaqueId !== undefined && !/^msp_doc_v1_[a-f0-9]{64}$/u.test(opaqueId)) {
    throw new Error('--id must be an opaque MSP linkage ID');
  }
  return {
    query:
      name === undefined
        ? { mode: 'OPAQUE_MSP_ID', value: opaqueId! }
        : { mode: 'NAME', value: name },
    ...(outputDirectory === undefined || outputDirectory.length === 0 ? {} : { outputDirectory }),
    ...(referencesPath === undefined || referencesPath.length === 0 ? {} : { referencesPath }),
  };
}

async function selectLatestManifest(
  root: string,
  timestamp: (manifest: UnknownRecord) => string | undefined,
): Promise<{
  readonly content: Buffer;
  readonly manifest: UnknownRecord;
  readonly path: string;
}> {
  const candidates = await Promise.all(
    (await walk(root))
      .filter((path) => basename(path) === 'manifest.json')
      .map(async (path) => {
        const content = await readFile(path);
        const value: unknown = JSON.parse(content.toString('utf8'));
        if (!isObject(value)) {
          return undefined;
        }
        const key = timestamp(value);
        return key === undefined ? undefined : { content, manifest: value, path, key };
      }),
  );
  const selected = candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .sort((left, right) => right.key.localeCompare(left.key))[0];
  if (selected === undefined) {
    throw new Error(`No compatible manifest found under ${root}`);
  }
  return selected;
}

async function validatedArtifact(
  dataDirectory: string,
  descriptor: UnknownRecord,
  context: string,
): Promise<ArtifactSelection> {
  const relativePath = requiredString(descriptor, 'relativePath', context).replaceAll('\\', '/');
  const path = resolve(dataDirectory, relativePath);
  if (!isPathInside(dataDirectory, path)) {
    throw new Error(`${context}.relativePath escapes DATA_INGESTION_DIR`);
  }
  const content = await readFile(path);
  const expectedSha256 = requiredString(descriptor, 'sha256', context);
  const expectedRecords = requiredNonNegativeInteger(descriptor, 'records', context);
  const actualSha256 = sha256(content);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${context} hash mismatch`);
  }
  const actualRecords = content
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0).length;
  if (actualRecords !== expectedRecords) {
    throw new Error(`${context} record count mismatch`);
  }
  return {
    content,
    path,
    records: actualRecords,
    sha256: actualSha256,
  };
}

export async function loadMspSelection(
  dataDirectory: string,
  configuredPath: string | undefined,
): Promise<MspSelection> {
  const selectedManifest = await selectLatestManifest(
    join(dataDirectory, 'processed', 'msp', 'infotitulos'),
    (manifest) => {
      if (manifest['schemaVersion'] !== 1) {
        return undefined;
      }
      const source = manifest['source'];
      return isObject(source) && typeof source['sourceCutoffDate'] === 'string'
        ? source['sourceCutoffDate']
        : undefined;
    },
  );
  const outputs = requiredObject(selectedManifest.manifest, 'outputs', 'MSP manifest');
  const descriptor = requiredObject(outputs, 'professionals', 'MSP manifest.outputs');
  if (configuredPath !== undefined) {
    const configured = resolve(configuredPath);
    const expected = resolve(
      dataDirectory,
      requiredString(descriptor, 'relativePath', 'MSP professionals descriptor'),
    );
    if (configured !== expected) {
      throw new Error('Configured MSP path does not match the selected latest manifest');
    }
  }
  const artifact = await validatedArtifact(
    dataDirectory,
    descriptor,
    'MSP professionals descriptor',
  );
  return {
    ...artifact,
    professionals: parseNdjson(artifact.content, parseMspProfessional),
    manifestContent: selectedManifest.content,
    manifestPath: selectedManifest.path,
  };
}

export async function loadLinkageSelection(
  dataDirectory: string,
  configuredPath: string | undefined,
): Promise<LinkageSelection> {
  const selectedManifest = await selectLatestManifest(
    join(dataDirectory, 'processed', 'linkage'),
    (manifest) =>
      manifest['schemaVersion'] === 2 &&
      manifest['algorithmVersion'] === 'exact-full-name-candidates-v3' &&
      typeof manifest['createdAt'] === 'string'
        ? manifest['createdAt']
        : undefined,
  );
  const safeguards = requiredObject(selectedManifest.manifest, 'safeguards', 'linkage manifest');
  if (
    safeguards['fuzzyMatchingUsed'] !== false ||
    safeguards['automaticallyMerged'] !== false ||
    safeguards['rawGovernmentIdentifiersPublished'] !== false
  ) {
    throw new Error('Linkage manifest violates fail-closed safeguards');
  }
  const descriptor = requiredObject(selectedManifest.manifest, 'output', 'linkage manifest');
  if (configuredPath !== undefined) {
    const configured = resolve(configuredPath);
    const expected = resolve(
      dataDirectory,
      requiredString(descriptor, 'relativePath', 'linkage output descriptor'),
    );
    if (configured !== expected) {
      throw new Error('Configured linkage path does not match the selected latest manifest');
    }
  }
  const artifact = await validatedArtifact(dataDirectory, descriptor, 'linkage output descriptor');
  return {
    ...artifact,
    candidates: parseNdjson(artifact.content, parseLinkageCandidate),
    manifest: selectedManifest.manifest,
    manifestContent: selectedManifest.content,
    manifestPath: selectedManifest.path,
  };
}

export async function loadWebSelection(
  dataDirectory: string,
  now: Date,
): Promise<WebSelection | undefined> {
  const webRoot = join(dataDirectory, 'processed', 'web-enrichment');
  if ((await walk(webRoot)).every((path) => basename(path) !== 'manifest.json')) {
    return undefined;
  }
  const selectedManifest = await selectLatestManifest(webRoot, (manifest) =>
    manifest['schemaVersion'] === 1 &&
    manifest['artifactKind'] === 'WEB_ENRICHMENT_INTERNAL_QUARANTINE' &&
    typeof manifest['generatedAt'] === 'string'
      ? manifest['generatedAt']
      : undefined,
  );
  const safeguards = requiredObject(selectedManifest.manifest, 'safeguards', 'web manifest');
  if (
    safeguards['automaticIdentityConfirmation'] !== false ||
    safeguards['automaticFactConfirmation'] !== false ||
    safeguards['automaticPublication'] !== false ||
    safeguards['publicExportAllowed'] !== false ||
    safeguards['noFindingsProvesAbsence'] !== false
  ) {
    throw new Error('Web manifest violates fail-closed safeguards');
  }
  const outputs = requiredObject(selectedManifest.manifest, 'outputs', 'web manifest');
  const descriptor = requiredObject(outputs, 'candidates', 'web manifest.outputs');
  const relativePath = requiredString(descriptor, 'relativePath', 'web candidates descriptor');
  const candidatesPath = resolve(dirname(selectedManifest.path), relativePath);
  if (!isPathInside(dataDirectory, candidatesPath)) {
    throw new Error('Web candidates path escapes DATA_INGESTION_DIR');
  }
  const content = await readFile(candidatesPath);
  const expectedSha256 = requiredString(descriptor, 'sha256', 'web candidates descriptor');
  const expectedRecords = requiredNonNegativeInteger(
    descriptor,
    'records',
    'web candidates descriptor',
  );
  const candidates = parseNdjson(content, (value, rowNumber) =>
    parseWebCandidate(value, rowNumber, now),
  );
  if (sha256(content) !== expectedSha256 || candidates.length !== expectedRecords) {
    throw new Error('Web candidates do not match their manifest');
  }
  return {
    candidates,
    candidatesPath,
    content,
    manifestContent: selectedManifest.content,
    manifestPath: selectedManifest.path,
    records: candidates.length,
    sha256: expectedSha256,
  };
}

export async function loadSchedules(
  dataDirectory: string,
  linkage: LinkageSelection,
  relevantCandidates: readonly ResearchInstitutionalLinkageCandidate[],
): Promise<{
  readonly descriptors: readonly InputDescriptor[];
  readonly schedules: ReadonlyMap<string, ResearchScheduleRecord>;
}> {
  const inputValues = linkage.manifest['inputs'];
  if (!Array.isArray(inputValues)) {
    throw new Error('Linkage manifest.inputs must be an array');
  }
  const inputByPath = new Map<string, UnknownRecord>();
  for (const input of inputValues) {
    if (!isObject(input)) {
      throw new Error('Linkage manifest input must be an object');
    }
    inputByPath.set(
      requiredString(input, 'relativePath', 'linkage input').replaceAll('\\', '/'),
      input,
    );
  }
  const requiredRecordsByPath = new Map<string, Set<string>>();
  for (const sourceRecord of relevantCandidates.flatMap(({ sourceRecords }) => sourceRecords)) {
    const sourceFile = sourceRecord.sourceFile.replaceAll('\\', '/');
    const recordIds = requiredRecordsByPath.get(sourceFile) ?? new Set<string>();
    recordIds.add(sourceRecord.recordId);
    requiredRecordsByPath.set(sourceFile, recordIds);
  }

  const schedules = new Map<string, ResearchScheduleRecord>();
  const descriptors: InputDescriptor[] = [];
  for (const [sourceFile, requiredRecordIds] of [...requiredRecordsByPath].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const input = inputByPath.get(sourceFile);
    if (input === undefined) {
      throw new Error(`Source record file ${sourceFile} is absent from the linkage manifest`);
    }
    const artifact = await validatedArtifact(dataDirectory, input, `linkage input ${sourceFile}`);
    descriptors.push({
      relativePath: sourceFile,
      records: artifact.records,
      sha256: artifact.sha256,
    });
    const parsedSchedules = parseNdjson(artifact.content, parseScheduleRecord);
    for (const schedule of parsedSchedules) {
      if (requiredRecordIds.has(schedule.recordId)) {
        schedules.set(institutionalSourceRecordKey(sourceFile, schedule.recordId), schedule);
      }
    }
  }
  return { descriptors, schedules };
}

export async function loadReferences(
  dataDirectory: string,
  configuredPath: string | undefined,
): Promise<{
  readonly content?: Buffer;
  readonly path?: string;
  readonly references: readonly CuratedPublicReference[];
}> {
  const path = resolve(
    configuredPath ?? join(dataDirectory, 'curation', 'professional-public-references.ndjson'),
  );
  if (!isPathInside(dataDirectory, path)) {
    throw new Error('Professional reference ledger must stay inside DATA_INGESTION_DIR');
  }
  try {
    const content = await readFile(path);
    const references = parseNdjson(content, parseCuratedPublicReference);
    const ids = references.map(({ referenceId }) => referenceId);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Professional reference ledger contains duplicate reference IDs');
    }
    const knownIds = new Set(ids);
    for (const reference of references) {
      if (reference.corroboratesReferenceIds.some((id) => !knownIds.has(id))) {
        throw new Error(`${reference.referenceId} corroborates an unknown reference`);
      }
    }
    return { content, path, references };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && configuredPath === undefined) {
      return { references: [] };
    }
    throw error;
  }
}

async function installOutput(
  dataDirectory: string,
  requestedOutputDirectory: string | undefined,
  view: ProfessionalResearchViewV1,
  manifest: UnknownRecord,
): Promise<{ readonly manifestPath: string; readonly viewPath: string }> {
  const suffix = `${view.generatedAt.replaceAll(/[^0-9]/gu, '').slice(0, 17)}-${view.reportId.slice(-16)}`;
  const outputDirectory = resolve(
    requestedOutputDirectory ??
      join(dataDirectory, 'processed', 'professional-research', `research-v1-${suffix}`),
  );
  if (!isPathInside(dataDirectory, outputDirectory)) {
    throw new Error('Professional research output must stay inside DATA_INGESTION_DIR');
  }
  const temporaryDirectory = `${outputDirectory}.tmp-${randomUUID()}`;
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  try {
    await Promise.all([
      writeFile(
        join(temporaryDirectory, 'professional-research-view.json'),
        `${JSON.stringify(view, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      ),
      writeFile(
        join(temporaryDirectory, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        },
      ),
    ]);
    await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
    await rename(temporaryDirectory, outputDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await stat(outputDirectory);
      if (existing.isDirectory()) {
        throw new Error(`Research output already exists: ${outputDirectory}`, { cause: error });
      }
    }
    throw error;
  }
  return {
    manifestPath: join(outputDirectory, 'manifest.json'),
    viewPath: join(outputDirectory, 'professional-research-view.json'),
  };
}

export async function runProfessionalResearchView(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  now = new Date(),
): Promise<{
  readonly manifestPath: string;
  readonly view: ProfessionalResearchViewV1;
  readonly viewPath: string;
}> {
  const argumentsValue = parseArguments(argv, environment);
  const dataDirectory = await realpath(resolve(environment['DATA_INGESTION_DIR'] ?? 'data'));
  const [msp, linkage, web, references] = await Promise.all([
    loadMspSelection(dataDirectory, environment['PROFESSIONAL_RESEARCH_MSP_PATH']?.trim()),
    loadLinkageSelection(dataDirectory, environment['PROFESSIONAL_RESEARCH_LINKAGE_PATH']?.trim()),
    loadWebSelection(dataDirectory, now),
    loadReferences(dataDirectory, argumentsValue.referencesPath),
  ]);
  const relevantMspIds = new Set(
    argumentsValue.query.mode === 'OPAQUE_MSP_ID'
      ? [argumentsValue.query.value]
      : (() => {
          const matched = msp.professionals.flatMap((professional) => {
            const match = evaluateResearchPersonName(
              professional.fullName,
              argumentsValue.query.value,
            );
            return match === null ? [] : [{ professional, match }];
          });
          const bestFlexibility = Math.min(...matched.map(({ match }) => match.flexibilityIndex));
          return matched
            .filter(({ match }) => match.flexibilityIndex === bestFlexibility)
            .map(({ professional }) => professional.linkageId);
        })(),
  );
  const relevantLinkageCandidates = linkage.candidates.filter(({ mspCandidates }) =>
    mspCandidates.some(({ linkageId }) => relevantMspIds.has(linkageId)),
  );
  const scheduleInput = await loadSchedules(dataDirectory, linkage, relevantLinkageCandidates);
  const inputFingerprint = sha256(
    JSON.stringify({
      query: argumentsValue.query,
      msp: msp.sha256,
      linkage: linkage.sha256,
      schedules: scheduleInput.descriptors,
      web: web?.sha256 ?? null,
      references: references.content === undefined ? null : sha256(references.content),
    }),
  );
  const reportId = `professional_research_v1_${inputFingerprint}`;
  const view = buildProfessionalResearchView({
    reportId,
    generatedAt: now.toISOString(),
    query: argumentsValue.query,
    mspProfessionals: msp.professionals,
    institutionalLinkageCandidates: linkage.candidates,
    schedulesBySourceRecord: scheduleInput.schedules,
    webCandidates: web?.candidates ?? [],
    publicReferences: references.references,
    sourceCoverage: [cmuEthicsBlockedCoverage()],
    checkedScheduleArtifacts: scheduleInput.descriptors.length,
    webEnrichmentSnapshotChecked: web !== undefined,
    curatedReferenceLedgerChecked: references.content !== undefined,
  });
  const viewContent = `${JSON.stringify(view, null, 2)}\n`;
  const manifest: UnknownRecord = {
    schemaVersion: 1,
    artifactKind: 'INTERNAL_PROFESSIONAL_RESEARCH_VIEW',
    reportId,
    generatedAt: now.toISOString(),
    query: {
      mode: argumentsValue.query.mode,
      normalizedInput: view.query.normalized,
    },
    inputs: {
      msp: {
        relativePath: portableRelative(dataDirectory, msp.path),
        records: msp.records,
        sha256: msp.sha256,
        manifestRelativePath: portableRelative(dataDirectory, msp.manifestPath),
        manifestSha256: sha256(msp.manifestContent),
      },
      linkage: {
        relativePath: portableRelative(dataDirectory, linkage.path),
        records: linkage.records,
        sha256: linkage.sha256,
        manifestRelativePath: portableRelative(dataDirectory, linkage.manifestPath),
        manifestSha256: sha256(linkage.manifestContent),
      },
      schedules: scheduleInput.descriptors,
      web:
        web === undefined
          ? null
          : {
              relativePath: portableRelative(dataDirectory, web.candidatesPath),
              records: web.records,
              sha256: web.sha256,
              manifestRelativePath: portableRelative(dataDirectory, web.manifestPath),
              manifestSha256: sha256(web.manifestContent),
            },
      publicReferences:
        references.content === undefined || references.path === undefined
          ? null
          : {
              relativePath: portableRelative(dataDirectory, references.path),
              records: references.references.length,
              sha256: sha256(references.content),
            },
    },
    output: {
      relativePath: 'professional-research-view.json',
      records: 1,
      sha256: sha256(viewContent),
    },
    safeguards: {
      rawGovernmentIdentifiersPresent: false,
      sourceHtmlStoredInReport: false,
      linkedinAutomaticallyFetched: false,
      canonicalUrlsIncludedForPrivateApi: true,
      privateApiDeliveryAllowed: true,
      publicApiDeliveryAllowed: false,
      automaticIdentityConfirmation: false,
      automaticFactConfirmation: false,
      automaticLinkage: false,
      automaticPublication: false,
      publicExportAllowed: false,
      noFindingsProvesAbsence: false,
    },
  };
  const installed = await installOutput(
    dataDirectory,
    argumentsValue.outputDirectory,
    view,
    manifest,
  );
  return { ...installed, view };
}

async function main(): Promise<void> {
  const result = await runProfessionalResearchView();
  console.log(
    JSON.stringify({
      event: 'professional_research_view_completed',
      reportId: result.view.reportId,
      candidates: result.view.candidates.length,
      ambiguity: result.view.query.ambiguity,
      manifestPath: result.manifestPath,
      viewPath: result.viewPath,
      privateApiDeliveryAllowed: result.view.delivery.privateApiDeliveryAllowed,
      canonicalUrlsIncluded: result.view.delivery.canonicalUrlsIncluded,
      publicExportAllowed: false,
    }),
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
