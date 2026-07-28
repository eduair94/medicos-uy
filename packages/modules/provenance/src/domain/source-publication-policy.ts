export const SOURCE_PUBLICATION_STATES = ['PENDING', 'APPROVED', 'REVOKED'] as const;
export type SourcePublicationState = (typeof SOURCE_PUBLICATION_STATES)[number];

export const SOURCE_KINDS = [
  'GOVERNMENT_OPEN_DATA',
  'OFFICIAL_PUBLICATION',
  'PROVIDER_AUTHORIZED_FEED',
  'ACADEMIC_METADATA',
  'DATA_SUBJECT_CLAIM',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_PURPOSE_COMPATIBILITY_STATES = [
  'PENDING',
  'COMPATIBLE',
  'INCOMPATIBLE',
] as const;
export type SourcePurposeCompatibility = (typeof SOURCE_PURPOSE_COMPATIBILITY_STATES)[number];

export const SOURCE_REUSE_BASES = [
  'PENDING',
  'OPEN_DATA_LICENSE',
  'WRITTEN_AUTHORIZATION',
  'OFFICIAL_PUBLICATION_REVIEW',
  'DATA_SUBJECT_CONSENT',
] as const;
export type SourceReuseBasis = (typeof SOURCE_REUSE_BASES)[number];

export const EVIDENCE_CONFIDENCE_LEVELS = [
  'CANDIDATE',
  'DETERMINISTIC',
  'HUMAN_VERIFIED',
  'DATA_SUBJECT_CLAIMED',
] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCE_LEVELS)[number];

export const EVIDENCE_PUBLICATION_STATES = ['PENDING', 'APPROVED', 'REVOKED'] as const;
export type EvidencePublicationState = (typeof EVIDENCE_PUBLICATION_STATES)[number];

export const EVIDENCE_CLAIM_KINDS = ['PROFESSIONAL_NAME', 'REGISTERED_TITLE'] as const;
export type EvidenceClaimKind = (typeof EVIDENCE_CLAIM_KINDS)[number];

export const SOURCE_PUBLICATION_BLOCK_REASONS = [
  'SOURCE_NOT_APPROVED',
  'SOURCE_APPROVAL_EXPIRY_MISSING',
  'SOURCE_APPROVAL_EXPIRED',
  'PURPOSE_NOT_COMPATIBLE',
  'REUSE_NOT_APPROVED',
  'EVIDENCE_NOT_APPROVED',
  'CONFIDENCE_NOT_PUBLISHABLE',
  'EVIDENCE_EXPIRED',
] as const;
export type SourcePublicationBlockReason = (typeof SOURCE_PUBLICATION_BLOCK_REASONS)[number];

export interface SourceEvidencePublicationAssessment {
  readonly sourcePublicationState: SourcePublicationState;
  readonly purposeCompatibility: SourcePurposeCompatibility;
  readonly reuseBasis: SourceReuseBasis;
  readonly evidencePublicationState: EvidencePublicationState;
  readonly confidence: EvidenceConfidence;
  readonly sourceValidUntil?: Date;
  readonly validUntil?: Date;
}

export interface SourceEvidencePublicationDecision {
  readonly allowed: boolean;
  readonly reasons: readonly SourcePublicationBlockReason[];
}

export function assessSourceEvidenceForPublication(
  assessment: SourceEvidencePublicationAssessment,
  now: Date = new Date(),
): SourceEvidencePublicationDecision {
  const reasons: SourcePublicationBlockReason[] = [];

  if (assessment.sourcePublicationState !== 'APPROVED') {
    reasons.push('SOURCE_NOT_APPROVED');
  }

  if (
    assessment.sourcePublicationState === 'APPROVED' &&
    assessment.sourceValidUntil === undefined
  ) {
    reasons.push('SOURCE_APPROVAL_EXPIRY_MISSING');
  } else if (
    assessment.sourceValidUntil !== undefined &&
    assessment.sourceValidUntil.getTime() <= now.getTime()
  ) {
    reasons.push('SOURCE_APPROVAL_EXPIRED');
  }

  if (assessment.purposeCompatibility !== 'COMPATIBLE') {
    reasons.push('PURPOSE_NOT_COMPATIBLE');
  }

  if (assessment.reuseBasis === 'PENDING') {
    reasons.push('REUSE_NOT_APPROVED');
  }

  if (assessment.evidencePublicationState !== 'APPROVED') {
    reasons.push('EVIDENCE_NOT_APPROVED');
  }

  if (assessment.confidence === 'CANDIDATE') {
    reasons.push('CONFIDENCE_NOT_PUBLISHABLE');
  }

  if (assessment.validUntil !== undefined && assessment.validUntil.getTime() <= now.getTime()) {
    reasons.push('EVIDENCE_EXPIRED');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
