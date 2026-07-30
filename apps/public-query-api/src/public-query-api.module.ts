import { validatePublicQueryApiEnvironment } from '@medicos/config';
import { CredentialsModule } from '@medicos/credentials/nest';
import { CatalogDatabaseModule, CatalogDatabaseReadinessProbe } from '@medicos/database';
import { HealthModule } from '@medicos/health';
import { ObservabilityModule } from '@medicos/observability';
import { ProfessionalsModule } from '@medicos/professionals/nest';
import {
  OwnerResearchDatabaseModule,
  OwnerResearchDatabaseReadinessProbe,
  OwnerResearchModule,
} from '@medicos/research/nest';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validatePublicQueryApiEnvironment,
    }),
    ObservabilityModule,
    CatalogDatabaseModule,
    HealthModule.register({
      imports: [CatalogDatabaseModule, OwnerResearchDatabaseModule],
      probes: [CatalogDatabaseReadinessProbe, OwnerResearchDatabaseReadinessProbe],
    }),
    ProfessionalsModule,
    CredentialsModule,
    OwnerResearchModule,
  ],
})
export class PublicQueryApiModule {}
