import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DrizzleProfessionalCredentialsReader } from '../../src/infrastructure/persistence/drizzle/drizzle-professional-credentials-reader';

import type { CatalogDatabase } from '@medicos/database';

const describeWithDocker =
  process.env['RUN_INTEGRATION_TESTS'] === 'true' ? describe : describe.skip;

describeWithDocker('DrizzleProfessionalCredentialsReader', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let reader: DrizzleProfessionalCredentialsReader;

  const sourceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7201';
  const releaseId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7202';
  const evidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7203';
  const evidencePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7203';
  const professionalId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7204';
  const professionalPublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7204';
  const enabledTitleId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7205';
  const enabledTitlePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7205';
  const disabledTitleId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7206';
  const dataSubjectSourceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7211';
  const dataSubjectReleaseId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7212';
  const dataSubjectEvidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7213';
  const dataSubjectEvidencePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7213';
  const dataSubjectTitleId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7214';
  const dataSubjectTitlePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7214';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('medicos_test')
      .withUsername('medicos')
      .withPassword('medicos_test')
      .start();
    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });
    await pool.query(`
      create role medicos_catalog_reader
        nologin
        nosuperuser
        nocreatedb
        nocreaterole
        noreplication
    `);
    await pool.query(`
      create role medicos_private_ingestor
        nologin
        noinherit
        nosuperuser
        nocreatedb
        nocreaterole
        noreplication
        nobypassrls
    `);
    const database: CatalogDatabase = drizzle(pool, {
      casing: 'snake_case',
    });
    await migrate(database, {
      migrationsFolder: resolve(process.cwd(), 'drizzle/catalog/migrations'),
    });
    await pool.query(
      `
        insert into provenance.source (
          id,
          name,
          canonical_url,
          source_kind,
          publication_state,
          purpose_compatibility,
          reuse_basis,
          license_url,
          publication_policy_id,
          publication_reviewed_by,
          publication_reviewed_at,
          publication_review_reference,
          publication_valid_until
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12)
      `,
      [
        sourceId,
        'Synthetic approved source',
        'https://example.invalid/source',
        'GOVERNMENT_OPEN_DATA',
        'APPROVED',
        'COMPATIBLE',
        'OPEN_DATA_LICENSE',
        'https://example.invalid/license',
        'synthetic-integration-policy-v1',
        'Integration test',
        'Synthetic integration approval',
        '2099-01-01T00:00:00.000Z',
      ],
    );
    await pool.query(
      `
        insert into provenance.source_release (
          id,
          source_id,
          upstream_release_key,
          cutoff_date,
          retrieved_at,
          sha256
        ) values ($1, $2, $3, $4, now(), $5)
      `,
      [releaseId, sourceId, 'synthetic-release', '2026-07-01', '1'.repeat(64)],
    );
    await pool.query(
      `
        insert into provenance.evidence_ref (
          id,
          public_id,
          source_release_id,
          canonical_url,
          observed_at,
          checksum,
          attribution,
          publication_state,
          confidence,
          valid_until
        ) values ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)
      `,
      [
        evidenceId,
        evidencePublicId,
        releaseId,
        'https://example.invalid/source',
        '2'.repeat(64),
        'Synthetic title evidence',
        'APPROVED',
        'DETERMINISTIC',
        '2099-01-01T00:00:00.000Z',
      ],
    );
    await pool.query(
      `
        insert into catalog.professional (
          id,
          public_id,
          display_name,
          normalized_name,
          visibility,
          current_name_evidence_id
        ) values ($1, $2, $3, $4, $5, $6)
      `,
      [professionalId, professionalPublicId, 'Ana Example', 'ana example', 'PUBLIC', evidenceId],
    );
    await pool.query(
      `
        insert into catalog.professional_route (slug, professional_id, route_kind)
        values ($1, $2, $3)
      `,
      ['ana-example', professionalId, 'CURRENT'],
    );
    await pool.query(
      `
        insert into credentials.registered_title (
          id,
          public_id,
          professional_id,
          title,
          normalized_title,
          registration_state,
          temporary_registration,
          current_evidence_id
        ) values
          ($1, $2, $3, $4, $5, $6, $7, $8),
          ($9, default, $3, $10, $11, $12, $7, $8)
      `,
      [
        enabledTitleId,
        enabledTitlePublicId,
        professionalId,
        'Doctor en Medicina',
        'doctor en medicina',
        'ENABLED',
        'NONE',
        evidenceId,
        disabledTitleId,
        'Former synthetic title',
        'former synthetic title',
        'DISABLED',
      ],
    );
    await pool.query(
      `
        insert into provenance.evidence_claim (
          evidence_id,
          subject_id,
          claim_kind,
          normalized_value
        ) values
          ($1, $2, 'PROFESSIONAL_NAME', $3),
          ($1, $2, 'REGISTERED_TITLE', $4)
      `,
      [evidenceId, professionalId, 'ana example', 'doctor en medicina'],
    );
    await pool.query(
      `
        insert into provenance.source (
          id,
          name,
          canonical_url,
          source_kind,
          publication_state,
          purpose_compatibility,
          reuse_basis,
          publication_policy_id,
          publication_reviewed_by,
          publication_reviewed_at,
          publication_review_reference,
          publication_valid_until
        ) values (
          $1,
          $2,
          $3,
          'DATA_SUBJECT_CLAIM',
          'APPROVED',
          'COMPATIBLE',
          'DATA_SUBJECT_CONSENT',
          $4,
          $5,
          now(),
          $6,
          $7
        )
      `,
      [
        dataSubjectSourceId,
        'Synthetic data-subject source',
        'https://example.invalid/data-subject-claim',
        'synthetic-data-subject-policy-v1',
        'Integration test',
        'Synthetic data-subject approval',
        '2099-01-01T00:00:00.000Z',
      ],
    );
    await pool.query(
      `
        insert into provenance.source_release (
          id,
          source_id,
          upstream_release_key,
          cutoff_date,
          retrieved_at,
          sha256
        ) values ($1, $2, $3, $4, now(), $5)
      `,
      [
        dataSubjectReleaseId,
        dataSubjectSourceId,
        'synthetic-data-subject-release',
        '2026-07-01',
        '3'.repeat(64),
      ],
    );
    await pool.query(
      `
        insert into provenance.evidence_ref (
          id,
          public_id,
          source_release_id,
          canonical_url,
          observed_at,
          checksum,
          attribution,
          publication_state,
          confidence,
          valid_until
        ) values ($1, $2, $3, $4, now(), $5, $6, 'APPROVED', 'HUMAN_VERIFIED', $7)
      `,
      [
        dataSubjectEvidenceId,
        dataSubjectEvidencePublicId,
        dataSubjectReleaseId,
        'https://example.invalid/data-subject-claim',
        '4'.repeat(64),
        'Synthetic data-subject title evidence',
        '2099-01-01T00:00:00.000Z',
      ],
    );
    await pool.query(
      `
        insert into credentials.registered_title (
          id,
          public_id,
          professional_id,
          title,
          normalized_title,
          registration_state,
          temporary_registration,
          current_evidence_id
        ) values ($1, $2, $3, $4, $5, 'ENABLED', 'NONE', $6)
      `,
      [
        dataSubjectTitleId,
        dataSubjectTitlePublicId,
        professionalId,
        'Claimed credential',
        'claimed credential',
        dataSubjectEvidenceId,
      ],
    );
    await pool.query(
      `
        insert into provenance.evidence_claim (
          evidence_id,
          subject_id,
          claim_kind,
          normalized_value
        ) values ($1, $2, 'REGISTERED_TITLE', $3)
      `,
      [dataSubjectEvidenceId, professionalId, 'claimed credential'],
    );

    reader = new DrizzleProfessionalCredentialsReader(database);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('returns only enabled titles backed by currently publishable evidence', async () => {
    await expect(reader.findPublicByProfessionalId(professionalPublicId)).resolves.toEqual([
      {
        id: enabledTitlePublicId,
        title: 'Doctor en Medicina',
        temporaryRegistration: 'NONE',
        evidenceId: evidencePublicId,
      },
    ]);
  });

  it('does not publish a title backed by a data-subject claim', async () => {
    const internalTitle = await pool.query<{ readonly public_id: string }>(
      'select public_id from credentials.registered_title where id = $1',
      [dataSubjectTitleId],
    );
    const publicTitle = await pool.query<{ readonly id: string }>(
      'select id from credentials.public_registered_title where id = $1',
      [dataSubjectTitlePublicId],
    );

    expect(internalTitle.rows).toEqual([
      {
        public_id: dataSubjectTitlePublicId,
      },
    ]);
    expect(publicTitle.rows).toEqual([]);
  });

  it('rejects a registered title that reuses its internal id as public id', async () => {
    const reusedId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7297';

    await expect(
      pool.query(
        `
          insert into credentials.registered_title (
            id,
            public_id,
            professional_id,
            title,
            normalized_title,
            registration_state,
            temporary_registration,
            current_evidence_id
          ) values ($1, $1, $2, $3, $4, 'DISABLED', 'NONE', $5)
        `,
        [reusedId, professionalId, 'Invalid equal-id title', 'invalid equal-id title', evidenceId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ck_registered_title_distinct_public_id',
    });
  });

  it('keeps a registered title public id immutable after creation', async () => {
    await expect(
      pool.query('update credentials.registered_title set public_id = $1 where id = $2', [
        '21985bb6-9fd8-75e3-84a7-b9f81fbe7205',
        enabledTitleId,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'public_id is immutable',
    });

    const storedTitle = await pool.query<{ readonly public_id: string }>(
      'select public_id from credentials.registered_title where id = $1',
      [enabledTitleId],
    );
    expect(storedTitle.rows[0]?.public_id).toBe(enabledTitlePublicId);
  });

  it('requires evidence to claim the exact professional, field and normalized value', async () => {
    await pool.query(
      `
        update provenance.evidence_claim
        set normalized_value = 'different title'
        where evidence_id = $1 and claim_kind = 'REGISTERED_TITLE'
      `,
      [evidenceId],
    );

    await expect(reader.findPublicByProfessionalId(professionalPublicId)).resolves.toBeUndefined();

    await pool.query(
      `
        update provenance.evidence_claim
        set normalized_value = 'doctor en medicina'
        where evidence_id = $1 and claim_kind = 'REGISTERED_TITLE'
      `,
      [evidenceId],
    );
  });

  it('withdraws the title when the source approval is revoked', async () => {
    await pool.query(`update provenance.source set publication_state = 'REVOKED' where id = $1`, [
      sourceId,
    ]);

    await expect(reader.findPublicByProfessionalId(professionalPublicId)).resolves.toBeUndefined();
  });

  it('allows the public role to read only the sanitized title view', async () => {
    const client = await pool.connect();

    try {
      await client.query('set role medicos_catalog_reader');
      await expect(
        client.query('select title from credentials.public_registered_title'),
      ).resolves.toBeDefined();
      await expect(
        client.query('select title from credentials.registered_title'),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.query('reset role');
      client.release();
    }
  });

  it('keeps the manually managed cross-module foreign keys in the migration', async () => {
    const constraints = await pool.query<{ readonly conname: string }>(
      `
        select conname
        from pg_constraint
        where conname = any($1::text[])
        order by conname
      `,
      [
        [
          'evidence_claim_subject_id_professional_id_fk',
          'registered_title_current_evidence_id_evidence_ref_id_fk',
          'registered_title_professional_id_professional_id_fk',
        ],
      ],
    );

    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      'evidence_claim_subject_id_professional_id_fk',
      'registered_title_current_evidence_id_evidence_ref_id_fk',
      'registered_title_professional_id_professional_id_fk',
    ]);
  });
});
