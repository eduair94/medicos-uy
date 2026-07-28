import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDirectoryLegalNotice,
  buildDirectorySnapshot,
  installDirectorySnapshotAtomically,
  type MspDirectoryInput,
} from './build-directory-snapshot';

import type { LinkageCandidate } from '../linkage/build-linkage-candidates';

const professionals: readonly MspDirectoryInput[] = [
  {
    linkageId: `msp_doc_v1_${'1'.repeat(64)}`,
    fullName: 'Ana María Ejemplo',
    enabledTitles: [
      {
        recruiterCode: 'private-synthetic-code-1',
        temporaryRegistration: null,
        title: 'DOCTOR EN MEDICINA',
      },
      {
        recruiterCode: 'private-synthetic-code-2',
        temporaryRegistration: null,
        title: 'ESPECIALISTA EN CARDIOLOGÍA',
      },
    ],
    provenance: {
      publisher: 'Ministerio de Salud Pública',
      dataset: 'Infotítulos',
      sourceCutoffDate: '2026-06-30',
    },
  },
  {
    linkageId: `msp_doc_v1_${'2'.repeat(64)}`,
    fullName: 'Bruno Ejemplo',
    enabledTitles: [
      {
        recruiterCode: 'private-synthetic-code-3',
        temporaryRegistration: null,
        title: 'DOCTOR EN MEDICINA',
      },
    ],
    provenance: {
      publisher: 'Ministerio de Salud Pública',
      dataset: 'Infotítulos',
      sourceCutoffDate: '2026-06-30',
    },
  },
];

function linkageCandidate(
  overrides: Partial<LinkageCandidate> & {
    readonly institution: string;
    readonly status: LinkageCandidate['status'];
  },
): LinkageCandidate {
  const { institution, status, ...remainingOverrides } = overrides;
  return {
    schemaVersion: 2,
    candidateId: `provider_identity_v2_${institution
      .normalize('NFKD')
      .replaceAll(/\W/gu, '')
      .padEnd(64, '0')
      .slice(0, 64)}`,
    status,
    publicationDecision: 'not_merged',
    providerIdentity: {
      institution,
      basis: 'institution_and_exact_name',
      sourceProfessionalId: null,
      normalizedName: 'ANA MARIA EJEMPLO',
    },
    sourceDisplayNames: ['EJEMPLO, ANA MARÍA'],
    sourceRecords: [
      {
        sourceFile: 'raw/mutualistas/synthetic/schedules.ndjson',
        recordId: 'synthetic-source-record',
      },
    ],
    sourceSpecialties: ['Cardiología'],
    mspCandidates: [
      {
        linkageId: professionals[0]?.linkageId ?? '',
        fullName: professionals[0]?.fullName ?? '',
        enabledTitles: ['DOCTOR EN MEDICINA', 'ESPECIALISTA EN CARDIOLOGÍA'],
      },
    ],
    identityEvidence: ['exact_full_name_token_multiset'],
    requiresHumanReview: true,
    ...remainingOverrides,
  };
}

describe('directory snapshot crossing', () => {
  it('keeps every MSP professional and attaches only reviewable, non-public link candidates', () => {
    const candidates: readonly LinkageCandidate[] = [
      linkageCandidate({
        institution: 'Prestador sintético',
        status: 'exact_name_and_title_consistent',
        identityEvidence: [
          'exact_full_name_token_multiset',
          'specialty_consistent_with_registered_title',
        ],
      }),
      linkageCandidate({
        institution: 'Prestador ambiguo',
        status: 'ambiguous_exact_name',
        mspCandidates: [
          {
            linkageId: professionals[0]?.linkageId ?? '',
            fullName: professionals[0]?.fullName ?? '',
            enabledTitles: ['DOCTOR EN MEDICINA'],
          },
          {
            linkageId: professionals[1]?.linkageId ?? '',
            fullName: professionals[1]?.fullName ?? '',
            enabledTitles: ['DOCTOR EN MEDICINA'],
          },
        ],
      }),
      linkageCandidate({
        institution: 'Prestador sin coincidencia',
        status: 'unmatched',
        mspCandidates: [],
        identityEvidence: [],
      }),
    ];

    const result = buildDirectorySnapshot(professionals, candidates);

    expect(result.profiles).toHaveLength(2);
    expect(result.aggregates).toMatchObject({
      mspProfiles: 2,
      profilesWithCandidateResolutions: 2,
      linkageResolutions: 3,
      abstainedResolutions: 3,
      linkedInstitutionalObservations: 0,
    });
    expect(result.profiles[0]).toMatchObject({
      displayName: 'Ana María Ejemplo',
      enabledTitles: ['DOCTOR EN MEDICINA', 'ESPECIALISTA EN CARDIOLOGÍA'],
      registeredTitles: [
        {
          title: 'DOCTOR EN MEDICINA',
          temporaryRegistration: 'NONE',
        },
        {
          title: 'ESPECIALISTA EN CARDIOLOGÍA',
          temporaryRegistration: 'NONE',
        },
      ],
      linkageReview: {
        linkedInstitutionalObservations: 0,
      },
      notice: {
        sourceCutoffDate: '2026-06-30',
        expectedRefreshFrequency: 'monthly',
      },
      publication: {
        institutionalLinks: 'not_public',
        publicExportAllowed: false,
      },
    });
    expect(result.profiles[0]?.notice.shortText).toContain('2026-06-30');
    expect(result.profiles[0]?.notice.shortText).toContain('Actualización prevista: mensual');
    expect(result.linkageResolutions).toHaveLength(3);
    expect(result.linkageResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateStatus: 'exact_name_and_title_consistent',
          outcome: 'ABSTAINED',
          reasonCode: 'HUMAN_REVIEW_REQUIRED',
          selectedMspLinkageId: null,
          publicationState: 'not_public',
        }),
        expect.objectContaining({
          candidateStatus: 'ambiguous_exact_name',
          reasonCode: 'MULTIPLE_MSP_CANDIDATES',
        }),
        expect.objectContaining({
          candidateStatus: 'unmatched',
          reasonCode: 'NO_MSP_CANDIDATE',
        }),
      ]),
    );
    expect(JSON.stringify(result.profiles)).not.toContain('private-synthetic-code');
  });

  it('rejects a candidate that references a professional outside the MSP snapshot', () => {
    const candidate = linkageCandidate({
      institution: 'Prestador sintético',
      status: 'exact_name_only',
      mspCandidates: [
        {
          linkageId: `msp_doc_v1_${'9'.repeat(64)}`,
          fullName: 'Persona ausente',
          enabledTitles: ['DOCTOR EN MEDICINA'],
        },
      ],
    });

    expect(() => buildDirectorySnapshot(professionals, [candidate])).toThrow(
      /unknown MSP professional/u,
    );
  });
});

describe('directory privacy and publication notice', () => {
  it('stays blocked and reports every missing Article 13 notice field', () => {
    const notice = buildDirectoryLegalNotice();

    expect(notice.publicationGate).toMatchObject({
      state: 'blocked',
      approval: {
        required: true,
        approved: false,
      },
      sourceApprovalRequired: true,
      disclaimerAloneCreatesLegalBasis: false,
      missingConfiguration: [
        'name',
        'address',
        'rightsEmail',
        'privacyNoticeUrl',
        'urcdpRegistration',
        'databaseName',
        'processorsNotice',
        'recipientsNotice',
        'internationalTransfersNotice',
      ],
    });
    expect(notice.article13).toMatchObject({
      database: {
        exists: true,
        name: null,
      },
      collection: {
        directlyFromDataSubject: false,
        questionnaireUsed: false,
        responseRequirement: 'not_applicable_no_questionnaire',
      },
      informationOnRequestMaximumBusinessDays: 5,
      automatedAssessment: {
        used: false,
        criteria: null,
        processes: null,
        technology: null,
      },
    });
    expect(notice.rights).toMatchObject({
      maximumResponseTimeBusinessDays: 5,
      access: {
        identityVerificationRequired: true,
        completeRecordRequired: true,
        thirdPartyDataDisclosureProhibited: true,
      },
      rectification: {
        freeOfCharge: true,
        markAsUnderReviewDuringVerification: true,
        notifyRecipientsMaximumBusinessDays: 5,
      },
    });
    expect(notice.sourcePolicy.msp).toMatchObject({
      classification: 'provisional_official_source_pending_dataset_specific_review',
      expectedRefreshFrequency: 'monthly',
      license: {
        status: 'provisional_unverified_for_this_dataset',
        appliesToDatasetConfirmed: false,
      },
      gates: {
        legalBasis: { required: true, approved: false },
        purposeCompatibility: { required: true, approved: false },
        reuseAuthorization: { required: true, approved: false },
      },
    });
    expect(notice.sourcePolicy.institutions).toMatchObject({
      internetAloneIsNotPublicSource: true,
      assessmentUnit: 'each_source_url_and_field',
      gates: {
        legalBasis: { required: true, approved: false },
        purposeCompatibility: { required: true, approved: false },
        reuseAuthorization: { required: true, approved: false },
      },
      publicationState: 'withheld_pending_source_authorization_and_human_review',
    });
  });

  it('does not mistake configured notice fields for legal approval', () => {
    const notice = buildDirectoryLegalNotice({
      controllerName: 'Directorio Médico del Plata SAS',
      address: 'Avenida Italia 1234, Montevideo',
      databaseName: 'Directorio factual de profesionales habilitados',
      rightsEmail: 'privacidad@directoriomedicodelplata.uy',
      privacyNoticeUrl: 'https://directoriomedicodelplata.uy/privacidad',
      urcdpRegistration: '2026-000123',
      processorsNotice: 'Proveedores de infraestructura sujetos a instrucciones documentadas',
      recipientsNotice: 'No existen destinatarios externos en el snapshot interno',
      internationalTransfersNotice: 'Sin transferencias internacionales',
    });

    expect(notice.controller.name).toBe('Directorio Médico del Plata SAS');
    expect(notice.processing.processorsNotice).not.toBe(notice.processing.recipientsNotice);
    expect(notice.publicationGate.missingConfiguration).toEqual([]);
    expect(notice.publicationGate.state).toBe('blocked');
    expect(notice.publicationGate.approval).toEqual({
      required: true,
      approved: false,
    });
    expect(notice.status).toBe('template_not_approved_for_publication');
  });

  it('rejects placeholders, invalid email addresses and non-HTTPS notice URLs', () => {
    expect(() =>
      buildDirectoryLegalNotice({
        controllerName: '[razón social]',
      }),
    ).toThrow(/placeholder content/u);
    expect(() =>
      buildDirectoryLegalNotice({
        rightsEmail: 'privacidad-sin-arroba',
      }),
    ).toThrow(/valid email address/u);
    expect(() =>
      buildDirectoryLegalNotice({
        privacyNoticeUrl: 'http://directoriomedicodelplata.uy/privacidad',
      }),
    ).toThrow(/absolute HTTPS URL/u);
    expect(() =>
      buildDirectoryLegalNotice({
        privacyNoticeUrl: 'https://example.invalid/privacidad',
      }),
    ).toThrow(/placeholder content/u);
  });
});

describe('atomic directory snapshot installation', () => {
  const artifact = {
    profilesContent: '{"profile":"synthetic"}\n',
    linkageResolutionsContent: '{"resolution":"synthetic"}\n',
    noticeContent: '{"notice":"synthetic"}\n',
    manifestContent: '{"manifest":"synthetic"}\n',
  } as const;

  it('publishes the four-file snapshot with one directory rename', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'medicos-directory-install-'));
    const outputDirectory = join(temporaryRoot, 'factual-v3-synthetic');

    try {
      await installDirectorySnapshotAtomically({
        outputDirectory,
        ...artifact,
      });

      expect((await readdir(outputDirectory)).sort()).toEqual([
        'linkage-resolutions.ndjson',
        'manifest.json',
        'privacy-and-publication-notice.json',
        'profiles.ndjson',
      ]);
      expect(await readFile(join(outputDirectory, 'profiles.ndjson'), 'utf8')).toBe(
        artifact.profilesContent,
      );
      expect(await readFile(join(outputDirectory, 'manifest.json'), 'utf8')).toBe(
        artifact.manifestContent,
      );
      expect(
        (await readdir(temporaryRoot)).filter((entry) =>
          entry.startsWith('.directory-snapshot-stage-'),
        ),
      ).toEqual([]);
    } finally {
      await rm(temporaryRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it('removes staging and leaves no final snapshot when the directory commit fails', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'medicos-directory-install-'));
    const outputDirectory = join(temporaryRoot, 'factual-v3-synthetic');

    try {
      await expect(
        installDirectorySnapshotAtomically(
          {
            outputDirectory,
            ...artifact,
          },
          () => Promise.reject(new Error('synthetic directory commit failure')),
        ),
      ).rejects.toThrow(/synthetic directory commit failure/u);

      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, {
        recursive: true,
        force: true,
      });
    }
  });
});
