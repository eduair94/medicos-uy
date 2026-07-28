import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildPublicDirectoryProfiles,
  parseCanonicalApprovedSourcePublicationPolicy,
  parseApprovedSourcePublicationPolicy,
  PUBLIC_PROFILE_FIELD_ALLOWLIST,
  PUBLIC_PROFILE_FORBIDDEN_KEYS,
  verifyDetachedPublicationPolicySignature,
} from './public-directory-policy';

import type { DirectoryProfile } from '../directory/build-directory-snapshot';

const now = new Date('2026-07-27T12:00:00.000Z');
const publicProfileSecret = createHash('sha256')
  .update('synthetic-public-profile-secret', 'utf8')
  .digest('base64url');

function rawPolicy(): Record<string, unknown> {
  const approval = {
    approved: true,
    reviewedBy: 'Synthetic reviewer',
    reviewedAt: '2026-07-27T10:00:00.000Z',
    reference: 'Synthetic test approval',
  };

  return {
    schemaVersion: 1,
    policyId: 'synthetic-policy-v1',
    policyExpiresAt: '2026-08-27T12:00:00.000Z',
    approvedSnapshot: {
      snapshotId: `factual-v3-${'1'.repeat(16)}`,
      profilesSha256: '2'.repeat(64),
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
      publisher: 'Ministerio de Salud Publica',
      dataset: 'Infotitulos',
      canonicalUrl:
        'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos',
      liveLookupUrl:
        'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud',
      attribution: 'MSP Infotitulos - synthetic test policy',
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

const internalProfile: DirectoryProfile = {
  schemaVersion: 2,
  internalLinkageId: `msp_doc_v1_${'a'.repeat(64)}`,
  displayName: 'Ana Maria Ejemplo',
  enabledTitles: ['DOCTOR EN MEDICINA'],
  registeredTitles: [
    {
      title: 'DOCTOR EN MEDICINA',
      temporaryRegistration: 'NONE',
    },
  ],
  officialRegistry: {
    publisher: 'Ministerio de Salud Publica',
    dataset: 'Infotitulos',
    sourceCutoffDate: '2026-06-30',
    datasetUrl:
      'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos',
    liveLookupUrl: 'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud',
  },
  linkageReview: {
    resolutionIds: ['private-resolution-id'],
    linkedInstitutionalObservations: 0,
  },
  notice: {
    noticeVersion: 'uy-medical-directory-factual-v3',
    status: 'internal_research_only',
    sourceCutoffDate: '2026-06-30',
    expectedRefreshFrequency: 'monthly',
    warningCodes: ['NOT_MEDICAL_ADVICE', 'VERIFY_WITH_OFFICIAL_SOURCE'],
    shortText: 'Synthetic internal notice',
  },
  publication: {
    profileFacts: 'pending_evidence_and_legal_approval',
    institutionalLinks: 'not_public',
    publicExportAllowed: false,
  },
};

describe('public directory publication policy', () => {
  it('requires every legal, purpose and reuse decision to be explicitly approved', () => {
    const policy = rawPolicy();
    const source = policy['source'] as Record<string, unknown>;
    source['reuseAuthorization'] = {
      approved: false,
    };

    expect(() => parseApprovedSourcePublicationPolicy(policy, now)).toThrow(/not approved/u);
  });

  it('requires every release prerequisite to be explicitly approved', () => {
    const policy = rawPolicy();
    const prerequisites = policy['releasePrerequisites'] as Record<string, unknown>;
    prerequisites['databaseRegistration'] = {
      approved: false,
    };

    expect(() => parseApprovedSourcePublicationPolicy(policy, now)).toThrow(
      /databaseRegistration.*not approved/u,
    );
  });

  it('rejects expired policies and any field outside the exact allowlist', () => {
    const expired = rawPolicy();
    expired['policyExpiresAt'] = '2026-07-27T11:59:59.000Z';
    expect(() => parseApprovedSourcePublicationPolicy(expired, now)).toThrow(/expired/u);

    const extraField = rawPolicy();
    const source = extraField['source'] as Record<string, unknown>;
    source['allowedFieldPaths'] = [...PUBLIC_PROFILE_FIELD_ALLOWLIST, 'internalLinkageId'];
    expect(() => parseApprovedSourcePublicationPolicy(extraField, now)).toThrow(/exactly match/u);
  });

  it('rejects ambiguous non-canonical policy dates', () => {
    const policy = rawPolicy();
    policy['policyExpiresAt'] = '08/27/2026';

    expect(() => parseApprovedSourcePublicationPolicy(policy, now)).toThrow(/canonical ISO/u);
  });

  it('accepts only canonical JSON bytes and therefore rejects duplicate keys', () => {
    const canonical = `${JSON.stringify(rawPolicy(), null, 2)}\n`;
    expect(parseCanonicalApprovedSourcePublicationPolicy(canonical, now).policyId).toBe(
      'synthetic-policy-v1',
    );

    const duplicateKey = canonical.replace(
      '  "schemaVersion": 1,',
      '  "schemaVersion": 1,\n  "schemaVersion": 1,',
    );
    expect(() => parseCanonicalApprovedSourcePublicationPolicy(duplicateKey, now)).toThrow(
      /canonical.*unique keys/u,
    );
    expect(() =>
      parseCanonicalApprovedSourcePublicationPolicy(JSON.stringify(rawPolicy()), now),
    ).toThrow(/canonical/u);
  });

  it('authenticates the exact policy bytes with a pinned Ed25519 key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const policyContent = `${JSON.stringify(rawPolicy())}\n`;
    const signature = sign(null, Buffer.from(policyContent, 'utf8'), privateKey).toString('base64');
    const publicKeyPem = publicKey
      .export({
        format: 'pem',
        type: 'spki',
      })
      .toString();
    const publicKeySha256 = createHash('sha256')
      .update(
        publicKey.export({
          format: 'der',
          type: 'spki',
        }),
      )
      .digest('hex');

    expect(
      verifyDetachedPublicationPolicySignature({
        policyContent,
        signatureContent: signature,
        publicKeyPem,
        expectedPublicKeySha256: publicKeySha256,
        signerKeyId: 'legal-release-2026-01',
      }),
    ).toMatchObject({
      algorithm: 'Ed25519',
      signerKeyId: 'legal-release-2026-01',
      publicKeySha256,
    });
    expect(() =>
      verifyDetachedPublicationPolicySignature({
        policyContent: `${policyContent} `,
        signatureContent: signature,
        publicKeyPem,
        expectedPublicKeySha256: publicKeySha256,
        signerKeyId: 'legal-release-2026-01',
      }),
    ).toThrow(/verification failed/u);
  });

  it('emits only the allowlisted public projection with a separate opaque id', () => {
    const policy = parseApprovedSourcePublicationPolicy(rawPolicy(), now);
    const [profile] = buildPublicDirectoryProfiles([internalProfile], policy, publicProfileSecret);

    expect(profile).toMatchObject({
      displayName: internalProfile.displayName,
      registeredTitles: internalProfile.registeredTitles,
      source: {
        policyId: 'synthetic-policy-v1',
        reuseBasis: 'OFFICIAL_PUBLICATION_REVIEW',
      },
      notice: {
        notMedicalAdvice: true,
        notRealTime: true,
        verifyWithOfficialSource: true,
      },
    });
    expect(profile?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(profile?.id).not.toContain(internalProfile.internalLinkageId);
    expect(profile?.slug).toMatch(/^ana-maria-ejemplo-[0-9a-f]{8}$/u);

    const serialized = JSON.stringify(profile);
    for (const forbiddenKey of PUBLIC_PROFILE_FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`);
    }
    expect(serialized).not.toContain(internalProfile.internalLinkageId);
    expect(serialized).not.toContain('private-resolution-id');
  });

  it('rejects a profile whose source differs from the reviewed source', () => {
    const policy = parseApprovedSourcePublicationPolicy(rawPolicy(), now);
    const mismatched: DirectoryProfile = {
      ...internalProfile,
      officialRegistry: {
        ...internalProfile.officialRegistry,
        datasetUrl: 'https://example.invalid/unapproved-source',
      },
    };

    expect(() => buildPublicDirectoryProfiles([mismatched], policy, publicProfileSecret)).toThrow(
      /does not match/u,
    );
  });

  it('rejects duplicate public identifiers', () => {
    const policy = parseApprovedSourcePublicationPolicy(rawPolicy(), now);

    expect(() =>
      buildPublicDirectoryProfiles([internalProfile, internalProfile], policy, publicProfileSecret),
    ).toThrow(/identifiers must be unique/u);
  });

  it('publishes the earliest effective expiry across policy and source approval', () => {
    const raw = rawPolicy();
    raw['policyExpiresAt'] = '2026-08-01T00:00:00.000Z';
    const policy = parseApprovedSourcePublicationPolicy(raw, now);
    const [profile] = buildPublicDirectoryProfiles([internalProfile], policy, publicProfileSecret);

    expect(profile?.source.validUntil).toBe('2026-08-01T00:00:00.000Z');
  });

  it('requires a canonical public-profile secret containing at least 32 decoded bytes', () => {
    const policy = parseApprovedSourcePublicationPolicy(rawPolicy(), now);

    expect(() =>
      buildPublicDirectoryProfiles([internalProfile], policy, 'not-a-canonical-secret-value!'),
    ).toThrow(/canonical base64/u);
    expect(() =>
      buildPublicDirectoryProfiles(
        [internalProfile],
        policy,
        Buffer.alloc(31, 0x5a).toString('base64url'),
      ),
    ).toThrow(/at least 32 random bytes/u);
  });
});
