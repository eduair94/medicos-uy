import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

export const OWNER_RESEARCH_DATABASE_POOL = Symbol('OWNER_RESEARCH_DATABASE_POOL');

interface OwnerResearchIsolationRow extends QueryResultRow {
  readonly isolation_ok: boolean;
}

const VERIFY_OWNER_RESEARCH_DATABASE_ISOLATION = `
  SELECT
    current_user = 'medicos_owner_research_query'
    AND current_setting('transaction_read_only') = 'on'
    AND role.rolcanlogin
    AND NOT role.rolsuper
    AND NOT role.rolcreatedb
    AND NOT role.rolcreaterole
    AND NOT role.rolreplication
    AND NOT role.rolbypassrls
    AND pg_has_role(current_user, 'medicos_owner_research_reader', 'MEMBER')
    AND has_schema_privilege(current_user, 'research_private', 'USAGE')
    AND has_table_privilege(
      current_user,
      'research_private.owner_professional_dossier',
      'SELECT'
    )
    AND has_function_privilege(
      current_user,
      'research_private.list_owner_professional_dossiers_page(text,uuid,integer)',
      'EXECUTE'
    )
    AND NOT has_table_privilege(
      current_user,
      'research_private.professional_dossier',
      'SELECT'
    )
    AND NOT has_table_privilege(
      current_user,
      'research_private.candidate',
      'SELECT'
    )
    AND NOT has_schema_privilege(current_user, 'ingestion_private', 'USAGE')
    AS isolation_ok
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = current_user
`;

@Injectable()
export class OwnerResearchDatabaseReadinessProbe {
  public readonly name = 'owner-research-database';

  public constructor(
    @Inject(OWNER_RESEARCH_DATABASE_POOL)
    private readonly pool: Pool,
  ) {}

  public async check(): Promise<void> {
    const result = await this.pool.query<OwnerResearchIsolationRow>(
      VERIFY_OWNER_RESEARCH_DATABASE_ISOLATION,
    );

    if (result.rows[0]?.isolation_ok !== true) {
      throw new Error('Owner research database isolation check failed.');
    }
  }
}

@Injectable()
class OwnerResearchDatabaseLifecycle implements OnApplicationShutdown {
  public constructor(
    @Inject(OWNER_RESEARCH_DATABASE_POOL)
    private readonly pool: Pool,
  ) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: OWNER_RESEARCH_DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool => {
        const poolConfig: PoolConfig = {
          connectionString: config.getOrThrow<string>('OWNER_RESEARCH_DATABASE_URL'),
          application_name: `${config.get<string>('SERVICE_NAME', 'unknown-service')}-owner-research`,
          max: config.get<number>('OWNER_RESEARCH_DATABASE_POOL_MAX', 4),
          connectionTimeoutMillis: 3_000,
          idleTimeoutMillis: 30_000,
          statement_timeout: 10_000,
          options: '-c default_transaction_read_only=on',
        };

        return new Pool(poolConfig);
      },
    },
    OwnerResearchDatabaseLifecycle,
    OwnerResearchDatabaseReadinessProbe,
  ],
  exports: [OWNER_RESEARCH_DATABASE_POOL, OwnerResearchDatabaseReadinessProbe],
})
export class OwnerResearchDatabaseModule {}
