import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';

import { DIRECTORY_NOTICE_VERSION } from '../directory/build-directory-snapshot';
import {
  INFOTITULOS_DATASET,
  INFOTITULOS_HEADERS,
  INFOTITULOS_LINKAGE_VERSION,
  INFOTITULOS_PUBLISHER,
} from '../msp/ingest-infotitulos';

import {
  buildPublicDirectoryProfiles,
  parseCanonicalApprovedSourcePublicationPolicy,
  verifyDetachedPublicationPolicySignature,
} from './public-directory-policy';
import {
  assertDistinctPublicationSecrets,
  decodeCanonicalPublicationSecret,
} from './publication-secret';

import type {
  PublicDirectoryProfile,
  PublicDirectorySourceProfile,
} from './public-directory-policy';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface ArtifactMetadata {
  readonly relativePath: string;
  readonly records: number;
  readonly sha256: string;
}

interface DirectoryInputManifest {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly generatedAt: string;
  readonly noticeVersion: typeof DIRECTORY_NOTICE_VERSION;
  readonly inputs: readonly ArtifactMetadata[];
  readonly profiles: ArtifactMetadata;
  readonly linkageResolutions: ArtifactMetadata;
  readonly legalNotice: ArtifactMetadata;
}

interface PublicDirectoryExportResult {
  readonly manifestPath: string;
  readonly profilesPath: string;
  readonly records: number;
}

export interface DeliverablePublicDirectoryArtifact {
  readonly manifestPath: string;
  readonly profilesContent: string;
  readonly records: number;
  readonly effectiveValidUntil: string;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredObject(parent: UnknownRecord, key: string): UnknownRecord {
  const value = parent[key];

  if (!isObject(value)) {
    throw new Error(`Directory field "${key}" must be an object`);
  }

  return value;
}

function assertExactKeys(value: UnknownRecord, expectedKeys: readonly string[]): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(
      `Directory object must contain exactly these fields: ${sortedExpectedKeys.join(', ')}`,
    );
  }
}

function requiredString(parent: UnknownRecord, key: string): string {
  const value = parent[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Directory field "${key}" must be a non-empty string`);
  }

  return value.trim();
}

function requiredNumber(parent: UnknownRecord, key: string): number {
  const value = parent[key];

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Directory field "${key}" must be a non-negative integer`);
  }

  return value;
}

function requiredIsoDate(parent: UnknownRecord, key: string): string {
  const value = requiredString(parent, key);

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`Directory field "${key}" must be an ISO date`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Directory field "${key}" must be an ISO date`);
  }

  return value;
}

function requiredCanonicalDateTime(parent: UnknownRecord, key: string): string {
  const value = requiredString(parent, key);
  const date = new Date(value);

  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Directory field "${key}" must be a canonical ISO date-time`);
  }

  return value;
}

function requiredHttpsUrl(parent: UnknownRecord, key: string): string {
  const value = requiredString(parent, key);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Directory field "${key}" must be an absolute HTTPS URL`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Directory field "${key}" must be an absolute HTTPS URL`);
  }

  return url.toString();
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertValidClock(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  throw new Error('Public directory manifest contains a non-canonical value');
}

function publicArtifactAuthenticationTag(document: unknown, key: Buffer): string {
  return createHmac('sha256', key)
    .update('medicos-public-directory-artifact:v1\u0000', 'utf8')
    .update(canonicalJson(document), 'utf8')
    .digest('hex');
}

function validatedArtifactAuthenticationKeyId(value: string): string {
  const keyId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(keyId)) {
    throw new Error('Public directory artifact authentication key id is invalid');
  }

  return keyId;
}

function authenticatedPublicManifestContent(options: {
  readonly body: UnknownRecord;
  readonly authenticationKey: Buffer;
  readonly authenticationKeyId: string;
}): string {
  const authenticationKeyId = validatedArtifactAuthenticationKeyId(options.authenticationKeyId);

  const unsignedDocument = {
    ...options.body,
    authentication: {
      algorithm: 'HMAC-SHA256',
      keyId: authenticationKeyId,
    },
  };
  const tag = publicArtifactAuthenticationTag(unsignedDocument, options.authenticationKey);

  return `${JSON.stringify(
    {
      ...unsignedDocument,
      authentication: {
        ...unsignedDocument.authentication,
        tag,
      },
    },
    null,
    2,
  )}\n`;
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent.length === 0 || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

async function resolveExistingPathInside(
  dataRoot: string,
  candidate: string,
  label: string,
): Promise<string> {
  const [realDataRoot, realCandidate] = await Promise.all([
    realpath(dataRoot),
    realpath(candidate),
  ]);

  if (!isPathInside(realDataRoot, realCandidate)) {
    throw new Error(`${label} must stay inside DATA_INGESTION_DIR`);
  }

  return realCandidate;
}

async function resolveFuturePathInside(
  dataRoot: string,
  candidate: string,
  label: string,
): Promise<string> {
  const realDataRoot = await realpath(dataRoot);
  let existingAncestor = resolve(candidate);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const realAncestor = await realpath(existingAncestor);
      const projectedPath = resolve(realAncestor, ...missingSegments);

      if (!isPathInside(realDataRoot, projectedPath)) {
        throw new Error(`${label} must stay inside DATA_INGESTION_DIR`);
      }

      return projectedPath;
    } catch (error) {
      const code = isObject(error) ? error['code'] : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }

      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error(`${label} has no existing ancestor inside DATA_INGESTION_DIR`, {
          cause: error,
        });
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function portableArtifactPath(parent: UnknownRecord, key: string): string {
  const value = requiredString(parent, key);
  const segments = value.split('/');

  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Directory field "${key}" must be a portable relative artifact path`);
  }

  return value;
}

function parseArtifactMetadata(value: unknown, label: string): ArtifactMetadata {
  if (!isObject(value)) {
    throw new Error(`Directory ${label} metadata must be an object`);
  }

  const artifactSha256 = requiredString(value, 'sha256');
  if (!/^[0-9a-f]{64}$/u.test(artifactSha256)) {
    throw new Error(`Directory ${label} hash is invalid`);
  }

  return {
    relativePath: portableArtifactPath(value, 'relativePath'),
    records: requiredNumber(value, 'records'),
    sha256: artifactSha256,
  };
}

function parseDirectoryInputManifest(value: unknown, now: Date): DirectoryInputManifest {
  if (!isObject(value)) {
    throw new Error('Directory manifest must be a JSON object');
  }

  if (value['schemaVersion'] !== 2 || value['noticeVersion'] !== DIRECTORY_NOTICE_VERSION) {
    throw new Error('Directory manifest must be a factual-v3 schema version 2 artifact');
  }
  const snapshotId = requiredString(value, 'snapshotId');
  if (!/^factual-v3-[0-9a-f]{16}$/u.test(snapshotId)) {
    throw new Error('Directory manifest has an invalid factual-v3 snapshotId');
  }
  const generatedAt = requiredCanonicalDateTime(value, 'generatedAt');
  if (new Date(generatedAt).getTime() > now.getTime()) {
    throw new Error('Directory manifest has a future generatedAt');
  }
  const safeguards = requiredObject(value, 'safeguards');
  if (
    safeguards['adverseDataAttached'] !== false ||
    safeguards['automaticallyMerged'] !== false ||
    safeguards['exhaustiveResolutionLedger'] !== true ||
    safeguards['fuzzyMatchingUsed'] !== false ||
    safeguards['institutionalObservationsAttached'] !== false ||
    safeguards['institutionalLinksPublished'] !== false ||
    safeguards['internalLinkageIdsPresent'] !== true ||
    safeguards['publicExportAllowed'] !== false ||
    safeguards['rawGovernmentIdentifiersPublished'] !== false ||
    safeguards['reviewsAttached'] !== false
  ) {
    throw new Error('Directory manifest violates the factual-v3 safeguards');
  }
  const publicationGate = requiredObject(value, 'publicationGate');
  const approval = requiredObject(publicationGate, 'approval');
  if (
    publicationGate['state'] !== 'blocked' ||
    approval['required'] !== true ||
    approval['approved'] !== false ||
    publicationGate['sourceApprovalRequired'] !== true ||
    publicationGate['disclaimerAloneCreatesLegalBasis'] !== false
  ) {
    throw new Error('Directory manifest does not contain the blocked internal publication gate');
  }

  const rawInputs = value['inputs'];
  if (!Array.isArray(rawInputs) || rawInputs.length !== 4) {
    throw new Error('Directory manifest must contain exactly four factual-v3 inputs');
  }
  const inputs = rawInputs.map((input, index) =>
    parseArtifactMetadata(input, `input ${index + 1}`),
  );
  if (new Set(inputs.map((input) => input.relativePath)).size !== inputs.length) {
    throw new Error('Directory manifest input paths must be unique');
  }

  const outputs = requiredObject(value, 'outputs');
  const profiles = parseArtifactMetadata(outputs['profiles'], 'profiles output');
  const linkageResolutions = parseArtifactMetadata(
    outputs['linkageResolutions'],
    'linkage resolutions output',
  );
  const legalNotice = parseArtifactMetadata(outputs['legalNotice'], 'legal notice output');

  return {
    schemaVersion: 2,
    snapshotId,
    generatedAt,
    noticeVersion: DIRECTORY_NOTICE_VERSION,
    inputs,
    profiles,
    linkageResolutions,
    legalNotice,
  };
}

function parseJsonObject(content: string, label: string): UnknownRecord {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, {
      cause: error,
    });
  }

  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value;
}

function assertMetadataMatches(
  actual: UnknownRecord,
  expected: ArtifactMetadata,
  label: string,
): void {
  if (
    requiredString(actual, 'relativePath') !== expected.relativePath ||
    requiredNumber(actual, 'records') !== expected.records ||
    requiredString(actual, 'sha256') !== expected.sha256
  ) {
    throw new Error(`${label} does not match the factual-v3 input chain`);
  }
}

function ndjsonRecordCount(content: string): number {
  return content.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
}

async function readVerifiedArtifact(
  dataRoot: string,
  metadata: ArtifactMetadata,
  label: string,
): Promise<{ readonly content: string; readonly path: string }> {
  const path = await resolveExistingPathInside(
    dataRoot,
    resolve(dataRoot, ...metadata.relativePath.split('/')),
    label,
  );
  const content = await readFile(path, 'utf8');

  if (sha256(content) !== metadata.sha256) {
    throw new Error(`${label} hash does not match the factual-v3 manifest`);
  }

  return { content, path };
}

function expectedInputMetadata(
  inputs: readonly ArtifactMetadata[],
  pattern: RegExp,
  label: string,
): ArtifactMetadata {
  const matches = inputs.filter((input) => pattern.test(input.relativePath));
  if (matches.length !== 1) {
    throw new Error(`Directory manifest must contain exactly one ${label}`);
  }

  return matches[0]!;
}

function validateMspManifest(content: string, professionals: ArtifactMetadata): string {
  const manifest = parseJsonObject(content, 'MSP input manifest');
  if (manifest['schemaVersion'] !== 1) {
    throw new Error('MSP input manifest must use schema version 1');
  }

  const source = requiredObject(manifest, 'source');
  if (
    requiredString(source, 'publisher') !== INFOTITULOS_PUBLISHER ||
    requiredString(source, 'dataset') !== INFOTITULOS_DATASET
  ) {
    throw new Error('MSP input manifest has an unexpected publisher or dataset');
  }
  const sourceCutoffDate = requiredIsoDate(source, 'sourceCutoffDate');

  const linkage = requiredObject(manifest, 'linkage');
  if (
    linkage['algorithm'] !== 'HMAC-SHA256' ||
    linkage['version'] !== INFOTITULOS_LINKAGE_VERSION ||
    linkage['rawIdentifiersPublished'] !== false
  ) {
    throw new Error('MSP input manifest violates the opaque linkage contract');
  }

  const quality = requiredObject(manifest, 'quality');
  const exactHeaders = quality['exactHeaders'];
  if (
    !Array.isArray(exactHeaders) ||
    exactHeaders.length !== INFOTITULOS_HEADERS.length ||
    exactHeaders.some((header, index) => header !== INFOTITULOS_HEADERS[index])
  ) {
    throw new Error('MSP input manifest violates the exact Infotítulos header contract');
  }

  const outputs = requiredObject(manifest, 'outputs');
  assertMetadataMatches(
    requiredObject(outputs, 'professionals'),
    professionals,
    'MSP professionals output',
  );
  const quarantine = requiredObject(outputs, 'quarantine');
  const aggregates = requiredObject(manifest, 'aggregates');
  const actualConflicts = requiredNumber(quality, 'actualIdentityConflicts');
  if (
    requiredNumber(quality, 'expectedIdentityConflicts') !== actualConflicts ||
    requiredNumber(quarantine, 'records') !== actualConflicts ||
    requiredNumber(aggregates, 'publishedProfessionals') !== professionals.records ||
    requiredNumber(aggregates, 'quarantinedIdentityConflicts') !== actualConflicts
  ) {
    throw new Error('MSP input manifest quarantine invariants do not reconcile');
  }

  return sourceCutoffDate;
}

function validateLinkageManifest(
  content: string,
  candidates: ArtifactMetadata,
  mspProfessionals: ArtifactMetadata,
): void {
  const manifest = parseJsonObject(content, 'Linkage input manifest');
  if (
    manifest['schemaVersion'] !== 2 ||
    manifest['algorithmVersion'] !== 'exact-full-name-candidates-v3'
  ) {
    throw new Error('Linkage input manifest must use schema 2 and algorithm v3');
  }

  assertMetadataMatches(
    requiredObject(manifest, 'output'),
    candidates,
    'Linkage candidates output',
  );
  const safeguards = requiredObject(manifest, 'safeguards');
  if (
    safeguards['fuzzyMatchingUsed'] !== false ||
    safeguards['automaticallyMerged'] !== false ||
    safeguards['rawGovernmentIdentifiersPublished'] !== false
  ) {
    throw new Error('Linkage input manifest violates the fail-closed safeguards');
  }

  const inputs = manifest['inputs'];
  if (
    !Array.isArray(inputs) ||
    !inputs.some(
      (input) =>
        isObject(input) &&
        input['relativePath'] === mspProfessionals.relativePath &&
        input['records'] === mspProfessionals.records &&
        input['sha256'] === mspProfessionals.sha256,
    )
  ) {
    throw new Error('Linkage input manifest is not bound to the selected MSP artifact');
  }
}

function validateLegalNotice(content: string): void {
  const notice = parseJsonObject(content, 'Directory legal notice');
  if (
    notice['schemaVersion'] !== 2 ||
    notice['noticeVersion'] !== DIRECTORY_NOTICE_VERSION ||
    notice['language'] !== 'es-UY' ||
    notice['status'] !== 'template_not_approved_for_publication'
  ) {
    throw new Error('Directory legal notice violates the factual-v3 contract');
  }

  const controller = requiredObject(notice, 'controller');
  const processing = requiredObject(notice, 'processing');
  const article13 = requiredObject(notice, 'article13');
  const database = requiredObject(article13, 'database');
  const collection = requiredObject(article13, 'collection');
  const automatedAssessment = requiredObject(article13, 'automatedAssessment');
  const rights = requiredObject(notice, 'rights');
  const access = requiredObject(rights, 'access');
  const rectification = requiredObject(rights, 'rectification');
  const gate = requiredObject(notice, 'publicationGate');
  const approval = requiredObject(gate, 'approval');
  const rightsEmail = requiredString(controller, 'rightsEmail');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(rightsEmail)) {
    throw new Error('Directory legal notice rights email is invalid');
  }
  requiredString(controller, 'name');
  requiredString(controller, 'address');
  requiredHttpsUrl(controller, 'privacyNoticeUrl');
  requiredString(controller, 'urcdpRegistration');
  requiredString(notice, 'purpose');
  requiredString(notice, 'shortProfileNotice');
  requiredString(database, 'name');
  requiredString(processing, 'processorsNotice');
  requiredString(processing, 'recipientsNotice');
  requiredString(processing, 'internationalTransfersNotice');
  const missingConfiguration = gate['missingConfiguration'];
  const mandatoryApprovals = gate['mandatoryApprovals'];
  const availableRights = rights['available'];
  const expectedRights = ['access', 'rectification', 'update', 'inclusion', 'suppression'];
  const expectedApprovals = [
    'legal_and_privacy_review',
    'database_registration',
    'rights_request_workflow',
    'source_by_source_reuse_assessment',
    'security_and_retention_controls',
    'impact_assessment_and_dpo_determination',
  ];
  if (
    processing['exclusivelyAutomatedDecisions'] !== false ||
    processing['professionalDataSold'] !== false ||
    database['exists'] !== true ||
    collection['directlyFromDataSubject'] !== false ||
    collection['questionnaireUsed'] !== false ||
    collection['responseRequirement'] !== 'not_applicable_no_questionnaire' ||
    collection['consequencesOfProvidingData'] !== 'not_applicable_no_questionnaire' ||
    collection['consequencesOfRefusal'] !== 'no_service_or_right_is_conditioned_on_answering' ||
    collection['consequencesOfInaccuracy'] !==
      'record_is_marked_under_review_and_corrected_if_verified' ||
    article13['informationOnRequestMaximumBusinessDays'] !== 5 ||
    automatedAssessment['used'] !== false ||
    automatedAssessment['criteria'] !== null ||
    automatedAssessment['processes'] !== null ||
    automatedAssessment['technology'] !== null ||
    !Array.isArray(availableRights) ||
    availableRights.length !== expectedRights.length ||
    availableRights.some((right, index) => right !== expectedRights[index]) ||
    rights['maximumResponseTimeBusinessDays'] !== 5 ||
    rights['disputedDataState'] !== 'under_review' ||
    access['identityVerificationRequired'] !== true ||
    access['freeExerciseIntervalMonths'] !== 6 ||
    access['renewedLegitimateInterestException'] !== true ||
    access['completeRecordRequired'] !== true ||
    access['clearAccessibleFormatRequired'] !== true ||
    access['thirdPartyDataDisclosureProhibited'] !== true ||
    rectification['freeOfCharge'] !== true ||
    rectification['errorFalsityOrExclusionCovered'] !== true ||
    rectification['markAsUnderReviewDuringVerification'] !== true ||
    rectification['notifyRecipientsMaximumBusinessDays'] !== 5 ||
    !Array.isArray(missingConfiguration) ||
    missingConfiguration.length !== 0 ||
    !Array.isArray(mandatoryApprovals) ||
    mandatoryApprovals.length !== expectedApprovals.length ||
    mandatoryApprovals.some(
      (mandatoryApproval, index) => mandatoryApproval !== expectedApprovals[index],
    ) ||
    gate['state'] !== 'blocked' ||
    approval['required'] !== true ||
    approval['approved'] !== false ||
    gate['sourceApprovalRequired'] !== true ||
    gate['disclaimerAloneCreatesLegalBasis'] !== false
  ) {
    throw new Error(
      'Directory legal notice is incomplete or does not preserve the fail-closed publication gate',
    );
  }
}

function validateLinkageResolutions(content: string, expectedRecords: number): void {
  const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== expectedRecords) {
    throw new Error('Directory linkage resolution count does not match its manifest');
  }

  lines.forEach((line, index) => {
    const resolution = parseJsonObject(line, `Directory linkage resolution row ${index + 1}`);
    if (
      resolution['outcome'] !== 'ABSTAINED' ||
      resolution['publicationState'] !== 'not_public' ||
      resolution['selectedMspLinkageId'] !== null
    ) {
      throw new Error(
        `Directory linkage resolution row ${index + 1} violates the non-public abstention contract`,
      );
    }
  });
}

async function validateDirectoryArtifactChain(options: {
  readonly dataRoot: string;
  readonly inputDirectory: string;
  readonly manifest: DirectoryInputManifest;
}): Promise<{ readonly mspSourceCutoffDate: string }> {
  const mspProfessionals = expectedInputMetadata(
    options.manifest.inputs,
    /^processed\/msp\/infotitulos\/[^/]+\/professionals\.ndjson$/u,
    'MSP professionals input',
  );
  const linkageCandidates = expectedInputMetadata(
    options.manifest.inputs,
    /^processed\/linkage\/[^/]+\/candidates\.ndjson$/u,
    'linkage candidates input',
  );
  const mspManifestRelativePath = mspProfessionals.relativePath.replace(
    /professionals\.ndjson$/u,
    'manifest.json',
  );
  const linkageManifestRelativePath = linkageCandidates.relativePath.replace(
    /candidates\.ndjson$/u,
    'manifest.json',
  );
  const mspManifest = expectedInputMetadata(
    options.manifest.inputs,
    new RegExp(`^${mspManifestRelativePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'),
    'MSP manifest input',
  );
  const linkageManifest = expectedInputMetadata(
    options.manifest.inputs,
    new RegExp(`^${linkageManifestRelativePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'),
    'linkage manifest input',
  );

  const expectedOutputBase = `processed/directory/${options.manifest.snapshotId}`;
  if (
    options.manifest.profiles.relativePath !== `${expectedOutputBase}/profiles.ndjson` ||
    options.manifest.linkageResolutions.relativePath !==
      `${expectedOutputBase}/linkage-resolutions.ndjson` ||
    options.manifest.legalNotice.relativePath !==
      `${expectedOutputBase}/privacy-and-publication-notice.json`
  ) {
    throw new Error('Directory outputs do not belong to the selected factual-v3 snapshot');
  }

  const [
    mspProfessionalsArtifact,
    linkageCandidatesArtifact,
    mspManifestArtifact,
    linkageManifestArtifact,
    linkageResolutionsArtifact,
    legalNoticeArtifact,
  ] = await Promise.all([
    readVerifiedArtifact(options.dataRoot, mspProfessionals, 'MSP professionals input'),
    readVerifiedArtifact(options.dataRoot, linkageCandidates, 'Linkage candidates input'),
    readVerifiedArtifact(options.dataRoot, mspManifest, 'MSP manifest input'),
    readVerifiedArtifact(options.dataRoot, linkageManifest, 'Linkage manifest input'),
    readVerifiedArtifact(
      options.dataRoot,
      options.manifest.linkageResolutions,
      'Directory linkage resolutions',
    ),
    readVerifiedArtifact(options.dataRoot, options.manifest.legalNotice, 'Directory legal notice'),
  ]);

  if (
    ndjsonRecordCount(mspProfessionalsArtifact.content) !== mspProfessionals.records ||
    ndjsonRecordCount(linkageCandidatesArtifact.content) !== linkageCandidates.records ||
    mspManifest.records !== 1 ||
    linkageManifest.records !== 1 ||
    options.manifest.legalNotice.records !== 1
  ) {
    throw new Error('Directory input chain record counts do not reconcile');
  }
  const recomputedSnapshotId = `factual-v3-${sha256(
    [
      mspProfessionals.sha256,
      linkageCandidates.sha256,
      mspManifest.sha256,
      linkageManifest.sha256,
      options.manifest.legalNotice.sha256,
      DIRECTORY_NOTICE_VERSION,
    ].join('\u0000'),
  ).slice(0, 16)}`;
  if (options.manifest.snapshotId !== recomputedSnapshotId) {
    throw new Error('Directory snapshotId does not match the verified factual-v3 hash chain');
  }

  const mspSourceCutoffDate = validateMspManifest(mspManifestArtifact.content, mspProfessionals);
  validateLinkageManifest(linkageManifestArtifact.content, linkageCandidates, mspProfessionals);
  validateLinkageResolutions(
    linkageResolutionsArtifact.content,
    options.manifest.linkageResolutions.records,
  );
  validateLegalNotice(legalNoticeArtifact.content);

  const realInputDirectory = await realpath(options.inputDirectory);
  for (const artifact of [linkageResolutionsArtifact, legalNoticeArtifact]) {
    if (!isPathInside(realInputDirectory, artifact.path)) {
      throw new Error('Directory output artifact must stay inside the selected snapshot');
    }
  }

  return { mspSourceCutoffDate };
}

function parseTemporaryRegistration(value: unknown): 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT' {
  if (value === 'NONE' || value === 'WITH_CONTRACT' || value === 'WITHOUT_CONTRACT') {
    return value;
  }

  throw new Error('Directory registered title has an invalid temporary registration value');
}

function parseDirectorySourceProfile(value: unknown): PublicDirectorySourceProfile {
  if (!isObject(value)) {
    throw new Error('Directory profile must be a JSON object');
  }

  if (value['schemaVersion'] !== 2) {
    throw new Error('Directory profile must use factual-v3 schema version 2');
  }
  const internalLinkageId = requiredString(value, 'internalLinkageId');
  if (!/^msp_doc_v1_[0-9a-f]{64}$/u.test(internalLinkageId)) {
    throw new Error('Directory profile has an invalid internal linkage id');
  }

  const rawTitles = value['registeredTitles'];
  if (!Array.isArray(rawTitles)) {
    throw new Error('Directory profile registeredTitles must be an array');
  }

  const registeredTitles = rawTitles.map((rawTitle) => {
    if (!isObject(rawTitle)) {
      throw new Error('Directory registered title must be an object');
    }

    return {
      title: requiredString(rawTitle, 'title'),
      temporaryRegistration: parseTemporaryRegistration(rawTitle['temporaryRegistration']),
    };
  });

  if (registeredTitles.length === 0) {
    throw new Error('Directory profile must contain at least one registered title');
  }

  const registry = requiredObject(value, 'officialRegistry');
  const sourceCutoffDate = requiredIsoDate(registry, 'sourceCutoffDate');
  const notice = requiredObject(value, 'notice');
  if (
    notice['noticeVersion'] !== DIRECTORY_NOTICE_VERSION ||
    notice['status'] !== 'internal_research_only' ||
    notice['sourceCutoffDate'] !== sourceCutoffDate
  ) {
    throw new Error('Directory profile does not contain the factual-v3 internal notice');
  }
  const publication = requiredObject(value, 'publication');
  if (
    publication['profileFacts'] !== 'pending_evidence_and_legal_approval' ||
    publication['institutionalLinks'] !== 'not_public' ||
    publication['publicExportAllowed'] !== false
  ) {
    throw new Error('Directory profile violates the blocked internal publication contract');
  }

  return {
    internalLinkageId,
    displayName: requiredString(value, 'displayName'),
    registeredTitles,
    officialRegistry: {
      publisher: requiredString(registry, 'publisher'),
      dataset: requiredString(registry, 'dataset'),
      sourceCutoffDate,
      datasetUrl: requiredHttpsUrl(registry, 'datasetUrl'),
      liveLookupUrl: requiredHttpsUrl(registry, 'liveLookupUrl'),
    },
  };
}

function parseProfiles(content: string): readonly PublicDirectorySourceProfile[] {
  const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    try {
      return parseDirectorySourceProfile(JSON.parse(line) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid directory profile at NDJSON row ${index + 1}: ${message}`, {
        cause: error,
      });
    }
  });
}

function serializeProfiles(profiles: readonly PublicDirectoryProfile[]): string {
  return `${profiles.map((profile) => JSON.stringify(profile)).join('\n')}\n`;
}

function artifactCreatedAt(content: string, path: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Existing publication manifest is invalid JSON: ${path}`, {
      cause: error,
    });
  }

  if (!isObject(value)) {
    throw new Error(`Existing publication manifest must be an object: ${path}`);
  }

  const createdAt = requiredString(value, 'createdAt');
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) {
    throw new Error(`Existing publication manifest has an invalid createdAt: ${path}`);
  }

  return date.toISOString();
}

async function readArtifactPair(
  outputDirectory: string,
): Promise<{ readonly manifest: string; readonly profiles: string } | undefined> {
  const profilesPath = join(outputDirectory, 'profiles.ndjson');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const [profiles, manifest] = await Promise.allSettled([
    readFile(profilesPath, 'utf8'),
    readFile(manifestPath, 'utf8'),
  ]);
  const profilesMissing =
    profiles.status === 'rejected' &&
    isObject(profiles.reason) &&
    profiles.reason['code'] === 'ENOENT';
  const manifestMissing =
    manifest.status === 'rejected' &&
    isObject(manifest.reason) &&
    manifest.reason['code'] === 'ENOENT';

  if (profilesMissing && manifestMissing) {
    return undefined;
  }

  if (profiles.status === 'rejected') {
    throw profiles.reason;
  }
  if (manifest.status === 'rejected') {
    throw manifest.reason;
  }

  return {
    profiles: profiles.value,
    manifest: manifest.value,
  };
}

async function installPublicationArtifact(options: {
  readonly dataRoot: string;
  readonly outputRoot: string;
  readonly outputDirectory: string;
  readonly profilesContent: string;
  readonly manifestForCreatedAt: (createdAt: string) => string;
  readonly proposedCreatedAt: string;
}): Promise<void> {
  await mkdir(options.outputRoot, {
    recursive: true,
  });

  const verifyExisting = async (): Promise<boolean> => {
    const existing = await readArtifactPair(options.outputDirectory);
    if (existing === undefined) {
      return false;
    }

    await resolveExistingPathInside(
      options.dataRoot,
      options.outputDirectory,
      'Existing publication artifact',
    );
    const existingCreatedAt = artifactCreatedAt(
      existing.manifest,
      join(options.outputDirectory, 'manifest.json'),
    );
    const expectedManifest = options.manifestForCreatedAt(existingCreatedAt);
    if (existing.profiles !== options.profilesContent || existing.manifest !== expectedManifest) {
      throw new Error(
        `Refusing to overwrite a different publication artifact: ${options.outputDirectory}`,
      );
    }

    return true;
  };

  if (await verifyExisting()) {
    return;
  }

  const stagingDirectory = await mkdtemp(join(options.outputRoot, '.public-v1-stage-'));
  try {
    await Promise.all([
      writeFile(join(stagingDirectory, 'profiles.ndjson'), options.profilesContent, {
        encoding: 'utf8',
        flag: 'wx',
      }),
      writeFile(
        join(stagingDirectory, 'manifest.json'),
        options.manifestForCreatedAt(options.proposedCreatedAt),
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      ),
    ]);

    try {
      await rename(stagingDirectory, options.outputDirectory);
    } catch (error) {
      if (await verifyExisting()) {
        return;
      }

      throw error;
    }
  } finally {
    await rm(stagingDirectory, {
      recursive: true,
      force: true,
    });
  }
}

function assertSourceFreshness(options: {
  readonly profiles: readonly PublicDirectorySourceProfile[];
  readonly mspSourceCutoffDate: string;
  readonly maxSourceAgeDays: number;
  readonly now: Date;
}): void {
  const cutoffDates = new Set(
    options.profiles.map((profile) => profile.officialRegistry.sourceCutoffDate),
  );
  if (cutoffDates.size !== 1 || !cutoffDates.has(options.mspSourceCutoffDate)) {
    throw new Error('Directory profile cutoff dates do not match the selected MSP manifest');
  }

  const cutoffAt = new Date(`${options.mspSourceCutoffDate}T00:00:00.000Z`).getTime();
  const todayAt = Date.UTC(
    options.now.getUTCFullYear(),
    options.now.getUTCMonth(),
    options.now.getUTCDate(),
  );
  const ageDays = (todayAt - cutoffAt) / 86_400_000;

  if (ageDays < 0) {
    throw new Error('Directory profile source cutoff date cannot be in the future');
  }
  if (ageDays > options.maxSourceAgeDays) {
    throw new Error(
      `Directory profile source is older than the approved ${options.maxSourceAgeDays}-day limit`,
    );
  }
}

export async function runPublicDirectoryExport(options: {
  readonly dataRoot: string;
  readonly inputDirectory?: string;
  readonly outputRoot?: string;
  readonly policyPath: string;
  readonly policySignaturePath: string;
  readonly policyPublicKeyPath: string;
  readonly policySignerKeyId: string;
  readonly trustedPolicyPublicKeySha256: string;
  readonly artifactAuthenticationKey: string;
  readonly artifactAuthenticationKeyId: string;
  readonly publicProfileSecret: string;
  readonly now?: Date;
}): Promise<PublicDirectoryExportResult> {
  const validationNow = options.now ?? new Date();
  assertValidClock(validationNow, 'Publication validation clock');
  const artifactAuthenticationKey = decodeCanonicalPublicationSecret(
    options.artifactAuthenticationKey,
    'PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY',
  );
  const publicProfileSecret = decodeCanonicalPublicationSecret(
    options.publicProfileSecret,
    'PUBLIC_PROFILE_ID_SECRET',
  );
  assertDistinctPublicationSecrets({
    left: artifactAuthenticationKey,
    leftLabel: 'PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY',
    right: publicProfileSecret,
    rightLabel: 'PUBLIC_PROFILE_ID_SECRET',
  });
  const artifactAuthenticationKeyId = validatedArtifactAuthenticationKeyId(
    options.artifactAuthenticationKeyId,
  );
  publicArtifactAuthenticationTag(
    {
      keyValidation: 'medicos-public-directory-artifact:v1',
    },
    artifactAuthenticationKey,
  );
  const policyPath = resolve(options.policyPath);
  const policySignaturePath = resolve(options.policySignaturePath);
  const policyPublicKeyPath = resolve(options.policyPublicKeyPath);
  const [policyContent, policySignatureContent, policyPublicKeyPem] = await Promise.all([
    readFile(policyPath, 'utf8'),
    readFile(policySignaturePath, 'utf8'),
    readFile(policyPublicKeyPath, 'utf8'),
  ]);
  const verifiedSignature = verifyDetachedPublicationPolicySignature({
    policyContent,
    signatureContent: policySignatureContent,
    publicKeyPem: policyPublicKeyPem,
    expectedPublicKeySha256: options.trustedPolicyPublicKeySha256,
    signerKeyId: options.policySignerKeyId,
  });
  const policy = parseCanonicalApprovedSourcePublicationPolicy(policyContent, validationNow);
  const dataRoot = await realpath(resolve(options.dataRoot));
  const inputDirectory = await resolveExistingPathInside(
    dataRoot,
    options.inputDirectory === undefined
      ? join(dataRoot, 'processed', 'directory', policy.approvedSnapshot.snapshotId)
      : resolve(options.inputDirectory),
    'Directory publication input',
  );
  const outputRoot = await resolveFuturePathInside(
    dataRoot,
    options.outputRoot === undefined
      ? join(dataRoot, 'processed', 'public-directory')
      : resolve(options.outputRoot),
    'Directory publication output',
  );
  const manifestPath = await resolveExistingPathInside(
    dataRoot,
    join(inputDirectory, 'manifest.json'),
    'Directory manifest',
  );
  const profilesPath = await resolveExistingPathInside(
    dataRoot,
    join(inputDirectory, 'profiles.ndjson'),
    'Directory profiles',
  );
  const [manifestContent, profilesContent] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(profilesPath, 'utf8'),
  ]);
  const inputManifest = parseDirectoryInputManifest(
    JSON.parse(manifestContent) as unknown,
    validationNow,
  );
  if (
    basename(inputDirectory) !== inputManifest.snapshotId ||
    resolve(dataRoot, ...inputManifest.profiles.relativePath.split('/')) !== profilesPath
  ) {
    throw new Error('Directory manifest paths do not match the selected factual-v3 snapshot');
  }
  const actualProfilesSha256 = sha256(profilesContent);

  if (actualProfilesSha256 !== inputManifest.profiles.sha256) {
    throw new Error('Directory profiles hash does not match its manifest');
  }
  if (
    policy.approvedSnapshot.snapshotId !== inputManifest.snapshotId ||
    policy.approvedSnapshot.profilesSha256 !== actualProfilesSha256
  ) {
    throw new Error('Signed publication policy does not approve the selected factual-v3 snapshot');
  }

  const validatedChain = await validateDirectoryArtifactChain({
    dataRoot,
    inputDirectory,
    manifest: inputManifest,
  });
  const sourceProfiles = parseProfiles(profilesContent);
  if (sourceProfiles.length !== inputManifest.profiles.records) {
    throw new Error('Directory profile count does not match its manifest');
  }
  assertSourceFreshness({
    profiles: sourceProfiles,
    mspSourceCutoffDate: validatedChain.mspSourceCutoffDate,
    maxSourceAgeDays: policy.source.maxSourceAgeDays,
    now: validationNow,
  });

  const publicProfiles = buildPublicDirectoryProfiles(
    sourceProfiles,
    policy,
    options.publicProfileSecret,
  );
  const outputContent = serializeProfiles(publicProfiles);
  const policySha256 = sha256(policyContent);
  const outputSha256 = sha256(outputContent);
  const fingerprint = sha256(
    [
      inputManifest.snapshotId,
      inputManifest.profiles.sha256,
      policySha256,
      verifiedSignature.signatureSha256,
      verifiedSignature.publicKeySha256,
      verifiedSignature.signerKeyId,
      artifactAuthenticationKeyId,
      outputSha256,
    ].join('\n'),
  ).slice(0, 16);
  const outputDirectory = join(outputRoot, `public-v1-${fingerprint}`);
  const outputProfilesPath = join(outputDirectory, 'profiles.ndjson');
  const outputManifestPath = join(outputDirectory, 'manifest.json');
  const effectiveValidUntil = new Date(
    Math.min(
      new Date(policy.policyExpiresAt).getTime(),
      new Date(policy.source.validUntil).getTime(),
    ),
  ).toISOString();
  const manifestForCreatedAt = (createdAt: string): string =>
    authenticatedPublicManifestContent({
      body: {
        schemaVersion: 1,
        createdAt,
        effectiveValidUntil,
        input: {
          schemaVersion: inputManifest.schemaVersion,
          snapshotId: inputManifest.snapshotId,
          generatedAt: inputManifest.generatedAt,
          profilesSha256: inputManifest.profiles.sha256,
          records: inputManifest.profiles.records,
        },
        policy: {
          policyId: policy.policyId,
          policySha256,
          policyExpiresAt: policy.policyExpiresAt,
          sourceValidUntil: policy.source.validUntil,
          approvedSnapshot: policy.approvedSnapshot,
          signature: verifiedSignature,
        },
        output: {
          records: publicProfiles.length,
          relativePath: relative(dataRoot, outputProfilesPath).replaceAll('\\', '/'),
          sha256: outputSha256,
        },
        safeguards: {
          fixedAllowlist: true,
          separatePublicIdentifiers: true,
          internalLinkageIdsPublished: false,
          institutionalCandidatesPublished: false,
          reviewsPublished: false,
          adverseDataPublished: false,
          expiredPolicyAccepted: false,
          completeArtifactInstalledAtomically: true,
        },
      },
      authenticationKey: artifactAuthenticationKey,
      authenticationKeyId: artifactAuthenticationKeyId,
    });

  const commitNow = options.now ?? new Date();
  assertValidClock(commitNow, 'Publication commit clock');
  const [policyAtCommit, signatureAtCommit, publicKeyAtCommit, manifestAtCommit, profilesAtCommit] =
    await Promise.all([
      readFile(policyPath, 'utf8'),
      readFile(policySignaturePath, 'utf8'),
      readFile(policyPublicKeyPath, 'utf8'),
      readFile(manifestPath, 'utf8'),
      readFile(profilesPath, 'utf8'),
    ]);
  if (
    policyAtCommit !== policyContent ||
    signatureAtCommit !== policySignatureContent ||
    publicKeyAtCommit !== policyPublicKeyPem ||
    manifestAtCommit !== manifestContent ||
    profilesAtCommit !== profilesContent
  ) {
    throw new Error('Publication inputs changed while the artifact was being built');
  }
  verifyDetachedPublicationPolicySignature({
    policyContent: policyAtCommit,
    signatureContent: signatureAtCommit,
    publicKeyPem: publicKeyAtCommit,
    expectedPublicKeySha256: options.trustedPolicyPublicKeySha256,
    signerKeyId: options.policySignerKeyId,
  });
  const policyAtCommitParsed = parseCanonicalApprovedSourcePublicationPolicy(
    policyAtCommit,
    commitNow,
  );
  const manifestAtCommitParsed = parseDirectoryInputManifest(
    JSON.parse(manifestAtCommit) as unknown,
    commitNow,
  );
  if (
    policyAtCommitParsed.approvedSnapshot.snapshotId !== manifestAtCommitParsed.snapshotId ||
    policyAtCommitParsed.approvedSnapshot.profilesSha256 !== sha256(profilesAtCommit) ||
    sha256(profilesAtCommit) !== manifestAtCommitParsed.profiles.sha256
  ) {
    throw new Error('Signed publication policy no longer matches the commit-time snapshot');
  }
  const commitChain = await validateDirectoryArtifactChain({
    dataRoot,
    inputDirectory,
    manifest: manifestAtCommitParsed,
  });
  const commitProfiles = parseProfiles(profilesAtCommit);
  if (commitProfiles.length !== manifestAtCommitParsed.profiles.records) {
    throw new Error('Directory profile count changed before publication commit');
  }
  assertSourceFreshness({
    profiles: commitProfiles,
    mspSourceCutoffDate: commitChain.mspSourceCutoffDate,
    maxSourceAgeDays: policyAtCommitParsed.source.maxSourceAgeDays,
    now: commitNow,
  });

  await installPublicationArtifact({
    dataRoot,
    outputRoot,
    outputDirectory,
    profilesContent: outputContent,
    manifestForCreatedAt,
    proposedCreatedAt: commitNow.toISOString(),
  });

  return {
    manifestPath: outputManifestPath,
    profilesPath: outputProfilesPath,
    records: publicProfiles.length,
  };
}

export async function readPublicDirectoryArtifactForDelivery(options: {
  readonly dataRoot: string;
  readonly manifestPath: string;
  readonly artifactAuthenticationKey: string;
  readonly artifactAuthenticationKeyId: string;
  readonly clock?: () => Date;
}): Promise<DeliverablePublicDirectoryArtifact> {
  const clock = options.clock ?? (() => new Date());
  const deliveryNow = clock();
  assertValidClock(deliveryNow, 'Public directory delivery clock');
  const artifactAuthenticationKey = decodeCanonicalPublicationSecret(
    options.artifactAuthenticationKey,
    'PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY',
  );
  const dataRoot = await realpath(resolve(options.dataRoot));
  const manifestPath = await resolveExistingPathInside(
    dataRoot,
    resolve(options.manifestPath),
    'Public directory delivery manifest',
  );
  const manifestContent = await readFile(manifestPath, 'utf8');
  const manifest = parseJsonObject(manifestContent, 'Public directory delivery manifest');
  if (manifest['schemaVersion'] !== 1) {
    throw new Error('Public directory delivery manifest has an unsupported schema version');
  }

  const authentication = requiredObject(manifest, 'authentication');
  assertExactKeys(authentication, ['algorithm', 'keyId', 'tag']);
  const authenticationKeyId = validatedArtifactAuthenticationKeyId(
    options.artifactAuthenticationKeyId,
  );
  const manifestKeyId = requiredString(authentication, 'keyId');
  const authenticationTag = requiredString(authentication, 'tag');
  if (
    authentication['algorithm'] !== 'HMAC-SHA256' ||
    manifestKeyId !== authenticationKeyId ||
    !/^[0-9a-f]{64}$/u.test(authenticationTag)
  ) {
    throw new Error('Public directory delivery manifest authentication metadata is invalid');
  }
  const expectedAuthenticationTag = publicArtifactAuthenticationTag(
    {
      ...manifest,
      authentication: {
        algorithm: 'HMAC-SHA256',
        keyId: manifestKeyId,
      },
    },
    artifactAuthenticationKey,
  );
  if (
    !timingSafeEqual(
      Buffer.from(authenticationTag, 'hex'),
      Buffer.from(expectedAuthenticationTag, 'hex'),
    )
  ) {
    throw new Error('Public directory delivery manifest authentication failed');
  }

  const createdAt = requiredCanonicalDateTime(manifest, 'createdAt');
  if (new Date(createdAt).getTime() > deliveryNow.getTime()) {
    throw new Error('Public directory delivery manifest has a future creation time');
  }
  const effectiveValidUntil = requiredCanonicalDateTime(manifest, 'effectiveValidUntil');
  if (new Date(effectiveValidUntil).getTime() <= deliveryNow.getTime()) {
    throw new Error('Public directory artifact is expired and must not be delivered');
  }

  const policy = requiredObject(manifest, 'policy');
  const signature = requiredObject(policy, 'signature');
  if (
    signature['algorithm'] !== 'Ed25519' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(requiredString(signature, 'signerKeyId')) ||
    !/^[0-9a-f]{64}$/u.test(requiredString(signature, 'publicKeySha256')) ||
    !/^[0-9a-f]{64}$/u.test(requiredString(signature, 'signatureSha256'))
  ) {
    throw new Error('Public directory delivery manifest has invalid signature metadata');
  }

  const safeguards = requiredObject(manifest, 'safeguards');
  if (
    safeguards['fixedAllowlist'] !== true ||
    safeguards['separatePublicIdentifiers'] !== true ||
    safeguards['internalLinkageIdsPublished'] !== false ||
    safeguards['institutionalCandidatesPublished'] !== false ||
    safeguards['reviewsPublished'] !== false ||
    safeguards['adverseDataPublished'] !== false ||
    safeguards['expiredPolicyAccepted'] !== false ||
    safeguards['completeArtifactInstalledAtomically'] !== true
  ) {
    throw new Error('Public directory delivery manifest violates the required safeguards');
  }

  const output = requiredObject(manifest, 'output');
  const outputMetadata = parseArtifactMetadata(output, 'public delivery profiles');
  const profilesPath = await resolveExistingPathInside(
    dataRoot,
    resolve(dataRoot, ...outputMetadata.relativePath.split('/')),
    'Public directory delivery profiles',
  );
  if (dirname(profilesPath) !== dirname(manifestPath)) {
    throw new Error('Public directory manifest and profiles must belong to the same artifact');
  }
  const profilesContent = await readFile(profilesPath, 'utf8');
  if (
    sha256(profilesContent) !== outputMetadata.sha256 ||
    ndjsonRecordCount(profilesContent) !== outputMetadata.records
  ) {
    throw new Error('Public directory profiles do not match the delivery manifest');
  }

  const finalNow = clock();
  assertValidClock(finalNow, 'Public directory delivery clock');
  if (new Date(effectiveValidUntil).getTime() <= finalNow.getTime()) {
    throw new Error('Public directory artifact expired while it was being opened');
  }

  return {
    manifestPath,
    profilesContent,
    records: outputMetadata.records,
    effectiveValidUntil,
  };
}

async function main(): Promise<void> {
  loadEnvironment({
    path: '.env.data.local',
    quiet: true,
  });
  const policyPath = process.env['PUBLICATION_POLICY_PATH'];
  const policySignaturePath = process.env['PUBLICATION_POLICY_SIGNATURE_PATH'];
  const policyPublicKeyPath = process.env['PUBLICATION_POLICY_PUBLIC_KEY_PATH'];
  const policySignerKeyId = process.env['PUBLICATION_POLICY_SIGNER_KEY_ID'];
  const trustedPolicyPublicKeySha256 = process.env['PUBLICATION_POLICY_SIGNER_FINGERPRINT_SHA256'];
  const artifactAuthenticationKey = process.env['PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY'];
  const artifactAuthenticationKeyId = process.env['PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY_ID'];
  const publicProfileSecret = process.env['PUBLIC_PROFILE_ID_SECRET'];

  if (policyPath === undefined || policyPath.trim().length === 0) {
    throw new Error('PUBLICATION_POLICY_PATH is required');
  }
  if (policySignaturePath === undefined || policySignaturePath.trim().length === 0) {
    throw new Error('PUBLICATION_POLICY_SIGNATURE_PATH is required');
  }
  if (policyPublicKeyPath === undefined || policyPublicKeyPath.trim().length === 0) {
    throw new Error('PUBLICATION_POLICY_PUBLIC_KEY_PATH is required');
  }
  if (policySignerKeyId === undefined || policySignerKeyId.trim().length === 0) {
    throw new Error('PUBLICATION_POLICY_SIGNER_KEY_ID is required');
  }
  if (
    trustedPolicyPublicKeySha256 === undefined ||
    trustedPolicyPublicKeySha256.trim().length === 0
  ) {
    throw new Error('PUBLICATION_POLICY_SIGNER_FINGERPRINT_SHA256 is required');
  }
  if (artifactAuthenticationKey === undefined || artifactAuthenticationKey.length === 0) {
    throw new Error('PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY is required');
  }
  if (
    artifactAuthenticationKeyId === undefined ||
    artifactAuthenticationKeyId.trim().length === 0
  ) {
    throw new Error('PUBLIC_DIRECTORY_ARTIFACT_AUTH_KEY_ID is required');
  }

  if (publicProfileSecret === undefined || publicProfileSecret.length === 0) {
    throw new Error('PUBLIC_PROFILE_ID_SECRET is required');
  }

  const result = await runPublicDirectoryExport({
    dataRoot: process.env['DATA_INGESTION_DIR'] ?? 'data',
    ...(process.env['PUBLIC_DIRECTORY_INPUT_DIR'] === undefined
      ? {}
      : {
          inputDirectory: process.env['PUBLIC_DIRECTORY_INPUT_DIR'],
        }),
    ...(process.env['PUBLIC_DIRECTORY_OUTPUT_DIR'] === undefined
      ? {}
      : {
          outputRoot: process.env['PUBLIC_DIRECTORY_OUTPUT_DIR'],
        }),
    policyPath,
    policySignaturePath,
    policyPublicKeyPath,
    policySignerKeyId,
    trustedPolicyPublicKeySha256,
    artifactAuthenticationKey,
    artifactAuthenticationKeyId,
    publicProfileSecret,
  });

  console.log(
    JSON.stringify({
      event: 'public_directory_export_built',
      result,
    }),
  );
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
