import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const MANIFEST_RELATIVE_PATH = 'drizzle/research-private/migrations/manifest.json';
const MIGRATIONS_RELATIVE_DIRECTORY = 'drizzle/research-private/migrations';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MIGRATION_ID_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/u;
const MIGRATION_FILE_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;
const ADVISORY_LOCK_NAMESPACE = 1_834_104;
const ADVISORY_LOCK_RESOURCE = 104_234_207;

const CREATE_MIGRATION_LEDGER = `
  CREATE TABLE IF NOT EXISTS research_private.schema_migration (
    migration_id varchar(128) PRIMARY KEY,
    source_file varchar(255) NOT NULL,
    sha256 char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by name NOT NULL DEFAULT session_user,
    execution_ms integer NOT NULL,
    CONSTRAINT ck_research_schema_migration_id
      CHECK (migration_id ~ '^[0-9]{4}_[a-z0-9_]+$'),
    CONSTRAINT ck_research_schema_migration_file
      CHECK (source_file ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'),
    CONSTRAINT ck_research_schema_migration_sha256
      CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_research_schema_migration_execution_ms
      CHECK (execution_ms >= 0)
  );
  REVOKE ALL ON research_private.schema_migration FROM PUBLIC;
`;

const CHECK_LEDGER_EXISTS = `
  SELECT to_regclass('research_private.schema_migration')::text AS relation_name
`;

const FIND_APPLIED_MIGRATION = `
  SELECT migration_id, sha256
  FROM research_private.schema_migration
  WHERE migration_id = $1
`;

const RECORD_APPLIED_MIGRATION = `
  INSERT INTO research_private.schema_migration (
    migration_id,
    source_file,
    sha256,
    execution_ms
  )
  VALUES ($1, $2, $3, $4)
`;

export type OwnerResearchMigrationMode = 'APPLY' | 'VERIFY';
export type OwnerResearchMigrationExecution = 'BASELINE' | 'MANAGED';

export interface OwnerResearchMigrationManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly execution: OwnerResearchMigrationExecution;
}

export interface OwnerResearchMigrationManifest {
  readonly schemaVersion: 1;
  readonly migrations: readonly OwnerResearchMigrationManifestEntry[];
}

export interface PreparedOwnerResearchMigration extends OwnerResearchMigrationManifestEntry {
  readonly sql: string;
}

export interface MigrationQueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface MigrationConnection {
  query(text: string, values?: readonly unknown[]): Promise<MigrationQueryResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key];

  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string.`);
  }

  return field;
}

export function parseOwnerResearchMigrationManifest(
  value: unknown,
): OwnerResearchMigrationManifest {
  if (!isRecord(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['migrations'])) {
    throw new Error('Owner-research migration manifest must use schemaVersion 1.');
  }

  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const migrations = value['migrations'].map((candidate, index) => {
    const context = `migrations[${index}]`;

    if (!isRecord(candidate)) {
      throw new Error(`${context} must be an object.`);
    }

    const id = requiredString(candidate, 'id', context);
    const file = requiredString(candidate, 'file', context);
    const sha256 = requiredString(candidate, 'sha256', context);
    const execution = candidate['execution'];

    if (!MIGRATION_ID_PATTERN.test(id)) {
      throw new Error(`${context}.id has an invalid migration identifier.`);
    }
    if (!MIGRATION_FILE_PATTERN.test(file) || basename(file) !== file) {
      throw new Error(`${context}.file must be a migration SQL basename.`);
    }
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`${context}.sha256 must be a lowercase SHA-256 digest.`);
    }
    if (execution !== 'BASELINE' && execution !== 'MANAGED') {
      throw new Error(`${context}.execution must be BASELINE or MANAGED.`);
    }
    const validatedExecution: OwnerResearchMigrationExecution = execution;
    if (seenIds.has(id) || seenFiles.has(file)) {
      throw new Error(`${context} duplicates a migration ID or file.`);
    }

    seenIds.add(id);
    seenFiles.add(file);

    return {
      id,
      file,
      sha256,
      execution: validatedExecution,
    };
  });

  const baselineMigrations = migrations.filter(({ execution }) => execution === 'BASELINE');
  const managedMigrations = migrations.filter(({ execution }) => execution === 'MANAGED');

  if (baselineMigrations.length !== 1 || migrations[0]?.execution !== 'BASELINE') {
    throw new Error(
      'Owner-research migration manifest must start with exactly one baseline migration.',
    );
  }
  if (managedMigrations.length === 0) {
    throw new Error('Owner-research migration manifest must contain a managed migration.');
  }

  return {
    schemaVersion: 1,
    migrations,
  };
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function assertMigrationHash(
  migration: OwnerResearchMigrationManifestEntry,
  sql: string,
): void {
  const actualSha256 = sha256Text(sql);

  if (actualSha256 !== migration.sha256) {
    throw new Error(
      `Migration ${migration.file} SHA-256 mismatch: expected ${migration.sha256}, got ${actualSha256}. Migration files are immutable.`,
    );
  }
}

export function unwrapMigrationTransaction(sql: string, file: string): string {
  const transaction = /^\uFEFF?\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/u.exec(sql);
  const body = transaction?.[1]?.trim();

  if (body === undefined || body.length === 0) {
    throw new Error(`Migration ${file} must contain exactly one outer BEGIN/COMMIT transaction.`);
  }

  return body;
}

export async function loadOwnerResearchMigrationPlan(
  repositoryRoot = process.cwd(),
): Promise<readonly PreparedOwnerResearchMigration[]> {
  const manifestPath = resolve(repositoryRoot, MANIFEST_RELATIVE_PATH);
  const migrationsDirectory = resolve(repositoryRoot, MIGRATIONS_RELATIVE_DIRECTORY);
  const manifest = parseOwnerResearchMigrationManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  );
  const actualSqlFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const declaredSqlFiles = manifest.migrations.map(({ file }) => file).sort();

  if (JSON.stringify(actualSqlFiles) !== JSON.stringify(declaredSqlFiles)) {
    throw new Error(
      `Owner-research migration manifest is incomplete. Declared ${declaredSqlFiles.join(', ')}, found ${actualSqlFiles.join(', ')}.`,
    );
  }

  const prepared = await Promise.all(
    manifest.migrations.map(async (migration) => {
      const sql = await readFile(resolve(migrationsDirectory, migration.file), 'utf8');
      assertMigrationHash(migration, sql);

      return {
        ...migration,
        sql,
      };
    }),
  );

  return prepared;
}

function appliedMigrationHash(row: Record<string, unknown> | undefined): string | undefined {
  if (row === undefined) {
    return undefined;
  }

  const sha256 = row['sha256'];
  return typeof sha256 === 'string' ? sha256 : undefined;
}

async function migrationLedgerExists(connection: MigrationConnection): Promise<boolean> {
  const result = await connection.query(CHECK_LEDGER_EXISTS);
  return result.rows[0]?.['relation_name'] === 'research_private.schema_migration';
}

async function inspectAppliedMigration(
  connection: MigrationConnection,
  migration: PreparedOwnerResearchMigration,
): Promise<'APPLIED' | 'MISSING'> {
  const result = await connection.query(FIND_APPLIED_MIGRATION, [migration.id]);
  const persistedSha256 = appliedMigrationHash(result.rows[0]);

  if (persistedSha256 === undefined) {
    return 'MISSING';
  }
  if (persistedSha256 !== migration.sha256) {
    throw new Error(
      `Applied migration ${migration.id} has SHA-256 ${persistedSha256}, but the immutable manifest requires ${migration.sha256}.`,
    );
  }

  return 'APPLIED';
}

export async function runOwnerResearchMigrations(
  connection: MigrationConnection,
  migrations: readonly PreparedOwnerResearchMigration[],
  mode: OwnerResearchMigrationMode,
): Promise<void> {
  const baselineMigrations = migrations.filter(({ execution }) => execution === 'BASELINE');
  const managedMigrations = migrations.filter(({ execution }) => execution === 'MANAGED');

  if (baselineMigrations.length !== 1 || migrations[0]?.execution !== 'BASELINE') {
    throw new Error(
      'Owner-research migration plan must start with exactly one baseline migration.',
    );
  }
  if (managedMigrations.length === 0) {
    throw new Error('No managed owner-research migrations were provided.');
  }

  for (const migration of migrations) {
    assertMigrationHash(migration, migration.sql);
  }

  await connection.query('BEGIN');

  try {
    await connection.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
      ADVISORY_LOCK_NAMESPACE,
      ADVISORY_LOCK_RESOURCE,
    ]);

    const ledgerExists = await migrationLedgerExists(connection);
    const bootstrappedMigrations = new Set<string>();

    if (mode === 'VERIFY' && !ledgerExists) {
      throw new Error(
        'Owner-research migration ledger is absent. Run pnpm db:migrate:owner-research first.',
      );
    }

    if (mode === 'APPLY' && !ledgerExists) {
      const executionTimes = new Map<string, number>();

      for (const migration of baselineMigrations) {
        const startedAt = Date.now();
        await connection.query(unwrapMigrationTransaction(migration.sql, migration.file));
        executionTimes.set(migration.id, Math.max(0, Date.now() - startedAt));
      }

      await connection.query(CREATE_MIGRATION_LEDGER);

      for (const migration of baselineMigrations) {
        await connection.query(RECORD_APPLIED_MIGRATION, [
          migration.id,
          migration.file,
          migration.sha256,
          executionTimes.get(migration.id) ?? 0,
        ]);
        bootstrappedMigrations.add(migration.id);
      }
    }

    for (const migration of migrations) {
      if (bootstrappedMigrations.has(migration.id)) {
        continue;
      }

      const state = await inspectAppliedMigration(connection, migration);

      if (state === 'APPLIED') {
        continue;
      }
      if (mode === 'VERIFY') {
        throw new Error(
          `Owner-research migration ${migration.id} has not been applied to this database.`,
        );
      }

      const startedAt = Date.now();
      await connection.query(unwrapMigrationTransaction(migration.sql, migration.file));
      await connection.query(RECORD_APPLIED_MIGRATION, [
        migration.id,
        migration.file,
        migration.sha256,
        Math.max(0, Date.now() - startedAt),
      ]);
    }

    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}
