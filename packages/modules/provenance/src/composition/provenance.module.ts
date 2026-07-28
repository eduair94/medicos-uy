import { CATALOG_DATABASE, CatalogDatabaseModule, type CatalogDatabase } from '@medicos/database';
import { Module } from '@nestjs/common';

import { APPROVED_EVIDENCE_FINDER } from '../application/ports/approved-evidence-finder.port';
import { DrizzleApprovedEvidenceReader } from '../infrastructure/persistence/drizzle/drizzle-approved-evidence-reader';

@Module({
  imports: [CatalogDatabaseModule],
  providers: [
    {
      provide: APPROVED_EVIDENCE_FINDER,
      inject: [CATALOG_DATABASE],
      useFactory: (database: CatalogDatabase): DrizzleApprovedEvidenceReader =>
        new DrizzleApprovedEvidenceReader(database),
    },
  ],
  exports: [APPROVED_EVIDENCE_FINDER],
})
export class ProvenanceModule {}
