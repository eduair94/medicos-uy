import { ApiProblemResponse } from '@medicos/http';
import { BadRequestException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import {
  InvalidProfessionalCredentialsQueryError,
  ProfessionalCredentialsNotFoundError,
} from '../../application/errors/professional-credentials.error';
import { GetProfessionalCredentials } from '../../application/queries/get-professional-credentials';

import { ProfessionalCredentialsResponseDto } from './dto/professional-credentials-response.dto';

function mapCredentialsError(error: unknown): never {
  if (error instanceof ProfessionalCredentialsNotFoundError) {
    throw new NotFoundException({
      message: error.message,
    });
  }

  if (error instanceof InvalidProfessionalCredentialsQueryError) {
    throw new BadRequestException({
      message: error.message,
    });
  }

  throw error;
}

@ApiTags('credentials')
@Controller({
  path: 'professionals/:professionalId/credentials',
  version: '1',
})
export class ProfessionalCredentialsController {
  public constructor(private readonly getProfessionalCredentials: GetProfessionalCredentials) {}

  @Get()
  @ApiOperation({
    description:
      'Solo incluye títulos habilitantes vigentes que superaron el gate de publicación y conservan evidencia pública aprobada.',
    operationId: 'getProfessionalCredentials',
    summary: 'Get registered titles for one public professional',
  })
  @ApiParam({
    description: 'UUID público del profesional.',
    name: 'professionalId',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Títulos habilitantes publicables con su evidencia.',
    type: ProfessionalCredentialsResponseDto,
  })
  @ApiProblemResponse({
    status: 400,
    description: 'El UUID no es válido.',
  })
  @ApiProblemResponse({
    status: 404,
    description: 'No hay títulos publicables para el profesional.',
  })
  @ApiProblemResponse({
    status: 429,
    description: 'Se superó el límite de solicitudes.',
  })
  @ApiProblemResponse({
    status: 500,
    description: 'Error interno sin detalles sensibles.',
  })
  public async getByProfessionalId(
    @Param('professionalId') professionalId: string,
  ): Promise<ProfessionalCredentialsResponseDto> {
    try {
      const credentials = await this.getProfessionalCredentials.execute(professionalId);
      return new ProfessionalCredentialsResponseDto(credentials);
    } catch (error) {
      return mapCredentialsError(error);
    }
  }
}
