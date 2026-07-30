import type { WebEnrichmentCandidate } from './discovery-contracts';
import type { ResearchPersonNameMatch, ResearchPersonNameMatchKind } from './research-person-name';

export type ResearchEthicsCandidateNameMatch = Omit<
  ResearchPersonNameMatch,
  'kind' | 'flexibilityIndex'
> &
  (
    | {
        readonly kind: 'EXACT_NORMALIZED_NAME' | 'EXACT_TOKEN_MULTISET';
        readonly flexibilityIndex: 0;
      }
    | {
        readonly kind: 'PARTIAL_TOKEN_SUBSET';
        readonly flexibilityIndex: 1;
      }
  );

export interface ResearchMspProfessional {
  readonly linkageId: string;
  readonly fullName: string;
  readonly enabledTitles: readonly {
    readonly title: string;
    readonly recruiterCode: string;
    readonly temporaryRegistration: string | null;
  }[];
  readonly provenance: {
    readonly publisher: string;
    readonly dataset: string;
    readonly sourceCutoffDate: string;
  };
}

export interface ResearchInstitutionalLinkageCandidate {
  readonly schemaVersion: 2;
  readonly candidateId: string;
  readonly status:
    'ambiguous_exact_name' | 'exact_name_and_title_consistent' | 'exact_name_only' | 'unmatched';
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
  readonly identityEvidence: readonly string[];
  readonly requiresHumanReview: true;
}

export interface ResearchScheduleRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly source: {
    readonly id: string;
    readonly institution: string;
    readonly url: string;
  };
  readonly observedAt: string;
  readonly scheduleType: 'published_consultation_roster';
  readonly appointmentAvailability: 'not_observed';
  readonly sourceProfessionalId: string;
  readonly sourceProfessionalLabel: string;
  readonly professionalName: string;
  readonly specialty: string;
  readonly venue: {
    readonly name?: string;
    readonly address?: string;
    readonly phone?: string;
    readonly dependency?: string;
  };
  readonly weeklySchedule: readonly {
    readonly dayOfWeek: string;
    readonly sourceLabel: string;
    readonly value: string;
  }[];
  readonly frequency?: string;
  readonly notes?: string;
  readonly evidence: {
    readonly rawSnapshotPath: string;
    readonly rawSnapshotSha256: string;
    readonly sourceRowNumber: number;
  };
}

export type PublicReferenceKind =
  | 'CRAWLED_SOURCE_METADATA'
  | 'PUBLIC_METADATA_REFERENCE'
  | 'MANUAL_REFERENCE_NO_AUTOMATED_FETCH'
  | 'CONTEXT_CORROBORATION_ONLY';

export type PublicReferenceRelationship =
  | 'MEDICAL_STUDENT_PRESENTATION'
  | 'ACADEMIC_RESEARCH_COAUTHOR'
  | 'SPECIALTY_MONOGRAPH_POSTER_COAUTHOR'
  | 'RESEARCH_PROJECT_APPROVAL_CONTEXT';

export interface CuratedPublicReference {
  readonly schemaVersion: 1;
  readonly referenceId: string;
  readonly referenceKind: PublicReferenceKind;
  readonly publisher: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly sourceDate: string;
  readonly sourceDatePrecision: 'DAY' | 'MONTH' | 'YEAR';
  readonly observedNames: readonly string[];
  readonly claim: {
    readonly relationship: PublicReferenceRelationship;
    readonly factualSummary: string;
    readonly institutionContext: readonly string[];
    readonly doesNotEstablish: readonly string[];
  };
  readonly access: {
    readonly mode:
      | 'ALLOWLISTED_PUBLIC_PAGE'
      | 'PUBLIC_METADATA_ONLY'
      | 'USER_OR_RESEARCHER_SUPPLIED_URL_NO_FETCH'
      | 'OFFICIAL_CONTEXT_DOCUMENT';
    readonly automatedFetchAllowed: boolean;
    readonly contentStored: false;
    readonly rightsNote: string;
  };
  readonly corroboratesReferenceIds: readonly string[];
  readonly decision: {
    readonly identityConfirmed: false;
    readonly factConfirmed: false;
    readonly linkageDecision: 'NOT_LINKED';
    readonly publicationDecision: 'NOT_PUBLISHED';
    readonly publicExportAllowed: false;
    readonly requiresHumanReview: true;
  };
}

export interface CuratedEthicsCaseReference {
  readonly schemaVersion: 1;
  readonly ethicsCaseId: string;
  readonly sourceCaseKey: string;
  readonly publisher: string;
  readonly tribunal: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly collectionMode: 'AUTOMATED_PUBLIC_METADATA_SNAPSHOT';
  readonly visibility: 'ORIGINAL' | 'ANONYMIZED' | 'MIXED' | 'UNKNOWN';
  readonly outcome: 'UNKNOWN';
  readonly finalityStatus: 'UNKNOWN';
  readonly currentnessVerified: false;
  readonly sourceDate: string | null;
  readonly sourceDatePrecision: 'DAY' | null;
  readonly observedRespondentNames: readonly string[];
  readonly documents: readonly {
    readonly label: string;
    readonly sourceDate: string | null;
    readonly sourceDatePrecision: 'DAY' | null;
    readonly contentFetched: false;
  }[];
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly contentStored: false;
  readonly source: {
    readonly sitemapUrl: string;
    readonly sitemapLastModified: string | null;
    readonly robotsUrl: string;
    readonly pageMetadataOnly: true;
  };
}

export interface ProfessionalResearchSourceCoverage {
  readonly sourceId: string;
  readonly publisher: string;
  readonly sourceUrl: string;
  readonly category: 'PROFESSIONAL_ETHICS_RULINGS';
  readonly status: 'SOURCE_BLOCKED_ROBOTS' | 'AUTHORIZED_FETCH_NOT_CONFIGURED' | 'CHECKED';
  readonly policyReviewedAt: string;
  readonly automatedFetchPerformed: boolean;
  readonly namedMatchStatus:
    | 'NOT_CHECKED_DUE_TO_AUTOMATION_PROHIBITED'
    | 'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX'
    | 'CANDIDATE_REQUIRES_HUMAN_REVIEW';
  readonly noFindingProvesAbsence: false;
  readonly identityDecision: 'NOT_LINKED';
  readonly publicationDecision: 'NOT_PUBLISHED';
  readonly warnings: readonly string[];
}

export interface ProfessionalResearchCandidateView {
  readonly professional: ResearchMspProfessional;
  readonly queryMatch: ResearchPersonNameMatch;
  readonly institutionalCandidates: readonly {
    readonly candidateId: string;
    readonly institution: string;
    readonly status: ResearchInstitutionalLinkageCandidate['status'];
    readonly providerIdentity: ResearchInstitutionalLinkageCandidate['providerIdentity'];
    readonly sourceDisplayNames: readonly string[];
    readonly sourceSpecialties: readonly string[];
    readonly identityEvidence: readonly string[];
    readonly schedules: readonly ResearchScheduleRecord[];
    readonly unresolvedSourceRecords: readonly {
      readonly sourceFile: string;
      readonly recordId: string;
    }[];
    readonly identityConfirmed: false;
    readonly linkageDecision: 'NOT_LINKED';
    readonly publicationDecision: 'NOT_PUBLISHED';
    readonly requiresHumanReview: true;
    readonly alerts: readonly string[];
  }[];
  readonly webCandidates: readonly WebEnrichmentCandidate[];
  readonly publicReferenceCandidates: readonly {
    readonly reference: CuratedPublicReference;
    readonly nameMatch: ResearchPersonNameMatch | null;
    readonly connection: 'DIRECT_NAME_CANDIDATE' | 'CORROBORATES_MATCHED_REFERENCE_CONTEXT_ONLY';
    readonly alerts: readonly string[];
  }[];
  readonly ethicsCaseCandidates: readonly {
    readonly ethicsCase: CuratedEthicsCaseReference;
    readonly observedName: string;
    readonly nameMatch: ResearchEthicsCandidateNameMatch;
    readonly decision: {
      readonly identityConfirmed: false;
      readonly factConfirmed: false;
      readonly linkageDecision: 'NOT_LINKED';
      readonly publicationDecision: 'NOT_PUBLISHED';
      readonly publicExportAllowed: false;
      readonly requiresHumanReview: true;
    };
    readonly alerts: readonly string[];
  }[];
  readonly sourceCoverage: readonly ProfessionalResearchSourceCoverage[];
  readonly signalSummary: {
    readonly officialRegistryRecords: number;
    readonly institutionalCandidates: number;
    readonly scheduleRecords: number;
    readonly webCandidates: number;
    readonly publicReferenceCandidates: number;
    readonly ethicsCandidates: number;
    readonly publishers: readonly string[];
    readonly institutionContexts: readonly string[];
  };
}

export interface ProfessionalResearchViewV1 {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly generatedAt: string;
  readonly purpose: 'INTERNAL_PROFESSIONAL_RESEARCH';
  readonly query: {
    readonly input: string;
    readonly normalized: string;
    readonly mode: 'NAME' | 'OPAQUE_MSP_ID';
    readonly selectionRule: 'ALL_BEST_LOOSENESS_MATCHES';
    readonly bestFlexibilityIndex: 0 | 1 | 2 | null;
    readonly ambiguity: 'NONE' | 'MULTIPLE_CANDIDATES' | 'NO_CANDIDATE';
  };
  readonly candidates: readonly ProfessionalResearchCandidateView[];
  readonly coverage: {
    readonly mspSnapshotChecked: true;
    readonly linkageSnapshotChecked: true;
    readonly scheduleArtifactsChecked: number;
    readonly webEnrichmentSnapshotChecked: boolean;
    readonly curatedReferenceLedgerChecked: boolean;
    readonly ethicsMetadataSnapshotChecked: boolean;
    readonly ethicsCasesObserved: number;
    readonly noFindingsProvesAbsence: false;
  };
  readonly warnings: readonly string[];
  readonly delivery: {
    readonly intendedSurface: 'AUTHENTICATED_PRIVATE_API';
    readonly intendedAudience: 'OWNER_ONLY';
    readonly canonicalUrlsIncluded: true;
    readonly privateApiDeliveryAllowed: true;
    readonly publicApiDeliveryAllowed: false;
    readonly authenticationEnforcedBy: 'CALLING_API';
  };
  readonly publication: {
    readonly decision: 'NOT_PUBLISHED';
    readonly destination: 'INTERNAL_RESEARCH_ONLY';
    readonly publicExportAllowed: false;
    readonly automaticIdentityConfirmation: false;
    readonly automaticFactConfirmation: false;
  };
}

export interface BuildProfessionalResearchViewInput {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly query: {
    readonly value: string;
    readonly mode: 'NAME' | 'OPAQUE_MSP_ID';
  };
  readonly mspProfessionals: readonly ResearchMspProfessional[];
  readonly institutionalLinkageCandidates: readonly ResearchInstitutionalLinkageCandidate[];
  readonly schedulesBySourceRecord: ReadonlyMap<string, ResearchScheduleRecord>;
  readonly webCandidates: readonly WebEnrichmentCandidate[];
  readonly publicReferences: readonly CuratedPublicReference[];
  readonly ethicsCases?: readonly CuratedEthicsCaseReference[];
  readonly sourceCoverage?: readonly ProfessionalResearchSourceCoverage[];
  readonly checkedScheduleArtifacts: number;
  readonly webEnrichmentSnapshotChecked: boolean;
  readonly curatedReferenceLedgerChecked: boolean;
  readonly ethicsMetadataSnapshotChecked?: boolean;
}

export function institutionalSourceRecordKey(sourceFile: string, recordId: string): string {
  return `${sourceFile.replaceAll('\\', '/')}\u001f${recordId}`;
}

export function alertsForResearchNameMatch(
  match: Pick<ResearchPersonNameMatch, 'flexibilityIndex' | 'kind'>,
): readonly string[] {
  const alerts = ['NAME_RELATION_IS_NOT_IDENTITY_PROOF'];
  if (match.flexibilityIndex === 1) {
    alerts.push('PARTIAL_NAME_MAY_REFER_TO_ANOTHER_PERSON', 'CONTEXT_CORROBORATION_REQUIRED');
  }
  if (match.flexibilityIndex === 2) {
    alerts.push(
      'INITIALS_OR_ABBREVIATED_NAME_HAS_HIGH_AMBIGUITY',
      'PROFESSION_AND_INSTITUTION_CORROBORATION_REQUIRED',
    );
  }
  if (match.kind === ('EXACT_TOKEN_MULTISET' satisfies ResearchPersonNameMatchKind)) {
    alerts.push('NAME_ORDER_DIFFERS_AFTER_NORMALIZATION');
  }
  return alerts;
}

/**
 * Ethics metadata can only create an unverified review candidate. Initials and
 * one-token observed names are intentionally excluded because their ambiguity
 * is too high even for automated candidate generation.
 */
export function isResearchEthicsCandidateNameMatch(
  match: ResearchPersonNameMatch,
): match is ResearchEthicsCandidateNameMatch {
  if (match.observedTokenCount < 2 || match.initialObservedTokenCount > 0) {
    return false;
  }
  return (
    (match.flexibilityIndex === 0 &&
      (match.kind === 'EXACT_NORMALIZED_NAME' || match.kind === 'EXACT_TOKEN_MULTISET')) ||
    (match.flexibilityIndex === 1 && match.kind === 'PARTIAL_TOKEN_SUBSET')
  );
}
