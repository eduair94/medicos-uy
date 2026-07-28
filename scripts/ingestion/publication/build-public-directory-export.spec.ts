import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  INFOTITULOS_DATASET,
  INFOTITULOS_HEADERS,
  INFOTITULOS_LINKAGE_VERSION,
  INFOTITULOS_PUBLISHER,
} from '../msp/ingest-infotitulos';

import {
  readPublicDirectoryArtifactForDelivery,
  runPublicDirectoryExport,
} from './build-public-directory-export';
import { PUBLIC_PROFILE_FIELD_ALLOWLIST } from './public-directory-policy';

import type { KeyObject } from 'node:crypto';

const temporaryRoots: string[] = [];
const now = new Date('2026-07-27T12:00:00.000Z');
const artifactAuthenticationKey = createHash('sha256')
  .update('synthetic-artifact-authentication-key', 'utf8')
  .digest('base64');
const publicProfileSecret = createHash('sha256')
  .update('synthetic-public-profile-secret', 'utf8')
  .digest('base64url');

interface PublicationFixture {
  readonly dataRoot: string;
  readonly inputDirectory: string;
  readonly policyPath: string;
  readonly policySignaturePath: string;
  readonly policyPublicKeyPath: string;
  readonly policySignerKeyId: string;
  readonly trustedPolicyPublicKeySha256: string;
  readonly privateKey: KeyObject;
  readonly internalLinkageId: string;
  readonly snapshotId: string;
  readonly profilesSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function approvedPolicy(snapshotId: string, profilesSha256: string): Record<string, unknown> {
  const approval = {
    approved: true,
    reviewedBy: 'Synthetic reviewer',
    reviewedAt: '2026-07-27T10:00:00.000Z',
    reference: 'Synthetic approval reference',
  };

  return {
    schemaVersion: 1,
    policyId: 'synthetic-policy-v1',
    policyExpiresAt: '2026-08-27T12:00:00.000Z',
    approvedSnapshot: {
      snapshotId,
      profilesSha256,
    },
    releasePrerequisites: {
      controllerNotice: approval,
      databaseRegistration: approval,
      rightsRequestWorkflow: approval,
      securityAndRetentionControls: approval,
      impactAssessmentAndDpoDetermination: approval,
    },
    source: {
      key: 'msp_infotitulos',
      publisher: INFOTITULOS_PUBLISHER,
      dataset: INFOTITULOS_DATASET,
      canonicalUrl:
        'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos',
      liveLookupUrl:
        'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud',
      attribution: 'Synthetic MSP attribution',
      validUntil: '2026-08-14T00:00:00.000Z',
      maxSourceAgeDays: 62,
      allowedFieldPaths: PUBLIC_PROFILE_FIELD_ALLOWLIST,
      legalBasis: approval,
      purposeCompatibility: approval,
      reuseAuthorization: {
        ...approval,
        basis: 'OFFICIAL_PUBLICATION_REVIEW',
      },
    },
  };
}

async function writeSignedPolicy(
  input: PublicationFixture,
  policy: Record<string, unknown>,
): Promise<void> {
  const policyContent = `${JSON.stringify(policy, null, 2)}\n`;
  const signature = sign(null, Buffer.from(policyContent, 'utf8'), input.privateKey).toString(
    'base64',
  );
  await Promise.all([
    writeFile(input.policyPath, policyContent, 'utf8'),
    writeFile(input.policySignaturePath, `${signature}\n`, 'utf8'),
  ]);
}

async function fixture(): Promise<PublicationFixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'medicos-publication-'));
  temporaryRoots.push(dataRoot);
  const mspDirectory = join(dataRoot, 'processed', 'msp', 'infotitulos', '2026-06-30-synthetic');
  const linkageDirectory = join(dataRoot, 'processed', 'linkage', 'synthetic-run');
  await Promise.all([
    mkdir(mspDirectory, { recursive: true }),
    mkdir(linkageDirectory, { recursive: true }),
  ]);

  const internalLinkageId = `msp_doc_v1_${'a'.repeat(64)}`;
  const profilesContent = `${JSON.stringify({
    schemaVersion: 2,
    internalLinkageId,
    displayName: 'Ana Maria Ejemplo',
    enabledTitles: ['DOCTOR EN MEDICINA'],
    registeredTitles: [
      {
        title: 'DOCTOR EN MEDICINA',
        temporaryRegistration: 'NONE',
      },
    ],
    officialRegistry: {
      publisher: INFOTITULOS_PUBLISHER,
      dataset: INFOTITULOS_DATASET,
      sourceCutoffDate: '2026-06-30',
      datasetUrl:
        'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos',
      liveLookupUrl:
        'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud',
    },
    linkageReview: {
      resolutionIds: [],
      linkedInstitutionalObservations: 0,
    },
    notice: {
      noticeVersion: 'uy-medical-directory-factual-v3',
      status: 'internal_research_only',
      sourceCutoffDate: '2026-06-30',
    },
    publication: {
      profileFacts: 'pending_evidence_and_legal_approval',
      institutionalLinks: 'not_public',
      publicExportAllowed: false,
    },
  })}\n`;
  const mspProfessionalsContent = `${JSON.stringify({ synthetic: true })}\n`;
  const linkageCandidatesContent = '';
  const linkageResolutionsContent = '';
  const legalNoticeContent = `${JSON.stringify({
    schemaVersion: 2,
    noticeVersion: 'uy-medical-directory-factual-v3',
    language: 'es-UY',
    status: 'template_not_approved_for_publication',
    controller: {
      name: 'Synthetic controller',
      address: 'Synthetic address 123, Montevideo',
      rightsEmail: 'privacy@example.invalid',
      privacyNoticeUrl: 'https://example.invalid/privacy',
      urcdpRegistration: 'synthetic-registration',
    },
    processing: {
      processorsNotice: 'Synthetic processors notice',
      recipientsNotice: 'No independent recipients',
      internationalTransfersNotice: 'No international transfers',
      exclusivelyAutomatedDecisions: false,
      professionalDataSold: false,
    },
    article13: {
      database: {
        exists: true,
        name: 'Synthetic public medical directory',
      },
      collection: {
        directlyFromDataSubject: false,
        questionnaireUsed: false,
        responseRequirement: 'not_applicable_no_questionnaire',
        consequencesOfProvidingData: 'not_applicable_no_questionnaire',
        consequencesOfRefusal: 'no_service_or_right_is_conditioned_on_answering',
        consequencesOfInaccuracy: 'record_is_marked_under_review_and_corrected_if_verified',
      },
      informationOnRequestMaximumBusinessDays: 5,
      automatedAssessment: {
        used: false,
        criteria: null,
        processes: null,
        technology: null,
      },
    },
    purpose: 'Synthetic factual professional directory purpose',
    shortProfileNotice: 'Synthetic source and currency notice',
    rights: {
      available: ['access', 'rectification', 'update', 'inclusion', 'suppression'],
      maximumResponseTimeBusinessDays: 5,
      disputedDataState: 'under_review',
      access: {
        identityVerificationRequired: true,
        freeExerciseIntervalMonths: 6,
        renewedLegitimateInterestException: true,
        completeRecordRequired: true,
        clearAccessibleFormatRequired: true,
        thirdPartyDataDisclosureProhibited: true,
      },
      rectification: {
        freeOfCharge: true,
        errorFalsityOrExclusionCovered: true,
        markAsUnderReviewDuringVerification: true,
        notifyRecipientsMaximumBusinessDays: 5,
      },
    },
    publicationGate: {
      state: 'blocked',
      approval: {
        required: true,
        approved: false,
      },
      missingConfiguration: [],
      mandatoryApprovals: [
        'legal_and_privacy_review',
        'database_registration',
        'rights_request_workflow',
        'source_by_source_reuse_assessment',
        'security_and_retention_controls',
        'impact_assessment_and_dpo_determination',
      ],
      sourceApprovalRequired: true,
      disclaimerAloneCreatesLegalBasis: false,
    },
  })}\n`;

  const mspProfessionalsMetadata = {
    relativePath: 'processed/msp/infotitulos/2026-06-30-synthetic/professionals.ndjson',
    records: 1,
    sha256: sha256(mspProfessionalsContent),
  };
  const linkageCandidatesMetadata = {
    relativePath: 'processed/linkage/synthetic-run/candidates.ndjson',
    records: 0,
    sha256: sha256(linkageCandidatesContent),
  };
  const mspManifestContent = `${JSON.stringify({
    schemaVersion: 1,
    source: {
      publisher: INFOTITULOS_PUBLISHER,
      dataset: INFOTITULOS_DATASET,
      sourceCutoffDate: '2026-06-30',
    },
    outputs: {
      professionals: mspProfessionalsMetadata,
      quarantine: {
        records: 0,
      },
    },
    linkage: {
      algorithm: 'HMAC-SHA256',
      version: INFOTITULOS_LINKAGE_VERSION,
      rawIdentifiersPublished: false,
    },
    quality: {
      expectedIdentityConflicts: 0,
      actualIdentityConflicts: 0,
      exactHeaders: INFOTITULOS_HEADERS,
    },
    aggregates: {
      publishedProfessionals: 1,
      quarantinedIdentityConflicts: 0,
    },
  })}\n`;
  const linkageManifestContent = `${JSON.stringify({
    schemaVersion: 2,
    algorithmVersion: 'exact-full-name-candidates-v3',
    inputs: [mspProfessionalsMetadata],
    output: linkageCandidatesMetadata,
    safeguards: {
      fuzzyMatchingUsed: false,
      automaticallyMerged: false,
      rawGovernmentIdentifiersPublished: false,
    },
  })}\n`;
  const snapshotId = `factual-v3-${sha256(
    [
      sha256(mspProfessionalsContent),
      sha256(linkageCandidatesContent),
      sha256(mspManifestContent),
      sha256(linkageManifestContent),
      sha256(legalNoticeContent),
      'uy-medical-directory-factual-v3',
    ].join('\u0000'),
  ).slice(0, 16)}`;
  const inputDirectory = join(dataRoot, 'processed', 'directory', snapshotId);
  await mkdir(inputDirectory, { recursive: true });
  const directoryManifest = {
    schemaVersion: 2,
    snapshotId,
    generatedAt: '2026-07-27T11:00:00.000Z',
    noticeVersion: 'uy-medical-directory-factual-v3',
    inputs: [
      mspProfessionalsMetadata,
      linkageCandidatesMetadata,
      {
        relativePath: 'processed/msp/infotitulos/2026-06-30-synthetic/manifest.json',
        records: 1,
        sha256: sha256(mspManifestContent),
      },
      {
        relativePath: 'processed/linkage/synthetic-run/manifest.json',
        records: 1,
        sha256: sha256(linkageManifestContent),
      },
    ],
    outputs: {
      profiles: {
        relativePath: `processed/directory/${snapshotId}/profiles.ndjson`,
        records: 1,
        sha256: sha256(profilesContent),
      },
      linkageResolutions: {
        relativePath: `processed/directory/${snapshotId}/linkage-resolutions.ndjson`,
        records: 0,
        sha256: sha256(linkageResolutionsContent),
      },
      legalNotice: {
        relativePath: `processed/directory/${snapshotId}/privacy-and-publication-notice.json`,
        records: 1,
        sha256: sha256(legalNoticeContent),
      },
    },
    safeguards: {
      adverseDataAttached: false,
      automaticallyMerged: false,
      exhaustiveResolutionLedger: true,
      fuzzyMatchingUsed: false,
      institutionalObservationsAttached: false,
      institutionalLinksPublished: false,
      internalLinkageIdsPresent: true,
      publicExportAllowed: false,
      rawGovernmentIdentifiersPublished: false,
      reviewsAttached: false,
    },
    publicationGate: {
      state: 'blocked',
      approval: {
        required: true,
        approved: false,
      },
      sourceApprovalRequired: true,
      disclaimerAloneCreatesLegalBasis: false,
    },
  };

  await Promise.all([
    writeFile(join(inputDirectory, 'profiles.ndjson'), profilesContent, 'utf8'),
    writeFile(
      join(inputDirectory, 'linkage-resolutions.ndjson'),
      linkageResolutionsContent,
      'utf8',
    ),
    writeFile(
      join(inputDirectory, 'privacy-and-publication-notice.json'),
      legalNoticeContent,
      'utf8',
    ),
    writeFile(
      join(inputDirectory, 'manifest.json'),
      `${JSON.stringify(directoryManifest)}\n`,
      'utf8',
    ),
    writeFile(join(mspDirectory, 'professionals.ndjson'), mspProfessionalsContent, 'utf8'),
    writeFile(join(mspDirectory, 'manifest.json'), mspManifestContent, 'utf8'),
    writeFile(join(linkageDirectory, 'candidates.ndjson'), linkageCandidatesContent, 'utf8'),
    writeFile(join(linkageDirectory, 'manifest.json'), linkageManifestContent, 'utf8'),
  ]);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const policyPath = join(dataRoot, 'approved-policy.json');
  const policySignaturePath = join(dataRoot, 'approved-policy.sig');
  const policyPublicKeyPath = join(dataRoot, 'approved-policy-public.pem');
  const publicKeyPem = publicKey.export({
    format: 'pem',
    type: 'spki',
  });
  const trustedPolicyPublicKeySha256 = sha256(
    publicKey.export({
      format: 'der',
      type: 'spki',
    }),
  );
  const result: PublicationFixture = {
    dataRoot,
    inputDirectory,
    policyPath,
    policySignaturePath,
    policyPublicKeyPath,
    policySignerKeyId: 'synthetic-legal-release-2026-01',
    trustedPolicyPublicKeySha256,
    privateKey,
    internalLinkageId,
    snapshotId,
    profilesSha256: sha256(profilesContent),
  };
  await writeFile(policyPublicKeyPath, publicKeyPem, 'utf8');
  await writeSignedPolicy(result, approvedPolicy(result.snapshotId, result.profilesSha256));

  return result;
}

function exportOptions(input: PublicationFixture) {
  return {
    dataRoot: input.dataRoot,
    inputDirectory: input.inputDirectory,
    policyPath: input.policyPath,
    policySignaturePath: input.policySignaturePath,
    policyPublicKeyPath: input.policyPublicKeyPath,
    policySignerKeyId: input.policySignerKeyId,
    trustedPolicyPublicKeySha256: input.trustedPolicyPublicKeySha256,
    artifactAuthenticationKey,
    artifactAuthenticationKeyId: 'synthetic-delivery-auth-2026-01',
    publicProfileSecret,
    now,
  } as const;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((temporaryRoot) =>
      rm(temporaryRoot, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('public directory export', () => {
  it('builds an idempotent sanitized artifact from a signed snapshot-bound policy', async () => {
    const input = await fixture();
    const options = exportOptions(input);

    const first = await runPublicDirectoryExport(options);
    const second = await runPublicDirectoryExport({
      ...options,
      now: new Date('2026-07-27T13:00:00.000Z'),
    });
    expect(second).toEqual(first);
    expect(first.records).toBe(1);

    const profilesContent = await readFile(first.profilesPath, 'utf8');
    expect(profilesContent).not.toContain(input.internalLinkageId);
    expect(profilesContent).not.toContain('resolutionIds');
    expect(profilesContent).toContain('"registeredTitles"');

    const manifestContent = await readFile(first.manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent) as {
      readonly policy: {
        readonly approvedSnapshot: {
          readonly snapshotId: string;
          readonly profilesSha256: string;
        };
        readonly signature: {
          readonly algorithm: string;
          readonly signerKeyId: string;
          readonly publicKeySha256: string;
        };
      };
      readonly safeguards: Record<string, boolean>;
    };
    expect(manifest.policy.approvedSnapshot).toEqual({
      snapshotId: input.snapshotId,
      profilesSha256: input.profilesSha256,
    });
    expect(manifest.policy.signature).toMatchObject({
      algorithm: 'Ed25519',
      signerKeyId: input.policySignerKeyId,
      publicKeySha256: input.trustedPolicyPublicKeySha256,
    });
    expect(manifest.safeguards).toMatchObject({
      fixedAllowlist: true,
      separatePublicIdentifiers: true,
      internalLinkageIdsPublished: false,
      institutionalCandidatesPublished: false,
      reviewsPublished: false,
      adverseDataPublished: false,
    });
    expect(manifestContent).not.toContain('keyFingerprint');
    expect(manifestContent).not.toContain(options.artifactAuthenticationKey);
    expect(manifestContent).not.toContain(options.publicProfileSecret);

    const deliverable = await readPublicDirectoryArtifactForDelivery({
      dataRoot: input.dataRoot,
      manifestPath: first.manifestPath,
      artifactAuthenticationKey: options.artifactAuthenticationKey,
      artifactAuthenticationKeyId: options.artifactAuthenticationKeyId,
      clock: () => now,
    });
    expect(deliverable.records).toBe(1);
    expect(deliverable.profilesContent).toBe(profilesContent);
    expect(deliverable).not.toHaveProperty('profilesPath');
    await expect(
      readPublicDirectoryArtifactForDelivery({
        dataRoot: input.dataRoot,
        manifestPath: first.manifestPath,
        artifactAuthenticationKey: options.artifactAuthenticationKey,
        artifactAuthenticationKeyId: options.artifactAuthenticationKeyId,
        clock: () => new Date('2026-08-14T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/expired.*must not be delivered/u);
  });

  it('writes nothing when the signed source policy is not approved', async () => {
    const input = await fixture();
    const blockedPolicy = approvedPolicy(input.snapshotId, input.profilesSha256);
    const source = blockedPolicy['source'] as Record<string, unknown>;
    source['reuseAuthorization'] = {
      approved: false,
    };
    await writeSignedPolicy(input, blockedPolicy);

    await expect(runPublicDirectoryExport(exportOptions(input))).rejects.toThrow(/not approved/u);
    await expect(
      readdir(join(input.dataRoot, 'processed', 'public-directory')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a policy whose detached signature is invalid', async () => {
    const input = await fixture();
    await writeFile(input.policySignaturePath, `${Buffer.alloc(64).toString('base64')}\n`, 'utf8');

    await expect(runPublicDirectoryExport(exportOptions(input))).rejects.toThrow(
      /signature verification failed/u,
    );
  });

  it('rejects a forged self-consistent delivery manifest and an invalid clock', async () => {
    const input = await fixture();
    const options = exportOptions(input);
    const result = await runPublicDirectoryExport(options);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest['effectiveValidUntil'] = '2099-01-01T00:00:00.000Z';
    const authentication = manifest['authentication'] as Record<string, unknown>;
    authentication['tag'] = '0'.repeat(64);
    await writeFile(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await expect(
      readPublicDirectoryArtifactForDelivery({
        dataRoot: input.dataRoot,
        manifestPath: result.manifestPath,
        artifactAuthenticationKey: options.artifactAuthenticationKey,
        artifactAuthenticationKeyId: options.artifactAuthenticationKeyId,
        clock: () => now,
      }),
    ).rejects.toThrow(/authentication failed/u);
    await expect(
      readPublicDirectoryArtifactForDelivery({
        dataRoot: input.dataRoot,
        manifestPath: result.manifestPath,
        artifactAuthenticationKey: options.artifactAuthenticationKey,
        artifactAuthenticationKeyId: options.artifactAuthenticationKeyId,
        clock: () => new Date('invalid'),
      }),
    ).rejects.toThrow(/clock must be a valid date/u);
  });

  it('rejects authentication metadata fields that are not covered by the MAC schema', async () => {
    const input = await fixture();
    const options = exportOptions(input);
    const result = await runPublicDirectoryExport(options);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const authentication = manifest['authentication'] as Record<string, unknown>;
    authentication['unsignedExtraField'] = 'attacker-controlled';
    await writeFile(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await expect(
      readPublicDirectoryArtifactForDelivery({
        dataRoot: input.dataRoot,
        manifestPath: result.manifestPath,
        artifactAuthenticationKey: options.artifactAuthenticationKey,
        artifactAuthenticationKeyId: options.artifactAuthenticationKeyId,
        clock: () => now,
      }),
    ).rejects.toThrow(/exactly these fields: algorithm, keyId, tag/u);
  });

  it('rejects publication secrets that reuse the same decoded bytes', async () => {
    const input = await fixture();
    const options = exportOptions(input);
    const reusedSecret = Buffer.alloc(32, 0xfb);

    await expect(
      runPublicDirectoryExport({
        ...options,
        artifactAuthenticationKey: Buffer.alloc(31, 0xa5).toString('base64'),
      }),
    ).rejects.toThrow(/at least 32 random bytes/u);
    await expect(
      runPublicDirectoryExport({
        ...options,
        artifactAuthenticationKey: reusedSecret.toString('base64'),
        publicProfileSecret: reusedSecret.toString('base64url'),
      }),
    ).rejects.toThrow(/must use different secret bytes/u);
  });

  it('rejects a validly signed policy for a different snapshot hash', async () => {
    const input = await fixture();
    await writeSignedPolicy(input, approvedPolicy(input.snapshotId, 'f'.repeat(64)));

    await expect(runPublicDirectoryExport(exportOptions(input))).rejects.toThrow(
      /does not approve/u,
    );
  });

  it('rejects MSP data older than the signed maximum age', async () => {
    const input = await fixture();
    const stalePolicy = approvedPolicy(input.snapshotId, input.profilesSha256);
    const source = stalePolicy['source'] as Record<string, unknown>;
    source['maxSourceAgeDays'] = 1;
    await writeSignedPolicy(input, stalePolicy);

    await expect(runPublicDirectoryExport(exportOptions(input))).rejects.toThrow(/older than/u);
  });

  it('rejects a tampered artifact in the signed source chain', async () => {
    const input = await fixture();
    await writeFile(
      join(input.inputDirectory, 'privacy-and-publication-notice.json'),
      '{}\n',
      'utf8',
    );

    await expect(runPublicDirectoryExport(exportOptions(input))).rejects.toThrow(
      /hash does not match/u,
    );
  });

  it('rejects a self-consistent artifact that is not a factual-v3 snapshot', async () => {
    const input = await fixture();
    const manifestPath = join(input.inputDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['schemaVersion'] = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');

    await expect(runPublicDirectoryExport(exportOptions(input))).rejects.toThrow(/factual-v3/u);
  });
});
