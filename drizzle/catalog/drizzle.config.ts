import { config as loadEnvironment } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

loadEnvironment({
  quiet: true,
});

const migrationDatabaseUrl = process.env['CATALOG_MIGRATION_DATABASE_URL'];

if (migrationDatabaseUrl === undefined || migrationDatabaseUrl.trim().length === 0) {
  throw new Error('CATALOG_MIGRATION_DATABASE_URL is required to run catalog migrations.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './drizzle/catalog/schema.ts',
  out: './drizzle/catalog/migrations',
  dbCredentials: {
    url: migrationDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
