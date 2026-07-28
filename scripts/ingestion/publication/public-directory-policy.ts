import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

import { decodeCanonicalPublicationSecret } from './publication-secret';

export const PUBLIC_PROFILE_FIELD_ALLOWLIST = [
  'schemaVersion',
  'id',
  'slug',
  'displayName',
  'registeredTitles.title',
  'registeredTitles.temporaryRegistration',
  'source.publisher',
  'source.dataset',
  'source.canonicalUrl',
  'source.liveLookupUrl',
  'source.sourceCutoffDate',
  'source.validUntil',
  'source.attribution',
  'source.reuseBasis',
  'source.policyId',
  'notice.notMedicalAdvice',
  'notice.notRealTime',
  'notice.verifyWithOfficialSource',
] as const;

export const PUBLIC_PROFILE_FORBIDDEN_KEYS = [
  'internalLinkageId',
  'documentNumber',
  'professionalFundNumber',
  'recruiterCode',
  'candidateId',
  'resolutionIds',
  'sourceProfessionalId',
  'rawSnapshotPath',
  'rawSnapshotSha256',
  'sourceRowNumber',
  'matchScore',
  'confidence',
] as const;

type PublicProfileFieldPath = (typeof PUBLIC_PROFILE_FIELD_ALLOWLIST)[number];

interface ApprovedPolicyDecision {
  readonly approved: true;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly reference: string;
}

export interface ApprovedSourcePublicationPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyExpiresAt: string;
  readonly approvedSnapshot: {
    readonly snapshotId: string;
    readonly profilesSha256: string;
  };
  readonly releasePrerequisites: {
    readonly controllerNotice: ApprovedPolicyDecision;
    readonly databaseRegistration: ApprovedPolicyDecision;
    readonly rightsRequestWorkflow: ApprovedPolicyDecision;
    readonly securityAndRetentionControls: ApprovedPolicyDecision;
    readonly impactAssessmentAndDpoDetermination: ApprovedPolicyDecision;
  };
  readonly source: {
    readonly key: 'msp_infotitulos';
    readonly publisher: string;
    readonly dataset: string;
    readonly canonicalUrl: string;
    readonly liveLookupUrl: string;
    readonly attribution: string;
    readonly validUntil: string;
    readonly maxSourceAgeDays: number;
    readonly allowedFieldPaths: readonly PublicProfileFieldPath[];
    readonly legalBasis: ApprovedPolicyDecision;
    readonly purposeCompatibility: ApprovedPolicyDecision;
    readonly reuseAuthorization: ApprovedPolicyDecision & {
      readonly basis: 'OPEN_DATA_LICENSE' | 'WRITTEN_AUTHORIZATION' | 'OFFICIAL_PUBLICATION_REVIEW';
    };
  };
}

export interface PublicDirectoryProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly registeredTitles: readonly {
    readonly title: string;
    readonly temporaryRegistration: 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT';
  }[];
  readonly source: {
    readonly publisher: string;
    readonly dataset: string;
    readonly canonicalUrl: string;
    readonly liveLookupUrl: string;
    readonly sourceCutoffDate: string;
    readonly validUntil: string;
    readonly attribution: string;
    readonly reuseBasis:
      'OPEN_DATA_LICENSE' | 'WRITTEN_AUTHORIZATION' | 'OFFICIAL_PUBLICATION_REVIEW';
    readonly policyId: string;
  };
  readonly notice: {
    readonly notMedicalAdvice: true;
    readonly notRealTime: true;
    readonly verifyWithOfficialSource: true;
  };
}

export interface PublicDirectorySourceProfile {
  readonly internalLinkageId: string;
  readonly displayName: string;
  readonly registeredTitles: readonly {
    readonly title: string;
    readonly temporaryRegistration: 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT';
  }[];
  readonly officialRegistry: {
    readonly publisher: string;
    readonly dataset: string;
    readonly sourceCutoffDate: string;
    readonly datasetUrl: string;
    readonly liveLookupUrl: string;
  };
}

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface VerifiedPublicationPolicySignature {
  readonly algorithm: 'Ed25519';
  readonly signerKeyId: string;
  readonly publicKeySha256: string;
  readonly signatureSha256: string;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredObject(parent: UnknownRecord, key: string): UnknownRecord {
  const value = parent[key];

  if (!isObject(value)) {
    throw new Error(`Publication policy field "${key}" must be an object`);
  }

  return value;
}

function requiredString(parent: UnknownRecord, key: string): string {
  const value = parent[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Publication policy field "${key}" must be a non-empty string`);
  }

  return value.trim();
}

function requiredPositiveInteger(parent: UnknownRecord, key: string, maximum: number): number {
  const value = parent[key];

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `Publication policy field "${key}" must be an integer between 1 and ${maximum}`,
    );
  }

  return value;
}

function assertExactKeys(
  value: UnknownRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();

  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} fields must exactly match the signed schema`);
  }
}

function requiredHttpsUrl(parent: UnknownRecord, key: string): string {
  const value = requiredString(parent, key);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Publication policy field "${key}" must be an absolute HTTPS URL`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Publication policy field "${key}" must be an absolute HTTPS URL`);
  }

  return url.toString();
}

function requiredDate(parent: UnknownRecord, key: string): Date {
  const value = requiredString(parent, key);
  const date = new Date(value);

  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Publication policy field "${key}" must be a canonical ISO date-time`);
  }

  return date;
}

function approvedDecision(parent: UnknownRecord, key: string, now: Date): ApprovedPolicyDecision {
  const decision = requiredObject(parent, key);

  if (decision['approved'] !== true) {
    throw new Error(`Publication policy decision "${key}" is not approved`);
  }

  assertExactKeys(
    decision,
    key === 'reuseAuthorization'
      ? ['approved', 'basis', 'reference', 'reviewedAt', 'reviewedBy']
      : ['approved', 'reference', 'reviewedAt', 'reviewedBy'],
    `Publication policy decision "${key}"`,
  );

  const reviewedAt = requiredDate(decision, 'reviewedAt');

  if (reviewedAt.getTime() > now.getTime()) {
    throw new Error(`Publication policy decision "${key}" has a future review date`);
  }

  return {
    approved: true,
    reviewedBy: requiredString(decision, 'reviewedBy'),
    reviewedAt: reviewedAt.toISOString(),
    reference: requiredString(decision, 'reference'),
  };
}

function allowedFieldPaths(source: UnknownRecord): readonly PublicProfileFieldPath[] {
  const value = source['allowedFieldPaths'];

  if (!Array.isArray(value) || !value.every((field) => typeof field === 'string')) {
    throw new Error('Publication policy allowedFieldPaths must be a string array');
  }

  const actual = [...new Set(value)].sort();
  const expected = [...PUBLIC_PROFILE_FIELD_ALLOWLIST].sort();

  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error('Publication policy allowedFieldPaths must exactly match the public allowlist');
  }

  return PUBLIC_PROFILE_FIELD_ALLOWLIST;
}

export function parseApprovedSourcePublicationPolicy(
  value: unknown,
  now: Date = new Date(),
): ApprovedSourcePublicationPolicy {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Publication policy validation clock must be a valid date');
  }
  if (!isObject(value)) {
    throw new Error('Publication policy must be a JSON object');
  }

  if (value['schemaVersion'] !== 1) {
    throw new Error('Unsupported publication policy schemaVersion');
  }
  assertExactKeys(
    value,
    [
      'approvedSnapshot',
      'policyExpiresAt',
      'policyId',
      'releasePrerequisites',
      'schemaVersion',
      'source',
    ],
    'Publication policy',
  );

  const policyExpiresAt = requiredDate(value, 'policyExpiresAt');
  if (policyExpiresAt.getTime() <= now.getTime()) {
    throw new Error('Publication policy is expired');
  }

  const source = requiredObject(value, 'source');
  assertExactKeys(
    source,
    [
      'allowedFieldPaths',
      'attribution',
      'canonicalUrl',
      'dataset',
      'key',
      'legalBasis',
      'liveLookupUrl',
      'maxSourceAgeDays',
      'publisher',
      'purposeCompatibility',
      'reuseAuthorization',
      'validUntil',
    ],
    'Publication policy source',
  );
  if (source['key'] !== 'msp_infotitulos') {
    throw new Error('Publication policy source key must be "msp_infotitulos"');
  }

  const approvedSnapshot = requiredObject(value, 'approvedSnapshot');
  assertExactKeys(
    approvedSnapshot,
    ['profilesSha256', 'snapshotId'],
    'Publication policy approvedSnapshot',
  );
  const snapshotId = requiredString(approvedSnapshot, 'snapshotId');
  const profilesSha256 = requiredString(approvedSnapshot, 'profilesSha256');
  if (!/^factual-v3-[0-9a-f]{16}$/u.test(snapshotId)) {
    throw new Error('Publication policy approved snapshotId is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(profilesSha256)) {
    throw new Error('Publication policy approved profilesSha256 is invalid');
  }

  const releasePrerequisites = requiredObject(value, 'releasePrerequisites');
  assertExactKeys(
    releasePrerequisites,
    [
      'controllerNotice',
      'databaseRegistration',
      'impactAssessmentAndDpoDetermination',
      'rightsRequestWorkflow',
      'securityAndRetentionControls',
    ],
    'Publication policy releasePrerequisites',
  );

  const validUntil = requiredDate(source, 'validUntil');
  if (validUntil.getTime() <= now.getTime()) {
    throw new Error('Publication source approval is expired');
  }

  const reuseDecision = requiredObject(source, 'reuseAuthorization');
  const reuseAuthorization = approvedDecision(source, 'reuseAuthorization', now);
  const reuseBasis = reuseDecision['basis'];
  if (
    reuseBasis !== 'OPEN_DATA_LICENSE' &&
    reuseBasis !== 'WRITTEN_AUTHORIZATION' &&
    reuseBasis !== 'OFFICIAL_PUBLICATION_REVIEW'
  ) {
    throw new Error('Publication policy reuse basis is not approved');
  }

  return {
    schemaVersion: 1,
    policyId: requiredString(value, 'policyId'),
    policyExpiresAt: policyExpiresAt.toISOString(),
    approvedSnapshot: {
      snapshotId,
      profilesSha256,
    },
    releasePrerequisites: {
      controllerNotice: approvedDecision(releasePrerequisites, 'controllerNotice', now),
      databaseRegistration: approvedDecision(releasePrerequisites, 'databaseRegistration', now),
      rightsRequestWorkflow: approvedDecision(releasePrerequisites, 'rightsRequestWorkflow', now),
      securityAndRetentionControls: approvedDecision(
        releasePrerequisites,
        'securityAndRetentionControls',
        now,
      ),
      impactAssessmentAndDpoDetermination: approvedDecision(
        releasePrerequisites,
        'impactAssessmentAndDpoDetermination',
        now,
      ),
    },
    source: {
      key: 'msp_infotitulos',
      publisher: requiredString(source, 'publisher'),
      dataset: requiredString(source, 'dataset'),
      canonicalUrl: requiredHttpsUrl(source, 'canonicalUrl'),
      liveLookupUrl: requiredHttpsUrl(source, 'liveLookupUrl'),
      attribution: requiredString(source, 'attribution'),
      validUntil: validUntil.toISOString(),
      maxSourceAgeDays: requiredPositiveInteger(source, 'maxSourceAgeDays', 366),
      allowedFieldPaths: allowedFieldPaths(source),
      legalBasis: approvedDecision(source, 'legalBasis', now),
      purposeCompatibility: approvedDecision(source, 'purposeCompatibility', now),
      reuseAuthorization: {
        ...reuseAuthorization,
        basis: reuseBasis,
      },
    },
  };
}

export function parseCanonicalApprovedSourcePublicationPolicy(
  content: string,
  now: Date = new Date(),
): ApprovedSourcePublicationPolicy {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error('Publication policy must be valid canonical JSON', {
      cause: error,
    });
  }

  const canonicalContent = `${JSON.stringify(value, null, 2)}\n`;
  if (content !== canonicalContent) {
    throw new Error(
      'Publication policy must use canonical two-space JSON with unique keys and one final newline',
    );
  }

  return parseApprovedSourcePublicationPolicy(value, now);
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalBase64(value: string): Buffer {
  const normalized = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) {
    throw new Error('Publication policy signature must use canonical base64');
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized || decoded.length !== 64) {
    throw new Error('Publication policy signature must be a canonical Ed25519 signature');
  }

  return decoded;
}

export function verifyDetachedPublicationPolicySignature(options: {
  readonly policyContent: string;
  readonly signatureContent: string;
  readonly publicKeyPem: string;
  readonly expectedPublicKeySha256: string;
  readonly signerKeyId: string;
}): VerifiedPublicationPolicySignature {
  const signerKeyId = options.signerKeyId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(signerKeyId)) {
    throw new Error('Publication policy signer key id is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(options.expectedPublicKeySha256)) {
    throw new Error('Publication policy signer fingerprint must be a lowercase SHA-256 value');
  }
  if (options.publicKeyPem.includes('PRIVATE KEY')) {
    throw new Error('Publication policy verifier must receive a public key, never a private key');
  }

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(options.publicKeyPem);
  } catch (error) {
    throw new Error('Publication policy public key is invalid', {
      cause: error,
    });
  }

  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Publication policy public key must be Ed25519');
  }

  const publicKeyDer = publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const publicKeySha256 = sha256Buffer(publicKeyDer);
  if (
    !timingSafeEqual(
      Buffer.from(publicKeySha256, 'hex'),
      Buffer.from(options.expectedPublicKeySha256, 'hex'),
    )
  ) {
    throw new Error('Publication policy public key does not match the trusted fingerprint');
  }

  const signature = canonicalBase64(options.signatureContent);
  if (!verifySignature(null, Buffer.from(options.policyContent, 'utf8'), publicKey, signature)) {
    throw new Error('Publication policy signature verification failed');
  }

  return {
    algorithm: 'Ed25519',
    signerKeyId,
    publicKeySha256,
    signatureSha256: sha256Buffer(signature),
  };
}

function publicProfileId(secret: Buffer, internalLinkageId: string): string {
  const bytes = createHmac('sha256', secret)
    .update(internalLinkageId, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function slugify(displayName: string, id: string): string {
  const base = displayName
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('es-UY')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 140)
    .replace(/-+$/gu, '');

  return `${base.length === 0 ? 'profesional' : base}-${id.slice(0, 8)}`;
}

function leafFieldPaths(value: unknown, prefix = ''): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => leafFieldPaths(item, prefix));
  }

  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, item]) =>
      leafFieldPaths(item, prefix.length === 0 ? key : `${prefix}.${key}`),
    );
  }

  return prefix.length === 0 ? [] : [prefix];
}

function assertPublicProfileMatchesAllowlist(profile: PublicDirectoryProfile): void {
  const actual = [...new Set(leafFieldPaths(profile))].sort();
  const expected = [...PUBLIC_PROFILE_FIELD_ALLOWLIST].sort();

  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error('Generated public profile does not exactly match the public allowlist');
  }
}

export function buildPublicDirectoryProfiles(
  profiles: readonly PublicDirectorySourceProfile[],
  policy: ApprovedSourcePublicationPolicy,
  publicProfileSecret: string,
): readonly PublicDirectoryProfile[] {
  const publicProfileSecretBytes = decodeCanonicalPublicationSecret(
    publicProfileSecret,
    'PUBLIC_PROFILE_ID_SECRET',
  );
  const effectiveValidUntil = new Date(
    Math.min(
      new Date(policy.policyExpiresAt).getTime(),
      new Date(policy.source.validUntil).getTime(),
    ),
  ).toISOString();
  const publicProfiles = profiles.map((profile): PublicDirectoryProfile => {
    if (
      profile.officialRegistry.publisher !== policy.source.publisher ||
      profile.officialRegistry.dataset !== policy.source.dataset ||
      new URL(profile.officialRegistry.datasetUrl).toString() !== policy.source.canonicalUrl ||
      new URL(profile.officialRegistry.liveLookupUrl).toString() !== policy.source.liveLookupUrl
    ) {
      throw new Error('Directory profile source does not match the approved publication policy');
    }

    const id = publicProfileId(publicProfileSecretBytes, profile.internalLinkageId);

    const publicProfile: PublicDirectoryProfile = {
      schemaVersion: 1,
      id,
      slug: slugify(profile.displayName, id),
      displayName: profile.displayName,
      registeredTitles: profile.registeredTitles.map((title) => ({
        title: title.title,
        temporaryRegistration: title.temporaryRegistration,
      })),
      source: {
        publisher: policy.source.publisher,
        dataset: policy.source.dataset,
        canonicalUrl: policy.source.canonicalUrl,
        liveLookupUrl: policy.source.liveLookupUrl,
        sourceCutoffDate: profile.officialRegistry.sourceCutoffDate,
        validUntil: effectiveValidUntil,
        attribution: policy.source.attribution,
        reuseBasis: policy.source.reuseAuthorization.basis,
        policyId: policy.policyId,
      },
      notice: {
        notMedicalAdvice: true,
        notRealTime: true,
        verifyWithOfficialSource: true,
      },
    };

    assertPublicProfileMatchesAllowlist(publicProfile);
    return publicProfile;
  });

  if (new Set(publicProfiles.map((profile) => profile.id)).size !== publicProfiles.length) {
    throw new Error('Generated public profile identifiers must be unique');
  }

  return publicProfiles.sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName, 'es-UY') || left.id.localeCompare(right.id),
  );
}
