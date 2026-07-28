import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SearchProfessionalsQueryDto {
  @ApiPropertyOptional({
    description: 'Coincidencia textual sobre el nombre público del profesional.',
    example: 'Ana Pérez',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public q?: string;

  @ApiPropertyOptional({
    description: 'Cursor opaco recibido en la página anterior; no debe interpretarse.',
    maxLength: 1_000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  public cursor?: string;

  @ApiPropertyOptional({
    default: 20,
    maximum: 50,
    minimum: 1,
    type: 'integer',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public limit = 20;
}
