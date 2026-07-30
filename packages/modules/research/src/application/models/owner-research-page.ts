import type {
  OwnerProfessionalResearch,
  PersistedOwnerResearchRecord,
} from './owner-research-read-model';

export interface PersistedOwnerResearchPage {
  readonly records: readonly PersistedOwnerResearchRecord[];
  readonly nextCursor?: string;
}

export interface OwnerResearchPagePagination {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface OwnerResearchPageLabels {
  readonly access: 'OWNER_ONLY';
  readonly associations: 'UNVERIFIED_CANDIDATES_INCLUDED';
  readonly projection: 'SANITIZED_OWNER_RESEARCH_VIEW';
}

export interface OwnerResearchItemLabels {
  readonly associationReview: 'UNVERIFIED_REVIEW_CANDIDATE';
  readonly originalSourceVerificationRequired: true;
}

export interface OwnerProfessionalResearchListItem extends OwnerProfessionalResearch {
  readonly labels: OwnerResearchItemLabels;
}

export interface OwnerProfessionalResearchPage {
  readonly items: readonly OwnerProfessionalResearchListItem[];
  readonly pagination: OwnerResearchPagePagination;
  readonly labels: OwnerResearchPageLabels;
}
