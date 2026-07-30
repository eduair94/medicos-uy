import { describe, expect, it } from 'vitest';

import {
  assertMigrationHash,
  loadOwnerResearchMigrationPlan,
  parseOwnerResearchMigrationManifest,
  runOwnerResearchMigrations,
  sha256Text,
  unwrapMigrationTransaction,
  type MigrationConnection,
  type PreparedOwnerResearchMigration,
} from './owner-research-migrations';

const BASELINE_SQL = "BEGIN;\nSELECT 'baseline';\nCOMMIT;\n";
const MANAGED_SQL = "BEGIN;\nSELECT 'managed';\nCOMMIT;\n";
const BASELINE: PreparedOwnerResearchMigration = {
  id: '0006_professional_research',
  file: '0006_professional_research.sql',
  sha256: sha256Text(BASELINE_SQL),
  execution: 'BASELINE',
  sql: BASELINE_SQL,
};
const MANAGED: PreparedOwnerResearchMigration = {
  id: '0007_owner_research_read_model',
  file: '0007_owner_research_read_model.sql',
  sha256: sha256Text(MANAGED_SQL),
  execution: 'MANAGED',
  sql: MANAGED_SQL,
};
const MIGRATION_PLAN = [BASELINE, MANAGED] as const;

class RecordingMigrationConnection implements MigrationConnection {
  public readonly calls: { readonly text: string; readonly values?: readonly unknown[] }[] = [];
  public readonly appliedMigrations: Map<string, string>;
  private ledgerExists: boolean;
  private researchSchemaExists: boolean;

  public constructor(
    options: {
      readonly ledgerExists?: boolean;
      readonly appliedMigrations?: Readonly<Record<string, string>>;
      readonly researchSchemaExists?: boolean;
    } = {},
  ) {
    this.ledgerExists = options.ledgerExists ?? false;
    this.researchSchemaExists = options.researchSchemaExists ?? options.ledgerExists ?? false;
    this.appliedMigrations = new Map(Object.entries(options.appliedMigrations ?? {}));
  }

  public query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
  }> {
    this.calls.push({
      text,
      ...(values === undefined ? {} : { values }),
    });

    if (text.includes('to_regclass')) {
      return Promise.resolve({
        rows: [
          {
            relation_name: this.ledgerExists ? 'research_private.schema_migration' : null,
          },
        ],
      });
    }
    if (text === "SELECT 'baseline';") {
      this.researchSchemaExists = true;
      return Promise.resolve({
        rows: [],
      });
    }
    if (text.includes('CREATE TABLE IF NOT EXISTS research_private.schema_migration')) {
      if (!this.researchSchemaExists) {
        return Promise.reject(
          new Error('research_private must exist before creating the migration ledger'),
        );
      }

      this.ledgerExists = true;
      return Promise.resolve({
        rows: [],
      });
    }
    if (text.includes('SELECT migration_id, sha256')) {
      const migrationId = values?.[0];
      const sha256 =
        typeof migrationId === 'string' ? this.appliedMigrations.get(migrationId) : undefined;

      return Promise.resolve({
        rows:
          sha256 === undefined
            ? []
            : [
                {
                  migration_id: migrationId,
                  sha256,
                },
              ],
      });
    }
    if (text.includes('INSERT INTO research_private.schema_migration')) {
      const migrationId = values?.[0];
      const sha256 = values?.[2];

      if (typeof migrationId === 'string' && typeof sha256 === 'string') {
        this.appliedMigrations.set(migrationId, sha256);
      }
    }

    return Promise.resolve({
      rows: [],
    });
  }
}

function manifestEntry(migration: PreparedOwnerResearchMigration): {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly execution: string;
} {
  return {
    id: migration.id,
    file: migration.file,
    sha256: migration.sha256,
    execution: migration.execution,
  };
}

function callIndex(
  connection: RecordingMigrationConnection,
  predicate: (call: { readonly text: string; readonly values?: readonly unknown[] }) => boolean,
): number {
  return connection.calls.findIndex(predicate);
}

describe('owner-research migration management', () => {
  it('loads the immutable repository plan through the bounded owner page migration', async () => {
    const plan = await loadOwnerResearchMigrationPlan();

    expect(plan.map(({ id, execution }) => ({ id, execution }))).toEqual([
      {
        id: '0006_professional_research',
        execution: 'BASELINE',
      },
      {
        id: '0007_owner_research_read_model',
        execution: 'MANAGED',
      },
      {
        id: '0008_cmu_ethics_metadata_snapshot',
        execution: 'MANAGED',
      },
      {
        id: '0009_owner_research_keyset_page',
        execution: 'MANAGED',
      },
    ]);
  });

  it('requires one immutable baseline followed by at least one managed migration', () => {
    expect(
      parseOwnerResearchMigrationManifest({
        schemaVersion: 1,
        migrations: MIGRATION_PLAN.map(manifestEntry),
      }),
    ).toMatchObject({
      schemaVersion: 1,
    });

    expect(() =>
      parseOwnerResearchMigrationManifest({
        schemaVersion: 1,
        migrations: [manifestEntry(MANAGED)],
      }),
    ).toThrow('must start with exactly one baseline migration');

    expect(() =>
      parseOwnerResearchMigrationManifest({
        schemaVersion: 1,
        migrations: [
          ...MIGRATION_PLAN.map(manifestEntry),
          {
            ...manifestEntry(MANAGED),
            id: '0008_duplicate',
          },
        ],
      }),
    ).toThrow('duplicates a migration ID or file');
  });

  it('fails closed when a migration file changes and unwraps only an outer transaction', () => {
    expect(() => assertMigrationHash(MANAGED, `${MANAGED_SQL}\n-- changed`)).toThrow(
      'Migration files are immutable',
    );
    expect(unwrapMigrationTransaction(MANAGED_SQL, MANAGED.file)).toBe("SELECT 'managed';");
    expect(() => unwrapMigrationTransaction("SELECT 'managed';", MANAGED.file)).toThrow(
      'exactly one outer BEGIN/COMMIT',
    );
  });

  it('bootstraps a fresh research schema with baseline, ledger and managed migration in order', async () => {
    const connection = new RecordingMigrationConnection({
      ledgerExists: false,
    });

    await runOwnerResearchMigrations(connection, MIGRATION_PLAN, 'APPLY');

    expect(connection.calls[0]?.text).toBe('BEGIN');
    expect(connection.calls[1]).toMatchObject({
      values: [1_834_104, 104_234_207],
    });
    const baselineIndex = callIndex(connection, ({ text }) => text === "SELECT 'baseline';");
    const ledgerIndex = callIndex(connection, ({ text }) =>
      text.includes('CREATE TABLE IF NOT EXISTS research_private.schema_migration'),
    );
    const baselineRecordIndex = callIndex(
      connection,
      ({ text, values }) =>
        text.includes('INSERT INTO research_private.schema_migration') &&
        values?.[0] === BASELINE.id,
    );
    const managedIndex = callIndex(connection, ({ text }) => text === "SELECT 'managed';");

    expect(baselineIndex).toBeGreaterThan(1);
    expect(ledgerIndex).toBeGreaterThan(baselineIndex);
    expect(baselineRecordIndex).toBeGreaterThan(ledgerIndex);
    expect(managedIndex).toBeGreaterThan(baselineRecordIndex);
    expect(connection.appliedMigrations).toEqual(
      new Map([
        [BASELINE.id, BASELINE.sha256],
        [MANAGED.id, MANAGED.sha256],
      ]),
    );
    expect(connection.calls.at(-1)?.text).toBe('COMMIT');
  });

  it('replays the idempotent baseline before creating a ledger for a preexisting schema', async () => {
    const connection = new RecordingMigrationConnection({
      ledgerExists: false,
      researchSchemaExists: true,
    });

    await runOwnerResearchMigrations(connection, MIGRATION_PLAN, 'APPLY');

    expect(connection.calls.some(({ text }) => text === "SELECT 'baseline';")).toBe(true);
    expect(
      connection.calls.some(
        ({ text, values }) =>
          text.includes('INSERT INTO research_private.schema_migration') &&
          values?.[0] === BASELINE.id &&
          values[2] === BASELINE.sha256,
      ),
    ).toBe(true);
  });

  it('is idempotent when baseline and managed hashes already match', async () => {
    const connection = new RecordingMigrationConnection({
      ledgerExists: true,
      appliedMigrations: {
        [BASELINE.id]: BASELINE.sha256,
        [MANAGED.id]: MANAGED.sha256,
      },
    });

    await runOwnerResearchMigrations(connection, MIGRATION_PLAN, 'APPLY');

    expect(connection.calls.some(({ text }) => text === "SELECT 'baseline';")).toBe(false);
    expect(connection.calls.some(({ text }) => text === "SELECT 'managed';")).toBe(false);
    expect(
      connection.calls.some(({ text }) =>
        text.includes('INSERT INTO research_private.schema_migration'),
      ),
    ).toBe(false);
    expect(connection.calls.at(-1)?.text).toBe('COMMIT');
  });

  it('applies missing ledger entries and rejects a persisted hash mismatch', async () => {
    const missingBaseline = new RecordingMigrationConnection({
      ledgerExists: true,
      appliedMigrations: {
        [MANAGED.id]: MANAGED.sha256,
      },
    });

    await runOwnerResearchMigrations(missingBaseline, MIGRATION_PLAN, 'APPLY');

    expect(missingBaseline.calls.some(({ text }) => text === "SELECT 'baseline';")).toBe(true);
    expect(missingBaseline.calls.some(({ text }) => text === "SELECT 'managed';")).toBe(false);
    expect(missingBaseline.appliedMigrations.get(BASELINE.id)).toBe(BASELINE.sha256);

    const mismatched = new RecordingMigrationConnection({
      ledgerExists: true,
      appliedMigrations: {
        [BASELINE.id]: 'f'.repeat(64),
        [MANAGED.id]: MANAGED.sha256,
      },
    });

    await expect(runOwnerResearchMigrations(mismatched, MIGRATION_PLAN, 'APPLY')).rejects.toThrow(
      'immutable manifest requires',
    );
    expect(mismatched.calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('verifies ledger and immutable hashes for baseline plus managed migrations', async () => {
    const verified = new RecordingMigrationConnection({
      ledgerExists: true,
      appliedMigrations: {
        [BASELINE.id]: BASELINE.sha256,
        [MANAGED.id]: MANAGED.sha256,
      },
    });

    await runOwnerResearchMigrations(verified, MIGRATION_PLAN, 'VERIFY');

    expect(
      verified.calls.some(({ text }) =>
        text.includes('CREATE TABLE IF NOT EXISTS research_private.schema_migration'),
      ),
    ).toBe(false);
    expect(verified.calls.at(-1)?.text).toBe('COMMIT');

    const missingLedger = new RecordingMigrationConnection({
      ledgerExists: false,
    });
    await expect(
      runOwnerResearchMigrations(missingLedger, MIGRATION_PLAN, 'VERIFY'),
    ).rejects.toThrow('migration ledger is absent');
    expect(missingLedger.calls.at(-1)?.text).toBe('ROLLBACK');

    const missingBaseline = new RecordingMigrationConnection({
      ledgerExists: true,
      appliedMigrations: {
        [MANAGED.id]: MANAGED.sha256,
      },
    });
    await expect(
      runOwnerResearchMigrations(missingBaseline, MIGRATION_PLAN, 'VERIFY'),
    ).rejects.toThrow(`${BASELINE.id} has not been applied`);
    expect(missingBaseline.calls.at(-1)?.text).toBe('ROLLBACK');

    const missingManaged = new RecordingMigrationConnection({
      ledgerExists: true,
      appliedMigrations: {
        [BASELINE.id]: BASELINE.sha256,
      },
    });
    await expect(
      runOwnerResearchMigrations(missingManaged, MIGRATION_PLAN, 'VERIFY'),
    ).rejects.toThrow(`${MANAGED.id} has not been applied`);
    expect(missingManaged.calls.at(-1)?.text).toBe('ROLLBACK');
  });
});
