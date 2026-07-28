import type {
  EvidenceConfidence,
  SourceKind,
  SourceReuseBasis,
} from '../../domain/source-publication-policy';

export interface PublicEvidenceSource {
  readonly kind: SourceKind;
  readonly name: string;
  readonly canonicalUrl: string;
  readonly licenseUrl?: string;
  readonly reuseBasis: Exclude<SourceReuseBasis, 'PENDING'>;
  readonly policyId: string;
  readonly validUntil: string;
}

export interface PublicEvidenceReference {
  readonly confidence: Exclude<EvidenceConfidence, 'CANDIDATE'>;
  readonly source: PublicEvidenceSource;
  readonly canonicalUrl: string;
  readonly observedAt: string;
  readonly sourceCutoffDate: string;
  readonly validUntil?: string;
  readonly attribution: string;
}
