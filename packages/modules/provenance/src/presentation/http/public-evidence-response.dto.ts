import { ApiProperty } from '@nestjs/swagger';

import type {
  PublicEvidenceReference,
  PublicEvidenceSource,
} from '../../application/models/public-evidence-reference';

export class PublicEvidenceSourceResponseDto {
  @ApiProperty({
    enum: [
      'GOVERNMENT_OPEN_DATA',
      'OFFICIAL_PUBLICATION',
      'PROVIDER_AUTHORIZED_FEED',
      'ACADEMIC_METADATA',
      'DATA_SUBJECT_CLAIM',
    ],
  })
  public readonly kind:
    | 'GOVERNMENT_OPEN_DATA'
    | 'OFFICIAL_PUBLICATION'
    | 'PROVIDER_AUTHORIZED_FEED'
    | 'ACADEMIC_METADATA'
    | 'DATA_SUBJECT_CLAIM';

  @ApiProperty()
  public readonly name: string;

  @ApiProperty({
    format: 'uri',
  })
  public readonly canonicalUrl: string;

  @ApiProperty({
    format: 'uri',
    required: false,
  })
  public readonly licenseUrl?: string;

  @ApiProperty({
    enum: [
      'OPEN_DATA_LICENSE',
      'WRITTEN_AUTHORIZATION',
      'OFFICIAL_PUBLICATION_REVIEW',
      'DATA_SUBJECT_CONSENT',
    ],
  })
  public readonly reuseBasis:
    | 'OPEN_DATA_LICENSE'
    | 'WRITTEN_AUTHORIZATION'
    | 'OFFICIAL_PUBLICATION_REVIEW'
    | 'DATA_SUBJECT_CONSENT';

  @ApiProperty()
  public readonly policyId: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly validUntil: string;

  public constructor(source: PublicEvidenceSource) {
    this.kind = source.kind;
    this.name = source.name;
    this.canonicalUrl = source.canonicalUrl;
    this.reuseBasis = source.reuseBasis;
    this.policyId = source.policyId;
    this.validUntil = source.validUntil;

    if (source.licenseUrl !== undefined) {
      this.licenseUrl = source.licenseUrl;
    }
  }
}

export class PublicEvidenceReferenceResponseDto {
  @ApiProperty({
    enum: ['DETERMINISTIC', 'HUMAN_VERIFIED', 'DATA_SUBJECT_CLAIMED'],
  })
  public readonly confidence: 'DETERMINISTIC' | 'HUMAN_VERIFIED' | 'DATA_SUBJECT_CLAIMED';

  @ApiProperty({
    type: PublicEvidenceSourceResponseDto,
  })
  public readonly source: PublicEvidenceSourceResponseDto;

  @ApiProperty({
    format: 'uri',
  })
  public readonly canonicalUrl: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly observedAt: string;

  @ApiProperty({
    format: 'date',
  })
  public readonly sourceCutoffDate: string;

  @ApiProperty({
    format: 'date-time',
    required: false,
  })
  public readonly validUntil?: string;

  @ApiProperty()
  public readonly attribution: string;

  public constructor(evidence: PublicEvidenceReference) {
    this.confidence = evidence.confidence;
    this.source = new PublicEvidenceSourceResponseDto(evidence.source);
    this.canonicalUrl = evidence.canonicalUrl;
    this.observedAt = evidence.observedAt;
    this.sourceCutoffDate = evidence.sourceCutoffDate;
    this.attribution = evidence.attribution;

    if (evidence.validUntil !== undefined) {
      this.validUntil = evidence.validUntil;
    }
  }
}
