import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';

export class ProblemDetailsResponseDto {
  @ApiProperty({
    example: 'about:blank',
    format: 'uri-reference',
  })
  public readonly type!: string;

  @ApiProperty({
    example: 'Bad Request',
  })
  public readonly title!: string;

  @ApiProperty({
    example: 400,
    maximum: 599,
    minimum: 400,
  })
  public readonly status!: number;

  @ApiProperty({
    example: 'One or more request fields are invalid.',
  })
  public readonly detail!: string;

  @ApiProperty({
    example: '/v1/professionals?limit=0',
    format: 'uri-reference',
  })
  public readonly instance!: string;

  @ApiProperty({
    example: 'c0a80101-7b7f-4f8c-9c84-38ae19fc5a22',
    format: 'uuid',
  })
  public readonly traceId!: string;

  @ApiProperty({
    example: ['limit must not be less than 1'],
    required: false,
    type: [String],
  })
  public readonly errors?: readonly string[];
}

export function ApiProblemResponse(options: {
  readonly status: number;
  readonly description: string;
}): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsResponseDto),
    ApiResponse({
      status: options.status,
      description: options.description,
      content: {
        'application/problem+json': {
          schema: {
            $ref: getSchemaPath(ProblemDetailsResponseDto),
          },
        },
      },
    }),
  );
}
