import { ApiProblemResponse } from '@medicos/http';
import { BadRequestException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import {
  InvalidOwnerResearchQueryError,
  OwnerResearchNotFoundError,
} from '../../application/errors/owner-research.error';
import { GetOwnerProfessionalResearch } from '../../application/queries/get-owner-professional-research';

import { OwnerProfessionalResearchResponseDto } from './dto/owner-research-response.dto';

function mapOwnerResearchError(error: unknown): never {
  if (error instanceof OwnerResearchNotFoundError) {
    throw new NotFoundException({
      message: error.message,
    });
  }

  if (error instanceof InvalidOwnerResearchQueryError) {
    throw new BadRequestException({
      message: error.message,
    });
  }

  throw error;
}

@ApiTags('owner research')
@Controller({
  path: 'professionals/:idOrSlug/research',
  version: '1',
})
export class OwnerResearchController {
  public constructor(private readonly getOwnerProfessionalResearch: GetOwnerProfessionalResearch) {}

  @Get()
  @ApiOperation({
    description:
      'Devuelve el dossier privado más reciente sin convertir coincidencias nominales en hechos. Conserva método e índice de flexibilidad, decisiones de identidad/hecho, alertas, fuentes y fechas; omite IDs HMAC, rutas de archivos y hashes internos.',
    operationId: 'getOwnerProfessionalResearch',
    summary: 'Get the latest owner-only research dossier for one professional',
  })
  @ApiParam({
    description: 'UUID público o slug actual/histórico del profesional.',
    name: 'idOrSlug',
  })
  @ApiOkResponse({
    description:
      'Registro oficial del MSP y candidatos institucionales, horarios observados, referencias web y cobertura del análisis.',
    type: OwnerProfessionalResearchResponseDto,
  })
  @ApiProblemResponse({
    status: 400,
    description: 'El identificador no es válido.',
  })
  @ApiProblemResponse({
    status: 404,
    description: 'No existe un dossier privado vigente para el profesional.',
  })
  @ApiProblemResponse({
    status: 429,
    description: 'Se superó el límite de solicitudes.',
  })
  @ApiProblemResponse({
    status: 500,
    description: 'Error interno o dossier persistido incompatible, sin detalles sensibles.',
  })
  public async getByIdOrSlug(
    @Param('idOrSlug') idOrSlug: string,
  ): Promise<OwnerProfessionalResearchResponseDto> {
    try {
      const research = await this.getOwnerProfessionalResearch.execute(idOrSlug);
      return new OwnerProfessionalResearchResponseDto(research);
    } catch (error) {
      return mapOwnerResearchError(error);
    }
  }
}
