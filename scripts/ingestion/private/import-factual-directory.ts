import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { config as loadEnvironment } from 'dotenv';
import { Client } from 'pg';

import { normalizePersonName } from '../linkage/normalize-person-name';

import type {
  PrivateOfficialRegistry,
  PrivateRegisteredTitle,
} from '../../../drizzle/ingestion-private/schema';

loadEnvironment({
  quiet: true,
});

export const PRIVATE_IMPORT_APPROVAL = 'IMPORT_TO_PRIVATE_STAGING_ONLY';

const FACTUAL_NOTICE_VERSION = 'uy-medical-directory-factual-v3';
const SNAPSHOT_ID_PATTERN = /^factual-v3-[0-9a-f]{16}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INTERNAL_HMAC_ID_PATTERN = /^msp_doc_v1_[0-9a-f]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_NDJSON_LINE_LENGTH = 1_000_000;
const ADVISORY_LOCK_NAMESPACE = 1_834_104;
const ADVISORY_LOCK_RESOURCE = 104_234_204;
const REQUIRED_DATABASE_USER = 'medicos_private_ingestor';
const REQUIRED_DATABASE_NAME = 'medicos_catalog';
const ALLOWED_PROFILE_KEYS = [
  'schemaVersion',
  'internalLinkageId',
  'displayName',
  'enabledTitles',
  'registeredTitles',
  'officialRegistry',
  'linkageReview',
  'notice',
  'publication',
] as const;
const ALLOWED_REGISTERED_TITLE_KEYS = ['title', 'temporaryRegistration'] as const;
const ALLOWED_OFFICIAL_REGISTRY_KEYS = [
  'publisher',
  'dataset',
  'sourceCutoffDate',
  'datasetUrl',
  'liveLookupUrl',
] as const;
const FORBIDDEN_RAW_IDENTIFIER_KEYS = new Set([
  'cedula',
  'cedulaidentidad',
  'document',
  'documentid',
  'documentnumber',
  'documento',
  'documentonumero',
  'dni',
  'governmentid',
  'governmentidentifier',
  'identificationnumber',
  'licensenumber',
  'pasaporte',
  'passport',
  'rawgovernmentid',
  'rawgovernmentidentifier',
  'rawid',
  'rawidentifier',
  'registryid',
  'registryidentifier',
  'registrynumber',
]);

type UnknownRecord = Record<string, unknown>;

interface FactualDirectoryManifest {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly noticeVersion: typeof FACTUAL_NOTICE_VERSION;
  readonly outputs: {
    readonly profiles: {
      readonly relativePath: string;
      readonly records: number;
      readonly sha256: string;
    };
  };
  readonly aggregates: {
    readonly mspProfiles: number;
  };
  readonly safeguards: {
    readonly internalLinkageIdsPresent: true;
    readonly publicExportAllowed: false;
    readonly rawGovernmentIdentifiersPublished: false;
  };
  readonly publicationGate: {
    readonly state: 'blocked';
  };
}

export interface PrivateDirectoryImportConfiguration {
  readonly approval: typeof PRIVATE_IMPORT_APPROVAL;
  readonly expectedSnapshotId: string;
  readonly expectedManifestSha256: string;
  readonly manifestPath: string;
  readonly dataRoot: string;
  readonly databaseUrl: string;
  readonly databaseCa: string;
  readonly batchSize: number;
}

export interface PreparedPrivateDirectorySnapshot {
  readonly snapshotId: string;
  readonly manifestSha256: string;
  readonly profilesSha256: string;
  readonly profileCount: number;
  readonly sourceGeneratedAt: Date;
  readonly manifestPath: string;
  readonly profilesPath: string;
}

export interface PrivateProfessionalProfileRow {
  readonly internalHmacId: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly registeredTitles: readonly PrivateRegisteredTitle[];
  readonly officialRegistry: PrivateOfficialRegistry;
  readonly recordSha256: string;
}

export interface PrivateImportResult {
  readonly status: 'imported' | 'already_imported';
  readonly snapshotId: string;
  readonly profileCount: number;
  readonly manifestSha256: string;
  readonly profilesSha256: string;
}

interface SqlQueryResult<Row extends UnknownRecord = UnknownRecord> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PrivateImportConnection {
  query<Row extends UnknownRecord = UnknownRecord>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

interface ExistingSnapshotRow extends UnknownRecord {
  readonly manifest_sha256: string;
  readonly profiles_sha256: string;
  readonly profile_count: number;
  readonly source_generated_at: Date | string;
}

interface CountRow extends UnknownRecord {
  readonly profile_count: number;
}

interface ExistingProfileHashRow extends UnknownRecord {
  readonly internal_hmac_id: string;
  readonly display_name: string;
  readonly normalized_name: string;
  readonly registered_titles: unknown;
  readonly official_registry: unknown;
  readonly record_sha256: string;
}

interface ImportRoleRow extends UnknownRecord {
  readonly database_name: string;
  readonly role_name: string;
  readonly rolsuper: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
  readonly rolbypassrls: boolean;
  readonly membership_count: number;
  readonly owns_database: boolean;
  readonly owns_schema: boolean;
  readonly owns_relation: boolean;
  readonly owns_function: boolean;
  readonly has_temp: boolean;
  readonly can_create_public: boolean;
  readonly can_use_private_schema: boolean;
  readonly can_select_private_snapshot: boolean;
  readonly can_insert_private_snapshot: boolean;
  readonly can_select_private_profile: boolean;
  readonly can_insert_private_profile: boolean;
  readonly has_forbidden_private_privileges: boolean;
  readonly has_public_catalog_privileges: boolean;
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parseBatchSize(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 500;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error('PRIVATE_DIRECTORY_IMPORT_BATCH_SIZE must be an integer from 1 to 1000.');
  }

  return parsed;
}

function databaseUrlAndUser(value: string): {
  readonly databaseUrl: string;
  readonly user: string;
} {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PRIVATE_INGESTION_DATABASE_URL must be a valid PostgreSQL URL.');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('PRIVATE_INGESTION_DATABASE_URL must use postgresql:// or postgres://.');
  }

  if (
    parsed.username.length === 0 ||
    parsed.password.length === 0 ||
    parsed.hostname.length === 0
  ) {
    throw new Error(
      'PRIVATE_INGESTION_DATABASE_URL must include an explicit host, username, and password.',
    );
  }

  if ([...parsed.searchParams].length > 0 || parsed.hash.length > 0) {
    throw new Error(
      'PRIVATE_INGESTION_DATABASE_URL must not contain query parameters or a fragment; TLS and client options are configured separately.',
    );
  }

  const user = decodeURIComponent(parsed.username);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));

  if (user !== REQUIRED_DATABASE_USER) {
    throw new Error(`Private imports require the ${REQUIRED_DATABASE_USER} database role.`);
  }

  if (databaseName !== REQUIRED_DATABASE_NAME) {
    throw new Error(`Private imports require the ${REQUIRED_DATABASE_NAME} database.`);
  }

  return {
    databaseUrl: value,
    user,
  };
}

export async function loadPrivateDirectoryImportConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PrivateDirectoryImportConfiguration> {
  const approval = requiredEnvironmentValue(environment, 'PRIVATE_DIRECTORY_IMPORT_APPROVAL');

  if (approval !== PRIVATE_IMPORT_APPROVAL) {
    throw new Error(
      `Private import refused. Set PRIVATE_DIRECTORY_IMPORT_APPROVAL=${PRIVATE_IMPORT_APPROVAL}.`,
    );
  }

  const expectedSnapshotId = requiredEnvironmentValue(
    environment,
    'PRIVATE_DIRECTORY_EXPECTED_SNAPSHOT_ID',
  );

  if (!SNAPSHOT_ID_PATTERN.test(expectedSnapshotId)) {
    throw new Error('PRIVATE_DIRECTORY_EXPECTED_SNAPSHOT_ID is not a factual-v3 snapshot ID.');
  }

  const expectedManifestSha256 = requiredEnvironmentValue(
    environment,
    'PRIVATE_DIRECTORY_EXPECTED_MANIFEST_SHA256',
  );

  if (!SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new Error('PRIVATE_DIRECTORY_EXPECTED_MANIFEST_SHA256 must be lowercase SHA-256.');
  }

  const { databaseUrl } = databaseUrlAndUser(
    requiredEnvironmentValue(environment, 'PRIVATE_INGESTION_DATABASE_URL'),
  );
  const caPath = requiredEnvironmentValue(environment, 'PRIVATE_INGESTION_DATABASE_SSL_CA_PATH');
  const databaseCa = await readFile(resolve(caPath), 'utf8');
  const configuredDataRoot = environment['DATA_INGESTION_DIR']?.trim();

  if (
    !databaseCa.includes('-----BEGIN CERTIFICATE-----') ||
    !databaseCa.includes('-----END CERTIFICATE-----')
  ) {
    throw new Error('PRIVATE_INGESTION_DATABASE_SSL_CA_PATH is not a PEM certificate.');
  }

  return {
    approval: PRIVATE_IMPORT_APPROVAL,
    expectedSnapshotId,
    expectedManifestSha256,
    manifestPath: resolve(requiredEnvironmentValue(environment, 'PRIVATE_DIRECTORY_MANIFEST_PATH')),
    dataRoot: resolve(
      configuredDataRoot === undefined || configuredDataRoot.length === 0
        ? 'data'
        : configuredDataRoot,
    ),
    databaseUrl,
    databaseCa,
    batchSize: parseBatchSize(environment['PRIVATE_DIRECTORY_IMPORT_BATCH_SIZE']),
  };
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(',')}]`;
  }

  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  throw new Error('Stored private snapshot contains a non-JSON value.');
}

function requiredObject(value: unknown, label: string): UnknownRecord {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requiredString(
  value: unknown,
  label: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  if (value.length > maximumLength) {
    throw new Error(`${label} exceeds ${String(maximumLength)} characters.`);
  }

  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value as number;
}

function requiredIsoTimestamp(value: unknown, label: string): Date {
  const text = requiredString(value, label);
  const parsed = new Date(text);

  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  }

  return parsed;
}

function assertExactKeys(
  value: UnknownRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} contains unexpected or missing keys.`);
  }
}

function normalizedIdentifierKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function assertNoRawIdentifierKeys(value: unknown, path = 'profile'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertNoRawIdentifierKeys(child, `${path}[${String(index)}]`);
    });
    return;
  }

  if (!isObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RAW_IDENTIFIER_KEYS.has(normalizedIdentifierKey(key))) {
      throw new Error(`${path}.${key} is a forbidden raw identifier field.`);
    }

    assertNoRawIdentifierKeys(child, `${path}.${key}`);
  }
}

function parseManifest(value: unknown): FactualDirectoryManifest {
  const manifest = requiredObject(value, 'manifest');

  if (manifest['schemaVersion'] !== 2) {
    throw new Error('Only factual directory manifest schemaVersion 2 is accepted.');
  }

  const snapshotId = requiredString(manifest['snapshotId'], 'manifest.snapshotId', 120);

  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error('manifest.snapshotId is not a factual-v3 snapshot ID.');
  }

  if (manifest['noticeVersion'] !== FACTUAL_NOTICE_VERSION) {
    throw new Error(`manifest.noticeVersion must be ${FACTUAL_NOTICE_VERSION}.`);
  }

  const generatedAt = requiredString(manifest['generatedAt'], 'manifest.generatedAt');
  requiredIsoTimestamp(generatedAt, 'manifest.generatedAt');

  const outputs = requiredObject(manifest['outputs'], 'manifest.outputs');
  const profiles = requiredObject(outputs['profiles'], 'manifest.outputs.profiles');
  const relativePath = requiredString(
    profiles['relativePath'],
    'manifest.outputs.profiles.relativePath',
  );
  const records = requiredNonNegativeInteger(
    profiles['records'],
    'manifest.outputs.profiles.records',
  );
  const profilesSha256 = requiredString(profiles['sha256'], 'manifest.outputs.profiles.sha256');

  if (!SHA256_PATTERN.test(profilesSha256)) {
    throw new Error('manifest.outputs.profiles.sha256 must be lowercase SHA-256.');
  }

  const aggregates = requiredObject(manifest['aggregates'], 'manifest.aggregates');
  const mspProfiles = requiredNonNegativeInteger(
    aggregates['mspProfiles'],
    'manifest.aggregates.mspProfiles',
  );

  if (mspProfiles !== records) {
    throw new Error('manifest profile counts disagree.');
  }

  const safeguards = requiredObject(manifest['safeguards'], 'manifest.safeguards');

  if (safeguards['publicExportAllowed'] !== false) {
    throw new Error('Private import refused because publicExportAllowed is not false.');
  }

  if (safeguards['rawGovernmentIdentifiersPublished'] !== false) {
    throw new Error(
      'Private import refused because rawGovernmentIdentifiersPublished is not false.',
    );
  }

  if (safeguards['internalLinkageIdsPresent'] !== true) {
    throw new Error('Private import requires internal HMAC linkage IDs.');
  }

  const publicationGate = requiredObject(manifest['publicationGate'], 'manifest.publicationGate');

  if (publicationGate['state'] !== 'blocked') {
    throw new Error('Private import requires a blocked publication gate.');
  }

  return {
    schemaVersion: 2,
    snapshotId,
    generatedAt,
    noticeVersion: FACTUAL_NOTICE_VERSION,
    outputs: {
      profiles: {
        relativePath,
        records,
        sha256: profilesSha256,
      },
    },
    aggregates: {
      mspProfiles,
    },
    safeguards: {
      internalLinkageIdsPresent: true,
      publicExportAllowed: false,
      rawGovernmentIdentifiersPublished: false,
    },
    publicationGate: {
      state: 'blocked',
    },
  };
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

function portableRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(filePath)) {
    const binaryChunk: unknown = chunk;

    if (!(binaryChunk instanceof Uint8Array)) {
      throw new Error('File stream produced an unexpected non-binary chunk.');
    }

    hash.update(binaryChunk);
  }

  return hash.digest('hex');
}

async function countNdjsonRecords(filePath: string): Promise<number> {
  const lines = createInterface({
    input: createReadStream(filePath, {
      encoding: 'utf8',
    }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let count = 0;

  try {
    for await (const line of lines) {
      if (line.length === 0) {
        throw new Error(`NDJSON contains a blank record at line ${String(count + 1)}.`);
      }

      if (line.length > MAX_NDJSON_LINE_LENGTH) {
        throw new Error(`NDJSON line ${String(count + 1)} exceeds the safety limit.`);
      }

      parsePrivateProfessionalProfileLine(line, count + 1);
      count += 1;
    }
  } finally {
    lines.close();
  }

  return count;
}

async function inspectProfilesFile(
  filePath: string,
): Promise<{ readonly sha256: string; readonly records: number }> {
  const [sha256, records] = await Promise.all([sha256File(filePath), countNdjsonRecords(filePath)]);

  return {
    sha256,
    records,
  };
}

export async function preparePrivateDirectorySnapshot(options: {
  readonly dataRoot: string;
  readonly manifestPath: string;
  readonly expectedSnapshotId: string;
  readonly expectedManifestSha256: string;
}): Promise<PreparedPrivateDirectorySnapshot> {
  if (!SNAPSHOT_ID_PATTERN.test(options.expectedSnapshotId)) {
    throw new Error('Expected snapshot ID is not a factual-v3 snapshot ID.');
  }

  if (!SHA256_PATTERN.test(options.expectedManifestSha256)) {
    throw new Error('Expected manifest hash must be lowercase SHA-256.');
  }

  const dataRoot = await realpath(resolve(options.dataRoot));
  const manifestPath = await realpath(resolve(options.manifestPath));

  if (!isPathInside(dataRoot, manifestPath)) {
    throw new Error('Manifest path escapes DATA_INGESTION_DIR.');
  }

  const expectedManifestPath = resolve(
    dataRoot,
    'processed',
    'directory',
    options.expectedSnapshotId,
    'manifest.json',
  );

  if (manifestPath !== expectedManifestPath) {
    throw new Error('Manifest path does not match the expected factual-v3 snapshot path.');
  }

  const manifestContent = await readFile(manifestPath);
  const manifestSha256 = createHash('sha256').update(manifestContent).digest('hex');

  if (manifestSha256 !== options.expectedManifestSha256) {
    throw new Error('Manifest SHA-256 does not match the explicitly approved hash.');
  }

  let manifestValue: unknown;

  try {
    manifestValue = JSON.parse(manifestContent.toString('utf8')) as unknown;
  } catch {
    throw new Error('Directory manifest is not valid JSON.');
  }

  const manifest = parseManifest(manifestValue);

  if (manifest.snapshotId !== options.expectedSnapshotId) {
    throw new Error('Manifest snapshot ID does not match the explicitly approved snapshot.');
  }

  const expectedProfilesRelativePath = portableRelativePath(
    `processed/directory/${manifest.snapshotId}/profiles.ndjson`,
  );

  if (
    portableRelativePath(manifest.outputs.profiles.relativePath) !== expectedProfilesRelativePath
  ) {
    throw new Error('Profile output path is not canonical for the approved snapshot.');
  }

  const profilesPath = await realpath(resolve(dataRoot, manifest.outputs.profiles.relativePath));

  if (!isPathInside(dataRoot, profilesPath)) {
    throw new Error('Profile path escapes DATA_INGESTION_DIR.');
  }

  const expectedProfilesPath = resolve(
    dataRoot,
    'processed',
    'directory',
    manifest.snapshotId,
    'profiles.ndjson',
  );

  if (profilesPath !== expectedProfilesPath) {
    throw new Error('Resolved profile path does not match the approved snapshot.');
  }

  const inspectedProfiles = await inspectProfilesFile(profilesPath);

  if (inspectedProfiles.sha256 !== manifest.outputs.profiles.sha256) {
    throw new Error('Profile file SHA-256 does not match the factual-v3 manifest.');
  }

  if (inspectedProfiles.records !== manifest.outputs.profiles.records) {
    throw new Error('Profile file count does not match the factual-v3 manifest.');
  }

  return {
    snapshotId: manifest.snapshotId,
    manifestSha256,
    profilesSha256: inspectedProfiles.sha256,
    profileCount: inspectedProfiles.records,
    sourceGeneratedAt: requiredIsoTimestamp(manifest.generatedAt, 'manifest.generatedAt'),
    manifestPath,
    profilesPath,
  };
}

function parseRegisteredTitles(value: unknown): readonly PrivateRegisteredTitle[] {
  if (!Array.isArray(value)) {
    throw new Error('profile.registeredTitles must be an array.');
  }

  return value.map((candidate, index) => {
    const title = requiredObject(candidate, `profile.registeredTitles[${String(index)}]`);
    assertExactKeys(
      title,
      ALLOWED_REGISTERED_TITLE_KEYS,
      `profile.registeredTitles[${String(index)}]`,
    );
    const temporaryRegistration = title['temporaryRegistration'];

    if (
      temporaryRegistration !== 'NONE' &&
      temporaryRegistration !== 'WITH_CONTRACT' &&
      temporaryRegistration !== 'WITHOUT_CONTRACT'
    ) {
      throw new Error(
        `profile.registeredTitles[${String(index)}].temporaryRegistration is invalid.`,
      );
    }

    return {
      title: requiredString(
        title['title'],
        `profile.registeredTitles[${String(index)}].title`,
        250,
      ),
      temporaryRegistration,
    };
  });
}

function requiredHttpsUrl(value: unknown, label: string): string {
  const text = requiredString(value, label, 2_048);
  let url: URL;

  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS.`);
  }

  return text;
}

function parseOfficialRegistry(value: unknown): PrivateOfficialRegistry {
  const registry = requiredObject(value, 'profile.officialRegistry');
  assertExactKeys(registry, ALLOWED_OFFICIAL_REGISTRY_KEYS, 'profile.officialRegistry');
  const sourceCutoffDate = requiredString(
    registry['sourceCutoffDate'],
    'profile.officialRegistry.sourceCutoffDate',
    10,
  );

  if (!ISO_DATE_PATTERN.test(sourceCutoffDate)) {
    throw new Error('profile.officialRegistry.sourceCutoffDate must be YYYY-MM-DD.');
  }

  return {
    publisher: requiredString(registry['publisher'], 'profile.officialRegistry.publisher', 200),
    dataset: requiredString(registry['dataset'], 'profile.officialRegistry.dataset', 300),
    sourceCutoffDate,
    datasetUrl: requiredHttpsUrl(registry['datasetUrl'], 'profile.officialRegistry.datasetUrl'),
    liveLookupUrl: requiredHttpsUrl(
      registry['liveLookupUrl'],
      'profile.officialRegistry.liveLookupUrl',
    ),
  };
}

export function parsePrivateProfessionalProfileLine(
  line: string,
  lineNumber: number,
): PrivateProfessionalProfileRow {
  if (line.length === 0 || line.length > MAX_NDJSON_LINE_LENGTH) {
    throw new Error(`Invalid NDJSON record length at line ${String(lineNumber)}.`);
  }

  let value: unknown;

  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Invalid profile JSON at line ${String(lineNumber)}.`);
  }

  assertNoRawIdentifierKeys(value);
  const profile = requiredObject(value, `profile at line ${String(lineNumber)}`);
  assertExactKeys(profile, ALLOWED_PROFILE_KEYS, `profile at line ${String(lineNumber)}`);

  if (profile['schemaVersion'] !== 2) {
    throw new Error(`Unsupported profile schemaVersion at line ${String(lineNumber)}.`);
  }

  const internalHmacId = requiredString(
    profile['internalLinkageId'],
    `profile.internalLinkageId at line ${String(lineNumber)}`,
    75,
  );

  if (!INTERNAL_HMAC_ID_PATTERN.test(internalHmacId)) {
    throw new Error(`Invalid internal HMAC ID at line ${String(lineNumber)}.`);
  }

  const displayName = requiredString(
    profile['displayName'],
    `profile.displayName at line ${String(lineNumber)}`,
    200,
  );
  const normalizedName = normalizePersonName(displayName);

  if (normalizedName.length === 0 || normalizedName.length > 200) {
    throw new Error(`Invalid normalized name at line ${String(lineNumber)}.`);
  }

  const publication = requiredObject(profile['publication'], 'profile.publication');

  if (publication['publicExportAllowed'] !== false) {
    throw new Error(`Profile publicExportAllowed is not false at line ${String(lineNumber)}.`);
  }

  return {
    internalHmacId,
    displayName,
    normalizedName,
    registeredTitles: parseRegisteredTitles(profile['registeredTitles']),
    officialRegistry: parseOfficialRegistry(profile['officialRegistry']),
    recordSha256: createHash('sha256').update(line, 'utf8').digest('hex'),
  };
}

async function* readProfileRows(
  filePath: string,
): AsyncGenerator<PrivateProfessionalProfileRow, void, undefined> {
  const lines = createInterface({
    input: createReadStream(filePath, {
      encoding: 'utf8',
    }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      yield parsePrivateProfessionalProfileLine(line, lineNumber);
    }
  } finally {
    lines.close();
  }
}

async function insertProfileBatch(
  connection: PrivateImportConnection,
  snapshotId: string,
  profiles: readonly PrivateProfessionalProfileRow[],
): Promise<void> {
  if (profiles.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const rows = profiles.map((profile, rowIndex) => {
    const first = rowIndex * 7 + 1;
    values.push(
      snapshotId,
      profile.internalHmacId,
      profile.displayName,
      profile.normalizedName,
      JSON.stringify(profile.registeredTitles),
      JSON.stringify(profile.officialRegistry),
      profile.recordSha256,
    );

    return `($${String(first)}, $${String(first + 1)}, $${String(first + 2)}, $${String(
      first + 3,
    )}, $${String(first + 4)}::jsonb, $${String(first + 5)}::jsonb, $${String(first + 6)})`;
  });
  const result = await connection.query(
    `INSERT INTO ingestion_private.professional_profile (
      snapshot_id,
      internal_hmac_id,
      display_name,
      normalized_name,
      registered_titles,
      official_registry,
      record_sha256
    ) VALUES ${rows.join(', ')}`,
    values,
  );

  if (result.rowCount !== profiles.length) {
    throw new Error('PostgreSQL did not insert the complete private profile batch.');
  }
}

function existingTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error('Stored private snapshot has an invalid source timestamp.');
  }

  return date.toISOString();
}

async function existingSnapshotResult(
  connection: PrivateImportConnection,
  snapshot: PreparedPrivateDirectorySnapshot,
  row: ExistingSnapshotRow,
): Promise<PrivateImportResult> {
  if (
    row.manifest_sha256 !== snapshot.manifestSha256 ||
    row.profiles_sha256 !== snapshot.profilesSha256 ||
    row.profile_count !== snapshot.profileCount ||
    existingTimestamp(row.source_generated_at) !== snapshot.sourceGeneratedAt.toISOString()
  ) {
    throw new Error('Snapshot ID collision: stored metadata differs from the approved snapshot.');
  }

  const countResult = await connection.query<CountRow>(
    `SELECT count(*)::integer AS profile_count
     FROM ingestion_private.professional_profile
     WHERE snapshot_id = $1`,
    [snapshot.snapshotId],
  );
  const actualCount = countResult.rows[0]?.profile_count;

  if (actualCount !== snapshot.profileCount) {
    throw new Error('Stored private snapshot is incomplete or inconsistent.');
  }

  const storedProfilesResult = await connection.query<ExistingProfileHashRow>(
    `SELECT
       internal_hmac_id,
       display_name,
       normalized_name,
       registered_titles,
       official_registry,
       record_sha256
     FROM ingestion_private.professional_profile
     WHERE snapshot_id = $1
     ORDER BY internal_hmac_id`,
    [snapshot.snapshotId],
  );

  if (storedProfilesResult.rows.length !== snapshot.profileCount) {
    throw new Error('Stored private snapshot row hashes are incomplete.');
  }

  const storedProfiles = new Map(
    storedProfilesResult.rows.map((profile) => [profile.internal_hmac_id, profile]),
  );

  for await (const expectedProfile of readProfileRows(snapshot.profilesPath)) {
    const storedProfile = storedProfiles.get(expectedProfile.internalHmacId);

    if (
      storedProfile?.display_name !== expectedProfile.displayName ||
      storedProfile.normalized_name !== expectedProfile.normalizedName ||
      canonicalJson(storedProfile.registered_titles) !==
        canonicalJson(expectedProfile.registeredTitles) ||
      canonicalJson(storedProfile.official_registry) !==
        canonicalJson(expectedProfile.officialRegistry) ||
      storedProfile.record_sha256 !== expectedProfile.recordSha256
    ) {
      throw new Error('Stored private snapshot rows differ from the approved source file.');
    }

    storedProfiles.delete(expectedProfile.internalHmacId);
  }

  if (storedProfiles.size !== 0) {
    throw new Error('Stored private snapshot contains unexpected rows.');
  }

  return {
    status: 'already_imported',
    snapshotId: snapshot.snapshotId,
    profileCount: snapshot.profileCount,
    manifestSha256: snapshot.manifestSha256,
    profilesSha256: snapshot.profilesSha256,
  };
}

async function assertFilesUnchanged(snapshot: PreparedPrivateDirectorySnapshot): Promise<void> {
  const currentManifestSha256 = await sha256File(snapshot.manifestPath);
  const currentProfiles = await inspectProfilesFile(snapshot.profilesPath);

  if (
    currentManifestSha256 !== snapshot.manifestSha256 ||
    currentProfiles.sha256 !== snapshot.profilesSha256 ||
    currentProfiles.records !== snapshot.profileCount
  ) {
    throw new Error('Approved snapshot files changed while the private import was running.');
  }
}

async function assertLeastPrivilegeImportRole(connection: PrivateImportConnection): Promise<void> {
  const result = await connection.query<ImportRoleRow>(
    `SELECT
       current_database() AS database_name,
       current_user AS role_name,
       role.rolsuper,
       role.rolcreatedb,
       role.rolcreaterole,
       role.rolreplication,
       role.rolbypassrls,
       (
         SELECT count(*)::integer
         FROM pg_catalog.pg_auth_members membership
         WHERE membership.member = role.oid
       ) AS membership_count,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_database database
         WHERE database.datdba = role.oid
       ) AS owns_database,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace namespace
         WHERE namespace.nspowner = role.oid
       ) AS owns_schema,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_class relation
         WHERE relation.relowner = role.oid
       ) AS owns_relation,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc owned_function
         WHERE owned_function.proowner = role.oid
       ) AS owns_function,
       has_database_privilege(current_user, current_database(), 'TEMP') AS has_temp,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
       has_schema_privilege(
         current_user,
         'ingestion_private',
         'USAGE'
       ) AS can_use_private_schema,
       has_table_privilege(
         current_user,
         'ingestion_private.snapshot',
         'SELECT'
       ) AS can_select_private_snapshot,
       has_table_privilege(
         current_user,
         'ingestion_private.snapshot',
         'INSERT'
       ) AS can_insert_private_snapshot,
       has_table_privilege(
         current_user,
         'ingestion_private.professional_profile',
         'SELECT'
       ) AS can_select_private_profile,
       has_table_privilege(
         current_user,
         'ingestion_private.professional_profile',
         'INSERT'
       ) AS can_insert_private_profile,
       (
         has_schema_privilege(current_user, 'ingestion_private', 'CREATE')
         OR has_table_privilege(
           current_user,
           'ingestion_private.snapshot',
           'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
         )
         OR has_table_privilege(
           current_user,
           'ingestion_private.professional_profile',
           'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
         )
       ) AS has_forbidden_private_privileges,
       (
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class public_relation
           JOIN pg_catalog.pg_namespace public_namespace
             ON public_namespace.oid = public_relation.relnamespace
           WHERE public_namespace.nspname IN ('catalog', 'credentials', 'provenance')
             AND has_table_privilege(
               current_user,
               public_relation.oid,
               'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
             )
         )
         OR has_schema_privilege(current_user, 'catalog', 'USAGE')
         OR has_schema_privilege(current_user, 'credentials', 'USAGE')
         OR has_schema_privilege(current_user, 'provenance', 'USAGE')
       ) AS has_public_catalog_privileges
     FROM pg_catalog.pg_roles role
     WHERE role.rolname = current_user`,
  );
  const role = result.rows[0];

  if (
    result.rows.length !== 1 ||
    role?.database_name !== REQUIRED_DATABASE_NAME ||
    role?.role_name !== REQUIRED_DATABASE_USER ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls ||
    role.membership_count !== 0 ||
    role.owns_database ||
    role.owns_schema ||
    role.owns_relation ||
    role.owns_function ||
    role.has_temp ||
    role.can_create_public ||
    !role.can_use_private_schema ||
    !role.can_select_private_snapshot ||
    !role.can_insert_private_snapshot ||
    !role.can_select_private_profile ||
    !role.can_insert_private_profile ||
    role.has_forbidden_private_privileges ||
    role.has_public_catalog_privileges
  ) {
    throw new Error(
      'Private import requires the least-privilege medicos_private_ingestor role configuration.',
    );
  }
}

export async function importPreparedPrivateDirectorySnapshot(
  connection: PrivateImportConnection,
  snapshot: PreparedPrivateDirectorySnapshot,
  batchSize = 500,
): Promise<PrivateImportResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('Private import batch size must be an integer from 1 to 1000.');
  }

  await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

  try {
    await assertLeastPrivilegeImportRole(connection);
    await connection.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
      ADVISORY_LOCK_NAMESPACE,
      ADVISORY_LOCK_RESOURCE,
    ]);
    const existing = await connection.query<ExistingSnapshotRow>(
      `SELECT manifest_sha256, profiles_sha256, profile_count, source_generated_at
       FROM ingestion_private.snapshot
       WHERE snapshot_id = $1`,
      [snapshot.snapshotId],
    );

    if (existing.rows.length > 1) {
      throw new Error('Private snapshot primary key invariant is violated.');
    }

    if (existing.rows[0] !== undefined) {
      const result = await existingSnapshotResult(connection, snapshot, existing.rows[0]);
      await assertFilesUnchanged(snapshot);
      await connection.query('COMMIT');
      return result;
    }

    const snapshotInsert = await connection.query(
      `INSERT INTO ingestion_private.snapshot (
        snapshot_id,
        manifest_sha256,
        profiles_sha256,
        profile_count,
        source_generated_at
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        snapshot.snapshotId,
        snapshot.manifestSha256,
        snapshot.profilesSha256,
        snapshot.profileCount,
        snapshot.sourceGeneratedAt,
      ],
    );

    if (snapshotInsert.rowCount !== 1) {
      throw new Error('PostgreSQL did not insert the private snapshot metadata.');
    }

    let batch: PrivateProfessionalProfileRow[] = [];
    let importedProfiles = 0;

    for await (const profile of readProfileRows(snapshot.profilesPath)) {
      batch.push(profile);

      if (batch.length === batchSize) {
        await insertProfileBatch(connection, snapshot.snapshotId, batch);
        importedProfiles += batch.length;
        batch = [];
      }
    }

    if (batch.length > 0) {
      await insertProfileBatch(connection, snapshot.snapshotId, batch);
      importedProfiles += batch.length;
    }

    if (importedProfiles !== snapshot.profileCount) {
      throw new Error('Imported profile count does not match the approved snapshot.');
    }

    const countResult = await connection.query<CountRow>(
      `SELECT count(*)::integer AS profile_count
       FROM ingestion_private.professional_profile
       WHERE snapshot_id = $1`,
      [snapshot.snapshotId],
    );

    if (countResult.rows[0]?.profile_count !== snapshot.profileCount) {
      throw new Error('PostgreSQL private profile count verification failed.');
    }

    await assertFilesUnchanged(snapshot);
    await connection.query('COMMIT');

    return {
      status: 'imported',
      snapshotId: snapshot.snapshotId,
      profileCount: snapshot.profileCount,
      manifestSha256: snapshot.manifestSha256,
      profilesSha256: snapshot.profilesSha256,
    };
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Private import failed and PostgreSQL rollback also failed.',
        {
          cause: rollbackError,
        },
      );
    }

    throw error;
  }
}

function pgConnection(client: Client): PrivateImportConnection {
  return {
    async query<Row extends UnknownRecord = UnknownRecord>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<SqlQueryResult<Row>> {
      const result = await client.query(text, [...values]);

      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount ?? 0,
      };
    },
  };
}

export async function runPrivateDirectoryImport(
  configuration: PrivateDirectoryImportConfiguration,
): Promise<PrivateImportResult> {
  const snapshot = await preparePrivateDirectorySnapshot({
    dataRoot: configuration.dataRoot,
    manifestPath: configuration.manifestPath,
    expectedSnapshotId: configuration.expectedSnapshotId,
    expectedManifestSha256: configuration.expectedManifestSha256,
  });
  const client = new Client({
    connectionString: configuration.databaseUrl,
    application_name: 'medicos-private-directory-import',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 120_000,
    idle_in_transaction_session_timeout: 120_000,
    ssl: {
      ca: configuration.databaseCa,
      rejectUnauthorized: true,
    },
  });

  await client.connect();

  try {
    return await importPreparedPrivateDirectorySnapshot(
      pgConnection(client),
      snapshot,
      configuration.batchSize,
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const configuration = await loadPrivateDirectoryImportConfiguration();
  const result = await runPrivateDirectoryImport(configuration);

  console.log(
    JSON.stringify({
      event: 'private_directory_import_completed',
      ...result,
      publicCatalogMutationPerformed: false,
    }),
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown private import failure.';

    console.error(
      JSON.stringify({
        event: 'private_directory_import_failed',
        message,
      }),
    );
    process.exitCode = 1;
  });
}
