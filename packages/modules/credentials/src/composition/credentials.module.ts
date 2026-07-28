import { CATALOG_DATABASE, CatalogDatabaseModule, type CatalogDatabase } from '@medicos/database';
import { APPROVED_EVIDENCE_FINDER, type ApprovedEvidenceFinder } from '@medicos/provenance';
import { ProvenanceModule } from '@medicos/provenance/nest';
import { Module } from '@nestjs/common';

import {
  PROFESSIONAL_CREDENTIALS_READER,
  type ProfessionalCredentialsReader,
} from '../application/ports/professional-credentials-reader.port';
import { GetProfessionalCredentials } from '../application/queries/get-professional-credentials';
import { DrizzleProfessionalCredentialsReader } from '../infrastructure/persistence/drizzle/drizzle-professional-credentials-reader';
import { ProfessionalCredentialsController } from '../presentation/http/professional-credentials.controller';

@Module({
  imports: [CatalogDatabaseModule, ProvenanceModule],
  controllers: [ProfessionalCredentialsController],
  providers: [
    {
      provide: PROFESSIONAL_CREDENTIALS_READER,
      inject: [CATALOG_DATABASE],
      useFactory: (database: CatalogDatabase): DrizzleProfessionalCredentialsReader =>
        new DrizzleProfessionalCredentialsReader(database),
    },
    {
      provide: GetProfessionalCredentials,
      inject: [PROFESSIONAL_CREDENTIALS_READER, APPROVED_EVIDENCE_FINDER],
      useFactory: (
        credentials: ProfessionalCredentialsReader,
        evidence: ApprovedEvidenceFinder,
      ): GetProfessionalCredentials => new GetProfessionalCredentials(credentials, evidence),
    },
  ],
  exports: [PROFESSIONAL_CREDENTIALS_READER],
})
export class CredentialsModule {}
