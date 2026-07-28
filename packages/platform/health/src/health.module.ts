import { ApiProblemResponse } from '@medicos/http';
import {
  Controller,
  DynamicModule,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export const READINESS_PROBES = Symbol('READINESS_PROBES');

export interface HealthModuleOptions {
  readonly imports?: DynamicModule['imports'];
  readonly probes?: readonly (string | symbol | Type<ReadinessProbe>)[];
}

class HealthCheck {
  @ApiProperty({
    example: 'catalog-database',
  })
  public readonly name!: string;

  @ApiProperty({
    enum: ['up', 'down'],
  })
  public readonly status!: 'up' | 'down';
}

class HealthResponse {
  @ApiProperty({
    enum: ['ok', 'error'],
  })
  public readonly status!: 'ok' | 'error';

  @ApiProperty({
    example: 'public-query-api',
  })
  public readonly service!: string;

  @ApiProperty({
    format: 'date-time',
  })
  public readonly timestamp!: string;

  @ApiPropertyOptional({
    type: [HealthCheck],
  })
  public readonly checks?: readonly HealthCheck[];
}

@ApiTags('health')
@Controller({
  path: 'health',
  version: VERSION_NEUTRAL,
})
class HealthController {
  public constructor(
    private readonly config: ConfigService,
    @Inject(READINESS_PROBES) private readonly readinessProbes: readonly ReadinessProbe[],
  ) {}

  @Get('live')
  @ApiOperation({
    operationId: 'getLiveness',
    summary: 'Check whether the process is alive',
  })
  @ApiOkResponse({
    description: 'The process is accepting HTTP requests.',
    type: HealthResponse,
  })
  public live(): HealthResponse {
    return {
      status: 'ok',
      service: this.config.get<string>('SERVICE_NAME', 'unknown-service'),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({
    operationId: 'getReadiness',
    summary: 'Check whether required dependencies are ready',
  })
  @ApiOkResponse({
    description: 'All required dependencies are available.',
    type: HealthResponse,
  })
  @ApiProblemResponse({
    status: 503,
    description: 'At least one required dependency is unavailable.',
  })
  public async ready(): Promise<HealthResponse> {
    const checkResults = await Promise.allSettled(
      this.readinessProbes.map(async (probe) => {
        await probe.check();
        return probe.name;
      }),
    );

    const checks: HealthCheck[] = checkResults.map((result, index) => ({
      name: this.readinessProbes[index]?.name ?? 'unknown',
      status: result.status === 'fulfilled' ? 'up' : 'down',
    }));
    const isReady = checks.every((check) => check.status === 'up');
    const response: HealthResponse = {
      status: isReady ? 'ok' : 'error',
      service: this.config.get<string>('SERVICE_NAME', 'unknown-service'),
      timestamp: new Date().toISOString(),
      checks,
    };

    if (!isReady) {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}

@Module({})
export class HealthModule {
  public static register(options: HealthModuleOptions = {}): DynamicModule {
    const probeTokens = options.probes ?? [];

    return {
      module: HealthModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers: [
        {
          provide: READINESS_PROBES,
          inject: [...probeTokens],
          useFactory: (...probes: ReadinessProbe[]): readonly ReadinessProbe[] => probes,
        },
      ],
      exports: [READINESS_PROBES],
    };
  }
}
