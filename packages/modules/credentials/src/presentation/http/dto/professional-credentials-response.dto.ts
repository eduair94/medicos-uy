import { PublicEvidenceReferenceResponseDto } from '@medicos/provenance';
import { ApiProperty } from '@nestjs/swagger';

import type {
  ProfessionalCredentialsDetail,
  RegisteredTitleDetail,
} from '../../../application/models/professional-credentials-read-model';

class RegisteredTitleResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  public readonly id: string;

  @ApiProperty()
  public readonly title: string;

  @ApiProperty({
    enum: ['ENABLED'],
  })
  public readonly registrationState: 'ENABLED';

  @ApiProperty({
    enum: ['NONE', 'WITH_CONTRACT', 'WITHOUT_CONTRACT'],
  })
  public readonly temporaryRegistration: 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT';

  @ApiProperty({
    type: PublicEvidenceReferenceResponseDto,
  })
  public readonly evidence: PublicEvidenceReferenceResponseDto;

  public constructor(title: RegisteredTitleDetail) {
    this.id = title.id;
    this.title = title.title;
    this.registrationState = title.registrationState;
    this.temporaryRegistration = title.temporaryRegistration;
    this.evidence = new PublicEvidenceReferenceResponseDto(title.evidence);
  }
}

export class ProfessionalCredentialsResponseDto {
  @ApiProperty({
    format: 'uuid',
  })
  public readonly professionalId: string;

  @ApiProperty({
    type: [RegisteredTitleResponseDto],
  })
  public readonly registeredTitles: readonly RegisteredTitleResponseDto[];

  public constructor(credentials: ProfessionalCredentialsDetail) {
    this.professionalId = credentials.professionalId;
    this.registeredTitles = credentials.registeredTitles.map(
      (title) => new RegisteredTitleResponseDto(title),
    );
  }
}
