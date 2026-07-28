import { CATALOG_DATABASE, CatalogDatabaseModule, type CatalogDatabase } from '@medicos/database';
import { APPROVED_EVIDENCE_FINDER, type ApprovedEvidenceFinder } from '@medicos/provenance';
import { ProvenanceModule } from '@medicos/provenance/nest';
import { Module } from '@nestjs/common';

import {
  PROFESSIONAL_FINDER,
  PROFESSIONAL_SEARCH,
  type ProfessionalFinder,
  type ProfessionalSearch,
} from '../application/ports/professional-reader.port';
import { GetProfessional } from '../application/queries/get-professional';
import { SearchProfessionals } from '../application/queries/search-professionals';
import { DrizzleProfessionalReader } from '../infrastructure/persistence/drizzle/drizzle-professional-reader';
import { ProfessionalsController } from '../presentation/http/professionals.controller';

const DRIZZLE_PROFESSIONAL_READER = Symbol('DRIZZLE_PROFESSIONAL_READER');

@Module({
  imports: [CatalogDatabaseModule, ProvenanceModule],
  controllers: [ProfessionalsController],
  providers: [
    {
      provide: DRIZZLE_PROFESSIONAL_READER,
      inject: [CATALOG_DATABASE],
      useFactory: (database: CatalogDatabase): DrizzleProfessionalReader =>
        new DrizzleProfessionalReader(database),
    },
    {
      provide: PROFESSIONAL_SEARCH,
      useExisting: DRIZZLE_PROFESSIONAL_READER,
    },
    {
      provide: PROFESSIONAL_FINDER,
      useExisting: DRIZZLE_PROFESSIONAL_READER,
    },
    {
      provide: SearchProfessionals,
      inject: [PROFESSIONAL_SEARCH],
      useFactory: (professionals: ProfessionalSearch): SearchProfessionals =>
        new SearchProfessionals(professionals),
    },
    {
      provide: GetProfessional,
      inject: [PROFESSIONAL_FINDER, APPROVED_EVIDENCE_FINDER],
      useFactory: (
        professionals: ProfessionalFinder,
        evidence: ApprovedEvidenceFinder,
      ): GetProfessional => new GetProfessional(professionals, evidence),
    },
  ],
  exports: [PROFESSIONAL_FINDER, PROFESSIONAL_SEARCH],
})
export class ProfessionalsModule {}
