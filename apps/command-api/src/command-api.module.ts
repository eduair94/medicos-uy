import { validateCommandApiEnvironment } from '@medicos/config';
import { HealthModule } from '@medicos/health';
import { ObservabilityModule } from '@medicos/observability';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateCommandApiEnvironment,
    }),
    ObservabilityModule,
    HealthModule.register(),
  ],
})
export class CommandApiModule {}
