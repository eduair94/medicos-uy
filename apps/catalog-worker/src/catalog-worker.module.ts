import { validateCatalogWorkerEnvironment } from '@medicos/config';
import { ObservabilityModule } from '@medicos/observability';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateCatalogWorkerEnvironment,
    }),
    ObservabilityModule,
  ],
})
export class CatalogWorkerModule {}
