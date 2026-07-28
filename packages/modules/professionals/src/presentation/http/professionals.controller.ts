import { ApiProblemResponse } from '@medicos/http';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import {
  InvalidProfessionalCursorError,
  InvalidProfessionalQueryError,
  ProfessionalNotFoundError,
} from '../../application/errors/professional-query.error';
import { GetProfessional } from '../../application/queries/get-professional';
import { SearchProfessionals } from '../../application/queries/search-professionals';

import {
  ProfessionalDetailResponseDto,
  ProfessionalSearchResponseDto,
} from './dto/professional-response.dto';
import { SearchProfessionalsQueryDto } from './dto/search-professionals-query.dto';

function mapProfessionalError(error: unknown): never {
  if (error instanceof ProfessionalNotFoundError) {
    throw new NotFoundException({
      message: error.message,
    });
  }

  if (
    error instanceof InvalidProfessionalQueryError ||
    error instanceof InvalidProfessionalCursorError
  ) {
    throw new BadRequestException({
      message: error.message,
    });
  }

  throw error;
}

@ApiTags('professionals')
@Controller({
  path: 'professionals',
  version: '1',
})
export class ProfessionalsController {
  public constructor(
    private readonly searchProfessionals: SearchProfessionals,
    private readonly getProfessional: GetProfessional,
  ) {}

  @Get()
  @ApiOperation({
    description:
      'Devuelve únicamente perfiles aprobados para publicación. La búsqueda no confirma identidad y el cliente debe revisar la evidencia del detalle.',
    operationId: 'searchProfessionals',
    summary: 'Search the public professional directory',
  })
  @ApiOkResponse({
    description: 'Página de perfiles públicos.',
    type: ProfessionalSearchResponseDto,
  })
  @ApiProblemResponse({
    status: 400,
    description: 'Los parámetros de búsqueda no son válidos.',
  })
  @ApiProblemResponse({
    status: 429,
    description: 'Se superó el límite de solicitudes.',
  })
  @ApiProblemResponse({
    status: 500,
    description: 'Error interno sin detalles sensibles.',
  })
  public async search(
    @Query() query: SearchProfessionalsQueryDto,
  ): Promise<ProfessionalSearchResponseDto> {
    try {
      const page = await this.searchProfessionals.execute({
        limit: query.limit,
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });

      return new ProfessionalSearchResponseDto(page);
    } catch (error) {
      return mapProfessionalError(error);
    }
  }

  @Get(':idOrSlug')
  @ApiOperation({
    description:
      'Acepta el UUID público o un slug actual/histórico. La respuesta incluye evidencia de procedencia aprobada.',
    operationId: 'getProfessional',
    summary: 'Get one public professional by UUID or current/historical slug',
  })
  @ApiParam({
    description: 'UUID público o slug del profesional.',
    name: 'idOrSlug',
  })
  @ApiOkResponse({
    description: 'Perfil público con evidencia del nombre.',
    type: ProfessionalDetailResponseDto,
  })
  @ApiProblemResponse({
    status: 400,
    description: 'El identificador no es válido.',
  })
  @ApiProblemResponse({
    status: 404,
    description: 'No existe un perfil publicable para el identificador.',
  })
  @ApiProblemResponse({
    status: 429,
    description: 'Se superó el límite de solicitudes.',
  })
  @ApiProblemResponse({
    status: 500,
    description: 'Error interno sin detalles sensibles.',
  })
  public async getByIdOrSlug(
    @Param('idOrSlug') idOrSlug: string,
  ): Promise<ProfessionalDetailResponseDto> {
    try {
      const professional = await this.getProfessional.execute(idOrSlug);
      return new ProfessionalDetailResponseDto(professional);
    } catch (error) {
      return mapProfessionalError(error);
    }
  }
}
