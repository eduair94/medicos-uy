import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

export const CATALOG_DATABASE_POOL = Symbol('CATALOG_DATABASE_POOL');
export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');

export type CatalogDatabase = NodePgDatabase<Record<string, never>>;

@Injectable()
class CatalogDatabaseLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(CATALOG_DATABASE_POOL) private readonly pool: Pool) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Injectable()
export class CatalogDatabaseReadinessProbe {
  public readonly name = 'catalog-database';

  public constructor(@Inject(CATALOG_DATABASE_POOL) private readonly pool: Pool) {}

  public async check(): Promise<void> {
    await this.pool.query('select 1 from catalog.public_professional limit 0');
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: CATALOG_DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool => {
        const sslEnabled = config.getOrThrow<boolean>('CATALOG_DATABASE_SSL');
        const poolConfig: PoolConfig = {
          connectionString: config.getOrThrow<string>('CATALOG_DATABASE_URL'),
          application_name: config.get<string>('SERVICE_NAME', 'unknown-service'),
          max: config.getOrThrow<number>('CATALOG_DATABASE_POOL_MAX'),
          connectionTimeoutMillis: 3_000,
          idleTimeoutMillis: 30_000,
          statement_timeout: 10_000,
        };

        if (sslEnabled) {
          poolConfig.ssl = {
            rejectUnauthorized: true,
          };
        }

        return new Pool(poolConfig);
      },
    },
    {
      provide: CATALOG_DATABASE,
      inject: [CATALOG_DATABASE_POOL],
      useFactory: (pool: Pool): CatalogDatabase =>
        drizzle(pool, {
          casing: 'snake_case',
        }),
    },
    CatalogDatabaseLifecycle,
    CatalogDatabaseReadinessProbe,
  ],
  exports: [CATALOG_DATABASE, CATALOG_DATABASE_POOL, CatalogDatabaseReadinessProbe],
})
export class CatalogDatabaseModule {}
