import { describe, expect, it } from 'vitest';

import {
  buildProfessionalResearchView,
  evaluateResearchPersonName,
  institutionalSourceRecordKey,
  normalizeResearchPersonName,
  type BuildProfessionalResearchViewInput,
  type CuratedEthicsCaseReference,
  type CuratedPublicReference,
  type ResearchInstitutionalLinkageCandidate,
  type ResearchMspProfessional,
  type ResearchScheduleRecord,
  type WebEnrichmentCandidate,
} from '../../src';

const professional: ResearchMspProfessional = {
  linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
  fullName: 'TAMARA - DIAZ SANZ FERNANDEZ',
  enabledTitles: [
    {
      title: 'DOCTOR EN MEDICINA',
      recruiterCode: '310000',
      temporaryRegistration: null,
    },
  ],
  provenance: {
    publisher: 'Ministerio de Salud Pública',
    dataset: 'Infotítulos',
    sourceCutoffDate: '2026-06-30',
  },
};

function linkageCandidate(
  institution: string,
  sourceFile: string,
  recordIds: readonly string[],
): ResearchInstitutionalLinkageCandidate {
  return {
    schemaVersion: 2,
    candidateId: `provider_${institution}`,
    status: 'exact_name_only',
    publicationDecision: 'not_merged',
    providerIdentity: {
      institution,
      basis: 'source_professional_id',
      sourceProfessionalId: '123',
      normalizedName: 'TAMARA DIAZ SANZ FERNANDEZ',
    },
    sourceDisplayNames: ['DIAZ SANZ FERNANDEZ, TAMARA'],
    sourceRecords: recordIds.map((recordId) => ({ sourceFile, recordId })),
    sourceSpecialties: ['PSIQUIATRIA'],
    mspCandidates: [
      {
        linkageId: professional.linkageId,
        fullName: professional.fullName,
        enabledTitles: ['DOCTOR EN MEDICINA'],
      },
    ],
    identityEvidence: ['exact_full_name_token_multiset'],
    requiresHumanReview: true,
  };
}

function schedule(
  institution: string,
  sourceFile: string,
  recordId: string,
  dayOfWeek: string,
  value: string,
): readonly [string, ResearchScheduleRecord] {
  return [
    institutionalSourceRecordKey(sourceFile, recordId),
    {
      schemaVersion: 1,
      recordId,
      source: {
        id: institution.toLowerCase(),
        institution,
        url: 'https://example.org/agenda',
      },
      observedAt: '2026-07-28T15:00:00.000Z',
      scheduleType: 'published_consultation_roster',
      appointmentAvailability: 'not_observed',
      sourceProfessionalId: '123',
      sourceProfessionalLabel: professional.fullName,
      professionalName: professional.fullName,
      specialty: 'PSIQUIATRIA',
      venue: { name: 'Central' },
      weeklySchedule: [{ dayOfWeek, sourceLabel: dayOfWeek, value }],
      evidence: {
        rawSnapshotPath: 'raw/doctors/123.html',
        rawSnapshotSha256: 'b'.repeat(64),
        sourceRowNumber: 2,
      },
    },
  ];
}

function publicReference(
  referenceIdSuffix: string,
  publisher: string,
  observedNames: readonly string[],
  referenceKind: CuratedPublicReference['referenceKind'] = 'PUBLIC_METADATA_REFERENCE',
): CuratedPublicReference {
  return {
    schemaVersion: 1,
    referenceId: `public_reference_v1_${referenceIdSuffix.repeat(64)}`,
    referenceKind,
    publisher,
    canonicalUrl: `https://example.org/${publisher}`,
    title: `${publisher} title`,
    sourceDate: '2024-10-26',
    sourceDatePrecision: 'DAY',
    observedNames,
    claim: {
      relationship:
        publisher === 'CLAEH' ? 'MEDICAL_STUDENT_PRESENTATION' : 'ACADEMIC_RESEARCH_COAUTHOR',
      factualSummary: 'Factual metadata summary.',
      institutionContext: [publisher],
      doesNotEstablish: ['IDENTITY', 'EMPLOYMENT'],
    },
    access: {
      mode:
        referenceKind === 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH'
          ? 'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH'
          : 'PUBLIC_METADATA_ONLY',
      automatedFetchAllowed: false,
      contentStored: false,
      rightsNote: 'Metadata only.',
    },
    corroboratesReferenceIds: [],
    decision: {
      identityConfirmed: false,
      factConfirmed: false,
      linkageDecision: 'NOT_LINKED',
      publicationDecision: 'NOT_PUBLISHED',
      publicExportAllowed: false,
      requiresHumanReview: true,
    },
  };
}

function webCandidate(): WebEnrichmentCandidate {
  return {
    schemaVersion: 1,
    candidateId: 'web_claeh',
    state: 'NEEDS_HUMAN_REVIEW',
    quarantine: true,
    subject: {
      opaqueProfessionalId: professional.linkageId,
      displayName: professional.fullName,
    },
    claim: {
      category: 'ACADEMIC_MENTION',
      sourceId: 'claeh',
      publisher: 'CLAEH',
    },
    match: {
      kind: 'PARTIAL_TOKEN_SUBSET',
      flexibilityIndex: 1,
      meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
      ambiguity: 'NONE',
      competingOpaqueProfessionalIds: [],
      alerts: ['CONTEXT_CORROBORATION_REQUIRED'],
    },
    provenance: {
      canonicalUrl: 'https://example.org/claeh',
      contentSha256: 'c'.repeat(64),
      retrievedAt: '2026-07-28T00:00:00.000Z',
      transport: 'DIRECT_FETCH',
      professionalSnapshotSha256: 'd'.repeat(64),
      sourcePolicySha256: 'e'.repeat(64),
    },
    linkageDecision: { decision: 'NOT_LINKED', identityConfirmed: false },
    factDecision: { factConfirmed: false },
    publicationDecision: {
      decision: 'NOT_PUBLISHED',
      destination: 'INTERNAL_QUARANTINE_ONLY',
      publicExportAllowed: false,
    },
    retention: {
      expiresAt: '2026-08-27T00:00:00.000Z',
      disposition: 'DELETE_OR_REVALIDATE',
    },
  };
}

function ethicsCase(observedRespondentNames: readonly string[]): CuratedEthicsCaseReference {
  return {
    schemaVersion: 1,
    ethicsCaseId: `ethics_case_v1_${'8'.repeat(64)}`,
    sourceCaseKey: '142/2021',
    publisher: 'Colegio Medico del Uruguay',
    tribunal: 'Tribunal de Etica Medica',
    title: '142/2021 ASSE C/ DR. FABRICIO EJEMPLO',
    canonicalUrl: 'https://www.colegiomedico.org.uy/fallos/expediente-142-2021-asse-c-dr-ejemplo/',
    collectionMode: 'AUTOMATED_PUBLIC_METADATA_SNAPSHOT',
    visibility: 'ORIGINAL',
    outcome: 'UNKNOWN',
    finalityStatus: 'UNKNOWN',
    currentnessVerified: false,
    sourceDate: '2022-11-28',
    sourceDatePrecision: 'DAY',
    observedRespondentNames,
    documents: [
      {
        label: 'Fallo del Tribunal de Etica Medica',
        sourceDate: '2022-11-28',
        sourceDatePrecision: 'DAY',
        contentFetched: false,
      },
    ],
    firstObservedAt: '2026-07-29T15:00:00.000Z',
    lastObservedAt: '2026-07-29T15:00:00.000Z',
    contentStored: false,
    source: {
      sitemapUrl: 'https://www.colegiomedico.org.uy/fallos-sitemap.xml',
      sitemapLastModified: '2026-07-29',
      robotsUrl: 'https://www.colegiomedico.org.uy/robots.txt',
      pageMetadataOnly: true,
    },
  };
}

function input(): BuildProfessionalResearchViewInput {
  const spanishFile = 'raw/mutualistas/espanola/schedules.ndjson';
  const uruguayanFile = 'raw/mutualistas/medica-uruguaya/schedules.ndjson';
  return {
    reportId: `professional_research_v1_${'f'.repeat(64)}`,
    generatedAt: '2026-07-28T22:00:00.000Z',
    query: { mode: 'NAME', value: 'Tamara Diaz Sanz' },
    mspProfessionals: [professional],
    institutionalLinkageCandidates: [
      linkageCandidate('Asociación Española', spanishFile, ['spanish-1', 'spanish-2']),
      linkageCandidate('Médica Uruguaya', uruguayanFile, ['uruguayan-1']),
    ],
    schedulesBySourceRecord: new Map([
      schedule('Asociación Española', spanishFile, 'spanish-1', 'tuesday', '09:00-12:00'),
      schedule('Asociación Española', spanishFile, 'spanish-2', 'tuesday', '13:00-15:00'),
      schedule('Médica Uruguaya', uruguayanFile, 'uruguayan-1', 'wednesday', '14:00-17:00'),
    ]),
    webCandidates: [webCandidate()],
    publicReferences: [
      publicReference('1', 'CLAEH', ['Tamara Díaz Sanz']),
      publicReference('2', 'Hospital Vilardebó', ['Tamara Díaz-Sanz']),
      publicReference('3', 'LinkedIn', ['Tamara Diaz Sanz'], 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH'),
    ],
    sourceCoverage: [
      {
        sourceId: 'cmu-tribunal-etica-fallos',
        publisher: 'Colegio Medico del Uruguay',
        sourceUrl: 'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/',
        category: 'PROFESSIONAL_ETHICS_RULINGS',
        status: 'SOURCE_BLOCKED_ROBOTS',
        policyReviewedAt: '2026-07-28',
        automatedFetchPerformed: false,
        namedMatchStatus: 'NOT_CHECKED_DUE_TO_AUTOMATION_PROHIBITED',
        noFindingProvesAbsence: false,
        identityDecision: 'NOT_LINKED',
        publicationDecision: 'NOT_PUBLISHED',
        warnings: ['SOURCE_ROBOTS_POLICY_PROHIBITS_AUTOMATED_COLLECTION'],
      },
    ],
    checkedScheduleArtifacts: 2,
    webEnrichmentSnapshotChecked: true,
    curatedReferenceLedgerChecked: true,
  };
}

describe('professional research view', () => {
  it('collects every Tamara acceptance signal without linking or publishing identity', () => {
    const result = buildProfessionalResearchView(input());
    const candidate = result.candidates[0];

    expect(result.query).toEqual(
      expect.objectContaining({
        bestFlexibilityIndex: 1,
        ambiguity: 'NONE',
      }),
    );
    expect(candidate?.signalSummary).toEqual(
      expect.objectContaining({
        officialRegistryRecords: 1,
        institutionalCandidates: 2,
        scheduleRecords: 3,
        webCandidates: 1,
        publicReferenceCandidates: 3,
      }),
    );
    expect(
      candidate?.institutionalCandidates.flatMap(({ schedules }) =>
        schedules.flatMap(({ weeklySchedule }) => weeklySchedule.map(({ value }) => value)),
      ),
    ).toEqual(['09:00-12:00', '13:00-15:00', '14:00-17:00']);
    expect(
      candidate?.publicReferenceCandidates.find(
        ({ reference }) => reference.publisher === 'LinkedIn',
      )?.alerts,
    ).toContain('SOURCE_WAS_NOT_AUTOMATICALLY_FETCHED');
    expect(result.publication).toEqual(
      expect.objectContaining({
        decision: 'NOT_PUBLISHED',
        publicExportAllowed: false,
        automaticIdentityConfirmation: false,
      }),
    );
    expect(result.delivery).toEqual({
      intendedSurface: 'AUTHENTICATED_PRIVATE_API',
      intendedAudience: 'OWNER_ONLY',
      canonicalUrlsIncluded: true,
      privateApiDeliveryAllowed: true,
      publicApiDeliveryAllowed: false,
      authenticationEnforcedBy: 'CALLING_API',
    });
    expect(candidate?.sourceCoverage).toEqual([
      expect.objectContaining({
        sourceId: 'cmu-tribunal-etica-fallos',
        status: 'SOURCE_BLOCKED_ROBOTS',
        automatedFetchPerformed: false,
      }),
    ]);
    expect(
      candidate?.institutionalCandidates.every(({ identityConfirmed }) => !identityConfirmed),
    ).toBe(true);
  });

  it('selects every best-looseness homonym and reports ambiguity', () => {
    const duplicate: ResearchMspProfessional = {
      ...professional,
      linkageId: `msp_doc_v1_${'9'.repeat(64)}`,
    };
    const result = buildProfessionalResearchView({
      ...input(),
      query: { mode: 'NAME', value: 'Tamara Diaz Sanz Fernandez' },
      mspProfessionals: [professional, duplicate],
      institutionalLinkageCandidates: [],
      schedulesBySourceRecord: new Map(),
      webCandidates: [],
      publicReferences: [],
    });

    expect(result.query.ambiguity).toBe('MULTIPLE_CANDIDATES');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(({ queryMatch }) => queryMatch.flexibilityIndex === 0)).toBe(
      true,
    );
  });

  it('emits an exact ethics-case name candidate without confirming identity or sanction', () => {
    const syntheticProfessional: ResearchMspProfessional = {
      ...professional,
      linkageId: `msp_doc_v1_${'7'.repeat(64)}`,
      fullName: 'FABRICIO EJEMPLO',
    };
    const result = buildProfessionalResearchView({
      ...input(),
      query: { mode: 'OPAQUE_MSP_ID', value: syntheticProfessional.linkageId },
      mspProfessionals: [syntheticProfessional],
      institutionalLinkageCandidates: [],
      schedulesBySourceRecord: new Map(),
      webCandidates: [],
      publicReferences: [],
      ethicsCases: [ethicsCase(['FABRICIO EJEMPLO'])],
      ethicsMetadataSnapshotChecked: true,
      sourceCoverage: [
        {
          sourceId: 'cmu-tribunal-etica-fallos',
          publisher: 'Colegio Medico del Uruguay',
          sourceUrl: 'https://www.colegiomedico.org.uy/fallos-sitemap.xml',
          category: 'PROFESSIONAL_ETHICS_RULINGS',
          status: 'CHECKED',
          policyReviewedAt: '2026-07-29',
          automatedFetchPerformed: true,
          namedMatchStatus: 'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX',
          noFindingProvesAbsence: false,
          identityDecision: 'NOT_LINKED',
          publicationDecision: 'NOT_PUBLISHED',
          warnings: ['EXACT_NAME_CANDIDATES_REQUIRE_HUMAN_REVIEW'],
        },
      ],
    });

    const candidate = result.candidates[0];
    expect(candidate?.ethicsCaseCandidates).toHaveLength(1);
    expect(candidate?.ethicsCaseCandidates[0]).toMatchObject({
      observedName: 'FABRICIO EJEMPLO',
      nameMatch: { flexibilityIndex: 0 },
      decision: {
        identityConfirmed: false,
        factConfirmed: false,
        linkageDecision: 'NOT_LINKED',
        publicationDecision: 'NOT_PUBLISHED',
        publicExportAllowed: false,
        requiresHumanReview: true,
      },
    });
    expect(candidate?.ethicsCaseCandidates[0]?.alerts).toContain(
      'CASE_PAGE_PRESENCE_DOES_NOT_ESTABLISH_A_SANCTION',
    );
    expect(candidate?.sourceCoverage[0]?.namedMatchStatus).toBe('CANDIDATE_REQUIRES_HUMAN_REVIEW');
    expect(result.coverage).toEqual(
      expect.objectContaining({
        ethicsMetadataSnapshotChecked: true,
        ethicsCasesObserved: 1,
      }),
    );
  });

  it('retains a partial ethics-case candidate with a strong ambiguity warning', () => {
    const syntheticProfessional: ResearchMspProfessional = {
      ...professional,
      linkageId: `msp_doc_v1_${'6'.repeat(64)}`,
      fullName: 'LUCIA PRUEBA SEGUNDO',
    };
    const result = buildProfessionalResearchView({
      ...input(),
      query: { mode: 'OPAQUE_MSP_ID', value: syntheticProfessional.linkageId },
      mspProfessionals: [syntheticProfessional],
      institutionalLinkageCandidates: [],
      schedulesBySourceRecord: new Map(),
      webCandidates: [],
      publicReferences: [],
      ethicsCases: [ethicsCase(['LUCIA PRUEBA'])],
    });

    expect(result.candidates[0]?.ethicsCaseCandidates[0]).toMatchObject({
      observedName: 'LUCIA PRUEBA',
      nameMatch: { kind: 'PARTIAL_TOKEN_SUBSET', flexibilityIndex: 1 },
      decision: {
        identityConfirmed: false,
        factConfirmed: false,
        linkageDecision: 'NOT_LINKED',
        publicationDecision: 'NOT_PUBLISHED',
        requiresHumanReview: true,
      },
    });
    expect(result.candidates[0]?.ethicsCaseCandidates[0]?.alerts).toEqual(
      expect.arrayContaining([
        'PARTIAL_NAME_MAY_REFER_TO_ANOTHER_PERSON',
        'PARTIAL_CASE_TITLE_NAME_IS_HIGHLY_AMBIGUOUS',
        'ALL_TOKEN_SUBSET_AND_HOMONYM_CANDIDATES_ARE_RETAINED',
      ]),
    );
  });

  it('does not create ethics candidates from initials or one-token observed names', () => {
    const syntheticProfessional: ResearchMspProfessional = {
      ...professional,
      linkageId: `msp_doc_v1_${'5'.repeat(64)}`,
      fullName: 'LUCIA PRUEBA SEGUNDO',
    };
    const result = buildProfessionalResearchView({
      ...input(),
      query: { mode: 'OPAQUE_MSP_ID', value: syntheticProfessional.linkageId },
      mspProfessionals: [syntheticProfessional],
      institutionalLinkageCandidates: [],
      schedulesBySourceRecord: new Map(),
      webCandidates: [],
      publicReferences: [],
      ethicsCases: [ethicsCase(['L. PRUEBA']), ethicsCase(['LUCIA'])],
    });

    expect(result.candidates[0]?.ethicsCaseCandidates).toEqual([]);
  });

  it('normalizes accents, surname-first forms and initials without treating them as confidence', () => {
    expect(
      evaluateResearchPersonName('TAMARA DIAZ SANZ FERNANDEZ', 'Díaz Sanz Fernández, Tamara'),
    ).toEqual(expect.objectContaining({ kind: 'EXACT_NORMALIZED_NAME', flexibilityIndex: 0 }));
    expect(evaluateResearchPersonName('GABRIEL GIANNINI', 'G. Giannini')).toEqual(
      expect.objectContaining({
        kind: 'INITIALS_TOKEN_SUBSEQUENCE',
        flexibilityIndex: 2,
        meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
      }),
    );
    expect(
      evaluateResearchPersonName(
        'TAMARA DIAZ SANZ FERNANDEZ',
        'Dra. Tamara (consulta externa) Diaz Sanz Fernandez',
      ),
    ).toEqual(expect.objectContaining({ kind: 'EXACT_NORMALIZED_NAME', flexibilityIndex: 0 }));
    expect(normalizeResearchPersonName(`${'('.repeat(20_000)}X`)).toBe('X');
  });
});
