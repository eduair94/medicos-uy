import { config as loadEnvironment } from 'dotenv';
import { Client } from 'pg';

import {
  loadOwnerResearchMigrationPlan,
  runOwnerResearchMigrations,
  type MigrationConnection,
  type MigrationQueryResult,
  type OwnerResearchMigrationMode,
} from './owner-research-migrations';

loadEnvironment({
  quiet: true,
});

type OwnerResearchMigrationCommand = 'apply' | 'verify' | 'verify-files';

function parseCommand(value: string | undefined): OwnerResearchMigrationCommand {
  if (value === 'apply' || value === 'verify' || value === 'verify-files') {
    return value;
  }

  throw new Error('Usage: manage-owner-research-migrations.ts <apply|verify|verify-files>.');
}

function migrationDatabaseUrl(): string {
  const value = process.env['CATALOG_MIGRATION_DATABASE_URL'];

  if (value === undefined || value.trim().length === 0) {
    throw new Error('CATALOG_MIGRATION_DATABASE_URL is required.');
  }

  const parsed = new URL(value);

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('CATALOG_MIGRATION_DATABASE_URL must use postgres:// or postgresql://.');
  }

  return value;
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const migrations = await loadOwnerResearchMigrationPlan();

  if (command === 'verify-files') {
    process.stdout.write('Owner-research migration manifest and SHA-256 hashes are valid.\n');
    return;
  }

  const client = new Client({
    connectionString: migrationDatabaseUrl(),
    application_name: 'medicos-owner-research-migrator',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  const connection: MigrationConnection = {
    query: async (text, values): Promise<MigrationQueryResult> => {
      const result = await client.query(text, values === undefined ? [] : [...values]);
      return {
        rows: result.rows as readonly Record<string, unknown>[],
      };
    },
  };

  await client.connect();

  try {
    const mode: OwnerResearchMigrationMode = command === 'apply' ? 'APPLY' : 'VERIFY';
    await runOwnerResearchMigrations(connection, migrations, mode);
    process.stdout.write(
      command === 'apply'
        ? 'Owner-research migrations are applied and immutable hashes match.\n'
        : 'Owner-research migration ledger and immutable hashes are valid.\n',
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
