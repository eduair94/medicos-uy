import { ApiProblemResponse } from '@medicos/http';
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import {
  InvalidOwnerResearchCursorError,
  InvalidOwnerResearchListQueryError,
} from '../../application/errors/owner-research.error';
import { ListOwnerProfessionalResearch } from '../../application/queries/list-owner-professional-research';

import { OwnerProfessionalResearchPageResponseDto } from './dto/owner-research-page-response.dto';

interface ParsedOwnerResearchListQuery {
  readonly cursor?: string;
  readonly limit: number;
}

function parseOwnerResearchListQuery(
  query: Readonly<Record<string, unknown>>,
): ParsedOwnerResearchListQuery {
  const hasUnknownParameter = Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit');

  if (hasUnknownParameter) {
    throw new InvalidOwnerResearchListQueryError('Unknown query parameters are not allowed.');
  }

  const rawLimit = query['limit'];
  let limit = 20;

  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(rawLimit)) {
      throw new InvalidOwnerResearchListQueryError('limit must be an integer between 1 and 50.');
    }

    limit = Number(rawLimit);
  }

  const rawCursor = query['cursor'];

  if (
    rawCursor !== undefined &&
    (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 1_000)
  ) {
    throw new InvalidOwnerResearchListQueryError(
      'cursor must be a non-empty opaque value of at most 1000 characters.',
    );
  }

  return {
    limit,
    ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
  };
}

function mapOwnerResearchListError(error: unknown): never {
  if (
    error instanceof InvalidOwnerResearchListQueryError ||
    error instanceof InvalidOwnerResearchCursorError
  ) {
    throw new BadRequestException({
      message: error.message,
    });
  }

  throw error;
}

@ApiTags('owner research')
@Controller({
  path: 'owner/research/professionals',
  version: '1',
})
export class OwnerResearchListController {
  public constructor(
    private readonly listOwnerProfessionalResearch: ListOwnerProfessionalResearch,
  ) {}

  @Get()
  @ApiOperation({
    description:
      'Lista todos los dossiers de investigación disponibles mediante paginación por cursor. Incluye candidatos no verificados, hechos oficiales, horarios publicados, referencias web y cruces éticos conservando labels, decisiones, alertas y URLs canónicas. La proyección omite secretos, HMAC, hashes, metadata interna, contenido documental y URLs de descarga de archivos.',
    operationId: 'listOwnerProfessionalResearch',
    summary: 'List every sanitized owner research dossier',
  })
  @ApiOkResponse({
    description:
      'Página owner-only con dossiers completos sanitizados y candidatos explícitamente etiquetados como no verificados.',
    type: OwnerProfessionalResearchPageResponseDto,
  })
  @ApiQuery({
    description: 'Cursor opaco recibido en la página anterior; no debe interpretarse.',
    maxLength: 1_000,
    name: 'cursor',
    required: false,
    type: String,
  })
  @ApiQuery({
    description: 'Cantidad máxima de dossiers completos por página.',
    name: 'limit',
    required: false,
    type: Number,
    example: 20,
  })
  @ApiProblemResponse({
    status: 400,
    description: 'El límite o el cursor opaco no es válido.',
  })
  @ApiProblemResponse({
    status: 429,
    description: 'Se superó el límite de solicitudes.',
  })
  @ApiProblemResponse({
    status: 500,
    description: 'Error interno o dossier persistido incompatible, sin detalles sensibles.',
  })
  public async list(
    @Query() query: Readonly<Record<string, unknown>>,
  ): Promise<OwnerProfessionalResearchPageResponseDto> {
    try {
      const page = await this.listOwnerProfessionalResearch.execute(
        parseOwnerResearchListQuery(query),
      );

      return new OwnerProfessionalResearchPageResponseDto(page);
    } catch (error) {
      return mapOwnerResearchListError(error);
    }
  }
}
