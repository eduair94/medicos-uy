import type { PublicEvidenceReference } from '../models/public-evidence-reference';

export interface ApprovedEvidenceFinder {
  findApprovedById(evidenceId: string): Promise<PublicEvidenceReference | undefined>;
}

export const APPROVED_EVIDENCE_FINDER = Symbol('APPROVED_EVIDENCE_FINDER');
