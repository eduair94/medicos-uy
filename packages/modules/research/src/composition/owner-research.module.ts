import { Module } from '@nestjs/common';

import {
  OWNER_RESEARCH_READER,
  type OwnerResearchReader,
} from '../application/ports/owner-research-reader.port';
import { GetOwnerProfessionalResearch } from '../application/queries/get-owner-professional-research';
import {
  OWNER_RESEARCH_DATABASE_POOL,
  OwnerResearchDatabaseModule,
} from '../infrastructure/persistence/postgres/owner-research-database.module';
import { PostgresOwnerResearchReader } from '../infrastructure/persistence/postgres/postgres-owner-research-reader';
import { OwnerResearchController } from '../presentation/http/owner-research.controller';

import type { Pool } from 'pg';

@Module({
  imports: [OwnerResearchDatabaseModule],
  controllers: [OwnerResearchController],
  providers: [
    {
      provide: OWNER_RESEARCH_READER,
      inject: [OWNER_RESEARCH_DATABASE_POOL],
      useFactory: (pool: Pool): PostgresOwnerResearchReader =>
        new PostgresOwnerResearchReader(pool),
    },
    {
      provide: GetOwnerProfessionalResearch,
      inject: [OWNER_RESEARCH_READER],
      useFactory: (research: OwnerResearchReader): GetOwnerProfessionalResearch =>
        new GetOwnerProfessionalResearch(research),
    },
  ],
  exports: [OWNER_RESEARCH_READER],
})
export class OwnerResearchModule {}
