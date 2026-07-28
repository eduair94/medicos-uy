import type { PublicEvidenceReference } from '@medicos/provenance';

export interface ProfessionalSummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

export interface ProfessionalLookupRecord extends ProfessionalSummary {
  readonly currentNameEvidenceId: string;
}

export interface ProfessionalDetail extends ProfessionalSummary {
  readonly nameEvidence: PublicEvidenceReference;
}

export interface ProfessionalSearchPage {
  readonly items: readonly ProfessionalSummary[];
  readonly nextCursor?: string;
}
