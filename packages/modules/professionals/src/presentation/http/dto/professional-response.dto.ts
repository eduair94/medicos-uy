import { PublicEvidenceReferenceResponseDto } from '@medicos/provenance';
import { ApiProperty } from '@nestjs/swagger';

import type {
  ProfessionalDetail,
  ProfessionalSearchPage,
  ProfessionalSummary,
} from '../../../application/models/professional-read-model';

export class ProfessionalSummaryResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  public readonly id: string;

  @ApiProperty()
  public readonly slug: string;

  @ApiProperty()
  public readonly displayName: string;

  public constructor(model: ProfessionalSummary) {
    this.id = model.id;
    this.slug = model.slug;
    this.displayName = model.displayName;
  }
}

export class ProfessionalDetailResponseDto extends ProfessionalSummaryResponseDto {
  @ApiProperty({
    type: PublicEvidenceReferenceResponseDto,
  })
  public readonly nameEvidence: PublicEvidenceReferenceResponseDto;

  public constructor(model: ProfessionalDetail) {
    super(model);
    this.nameEvidence = new PublicEvidenceReferenceResponseDto(model.nameEvidence);
  }
}

export class ProfessionalSearchResponseDto {
  @ApiProperty({
    type: [ProfessionalSummaryResponseDto],
  })
  public readonly items: readonly ProfessionalSummaryResponseDto[];

  @ApiProperty({
    required: false,
  })
  public readonly nextCursor?: string;

  public constructor(page: ProfessionalSearchPage) {
    this.items = page.items.map((item) => new ProfessionalSummaryResponseDto(item));

    if (page.nextCursor !== undefined) {
      this.nextCursor = page.nextCursor;
    }
  }
}
