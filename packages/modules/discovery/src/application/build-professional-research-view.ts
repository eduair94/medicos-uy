import { createHash } from 'node:crypto';

import {
  alertsForResearchNameMatch,
  institutionalSourceRecordKey,
  isResearchEthicsCandidateNameMatch,
} from '../domain/professional-research-contracts';
import {
  evaluateResearchPersonName,
  normalizeResearchPersonName,
} from '../domain/research-person-name';

import type {
  BuildProfessionalResearchViewInput,
  CuratedPublicReference,
  ProfessionalResearchCandidateView,
  ProfessionalResearchViewV1,
  ResearchMspProfessional,
} from '../domain/professional-research-contracts';
import type { ResearchPersonNameMatch } from '../domain/research-person-name';

type PublicReferenceCandidate =
  ProfessionalResearchCandidateView['publicReferenceCandidates'][number];
type EthicsCaseCandidate = ProfessionalResearchCandidateView['ethicsCaseCandidates'][number];

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'es'));
}

function queryCandidates(
  query: BuildProfessionalResearchViewInput['query'],
  professionals: readonly ResearchMspProfessional[],
): readonly {
  readonly professional: ResearchMspProfessional;
  readonly match: ResearchPersonNameMatch;
}[] {
  if (query.mode === 'OPAQUE_MSP_ID') {
    const professional = professionals.find(({ linkageId }) => linkageId === query.value);
    return professional === undefined
      ? []
      : [
          {
            professional,
            match: {
              kind: 'EXACT_NORMALIZED_NAME',
              flexibilityIndex: 0,
              canonicalTokenCount: 0,
              observedTokenCount: 0,
              exactObservedTokenCount: 0,
              initialObservedTokenCount: 0,
              meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
            },
          },
        ];
  }

  const candidates = professionals.flatMap((professional) => {
    const match = evaluateResearchPersonName(professional.fullName, query.value);
    return match === null ? [] : [{ professional, match }];
  });
  const bestFlexibilityIndex = Math.min(...candidates.map(({ match }) => match.flexibilityIndex));
  return candidates
    .filter(({ match }) => match.flexibilityIndex === bestFlexibilityIndex)
    .sort((left, right) => left.professional.linkageId.localeCompare(right.professional.linkageId));
}

function directReferenceMatches(
  professional: ResearchMspProfessional,
  references: readonly CuratedPublicReference[],
): ReadonlyMap<string, ResearchPersonNameMatch> {
  const result = new Map<string, ResearchPersonNameMatch>();
  for (const reference of references) {
    const matches = reference.observedNames
      .map((observedName) => evaluateResearchPersonName(professional.fullName, observedName))
      .filter((match): match is ResearchPersonNameMatch => match !== null)
      .sort((left, right) => left.flexibilityIndex - right.flexibilityIndex);
    const bestMatch = matches[0];
    if (bestMatch !== undefined) {
      result.set(reference.referenceId, bestMatch);
    }
  }
  return result;
}

function buildEthicsCaseCandidates(
  professional: ResearchMspProfessional,
  input: BuildProfessionalResearchViewInput,
): readonly EthicsCaseCandidate[] {
  return (input.ethicsCases ?? [])
    .flatMap<EthicsCaseCandidate>((ethicsCase): readonly EthicsCaseCandidate[] => {
      const best = ethicsCase.observedRespondentNames
        .flatMap((observedName) => {
          const nameMatch = evaluateResearchPersonName(professional.fullName, observedName);
          return nameMatch !== null && isResearchEthicsCandidateNameMatch(nameMatch)
            ? [{ observedName, nameMatch }]
            : [];
        })
        .sort((left, right) => {
          const flexibilityOrder =
            left.nameMatch.flexibilityIndex - right.nameMatch.flexibilityIndex;
          if (flexibilityOrder !== 0) {
            return flexibilityOrder;
          }
          const kindOrder =
            Number(left.nameMatch.kind === 'EXACT_TOKEN_MULTISET') -
            Number(right.nameMatch.kind === 'EXACT_TOKEN_MULTISET');
          return kindOrder === 0
            ? left.observedName.localeCompare(right.observedName, 'es')
            : kindOrder;
        })[0];
      return best === undefined
        ? []
        : [
            {
              ethicsCase,
              observedName: best.observedName,
              nameMatch: best.nameMatch,
              decision: {
                identityConfirmed: false,
                factConfirmed: false,
                linkageDecision: 'NOT_LINKED',
                publicationDecision: 'NOT_PUBLISHED',
                publicExportAllowed: false,
                requiresHumanReview: true,
              },
              alerts: [
                ...alertsForResearchNameMatch(best.nameMatch),
                ...(best.nameMatch.flexibilityIndex === 0
                  ? ['EXACT_CASE_TITLE_NAME_IS_NOT_IDENTITY_CONFIRMATION']
                  : [
                      'PARTIAL_CASE_TITLE_NAME_IS_HIGHLY_AMBIGUOUS',
                      'ALL_TOKEN_SUBSET_AND_HOMONYM_CANDIDATES_ARE_RETAINED',
                      'PARTIAL_CASE_TITLE_MATCH_REQUIRES_INDEPENDENT_IDENTITY_CORROBORATION',
                    ]),
                'CASE_PAGE_PRESENCE_DOES_NOT_ESTABLISH_A_SANCTION',
                'OUTCOME_AND_FINALITY_WERE_NOT_READ_FROM_DOCUMENT_CONTENT',
                'SOURCE_DOCUMENTS_WERE_NOT_FETCHED_DUE_TO_ROBOTS_POLICY',
                'ETHICS_CASE_CANDIDATE_REQUIRES_HUMAN_REVIEW',
              ],
            },
          ];
    })
    .sort((left, right) =>
      left.ethicsCase.ethicsCaseId.localeCompare(right.ethicsCase.ethicsCaseId),
    );
}

function buildCandidate(
  input: BuildProfessionalResearchViewInput,
  professional: ResearchMspProfessional,
  queryMatch: ResearchPersonNameMatch,
): ProfessionalResearchCandidateView {
  const institutionalCandidates = input.institutionalLinkageCandidates
    .filter(({ mspCandidates }) =>
      mspCandidates.some(({ linkageId }) => linkageId === professional.linkageId),
    )
    .map((candidate) => {
      const schedules = candidate.sourceRecords.flatMap((record) => {
        const schedule = input.schedulesBySourceRecord.get(
          institutionalSourceRecordKey(record.sourceFile, record.recordId),
        );
        return schedule === undefined ? [] : [schedule];
      });
      const foundIds = new Set(schedules.map(({ recordId }) => recordId));
      const unresolvedSourceRecords = candidate.sourceRecords.filter(
        ({ recordId }) => !foundIds.has(recordId),
      );
      return {
        candidateId: candidate.candidateId,
        institution: candidate.providerIdentity.institution,
        status: candidate.status,
        providerIdentity: candidate.providerIdentity,
        sourceDisplayNames: candidate.sourceDisplayNames,
        sourceSpecialties: candidate.sourceSpecialties,
        identityEvidence: candidate.identityEvidence,
        schedules,
        unresolvedSourceRecords,
        identityConfirmed: false as const,
        linkageDecision: 'NOT_LINKED' as const,
        publicationDecision: 'NOT_PUBLISHED' as const,
        requiresHumanReview: true as const,
        alerts: [
          'INSTITUTIONAL_NAME_MATCH_IS_NOT_AN_AUTOMATIC_IDENTITY_LINK',
          'SCHEDULE_IS_AN_OBSERVED_ROSTER_NOT_REAL_TIME_APPOINTMENT_AVAILABILITY',
          ...(unresolvedSourceRecords.length === 0
            ? []
            : ['ONE_OR_MORE_SOURCE_RECORDS_COULD_NOT_BE_RESOLVED']),
        ],
      };
    })
    .sort((left, right) => left.institution.localeCompare(right.institution, 'es'));

  const webCandidates = input.webCandidates
    .filter(({ subject }) => subject.opaqueProfessionalId === professional.linkageId)
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const directMatches = directReferenceMatches(professional, input.publicReferences);
  const directReferenceIds = new Set(directMatches.keys());
  const publicReferenceCandidates = input.publicReferences
    .flatMap<PublicReferenceCandidate>((reference): readonly PublicReferenceCandidate[] => {
      const nameMatch = directMatches.get(reference.referenceId);
      if (nameMatch !== undefined) {
        return [
          {
            reference,
            nameMatch,
            connection: 'DIRECT_NAME_CANDIDATE' as const,
            alerts: [
              ...alertsForResearchNameMatch(nameMatch),
              'PUBLIC_REFERENCE_REQUIRES_HUMAN_REVIEW',
              ...(reference.claim.doesNotEstablish.includes('EMPLOYMENT')
                ? ['ACADEMIC_CONTEXT_DOES_NOT_ESTABLISH_EMPLOYMENT']
                : []),
              ...(reference.referenceKind === 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH'
                ? ['SOURCE_WAS_NOT_AUTOMATICALLY_FETCHED']
                : []),
            ],
          },
        ];
      }
      const corroboratesMatchedReference = reference.corroboratesReferenceIds.some((referenceId) =>
        directReferenceIds.has(referenceId),
      );
      return corroboratesMatchedReference
        ? [
            {
              reference,
              nameMatch: null,
              connection: 'CORROBORATES_MATCHED_REFERENCE_CONTEXT_ONLY' as const,
              alerts: [
                'SOURCE_DOES_NOT_NAME_THE_PROFESSIONAL',
                'CONTEXT_CORROBORATION_IS_NOT_IDENTITY_CORROBORATION',
              ],
            },
          ]
        : [];
    })
    .sort((left, right) => left.reference.referenceId.localeCompare(right.reference.referenceId));
  const ethicsCaseCandidates = buildEthicsCaseCandidates(professional, input);
  const sourceCoverage = (input.sourceCoverage ?? []).map((coverage) =>
    coverage.category === 'PROFESSIONAL_ETHICS_RULINGS' && coverage.status === 'CHECKED'
      ? {
          ...coverage,
          namedMatchStatus:
            ethicsCaseCandidates.length > 0
              ? ('CANDIDATE_REQUIRES_HUMAN_REVIEW' as const)
              : ('NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX' as const),
        }
      : coverage,
  );

  const publishers = stableUnique([
    professional.provenance.publisher,
    ...institutionalCandidates.map(({ institution }) => institution),
    ...webCandidates.map(({ claim }) => claim.publisher),
    ...publicReferenceCandidates.map(({ reference }) => reference.publisher),
    ...ethicsCaseCandidates.map(({ ethicsCase }) => ethicsCase.publisher),
  ]);
  const institutionContexts = stableUnique(
    publicReferenceCandidates.flatMap(({ reference }) => reference.claim.institutionContext),
  );
  return {
    professional,
    queryMatch,
    institutionalCandidates,
    webCandidates,
    publicReferenceCandidates,
    ethicsCaseCandidates,
    sourceCoverage,
    signalSummary: {
      officialRegistryRecords: 1,
      institutionalCandidates: institutionalCandidates.length,
      scheduleRecords: institutionalCandidates.reduce(
        (total, candidate) => total + candidate.schedules.length,
        0,
      ),
      webCandidates: webCandidates.length,
      publicReferenceCandidates: publicReferenceCandidates.length,
      ethicsCandidates: ethicsCaseCandidates.length,
      publishers,
      institutionContexts,
    },
  };
}

export function buildProfessionalResearchView(
  input: BuildProfessionalResearchViewInput,
): ProfessionalResearchViewV1 {
  const matches = queryCandidates(input.query, input.mspProfessionals);
  const candidates = matches.map(({ professional, match }) =>
    buildCandidate(input, professional, match),
  );
  const bestFlexibilityIndex = matches[0]?.match.flexibilityIndex ?? null;
  const normalized =
    input.query.mode === 'NAME'
      ? normalizeResearchPersonName(input.query.value)
      : input.query.value;
  const calculatedReportId = `professional_research_v1_${createHash('sha256')
    .update(
      JSON.stringify({
        requestedReportId: input.reportId,
        query: { ...input.query, normalized },
        candidateIds: candidates.map(({ professional }) => professional.linkageId),
      }),
    )
    .digest('hex')}`;

  return {
    schemaVersion: 1,
    reportId: input.reportId.length > 0 ? input.reportId : calculatedReportId,
    generatedAt: input.generatedAt,
    purpose: 'INTERNAL_PROFESSIONAL_RESEARCH',
    query: {
      input: input.query.value,
      normalized,
      mode: input.query.mode,
      selectionRule: 'ALL_BEST_LOOSENESS_MATCHES',
      bestFlexibilityIndex,
      ambiguity:
        candidates.length === 0
          ? 'NO_CANDIDATE'
          : candidates.length === 1
            ? 'NONE'
            : 'MULTIPLE_CANDIDATES',
    },
    candidates,
    coverage: {
      mspSnapshotChecked: true,
      linkageSnapshotChecked: true,
      scheduleArtifactsChecked: input.checkedScheduleArtifacts,
      webEnrichmentSnapshotChecked: input.webEnrichmentSnapshotChecked,
      curatedReferenceLedgerChecked: input.curatedReferenceLedgerChecked,
      ethicsMetadataSnapshotChecked: input.ethicsMetadataSnapshotChecked ?? false,
      ethicsCasesObserved: input.ethicsCases?.length ?? 0,
      noFindingsProvesAbsence: false,
    },
    warnings: [
      'NAME_MATCHING_GENERATES_REVIEW_CANDIDATES_ONLY',
      'NON_MSP_RELATIONSHIPS_REMAIN_UNCONFIRMED_AND_UNLINKED',
      'ACADEMIC_MENTION_DOES_NOT_ESTABLISH_EMPLOYMENT_OR_CURRENT_AFFILIATION',
      'SCHEDULES_ARE_TIME_STAMPED_OBSERVATIONS_AND_MAY_CHANGE',
      'NO_FINDINGS_DOES_NOT_PROVE_ABSENCE',
      'ETHICS_CASE_PAGE_METADATA_DOES_NOT_ESTABLISH_IDENTITY_SANCTION_OR_FINALITY',
      'INTERNAL_RESEARCH_OUTPUT_MUST_NOT_ENTER_THE_PUBLIC_DIRECTORY',
    ],
    delivery: {
      intendedSurface: 'AUTHENTICATED_PRIVATE_API',
      intendedAudience: 'OWNER_ONLY',
      canonicalUrlsIncluded: true,
      privateApiDeliveryAllowed: true,
      publicApiDeliveryAllowed: false,
      authenticationEnforcedBy: 'CALLING_API',
    },
    publication: {
      decision: 'NOT_PUBLISHED',
      destination: 'INTERNAL_RESEARCH_ONLY',
      publicExportAllowed: false,
      automaticIdentityConfirmation: false,
      automaticFactConfirmation: false,
    },
  };
}
