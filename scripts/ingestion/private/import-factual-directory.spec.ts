import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PRIVATE_IMPORT_APPROVAL,
  importPreparedPrivateDirectorySnapshot,
  loadPrivateDirectoryImportConfiguration,
  parsePrivateProfessionalProfileLine,
  preparePrivateDirectorySnapshot,
  type PreparedPrivateDirectorySnapshot,
  type PrivateImportConnection,
} from './import-factual-directory';

type UnknownRecord = Record<string, unknown>;

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeQueryResult {
  readonly rows: readonly UnknownRecord[];
  readonly rowCount: number;
}

class FakeConnection implements PrivateImportConnection {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly respond: (
      text: string,
      values: readonly unknown[],
      calls: readonly QueryCall[],
    ) => FakeQueryResult | Promise<FakeQueryResult>,
  ) {}

  async query<Row extends UnknownRecord = UnknownRecord>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }> {
    this.calls.push({
      text,
      values,
    });
    const result = await this.respond(text, values, this.calls);

    return {
      rows: result.rows as readonly Row[],
      rowCount: result.rowCount,
    };
  }
}

interface SnapshotFixture {
  readonly root: string;
  readonly snapshotId: string;
  readonly manifestPath: string;
  readonly profilesPath: string;
  readonly manifestSha256: string;
  readonly profileLines: readonly string[];
}

const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function privateIngestorRoleRow(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    database_name: 'medicos_catalog',
    role_name: 'medicos_private_ingestor',
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    membership_count: 0,
    owns_database: false,
    owns_schema: false,
    owns_relation: false,
    owns_function: false,
    has_temp: false,
    can_create_public: false,
    can_use_private_schema: true,
    can_select_private_snapshot: true,
    can_insert_private_snapshot: true,
    can_select_private_profile: true,
    can_insert_private_profile: true,
    has_forbidden_private_privileges: false,
    has_public_catalog_privileges: false,
    ...overrides,
  };
}

function syntheticProfile(hexCharacter = 'a'): UnknownRecord {
  return {
    schemaVersion: 2,
    internalLinkageId: `msp_doc_v1_${hexCharacter.repeat(64)}`,
    displayName: 'Dra. Érica Pérez',
    enabledTitles: ['DOCTORA EN MEDICINA'],
    registeredTitles: [
      {
        title: 'DOCTORA EN MEDICINA',
        temporaryRegistration: 'NONE',
      },
    ],
    officialRegistry: {
      publisher: 'Ministerio de Salud Pública',
      dataset: 'Infotítulos',
      sourceCutoffDate: '2026-06-30',
      datasetUrl: 'https://example.test/dataset',
      liveLookupUrl: 'https://example.test/lookup',
    },
    linkageReview: {
      resolutionIds: [],
      linkedInstitutionalObservations: 0,
    },
    notice: {
      noticeVersion: 'uy-medical-directory-factual-v3',
      status: 'internal_research_only',
      sourceCutoffDate: '2026-06-30',
      expectedRefreshFrequency: 'monthly',
      warningCodes: ['VERIFY_WITH_OFFICIAL_SOURCE'],
      shortText: 'Synthetic fixture.',
    },
    publication: {
      profileFacts: 'pending_evidence_and_legal_approval',
      institutionalLinks: 'not_public',
      publicExportAllowed: false,
    },
  };
}

async function createSnapshotFixture(options?: {
  readonly profiles?: readonly UnknownRecord[];
  readonly manifestTransform?: (manifest: UnknownRecord) => void;
}): Promise<SnapshotFixture> {
  const root = await mkdtemp(join(tmpdir(), 'medicos-private-import-'));
  temporaryDirectories.push(root);
  const snapshotId = 'factual-v3-0123456789abcdef';
  const snapshotDirectory = join(root, 'processed', 'directory', snapshotId);
  const manifestPath = join(snapshotDirectory, 'manifest.json');
  const profilesPath = join(snapshotDirectory, 'profiles.ndjson');
  await mkdir(snapshotDirectory, {
    recursive: true,
  });
  const profiles = options?.profiles ?? [syntheticProfile('a'), syntheticProfile('b')];
  const profileLines = profiles.map((profile) => JSON.stringify(profile));
  const profilesContent = `${profileLines.join('\n')}\n`;
  await writeFile(profilesPath, profilesContent, 'utf8');
  const manifest: UnknownRecord = {
    schemaVersion: 2,
    snapshotId,
    generatedAt: '2026-07-28T15:45:49.765Z',
    noticeVersion: 'uy-medical-directory-factual-v3',
    inputs: [],
    outputs: {
      profiles: {
        relativePath: `processed/directory/${snapshotId}/profiles.ndjson`,
        records: profiles.length,
        sha256: sha256(profilesContent),
      },
      linkageResolutions: {
        relativePath: `processed/directory/${snapshotId}/linkage-resolutions.ndjson`,
        records: 0,
        sha256: 'c'.repeat(64),
      },
      legalNotice: {
        relativePath: `processed/directory/${snapshotId}/privacy-and-publication-notice.json`,
        records: 1,
        sha256: 'd'.repeat(64),
      },
    },
    aggregates: {
      mspProfiles: profiles.length,
    },
    safeguards: {
      internalLinkageIdsPresent: true,
      publicExportAllowed: false,
      rawGovernmentIdentifiersPublished: false,
    },
    publicationGate: {
      state: 'blocked',
    },
  };
  options?.manifestTransform?.(manifest);
  const manifestContent = `${JSON.stringify(manifest, undefined, 2)}\n`;
  await writeFile(manifestPath, manifestContent, 'utf8');

  return {
    root,
    snapshotId,
    manifestPath,
    profilesPath,
    manifestSha256: sha256(manifestContent),
    profileLines,
  };
}

async function prepareFixture(fixture: SnapshotFixture): Promise<PreparedPrivateDirectorySnapshot> {
  return preparePrivateDirectorySnapshot({
    dataRoot: fixture.root,
    manifestPath: fixture.manifestPath,
    expectedSnapshotId: fixture.snapshotId,
    expectedManifestSha256: fixture.manifestSha256,
  });
}

function standardImportConnection(profileCount: number): FakeConnection {
  return new FakeConnection((text, values) => {
    if (text.includes('FROM pg_catalog.pg_roles')) {
      return {
        rows: [privateIngestorRoleRow()],
        rowCount: 1,
      };
    }

    if (text.includes('FROM ingestion_private.snapshot')) {
      return {
        rows: [],
        rowCount: 0,
      };
    }

    if (text.includes('SELECT count(*)::integer')) {
      return {
        rows: [
          {
            profile_count: profileCount,
          },
        ],
        rowCount: 1,
      };
    }

    if (text.includes('INSERT INTO ingestion_private.professional_profile')) {
      return {
        rows: [],
        rowCount: values.length / 7,
      };
    }

    if (text.includes('INSERT INTO ingestion_private.snapshot')) {
      return {
        rows: [],
        rowCount: 1,
      };
    }

    return {
      rows: [],
      rowCount: 0,
    };
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }),
  );
});

describe('private factual directory configuration', () => {
  it('requires an explicit staging approval, expected snapshot and pinned manifest hash', async () => {
    const fixture = await createSnapshotFixture();
    const caPath = join(fixture.root, 'ca.pem');
    await writeFile(
      caPath,
      '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n',
      'utf8',
    );

    const configuration = await loadPrivateDirectoryImportConfiguration({
      PRIVATE_DIRECTORY_IMPORT_APPROVAL: PRIVATE_IMPORT_APPROVAL,
      PRIVATE_DIRECTORY_EXPECTED_SNAPSHOT_ID: fixture.snapshotId,
      PRIVATE_DIRECTORY_EXPECTED_MANIFEST_SHA256: fixture.manifestSha256,
      PRIVATE_DIRECTORY_MANIFEST_PATH: fixture.manifestPath,
      PRIVATE_INGESTION_DATABASE_URL:
        'postgresql://medicos_private_ingestor:secret@server.example:5432/medicos_catalog',
      PRIVATE_INGESTION_DATABASE_SSL_CA_PATH: caPath,
      DATA_INGESTION_DIR: fixture.root,
      PRIVATE_DIRECTORY_IMPORT_BATCH_SIZE: '250',
    });

    expect(configuration).toMatchObject({
      approval: PRIVATE_IMPORT_APPROVAL,
      expectedSnapshotId: fixture.snapshotId,
      expectedManifestSha256: fixture.manifestSha256,
      manifestPath: resolve(fixture.manifestPath),
      dataRoot: resolve(fixture.root),
      batchSize: 250,
    });
    expect(configuration.databaseCa).toContain('BEGIN CERTIFICATE');
  });

  it('rejects wrong roles, databases and all connection-string option overrides', async () => {
    const fixture = await createSnapshotFixture();
    const caPath = join(fixture.root, 'ca.pem');
    await writeFile(
      caPath,
      '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n',
      'utf8',
    );
    const environment = {
      PRIVATE_DIRECTORY_IMPORT_APPROVAL: PRIVATE_IMPORT_APPROVAL,
      PRIVATE_DIRECTORY_EXPECTED_SNAPSHOT_ID: fixture.snapshotId,
      PRIVATE_DIRECTORY_EXPECTED_MANIFEST_SHA256: fixture.manifestSha256,
      PRIVATE_DIRECTORY_MANIFEST_PATH: fixture.manifestPath,
      PRIVATE_INGESTION_DATABASE_SSL_CA_PATH: caPath,
    };

    await expect(
      loadPrivateDirectoryImportConfiguration({
        ...environment,
        PRIVATE_INGESTION_DATABASE_URL:
          'postgresql://medicos_public_query:secret@server.example:5432/medicos_catalog',
      }),
    ).rejects.toThrow('require the medicos_private_ingestor');
    await expect(
      loadPrivateDirectoryImportConfiguration({
        ...environment,
        PRIVATE_INGESTION_DATABASE_URL:
          'postgresql://medicos_private_ingestor:secret@server.example:5432/medicos_catalog?sslmode=disable',
      }),
    ).rejects.toThrow('must not contain query parameters');
    await expect(
      loadPrivateDirectoryImportConfiguration({
        ...environment,
        PRIVATE_INGESTION_DATABASE_URL:
          'postgresql://medicos_private_ingestor:secret@server.example:5432/medicos_catalog?ssl=0',
      }),
    ).rejects.toThrow('must not contain query parameters');
    await expect(
      loadPrivateDirectoryImportConfiguration({
        ...environment,
        PRIVATE_INGESTION_DATABASE_URL:
          'postgresql://medicos_private_ingestor:secret@server.example:5432/another_database',
      }),
    ).rejects.toThrow('require the medicos_catalog');
  });
});

describe('factual-v3 snapshot validation', () => {
  it('verifies the canonical path, manifest hash, profile hash and record count', async () => {
    const fixture = await createSnapshotFixture();

    await expect(prepareFixture(fixture)).resolves.toMatchObject({
      snapshotId: fixture.snapshotId,
      manifestSha256: fixture.manifestSha256,
      profileCount: 2,
      manifestPath: resolve(fixture.manifestPath),
      profilesPath: resolve(fixture.profilesPath),
    });
  });

  it('rejects a manifest that enables public export', async () => {
    const fixture = await createSnapshotFixture({
      manifestTransform(manifest) {
        (manifest['safeguards'] as UnknownRecord)['publicExportAllowed'] = true;
      },
    });

    await expect(prepareFixture(fixture)).rejects.toThrow('publicExportAllowed is not false');
  });

  it('rejects profile hash, count and canonical-path mismatches', async () => {
    const hashFixture = await createSnapshotFixture();
    await writeFile(hashFixture.profilesPath, `${JSON.stringify(syntheticProfile('c'))}\n`, 'utf8');
    await expect(prepareFixture(hashFixture)).rejects.toThrow('SHA-256 does not match');

    const countFixture = await createSnapshotFixture({
      manifestTransform(manifest) {
        const outputs = manifest['outputs'] as UnknownRecord;
        const profiles = outputs['profiles'] as UnknownRecord;
        profiles['records'] = 3;
        (manifest['aggregates'] as UnknownRecord)['mspProfiles'] = 3;
      },
    });
    await expect(prepareFixture(countFixture)).rejects.toThrow('count does not match');

    const pathFixture = await createSnapshotFixture({
      manifestTransform(manifest) {
        const outputs = manifest['outputs'] as UnknownRecord;
        const profiles = outputs['profiles'] as UnknownRecord;
        profiles['relativePath'] = 'processed/directory/other/profiles.ndjson';
      },
    });
    await expect(prepareFixture(pathFixture)).rejects.toThrow('not canonical');
  });

  it('rejects raw identifier keys and per-profile public export', () => {
    const rawIdentifierProfile = syntheticProfile();
    rawIdentifierProfile['rawGovernmentIdentifier'] = 'synthetic-id';

    expect(() =>
      parsePrivateProfessionalProfileLine(JSON.stringify(rawIdentifierProfile), 1),
    ).toThrow('forbidden raw identifier field');

    const publicProfile = syntheticProfile();
    (publicProfile['publication'] as UnknownRecord)['publicExportAllowed'] = true;

    expect(() => parsePrivateProfessionalProfileLine(JSON.stringify(publicProfile), 1)).toThrow(
      'publicExportAllowed is not false',
    );
  });
});

describe('private PostgreSQL staging import', () => {
  it('refuses an ingestor role that has elevated cluster privileges', async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = await prepareFixture(fixture);
    const connectionWithRole = (role: UnknownRecord): FakeConnection =>
      new FakeConnection((text) => {
        if (text.includes('FROM pg_catalog.pg_roles')) {
          return {
            rows: [role],
            rowCount: 1,
          };
        }

        return {
          rows: [],
          rowCount: 0,
        };
      });
    const superuserConnection = connectionWithRole(
      privateIngestorRoleRow({
        rolsuper: true,
      }),
    );

    await expect(
      importPreparedPrivateDirectorySnapshot(superuserConnection, snapshot),
    ).rejects.toThrow('least-privilege medicos_private_ingestor');
    expect(superuserConnection.calls.at(-1)?.text).toBe('ROLLBACK');

    const membershipConnection = connectionWithRole(
      privateIngestorRoleRow({
        membership_count: 1,
      }),
    );

    await expect(
      importPreparedPrivateDirectorySnapshot(membershipConnection, snapshot),
    ).rejects.toThrow('least-privilege medicos_private_ingestor');
    expect(membershipConnection.calls.at(-1)?.text).toBe('ROLLBACK');

    const wrongDatabaseConnection = connectionWithRole(
      privateIngestorRoleRow({
        database_name: 'another_database',
      }),
    );

    await expect(
      importPreparedPrivateDirectorySnapshot(wrongDatabaseConnection, snapshot),
    ).rejects.toThrow('least-privilege medicos_private_ingestor');
    expect(wrongDatabaseConnection.calls.at(-1)?.text).toBe('ROLLBACK');

    const overgrantedConnection = connectionWithRole(
      privateIngestorRoleRow({
        has_public_catalog_privileges: true,
      }),
    );

    await expect(
      importPreparedPrivateDirectorySnapshot(overgrantedConnection, snapshot),
    ).rejects.toThrow('least-privilege medicos_private_ingestor');
    expect(overgrantedConnection.calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('uses a transaction and advisory lock, batches rows and stores only approved fields', async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = await prepareFixture(fixture);
    const connection = standardImportConnection(2);

    await expect(importPreparedPrivateDirectorySnapshot(connection, snapshot, 1)).resolves.toEqual({
      status: 'imported',
      snapshotId: fixture.snapshotId,
      profileCount: 2,
      manifestSha256: fixture.manifestSha256,
      profilesSha256: sha256(`${fixture.profileLines.join('\n')}\n`),
    });

    expect(connection.calls[0]?.text).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(connection.calls[1]?.text).toContain('FROM pg_catalog.pg_roles');
    expect(connection.calls[2]?.text).toContain('pg_advisory_xact_lock');
    expect(connection.calls.at(-1)?.text).toBe('COMMIT');
    const profileInserts = connection.calls.filter((call) =>
      call.text.includes('INSERT INTO ingestion_private.professional_profile'),
    );
    expect(profileInserts).toHaveLength(2);
    expect(profileInserts[0]?.values).toHaveLength(7);
    expect(profileInserts[0]?.values[0]).toBe(fixture.snapshotId);
    expect(profileInserts[0]?.values[1]).toBe(`msp_doc_v1_${'a'.repeat(64)}`);
    expect(profileInserts[0]?.values[3]).toBe('ERICA PEREZ');
    expect(String(profileInserts[0]?.values[4])).toContain('temporaryRegistration');
    expect(String(profileInserts[0]?.values[5])).toContain('sourceCutoffDate');
    expect(profileInserts[0]?.values.join(' ')).not.toContain('resolutionIds');
    expect(profileInserts[0]?.values.join(' ')).not.toContain('warningCodes');
  });

  it('is idempotent when the same complete snapshot already exists', async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = await prepareFixture(fixture);
    const existingConnection = (tamperFirstPayload = false): FakeConnection =>
      new FakeConnection((text) => {
        if (text.includes('FROM pg_catalog.pg_roles')) {
          return {
            rows: [privateIngestorRoleRow()],
            rowCount: 1,
          };
        }

        if (text.includes('FROM ingestion_private.snapshot')) {
          return {
            rows: [
              {
                manifest_sha256: snapshot.manifestSha256,
                profiles_sha256: snapshot.profilesSha256,
                profile_count: snapshot.profileCount,
                source_generated_at: snapshot.sourceGeneratedAt,
              },
            ],
            rowCount: 1,
          };
        }

        if (text.includes('SELECT count(*)::integer')) {
          return {
            rows: [
              {
                profile_count: snapshot.profileCount,
              },
            ],
            rowCount: 1,
          };
        }

        if (text.includes('internal_hmac_id') && text.includes('record_sha256')) {
          return {
            rows: fixture.profileLines.map((line, index) => {
              const profile = JSON.parse(line) as UnknownRecord;

              return {
                internal_hmac_id: profile['internalLinkageId'],
                display_name:
                  tamperFirstPayload && index === 0 ? 'Tampered Name' : profile['displayName'],
                normalized_name: 'ERICA PEREZ',
                registered_titles: profile['registeredTitles'],
                official_registry: profile['officialRegistry'],
                record_sha256: sha256(line),
              };
            }),
            rowCount: snapshot.profileCount,
          };
        }

        return {
          rows: [],
          rowCount: 0,
        };
      });
    const connection = existingConnection();

    await expect(
      importPreparedPrivateDirectorySnapshot(connection, snapshot),
    ).resolves.toMatchObject({
      status: 'already_imported',
      profileCount: 2,
    });
    expect(
      connection.calls.some((call) =>
        call.text.includes('INSERT INTO ingestion_private.professional_profile'),
      ),
    ).toBe(false);
    expect(connection.calls.at(-1)?.text).toBe('COMMIT');

    const tamperedConnection = existingConnection(true);

    await expect(
      importPreparedPrivateDirectorySnapshot(tamperedConnection, snapshot),
    ).rejects.toThrow('rows differ from the approved source file');
    expect(tamperedConnection.calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('rolls back a snapshot ID collision or failed batch', async () => {
    const fixture = await createSnapshotFixture();
    const snapshot = await prepareFixture(fixture);
    const collisionConnection = new FakeConnection((text) => {
      if (text.includes('FROM pg_catalog.pg_roles')) {
        return {
          rows: [privateIngestorRoleRow()],
          rowCount: 1,
        };
      }

      if (text.includes('FROM ingestion_private.snapshot')) {
        return {
          rows: [
            {
              manifest_sha256: 'f'.repeat(64),
              profiles_sha256: snapshot.profilesSha256,
              profile_count: snapshot.profileCount,
              source_generated_at: snapshot.sourceGeneratedAt,
            },
          ],
          rowCount: 1,
        };
      }

      return {
        rows: [],
        rowCount: 0,
      };
    });

    await expect(
      importPreparedPrivateDirectorySnapshot(collisionConnection, snapshot),
    ).rejects.toThrow('Snapshot ID collision');
    expect(collisionConnection.calls.at(-1)?.text).toBe('ROLLBACK');

    const failedBatchConnection = new FakeConnection((text) => {
      if (text.includes('FROM pg_catalog.pg_roles')) {
        return {
          rows: [privateIngestorRoleRow()],
          rowCount: 1,
        };
      }

      if (text.includes('FROM ingestion_private.snapshot')) {
        return {
          rows: [],
          rowCount: 0,
        };
      }

      if (text.includes('INSERT INTO ingestion_private.snapshot')) {
        return {
          rows: [],
          rowCount: 1,
        };
      }

      if (text.includes('INSERT INTO ingestion_private.professional_profile')) {
        throw new Error('synthetic batch failure');
      }

      return {
        rows: [],
        rowCount: 0,
      };
    });

    await expect(
      importPreparedPrivateDirectorySnapshot(failedBatchConnection, snapshot),
    ).rejects.toThrow('synthetic batch failure');
    expect(failedBatchConnection.calls.at(-1)?.text).toBe('ROLLBACK');
  });
});

it('pins the test fixture hash to the exact bytes written', async () => {
  const fixture = await createSnapshotFixture();
  const manifestBytes = await readFile(fixture.manifestPath);

  expect(sha256(manifestBytes)).toBe(fixture.manifestSha256);
});
