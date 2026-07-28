import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { normalizePersonName } from './normalize-person-name';

interface MspTitle {
  readonly recruiterCode: string;
  readonly temporaryRegistration: string | null;
  readonly title: string;
}

export interface MspProfessional {
  readonly enabledTitles: readonly MspTitle[];
  readonly fullName: string;
  readonly linkageId: string;
}

export interface ProviderProfessionalObservation {
  readonly displayName: string;
  readonly institution: string;
  readonly recordId: string;
  readonly sourceFile: string;
  readonly sourceProfessionalId?: string;
  readonly specialties: readonly string[];
}

export type LinkageCandidateStatus =
  'ambiguous_exact_name' | 'exact_name_and_title_consistent' | 'exact_name_only' | 'unmatched';

export interface LinkageCandidate {
  readonly schemaVersion: 2;
  readonly candidateId: string;
  readonly status: LinkageCandidateStatus;
  readonly publicationDecision: 'not_merged';
  readonly providerIdentity: {
    readonly institution: string;
    readonly basis: 'institution_and_exact_name' | 'source_professional_id';
    readonly sourceProfessionalId: string | null;
    readonly normalizedName: string;
  };
  readonly sourceDisplayNames: readonly string[];
  readonly sourceRecords: readonly {
    readonly sourceFile: string;
    readonly recordId: string;
  }[];
  readonly sourceSpecialties: readonly string[];
  readonly mspCandidates: readonly {
    readonly linkageId: string;
    readonly fullName: string;
    readonly enabledTitles: readonly string[];
  }[];
  readonly identityEvidence: readonly (
    | 'exact_full_name_token_multiset'
    | 'exact_normalized_full_name'
    | 'specialty_consistent_with_registered_title'
  )[];
  readonly requiresHumanReview: true;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

interface LinkageManifest {
  readonly schemaVersion: 2;
  readonly algorithmVersion: 'exact-full-name-candidates-v3';
  readonly createdAt: string;
  readonly inputs: readonly {
    readonly relativePath: string;
    readonly records: number;
    readonly parsedRecords?: number;
    readonly quarantinedRecords?: number;
    readonly sha256: string;
  }[];
  readonly providerBundles: readonly {
    readonly providerKey: string;
    readonly providerLabel: string;
    readonly runId: string;
    readonly compatibilityMode:
      'complete_manifest_v1' | 'legacy_casmu_v1' | 'legacy_hospital_britanico_v1';
    readonly manifest: {
      readonly relativePath: string;
      readonly sha256: string;
    };
    readonly artifacts: readonly {
      readonly artifactKey: ProviderArtifactKey;
      readonly relativePath: string;
      readonly records: number;
      readonly sha256: string;
    }[];
  }[];
  readonly output: {
    readonly relativePath: string;
    readonly records: number;
    readonly sha256: string;
  };
  readonly aggregates: Readonly<Record<LinkageCandidateStatus, number>> & {
    readonly providerIdentities: number;
    readonly providerIdentitiesByExactNameFallback: number;
    readonly providerIdentitiesBySourceProfessionalId: number;
    readonly providerPhysicalRows: number;
    readonly quarantinedProviderRows: 0;
    readonly providerRows: number;
    readonly mspProfessionals: number;
  };
  readonly safeguards: {
    readonly fuzzyMatchingUsed: false;
    readonly automaticallyMerged: false;
    readonly providerBundlesSelectedAtomically: true;
    readonly providerRowsReconciled: true;
    readonly rawGovernmentIdentifiersPublished: false;
  };
}

const PROVIDER_ARTIFACT_KEYS = [
  'physiciansNdjson',
  'professionalsNdjson',
  'rosterNdjson',
  'schedulesNdjson',
] as const;

type ProviderArtifactKey = (typeof PROVIDER_ARTIFACT_KEYS)[number];

type ProviderBundleCompatibilityMode =
  'complete_manifest_v1' | 'legacy_casmu_v1' | 'legacy_hospital_britanico_v1';

interface ProviderArtifact {
  readonly artifactKey: ProviderArtifactKey;
  readonly expectedRecords: number;
  readonly expectedSha256?: string;
  readonly path: string;
}

interface ProviderBundle {
  readonly artifacts: readonly ProviderArtifact[];
  readonly compatibilityMode: ProviderBundleCompatibilityMode;
  readonly manifestContent: Buffer;
  readonly manifestPath: string;
  readonly orderKey: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly runId: string;
}

type ProviderQuarantineReason =
  'EMPTY_NORMALIZED_NAME' | 'INVALID_JSON' | 'MISSING_DISPLAY_NAME' | 'NON_OBJECT_RECORD';

interface ProviderQuarantineRecord {
  readonly rawRecordSha256: string;
  readonly reason: ProviderQuarantineReason;
  readonly rowNumber: number;
  readonly sourceFile: string;
}

interface ParsedProviderArtifact {
  readonly artifact: ProviderArtifact;
  readonly content: Buffer;
  readonly observations: readonly ProviderProfessionalObservation[];
  readonly physicalRecords: number;
  readonly quarantine: readonly ProviderQuarantineRecord[];
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getNonNegativeInteger(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function getObject(record: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = record[key];
  return isObject(value) ? value : undefined;
}

function getNestedString(
  record: UnknownRecord,
  objectKey: string,
  valueKey: string,
): string | undefined {
  const nested = record[objectKey];
  return isObject(nested) ? getString(nested, valueKey) : undefined;
}

function getSpecialties(record: UnknownRecord): readonly string[] {
  const value =
    getString(record, 'specialty') ??
    getString(record, 'speciality') ??
    getString(record, 'sourceSpecialty');

  if (value !== undefined) {
    return [value];
  }

  const values = record['specialties'];
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
}

function parseProviderObservation(
  value: unknown,
  sourceFile: string,
  rowNumber: number,
): ProviderProfessionalObservation | ProviderQuarantineReason {
  if (!isObject(value)) {
    return 'NON_OBJECT_RECORD';
  }

  const displayName =
    getString(value, 'professionalName') ??
    getString(value, 'physicianName') ??
    getString(value, 'fullName') ??
    getString(value, 'name');
  if (displayName === undefined) {
    return 'MISSING_DISPLAY_NAME';
  }
  if (normalizePersonName(displayName).length === 0) {
    return 'EMPTY_NORMALIZED_NAME';
  }

  const institution =
    getNestedString(value, 'source', 'institution') ??
    getString(value, 'institution') ??
    getString(value, 'provider') ??
    getNestedString(value, 'source', 'id') ??
    basename(dirname(sourceFile));
  const recordId =
    getString(value, 'recordId') ??
    getString(value, 'sourceProfessionalId') ??
    `${basename(sourceFile)}:${String(rowNumber)}`;
  const sourceProfessionalId = getString(value, 'sourceProfessionalId');

  return {
    displayName,
    institution,
    recordId,
    sourceFile,
    ...(sourceProfessionalId === undefined ? {} : { sourceProfessionalId }),
    specialties: getSpecialties(value),
  };
}

function parseMspProfessional(value: unknown): MspProfessional {
  if (!isObject(value)) {
    throw new Error('MSP NDJSON contains a non-object record');
  }

  const linkageId = getString(value, 'linkageId');
  const fullName = getString(value, 'fullName');
  const enabledTitlesValue = value['enabledTitles'];
  if (linkageId === undefined || fullName === undefined || !Array.isArray(enabledTitlesValue)) {
    throw new Error('MSP NDJSON record does not match the expected schema');
  }

  const enabledTitles = enabledTitlesValue.map((item): MspTitle => {
    if (!isObject(item)) {
      throw new Error('MSP title is not an object');
    }

    const title = getString(item, 'title');
    const recruiterCode = getString(item, 'recruiterCode');
    const temporaryRegistrationValue = item['temporaryRegistration'];
    if (
      title === undefined ||
      recruiterCode === undefined ||
      !(temporaryRegistrationValue === null || typeof temporaryRegistrationValue === 'string')
    ) {
      throw new Error('MSP title does not match the expected schema');
    }

    return {
      recruiterCode,
      temporaryRegistration: temporaryRegistrationValue,
      title,
    };
  });

  return { enabledTitles, fullName, linkageId };
}

function normalizeCredential(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

const NON_DISTINCTIVE_CREDENTIALS = new Set([
  'DOCTOR EN MEDICINA',
  'MEDICINA',
  'MEDICINA GENERAL',
  'MEDICO',
]);

function isSpecialtyConsistent(specialty: string, title: string): boolean {
  const normalizedSpecialty = normalizeCredential(specialty);
  const normalizedTitle = normalizeCredential(title);

  if (normalizedSpecialty.length < 4 || NON_DISTINCTIVE_CREDENTIALS.has(normalizedSpecialty)) {
    return false;
  }

  return (
    normalizedTitle.includes(normalizedSpecialty) || normalizedSpecialty.includes(normalizedTitle)
  );
}

export function buildLinkageCandidates(
  mspProfessionals: readonly MspProfessional[],
  providerRows: readonly ProviderProfessionalObservation[],
): readonly LinkageCandidate[] {
  const mspByNameTokens = new Map<string, MspProfessional[]>();
  for (const professional of mspProfessionals) {
    const key = fullNameTokenMultiset(professional.fullName);
    const existing = mspByNameTokens.get(key) ?? [];
    existing.push(professional);
    mspByNameTokens.set(key, existing);
  }

  const observationsByIdentity = new Map<string, ProviderProfessionalObservation[]>();
  for (const row of providerRows) {
    const normalizedName = normalizePersonName(row.displayName);
    if (normalizedName.length === 0) {
      throw new Error('Provider observation has an empty normalized name');
    }

    const key =
      row.sourceProfessionalId === undefined
        ? `${row.institution}\u0000name\u0000${normalizedName}`
        : `${row.institution}\u0000source-professional-id\u0000${row.sourceProfessionalId}`;
    const existing = observationsByIdentity.get(key) ?? [];
    existing.push(row);
    observationsByIdentity.set(key, existing);
  }

  const candidates: LinkageCandidate[] = [];
  for (const observations of observationsByIdentity.values()) {
    const first = observations[0];
    if (first === undefined) {
      continue;
    }

    const normalizedName = normalizePersonName(first.displayName);
    const matchesById = new Map<string, MspProfessional>();
    for (const observation of observations) {
      const matches = mspByNameTokens.get(fullNameTokenMultiset(observation.displayName)) ?? [];
      for (const match of matches) {
        matchesById.set(match.linkageId, match);
      }
    }
    const matches = [...matchesById.values()].sort((left, right) =>
      left.linkageId.localeCompare(right.linkageId),
    );
    const specialties = [
      ...new Set(observations.flatMap((observation) => observation.specialties)),
    ].sort();
    const specialtyConsistent =
      matches.length === 1 &&
      specialties.some((specialty) =>
        matches[0]?.enabledTitles.some((title) => isSpecialtyConsistent(specialty, title.title)),
      );

    let status: LinkageCandidateStatus;
    if (matches.length === 0) {
      status = 'unmatched';
    } else if (matches.length > 1) {
      status = 'ambiguous_exact_name';
    } else if (specialtyConsistent) {
      status = 'exact_name_and_title_consistent';
    } else {
      status = 'exact_name_only';
    }

    const exactOrderedName =
      matches.length > 0 &&
      matches.every(({ fullName }) =>
        observations.some(
          ({ displayName }) => normalizePersonName(fullName) === normalizePersonName(displayName),
        ),
      );
    const nameEvidence: LinkageCandidate['identityEvidence'][number] = exactOrderedName
      ? 'exact_normalized_full_name'
      : 'exact_full_name_token_multiset';
    const identityEvidence: LinkageCandidate['identityEvidence'] =
      matches.length === 0
        ? []
        : specialtyConsistent
          ? [nameEvidence, 'specialty_consistent_with_registered_title']
          : [nameEvidence];

    const providerIdentity =
      first.sourceProfessionalId === undefined
        ? {
            institution: first.institution,
            basis: 'institution_and_exact_name' as const,
            sourceProfessionalId: null,
            normalizedName,
          }
        : {
            institution: first.institution,
            basis: 'source_professional_id' as const,
            sourceProfessionalId: first.sourceProfessionalId,
            normalizedName,
          };
    const sourceRecords = [
      ...new Map(
        observations.map(({ sourceFile, recordId }) => [
          `${sourceFile}\u0000${recordId}`,
          { sourceFile, recordId },
        ]),
      ).values(),
    ].sort(
      (left, right) =>
        left.sourceFile.localeCompare(right.sourceFile) ||
        left.recordId.localeCompare(right.recordId),
    );
    const stableCandidateIdentity = JSON.stringify({
      institution: providerIdentity.institution,
      basis: providerIdentity.basis,
      sourceProfessionalId: providerIdentity.sourceProfessionalId,
      normalizedName:
        providerIdentity.basis === 'institution_and_exact_name'
          ? providerIdentity.normalizedName
          : null,
    });

    candidates.push({
      schemaVersion: 2,
      candidateId: `provider_identity_v2_${sha256(stableCandidateIdentity)}`,
      status,
      publicationDecision: 'not_merged',
      providerIdentity,
      sourceDisplayNames: [...new Set(observations.map(({ displayName }) => displayName))].sort(),
      sourceRecords,
      sourceSpecialties: specialties,
      mspCandidates: matches.map((match) => ({
        linkageId: match.linkageId,
        fullName: match.fullName,
        enabledTitles: match.enabledTitles.map(({ title }) => title),
      })),
      identityEvidence,
      requiresHumanReview: true,
    });
  }

  return candidates.sort(
    (left, right) =>
      left.providerIdentity.institution.localeCompare(
        right.providerIdentity.institution,
        'es-UY',
      ) ||
      left.providerIdentity.normalizedName.localeCompare(
        right.providerIdentity.normalizedName,
        'es-UY',
      ) ||
      left.candidateId.localeCompare(right.candidateId),
  );
}

function fullNameTokenMultiset(value: string): string {
  return normalizePersonName(value).split(' ').filter(Boolean).sort().join(' ');
}

async function walkFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isObject(error) && getString(error, 'code') === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(path) : [path];
    }),
  );

  return paths.flat();
}

async function parseNdjson<T>(
  path: string,
  parser: (value: unknown, rowNumber: number) => T | undefined,
): Promise<readonly T[]> {
  const content = await readFile(path, 'utf8');
  const values: T[] = [];
  const lines = content.split(/\r?\n/gu);

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const value: unknown = JSON.parse(line);
    const parsed = parser(value, index + 1);
    if (parsed !== undefined) {
      values.push(parsed);
    }
  }

  return values;
}

async function parseProviderArtifact(
  artifact: ProviderArtifact,
  dataDirectory: string,
): Promise<ParsedProviderArtifact> {
  const content = await readFile(artifact.path);
  const sourceFile = relative(dataDirectory, artifact.path).replaceAll('\\', '/');
  const observations: ProviderProfessionalObservation[] = [];
  const quarantine: ProviderQuarantineRecord[] = [];
  let physicalRecords = 0;

  for (const [index, line] of content.toString('utf8').split(/\r?\n/gu).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    physicalRecords += 1;
    const rowNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      quarantine.push({
        rawRecordSha256: sha256(line),
        reason: 'INVALID_JSON',
        rowNumber,
        sourceFile,
      });
      continue;
    }

    const parsed = parseProviderObservation(value, sourceFile, rowNumber);
    if (typeof parsed === 'string') {
      quarantine.push({
        rawRecordSha256: sha256(line),
        reason: parsed,
        rowNumber,
        sourceFile,
      });
      continue;
    }
    observations.push(parsed);
  }

  if (physicalRecords !== observations.length + quarantine.length) {
    throw new Error(
      `Provider row reconciliation failed for ${sourceFile}: physical=${String(
        physicalRecords,
      )}, parsed=${String(observations.length)}, quarantined=${String(quarantine.length)}`,
    );
  }
  if (physicalRecords !== artifact.expectedRecords) {
    throw new Error(
      `Provider artifact ${sourceFile} declares ${String(
        artifact.expectedRecords,
      )} records but contains ${String(physicalRecords)} physical NDJSON records`,
    );
  }
  const actualSha256 = sha256(content);
  if (artifact.expectedSha256 !== undefined && actualSha256 !== artifact.expectedSha256) {
    throw new Error(`Provider artifact ${sourceFile} does not match its manifest SHA-256`);
  }

  return { artifact, content, observations, physicalRecords, quarantine };
}

async function newestPath(paths: readonly string[]): Promise<string | undefined> {
  const entries = await Promise.all(
    paths.map(async (path) => ({ modifiedAt: (await stat(path)).mtimeMs, path })),
  );
  entries.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return entries[0]?.path;
}

async function findMspInput(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const explicitPath = environment['MSP_PROFESSIONALS_PATH'];
  if (explicitPath !== undefined) {
    return resolve(explicitPath);
  }

  const files = await walkFiles(join(dataDirectory, 'processed', 'msp', 'infotitulos'));
  const professionalsFiles = files.filter((path) => basename(path) === 'professionals.ndjson');
  const path = await newestPath(professionalsFiles);
  if (path === undefined) {
    throw new Error(
      'No MSP professionals.ndjson found. Run pnpm data:ingest:msp or set MSP_PROFESSIONALS_PATH.',
    );
  }
  return path;
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath.length === 0 ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  );
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function artifactDescriptor(value: unknown):
  | {
      readonly declaredPath: string;
      readonly expectedRecords?: number;
      readonly expectedSha256?: string;
    }
  | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { declaredPath: value.trim() };
  }
  if (!isObject(value)) {
    return undefined;
  }
  const declaredPath = getString(value, 'relativePath') ?? getString(value, 'path');
  if (declaredPath === undefined) {
    return undefined;
  }
  const expectedRecords = getNonNegativeInteger(value, 'records');
  const expectedSha256 = getString(value, 'sha256')?.toLowerCase();
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    return undefined;
  }
  return {
    declaredPath,
    ...(expectedRecords === undefined ? {} : { expectedRecords }),
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
  };
}

async function resolveBundleArtifactPath(
  dataDirectory: string,
  manifestPath: string,
  declaredPath: string,
): Promise<string | undefined> {
  const bundleDirectory = dirname(manifestPath);
  const portablePath = declaredPath.replaceAll('/', sep);
  const candidates = isAbsolute(portablePath)
    ? [resolve(portablePath)]
    : [
        resolve(bundleDirectory, portablePath),
        resolve(bundleDirectory, basename(portablePath)),
        resolve(dataDirectory, portablePath),
        resolve(dirname(dataDirectory), portablePath),
        resolve(portablePath),
      ];

  for (const candidate of [...new Set(candidates.map((path) => resolve(path)))]) {
    if (!isPathInside(bundleDirectory, candidate)) {
      continue;
    }
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch (error: unknown) {
      if (!(isObject(error) && getString(error, 'code') === 'ENOENT')) {
        throw error;
      }
    }
  }
  return undefined;
}

function modernManifestExpectedRecords(
  manifest: UnknownRecord,
  descriptorRecords: number | undefined,
  artifactCount: number,
): number | undefined {
  const counts = getObject(manifest, 'counts');
  const recordsWritten =
    counts === undefined ? undefined : getNonNegativeInteger(counts, 'recordsWritten');
  if (artifactCount === 1) {
    if (
      descriptorRecords !== undefined &&
      recordsWritten !== undefined &&
      descriptorRecords !== recordsWritten
    ) {
      return undefined;
    }
    return descriptorRecords ?? recordsWritten;
  }
  return descriptorRecords;
}

function validateModernManifest(manifest: UnknownRecord): boolean {
  if (
    getString(manifest, 'status') !== 'complete' ||
    getString(manifest, 'scope') !== 'full_filter_enumeration'
  ) {
    return false;
  }
  const counts = getObject(manifest, 'counts');
  if (counts === undefined) {
    return false;
  }
  const failed = getNonNegativeInteger(counts, 'doctorRequestsFailed');
  const possibleTruncations = getNonNegativeInteger(counts, 'doctorResponsesAtPossibleSourceLimit');
  const recordsWritten = getNonNegativeInteger(counts, 'recordsWritten');
  if (failed !== 0 || possibleTruncations !== 0 || recordsWritten === undefined) {
    return false;
  }
  const sourceRowsParsed = getNonNegativeInteger(counts, 'sourceRowsParsed');
  const duplicateRowsSkipped = getNonNegativeInteger(counts, 'duplicateRowsSkipped');
  return (
    sourceRowsParsed === undefined ||
    duplicateRowsSkipped === undefined ||
    sourceRowsParsed === recordsWritten + duplicateRowsSkipped
  );
}

function validateLegacyCasmuManifest(manifest: UnknownRecord): boolean {
  if (manifest['schemaVersion'] !== '1.0.0' || getString(manifest, 'provider') !== 'CASMU') {
    return false;
  }
  const extraction = getObject(manifest, 'extraction');
  if (extraction === undefined) {
    return false;
  }
  const sourceRows = getNonNegativeInteger(extraction, 'directorySourceRows');
  const uniqueRows = getNonNegativeInteger(extraction, 'directoryUniqueRecords');
  const duplicateRows = getNonNegativeInteger(extraction, 'directoryDuplicateRowsDiscarded');
  const invalidRows = getNonNegativeInteger(extraction, 'directoryInvalidRows');
  const scheduleRecords = getNonNegativeInteger(extraction, 'scheduleRecords');
  return (
    sourceRows !== undefined &&
    uniqueRows !== undefined &&
    duplicateRows !== undefined &&
    invalidRows !== undefined &&
    scheduleRecords !== undefined &&
    sourceRows === uniqueRows + duplicateRows + invalidRows
  );
}

function validateLegacyHospitalBritanicoManifest(manifest: UnknownRecord): boolean {
  if (
    manifest['schemaVersion'] !== '1.0.0' ||
    getString(manifest, 'provider') !== 'Hospital Británico'
  ) {
    return false;
  }
  const extraction = getObject(manifest, 'extraction');
  if (extraction === undefined) {
    return false;
  }
  const candidateEntries = getNonNegativeInteger(extraction, 'candidateScheduleEntries');
  const invalidPhysicians = getNonNegativeInteger(extraction, 'invalidPhysicianRows');
  const invalidEntries = getNonNegativeInteger(extraction, 'invalidScheduleEntries');
  const duplicateEntries = getNonNegativeInteger(extraction, 'duplicateEntriesDiscarded');
  const scheduleRecords = getNonNegativeInteger(extraction, 'scheduleRecords');
  return (
    candidateEntries !== undefined &&
    invalidPhysicians === 0 &&
    invalidEntries === 0 &&
    duplicateEntries !== undefined &&
    scheduleRecords !== undefined &&
    candidateEntries === scheduleRecords + duplicateEntries
  );
}

function bundleCompatibility(manifest: UnknownRecord): ProviderBundleCompatibilityMode | undefined {
  if (
    manifest['status'] !== undefined ||
    manifest['scope'] !== undefined ||
    manifest['counts'] !== undefined
  ) {
    return validateModernManifest(manifest) ? 'complete_manifest_v1' : undefined;
  }
  if (validateLegacyCasmuManifest(manifest)) {
    return 'legacy_casmu_v1';
  }
  if (validateLegacyHospitalBritanicoManifest(manifest)) {
    return 'legacy_hospital_britanico_v1';
  }
  return undefined;
}

function legacyExpectedRecords(
  manifest: UnknownRecord,
  mode: ProviderBundleCompatibilityMode,
  artifactKey: ProviderArtifactKey,
): number | undefined {
  const extraction = getObject(manifest, 'extraction');
  if (extraction === undefined) {
    return undefined;
  }
  if (mode === 'legacy_casmu_v1') {
    return artifactKey === 'physiciansNdjson'
      ? getNonNegativeInteger(extraction, 'directoryUniqueRecords')
      : artifactKey === 'schedulesNdjson'
        ? getNonNegativeInteger(extraction, 'scheduleRecords')
        : undefined;
  }
  if (mode === 'legacy_hospital_britanico_v1' && artifactKey === 'schedulesNdjson') {
    return getNonNegativeInteger(extraction, 'scheduleRecords');
  }
  return undefined;
}

async function loadProviderBundle(
  dataDirectory: string,
  manifestPath: string,
): Promise<ProviderBundle | undefined> {
  const resolvedManifestPath = resolve(manifestPath);
  if (!isPathInside(dataDirectory, resolvedManifestPath)) {
    return undefined;
  }
  let manifestContent: Buffer;
  try {
    manifestContent = await readFile(resolvedManifestPath);
  } catch (error: unknown) {
    if (isObject(error) && getString(error, 'code') === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const manifestValue = JSON.parse(manifestContent.toString('utf8')) as unknown;
  if (!isObject(manifestValue)) {
    throw new Error(`Provider manifest is not an object: ${resolvedManifestPath}`);
  }
  const artifactsValue = getObject(manifestValue, 'artifacts');
  if (artifactsValue === undefined) {
    return undefined;
  }
  const declaredArtifacts = PROVIDER_ARTIFACT_KEYS.flatMap((artifactKey) => {
    const descriptor = artifactDescriptor(artifactsValue[artifactKey]);
    return descriptor === undefined ? [] : [{ artifactKey, descriptor }];
  });
  if (declaredArtifacts.length === 0) {
    return undefined;
  }

  const compatibilityMode = bundleCompatibility(manifestValue);
  if (compatibilityMode === undefined) {
    return undefined;
  }
  const requiredKeys =
    compatibilityMode === 'legacy_casmu_v1'
      ? new Set<ProviderArtifactKey>(['physiciansNdjson', 'schedulesNdjson'])
      : compatibilityMode === 'legacy_hospital_britanico_v1'
        ? new Set<ProviderArtifactKey>(['schedulesNdjson'])
        : undefined;
  if (
    requiredKeys !== undefined &&
    [...requiredKeys].some(
      (requiredKey) => !declaredArtifacts.some(({ artifactKey }) => artifactKey === requiredKey),
    )
  ) {
    return undefined;
  }

  const runId = getString(manifestValue, 'runId');
  if (runId === undefined || basename(dirname(resolvedManifestPath)) !== runId) {
    return undefined;
  }
  const source = getObject(manifestValue, 'source');
  const provider =
    getString(manifestValue, 'provider') ??
    (source === undefined ? undefined : getString(source, 'institution'));
  const providerKey = (source === undefined ? undefined : getString(source, 'id')) ?? provider;
  if (providerKey === undefined || provider === undefined) {
    return undefined;
  }

  const artifacts: ProviderArtifact[] = [];
  for (const { artifactKey, descriptor } of declaredArtifacts) {
    const legacyRecords =
      compatibilityMode === 'complete_manifest_v1'
        ? undefined
        : legacyExpectedRecords(manifestValue, compatibilityMode, artifactKey);
    if (
      descriptor.expectedRecords !== undefined &&
      legacyRecords !== undefined &&
      descriptor.expectedRecords !== legacyRecords
    ) {
      return undefined;
    }
    const expectedRecords =
      compatibilityMode === 'complete_manifest_v1'
        ? modernManifestExpectedRecords(
            manifestValue,
            descriptor.expectedRecords,
            declaredArtifacts.length,
          )
        : (descriptor.expectedRecords ?? legacyRecords);
    if (expectedRecords === undefined) {
      return undefined;
    }
    const path = await resolveBundleArtifactPath(
      dataDirectory,
      resolvedManifestPath,
      descriptor.declaredPath,
    );
    if (path === undefined) {
      return undefined;
    }
    artifacts.push({
      artifactKey,
      expectedRecords,
      ...(descriptor.expectedSha256 === undefined
        ? {}
        : { expectedSha256: descriptor.expectedSha256 }),
      path,
    });
  }

  const orderKey =
    getString(manifestValue, 'completedAt') ??
    getString(manifestValue, 'generatedAt') ??
    getString(manifestValue, 'startedAt') ??
    runId;
  return {
    artifacts: artifacts.sort(
      (left, right) =>
        left.artifactKey.localeCompare(right.artifactKey) || left.path.localeCompare(right.path),
    ),
    compatibilityMode,
    manifestContent,
    manifestPath: resolvedManifestPath,
    orderKey,
    providerKey,
    providerLabel: provider,
    runId,
  };
}

async function findLatestProviderBundles(
  dataDirectory: string,
): Promise<readonly ProviderBundle[]> {
  const roots = [join(dataDirectory, 'raw', 'mutualistas'), join(dataDirectory, 'processed')];
  const manifestPaths = [
    ...new Set(
      (await Promise.all(roots.map(async (root) => walkFiles(root))))
        .flat()
        .filter((path) => basename(path) === 'manifest.json')
        .map((path) => resolve(path)),
    ),
  ];
  const loaded = await Promise.all(
    manifestPaths.map(async (manifestPath) => loadProviderBundle(dataDirectory, manifestPath)),
  );
  const grouped = new Map<string, ProviderBundle[]>();
  for (const bundle of loaded) {
    if (bundle === undefined) {
      continue;
    }
    const current = grouped.get(bundle.providerKey) ?? [];
    current.push(bundle);
    grouped.set(bundle.providerKey, current);
  }

  return [...grouped.values()]
    .map(
      (bundles) =>
        bundles.sort(
          (left, right) =>
            right.orderKey.localeCompare(left.orderKey) ||
            right.manifestPath.localeCompare(left.manifestPath),
        )[0],
    )
    .filter((bundle): bundle is ProviderBundle => bundle !== undefined)
    .sort((left, right) => left.providerKey.localeCompare(right.providerKey));
}

async function bundlesFromExplicitArtifactPaths(
  dataDirectory: string,
  paths: readonly string[],
): Promise<readonly ProviderBundle[]> {
  const explicitPaths = [...new Set(paths.map((path) => resolve(path)))];
  const explicitPathKeys = new Set(explicitPaths.map(pathIdentity));
  const bundlesByManifest = new Map<string, ProviderBundle>();

  for (const path of explicitPaths) {
    const manifestPath = join(dirname(path), 'manifest.json');
    const bundle = await loadProviderBundle(dataDirectory, manifestPath);
    if (bundle === undefined) {
      throw new Error(
        `Explicit provider input is not part of an eligible complete bundle: ${path}`,
      );
    }
    if (!bundle.artifacts.some((artifact) => pathIdentity(artifact.path) === pathIdentity(path))) {
      throw new Error(`Explicit provider input is not declared by its manifest: ${path}`);
    }
    bundlesByManifest.set(pathIdentity(bundle.manifestPath), bundle);
  }

  const bundles = [...bundlesByManifest.values()];
  for (const bundle of bundles) {
    const missingArtifacts = bundle.artifacts.filter(
      ({ path }) => !explicitPathKeys.has(pathIdentity(path)),
    );
    if (missingArtifacts.length > 0) {
      throw new Error(
        `Explicit provider bundle ${bundle.manifestPath} is incomplete; missing ${missingArtifacts
          .map(({ artifactKey }) => artifactKey)
          .join(', ')}`,
      );
    }
  }
  const providerKeys = new Set<string>();
  for (const bundle of bundles) {
    if (providerKeys.has(bundle.providerKey)) {
      throw new Error(
        `Explicit provider inputs include more than one run for ${bundle.providerLabel}`,
      );
    }
    providerKeys.add(bundle.providerKey);
  }
  return bundles.sort((left, right) => left.providerKey.localeCompare(right.providerKey));
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function serializeNdjson(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid.toString()}.tmp`;
  await writeFile(temporaryPath, content, { flag: 'wx' });
  await rename(temporaryPath, path);
}

function countByStatus(
  candidates: readonly LinkageCandidate[],
): Readonly<Record<LinkageCandidateStatus, number>> {
  return {
    ambiguous_exact_name: candidates.filter(({ status }) => status === 'ambiguous_exact_name')
      .length,
    exact_name_and_title_consistent: candidates.filter(
      ({ status }) => status === 'exact_name_and_title_consistent',
    ).length,
    exact_name_only: candidates.filter(({ status }) => status === 'exact_name_only').length,
    unmatched: candidates.filter(({ status }) => status === 'unmatched').length,
  };
}

export async function runLinkageCandidateBuild(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly manifestPath: string; readonly outputPath: string }> {
  const dataDirectory = resolve(environment['DATA_INGESTION_DIR'] ?? 'data');
  const mspPath = await findMspInput(dataDirectory, environment);
  const explicitProviderPaths = environment['LINKAGE_PROVIDER_INPUT_PATHS']
    ?.split(delimiter)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => resolve(path));
  const providerBundles =
    explicitProviderPaths === undefined || explicitProviderPaths.length === 0
      ? await findLatestProviderBundles(dataDirectory)
      : await bundlesFromExplicitArtifactPaths(dataDirectory, explicitProviderPaths);
  if (providerBundles.length === 0) {
    throw new Error(
      'No mutualista NDJSON inputs found. Run the provider ingestion commands first.',
    );
  }

  const mspProfessionals = await parseNdjson(mspPath, (value) => parseMspProfessional(value));
  const providerArtifacts = providerBundles.flatMap(({ artifacts }) => artifacts);
  const parsedProviderArtifacts = await Promise.all(
    providerArtifacts.map(async (artifact) => parseProviderArtifact(artifact, dataDirectory)),
  );
  const quarantinedRows = parsedProviderArtifacts.flatMap(({ quarantine }) => quarantine);
  if (quarantinedRows.length > 0) {
    const reasonCounts = quarantinedRows.reduce<Partial<Record<ProviderQuarantineReason, number>>>(
      (counts, { reason }) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }),
      {},
    );
    const examples = quarantinedRows
      .slice(0, 10)
      .map(({ reason, rowNumber, sourceFile }) => `${sourceFile}:${String(rowNumber)}:${reason}`)
      .join(', ');
    throw new Error(
      `Provider parsing aborted: physical=${String(
        parsedProviderArtifacts.reduce((total, { physicalRecords }) => total + physicalRecords, 0),
      )}, parsed=${String(
        parsedProviderArtifacts.reduce((total, { observations }) => total + observations.length, 0),
      )}, quarantined=${String(quarantinedRows.length)}, reasons=${JSON.stringify(
        reasonCounts,
      )}, examples=${examples}`,
    );
  }
  const providerRows = parsedProviderArtifacts.flatMap(({ observations }) => observations);
  if (providerRows.length === 0) {
    throw new Error('Complete provider bundles contained no parseable professional observations');
  }
  const candidates = buildLinkageCandidates(mspProfessionals, providerRows);
  const createdAt = new Date().toISOString();
  const runId = `${createdAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const outputDirectory = join(dataDirectory, 'processed', 'linkage', runId);
  const outputPath = join(outputDirectory, 'candidates.ndjson');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const outputContent = serializeNdjson(candidates);
  await writeAtomic(outputPath, outputContent);

  const mspContent = await readFile(mspPath);
  const inputMetadata: LinkageManifest['inputs'] = [
    {
      relativePath: relative(dataDirectory, mspPath).replaceAll('\\', '/'),
      records: mspProfessionals.length,
      sha256: sha256(mspContent),
    },
    ...parsedProviderArtifacts.map(({ artifact, content, observations, physicalRecords }) => ({
      relativePath: relative(dataDirectory, artifact.path).replaceAll('\\', '/'),
      records: physicalRecords,
      parsedRecords: observations.length,
      quarantinedRecords: 0 as const,
      sha256: sha256(content),
    })),
  ];
  const manifest: LinkageManifest = {
    schemaVersion: 2,
    algorithmVersion: 'exact-full-name-candidates-v3',
    createdAt,
    inputs: inputMetadata,
    providerBundles: providerBundles.map((bundle) => ({
      providerKey: bundle.providerKey,
      providerLabel: bundle.providerLabel,
      runId: bundle.runId,
      compatibilityMode: bundle.compatibilityMode,
      manifest: {
        relativePath: relative(dataDirectory, bundle.manifestPath).replaceAll('\\', '/'),
        sha256: sha256(bundle.manifestContent),
      },
      artifacts: parsedProviderArtifacts
        .filter(({ artifact }) =>
          bundle.artifacts.some(
            (bundleArtifact) => pathIdentity(bundleArtifact.path) === pathIdentity(artifact.path),
          ),
        )
        .map(({ artifact, content, physicalRecords }) => ({
          artifactKey: artifact.artifactKey,
          relativePath: relative(dataDirectory, artifact.path).replaceAll('\\', '/'),
          records: physicalRecords,
          sha256: sha256(content),
        }))
        .sort(
          (left, right) =>
            left.artifactKey.localeCompare(right.artifactKey) ||
            left.relativePath.localeCompare(right.relativePath),
        ),
    })),
    output: {
      relativePath: relative(dataDirectory, outputPath).replaceAll('\\', '/'),
      records: candidates.length,
      sha256: sha256(outputContent),
    },
    aggregates: {
      ...countByStatus(candidates),
      providerIdentities: candidates.length,
      providerIdentitiesByExactNameFallback: candidates.filter(
        ({ providerIdentity }) => providerIdentity.basis === 'institution_and_exact_name',
      ).length,
      providerIdentitiesBySourceProfessionalId: candidates.filter(
        ({ providerIdentity }) => providerIdentity.basis === 'source_professional_id',
      ).length,
      providerPhysicalRows: parsedProviderArtifacts.reduce(
        (total, { physicalRecords }) => total + physicalRecords,
        0,
      ),
      quarantinedProviderRows: 0,
      providerRows: providerRows.length,
      mspProfessionals: mspProfessionals.length,
    },
    safeguards: {
      fuzzyMatchingUsed: false,
      automaticallyMerged: false,
      providerBundlesSelectedAtomically: true,
      providerRowsReconciled: true,
      rawGovernmentIdentifiersPublished: false,
    },
  };
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifestPath, outputPath };
}

async function main(): Promise<void> {
  const result = await runLinkageCandidateBuild();
  console.log(JSON.stringify({ event: 'linkage_candidates_completed', ...result }));
}

function loadOptionalDataEnvironment(): void {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error: unknown) {
    if (!(isObject(error) && getString(error, 'code') === 'ENOENT')) {
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
