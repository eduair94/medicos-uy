import { ApiProperty } from '@nestjs/swagger';

import { OwnerProfessionalResearchResponseDto } from './owner-research-response.dto';

import type {
  OwnerProfessionalResearchListItem,
  OwnerProfessionalResearchPage,
  OwnerResearchItemLabels,
  OwnerResearchPageLabels,
  OwnerResearchPagePagination,
} from '../../../application/models/owner-research-page';

class OwnerResearchItemLabelsResponseDto {
  @ApiProperty({
    description:
      'Label conservador para cualquier asociación del dossier que no tenga confirmación humana explícita.',
    enum: ['UNVERIFIED_REVIEW_CANDIDATE'],
    example: 'UNVERIFIED_REVIEW_CANDIDATE',
  })
  public readonly associationReview: OwnerResearchItemLabels['associationReview'];

  @ApiProperty({
    enum: [true],
  })
  public readonly originalSourceVerificationRequired: true;

  public constructor(labels: OwnerResearchItemLabels) {
    this.associationReview = labels.associationReview;
    this.originalSourceVerificationRequired = labels.originalSourceVerificationRequired;
  }
}

class OwnerProfessionalResearchListItemResponseDto extends OwnerProfessionalResearchResponseDto {
  @ApiProperty({
    type: OwnerResearchItemLabelsResponseDto,
  })
  public readonly labels: OwnerResearchItemLabelsResponseDto;

  public constructor(item: OwnerProfessionalResearchListItem) {
    super(item);
    this.labels = new OwnerResearchItemLabelsResponseDto(item.labels);
  }
}

class OwnerResearchPagePaginationResponseDto {
  @ApiProperty({
    maximum: 50,
    minimum: 1,
    type: 'integer',
  })
  public readonly limit: number;

  @ApiProperty({
    minimum: 0,
    type: 'integer',
  })
  public readonly returned: number;

  @ApiProperty()
  public readonly hasMore: boolean;

  @ApiProperty({
    description: 'Cursor opaco para solicitar la página siguiente.',
    required: false,
  })
  public readonly nextCursor?: string;

  public constructor(pagination: OwnerResearchPagePagination) {
    this.limit = pagination.limit;
    this.returned = pagination.returned;
    this.hasMore = pagination.hasMore;

    if (pagination.nextCursor !== undefined) {
      this.nextCursor = pagination.nextCursor;
    }
  }
}

class OwnerResearchPageLabelsResponseDto {
  @ApiProperty({
    enum: ['OWNER_ONLY'],
    example: 'OWNER_ONLY',
  })
  public readonly access: OwnerResearchPageLabels['access'];

  @ApiProperty({
    description:
      'Las asociaciones se incluyen como candidatos no verificados; deben leerse junto con las decisiones y alertas de cada candidato.',
    enum: ['UNVERIFIED_CANDIDATES_INCLUDED'],
    example: 'UNVERIFIED_CANDIDATES_INCLUDED',
  })
  public readonly associations: OwnerResearchPageLabels['associations'];

  @ApiProperty({
    description:
      'Proyección completa del dossier sanitizado: omite HMAC, hashes, metadata interna, secretos y contenido documental.',
    enum: ['SANITIZED_OWNER_RESEARCH_VIEW'],
    example: 'SANITIZED_OWNER_RESEARCH_VIEW',
  })
  public readonly projection: OwnerResearchPageLabels['projection'];

  public constructor(labels: OwnerResearchPageLabels) {
    this.access = labels.access;
    this.associations = labels.associations;
    this.projection = labels.projection;
  }
}

export class OwnerProfessionalResearchPageResponseDto {
  @ApiProperty({
    description:
      'Dossiers completos sanitizados. Cada asociación conserva su estado, decisión, alertas y fuente.',
    type: [OwnerProfessionalResearchListItemResponseDto],
  })
  public readonly items: readonly OwnerProfessionalResearchListItemResponseDto[];

  @ApiProperty({
    type: OwnerResearchPagePaginationResponseDto,
  })
  public readonly pagination: OwnerResearchPagePaginationResponseDto;

  @ApiProperty({
    type: OwnerResearchPageLabelsResponseDto,
  })
  public readonly labels: OwnerResearchPageLabelsResponseDto;

  public constructor(page: OwnerProfessionalResearchPage) {
    this.items = page.items.map((item) => new OwnerProfessionalResearchListItemResponseDto(item));
    this.pagination = new OwnerResearchPagePaginationResponseDto(page.pagination);
    this.labels = new OwnerResearchPageLabelsResponseDto(page.labels);
  }
}
