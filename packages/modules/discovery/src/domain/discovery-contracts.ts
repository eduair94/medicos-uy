export type BenignClaimCategory =
  | 'ACADEMIC_MENTION'
  | 'INSTITUTIONAL_DIRECTORY_MENTION'
  | 'OFFICIAL_PUBLICATION_MENTION'
  | 'PROFESSIONAL_DIRECTORY_PROFILE';

export interface ProfessionalSeed {
  readonly opaqueProfessionalId: string;
  readonly displayName: string;
}

export interface SourcePage {
  readonly pageId: string;
  readonly sourceId: string;
  readonly publisher: string;
  readonly category: BenignClaimCategory;
  readonly canonicalUrl: string;
  readonly text: string;
  readonly contentSha256: string;
  readonly retrievedAt: string;
  readonly transport: 'CRAWL4AI' | 'DIRECT_FETCH';
}

export type RestrictedContentReason =
  'ADVERSE_OR_JUDICIAL' | 'MINOR_OR_PRIVATE_HEALTH' | 'AUTOMATION_CHALLENGE';

export interface WebEnrichmentCandidate {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly state: 'NEEDS_HUMAN_REVIEW';
  readonly quarantine: true;
  readonly subject: {
    readonly opaqueProfessionalId: string;
    readonly displayName: string;
  };
  readonly claim: {
    readonly category: BenignClaimCategory;
    readonly sourceId: string;
    readonly publisher: string;
  };
  readonly match: {
    readonly kind: 'EXACT_NORMALIZED_NAME' | 'PARTIAL_TOKEN_SUBSET' | 'INITIALS_TOKEN_SUBSEQUENCE';
    readonly flexibilityIndex: 0 | 1 | 2;
    readonly meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE';
    readonly ambiguity: 'NONE' | 'HOMONYM';
    readonly competingOpaqueProfessionalIds: readonly string[];
    readonly alerts: readonly string[];
  };
  readonly provenance: {
    readonly canonicalUrl: string;
    readonly contentSha256: string;
    readonly retrievedAt: string;
    readonly transport: 'CRAWL4AI' | 'DIRECT_FETCH';
    readonly professionalSnapshotSha256: string;
    readonly sourcePolicySha256: string;
  };
  readonly linkageDecision: {
    readonly decision: 'NOT_LINKED';
    readonly identityConfirmed: false;
  };
  readonly factDecision: {
    readonly factConfirmed: false;
  };
  readonly publicationDecision: {
    readonly decision: 'NOT_PUBLISHED';
    readonly destination: 'INTERNAL_QUARANTINE_ONLY';
    readonly publicExportAllowed: false;
  };
  readonly retention: {
    readonly expiresAt: string;
    readonly disposition: 'DELETE_OR_REVALIDATE';
  };
}

export type DiscoveryCoverageStatus =
  | 'COMPLETE_CONFIGURED_SCOPE'
  | 'NO_CANDIDATE_WITHIN_CONFIGURED_SCOPE'
  | 'PARTIAL_SOURCE_FAILURE'
  | 'BLOCKED_BY_SOURCE_POLICY';

export interface ProfessionalDiscoveryCoverage {
  readonly schemaVersion: 1;
  readonly opaqueProfessionalId: string;
  readonly professionalSnapshotSha256: string;
  readonly sourcePolicySha256: string;
  readonly status: DiscoveryCoverageStatus;
  readonly candidateCount: number;
  readonly plannedSourcePages: number;
  readonly completedSourcePages: number;
  readonly lastAttemptAt: string;
  readonly noFindingsProvesAbsence: false;
  readonly publicExportAllowed: false;
}
