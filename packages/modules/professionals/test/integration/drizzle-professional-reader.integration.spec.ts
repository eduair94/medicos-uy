import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DrizzleApprovedEvidenceReader } from '../../../provenance/src/infrastructure/persistence/drizzle/drizzle-approved-evidence-reader';
import {
  evidenceClaimTable,
  evidenceRefTable,
  sourceReleaseTable,
  sourceTable,
} from '../../../provenance/src/infrastructure/persistence/drizzle/provenance.schema';
import { InvalidProfessionalCursorError } from '../../src/application/errors/professional-query.error';
import { DrizzleProfessionalReader } from '../../src/infrastructure/persistence/drizzle/drizzle-professional-reader';
import {
  professionalRouteTable,
  professionalTable,
} from '../../src/infrastructure/persistence/drizzle/professional.schema';

import type { CatalogDatabase } from '@medicos/database';

const describeWithDocker =
  process.env['RUN_INTEGRATION_TESTS'] === 'true' ? describe : describe.skip;

describeWithDocker('DrizzleProfessionalReader', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let database: CatalogDatabase;
  let reader: DrizzleProfessionalReader;
  let evidenceReader: DrizzleApprovedEvidenceReader;

  const sourceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7101';
  const releaseId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7102';
  const evidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7103';
  const evidencePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7103';
  const revokedEvidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7107';
  const revokedEvidencePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7107';
  const pendingEvidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7109';
  const pendingEvidencePublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7109';
  const anaId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7104';
  const anaPublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7104';
  const beatrizId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7105';
  const beatrizPublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7105';
  const hiddenId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7106';
  const hiddenPublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7106';
  const revokedProfessionalId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7108';
  const revokedProfessionalPublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7108';
  const pendingProfessionalId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7110';
  const pendingProfessionalPublicId = '11985bb6-9fd8-75e3-84a7-b9f81fbe7110';

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
    database = drizzle(pool, {
      casing: 'snake_case',
    });

    await migrate(database, {
      migrationsFolder: resolve(process.cwd(), 'drizzle/catalog/migrations'),
    });

    const now = new Date();
    await database.insert(sourceTable).values({
      id: sourceId,
      name: 'Synthetic contract source',
      canonicalUrl: 'https://example.invalid/source',
      sourceKind: 'GOVERNMENT_OPEN_DATA',
      publicationState: 'APPROVED',
      purposeCompatibility: 'COMPATIBLE',
      reuseBasis: 'OPEN_DATA_LICENSE',
      licenseUrl: 'https://example.invalid/license',
      publicationPolicyId: 'synthetic-integration-policy-v1',
      publicationReviewedBy: 'Integration test',
      publicationReviewedAt: now,
      publicationReviewReference: 'Synthetic integration approval',
      publicationValidUntil: new Date('2099-01-01T00:00:00.000Z'),
    });
    await database.insert(sourceReleaseTable).values({
      id: releaseId,
      sourceId,
      upstreamReleaseKey: 'contract-test',
      cutoffDate: '2026-07-01',
      retrievedAt: now,
      sha256: '1'.repeat(64),
    });
    await database.insert(evidenceRefTable).values({
      id: evidenceId,
      publicId: evidencePublicId,
      sourceReleaseId: releaseId,
      canonicalUrl: 'https://example.invalid/source',
      observedAt: now,
      checksum: '1'.repeat(64),
      attribution: 'Synthetic contract fixture',
      publicationState: 'APPROVED',
      confidence: 'DETERMINISTIC',
      validUntil: new Date('2099-01-01T00:00:00.000Z'),
    });
    await database.insert(evidenceRefTable).values({
      id: revokedEvidenceId,
      publicId: revokedEvidencePublicId,
      sourceReleaseId: releaseId,
      canonicalUrl: 'https://example.invalid/revoked-source',
      observedAt: now,
      checksum: '2'.repeat(64),
      attribution: 'Synthetic revoked fixture',
      publicationState: 'REVOKED',
      confidence: 'DETERMINISTIC',
    });
    await database.insert(evidenceRefTable).values({
      id: pendingEvidenceId,
      publicId: pendingEvidencePublicId,
      sourceReleaseId: releaseId,
      canonicalUrl: 'https://example.invalid/pending-source',
      observedAt: now,
      checksum: '3'.repeat(64),
      attribution: 'Synthetic pending fixture',
      confidence: 'DETERMINISTIC',
    });
    await database.insert(professionalTable).values([
      {
        id: anaId,
        publicId: anaPublicId,
        displayName: 'Ana Pérez',
        normalizedName: 'ana perez',
        visibility: 'PUBLIC',
        currentNameEvidenceId: evidenceId,
      },
      {
        id: beatrizId,
        publicId: beatrizPublicId,
        displayName: 'Beatriz Silva',
        normalizedName: 'beatriz silva',
        visibility: 'PUBLIC',
        currentNameEvidenceId: evidenceId,
      },
      {
        id: hiddenId,
        publicId: hiddenPublicId,
        displayName: 'Persona Suprimida',
        normalizedName: 'persona suprimida',
        visibility: 'SUPPRESSED',
        currentNameEvidenceId: evidenceId,
      },
      {
        id: revokedProfessionalId,
        publicId: revokedProfessionalPublicId,
        displayName: 'Persona con evidencia revocada',
        normalizedName: 'persona con evidencia revocada',
        visibility: 'PUBLIC',
        currentNameEvidenceId: revokedEvidenceId,
      },
      {
        id: pendingProfessionalId,
        publicId: pendingProfessionalPublicId,
        displayName: 'Persona con evidencia pendiente',
        normalizedName: 'persona con evidencia pendiente',
        visibility: 'PUBLIC',
        currentNameEvidenceId: pendingEvidenceId,
      },
    ]);
    await database.insert(evidenceClaimTable).values([
      {
        evidenceId,
        subjectId: anaId,
        claimKind: 'PROFESSIONAL_NAME',
        normalizedValue: 'ana perez',
      },
      {
        evidenceId,
        subjectId: beatrizId,
        claimKind: 'PROFESSIONAL_NAME',
        normalizedValue: 'beatriz silva',
      },
      {
        evidenceId,
        subjectId: hiddenId,
        claimKind: 'PROFESSIONAL_NAME',
        normalizedValue: 'persona suprimida',
      },
      {
        evidenceId: revokedEvidenceId,
        subjectId: revokedProfessionalId,
        claimKind: 'PROFESSIONAL_NAME',
        normalizedValue: 'persona con evidencia revocada',
      },
      {
        evidenceId: pendingEvidenceId,
        subjectId: pendingProfessionalId,
        claimKind: 'PROFESSIONAL_NAME',
        normalizedValue: 'persona con evidencia pendiente',
      },
    ]);
    await database.insert(professionalRouteTable).values([
      {
        slug: 'ana-perez',
        professionalId: anaId,
        routeKind: 'CURRENT',
      },
      {
        slug: 'ana-perez-anterior',
        professionalId: anaId,
        routeKind: 'REDIRECT',
      },
      {
        slug: 'beatriz-silva',
        professionalId: beatrizId,
        routeKind: 'CURRENT',
      },
      {
        slug: 'persona-suprimida',
        professionalId: hiddenId,
        routeKind: 'CURRENT',
      },
      {
        slug: 'persona-evidencia-revocada',
        professionalId: revokedProfessionalId,
        routeKind: 'CURRENT',
      },
      {
        slug: 'persona-evidencia-pendiente',
        professionalId: pendingProfessionalId,
        routeKind: 'CURRENT',
      },
    ]);

    reader = new DrizzleProfessionalReader(database);
    evidenceReader = new DrizzleApprovedEvidenceReader(database);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('returns only public professionals with keyset pagination', async () => {
    const firstPage = await reader.searchPublic({
      limit: 1,
    });

    expect(firstPage.items).toEqual([
      {
        id: anaPublicId,
        slug: 'ana-perez',
        displayName: 'Ana Pérez',
      },
    ]);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const nextCursor = firstPage.nextCursor;

    if (nextCursor === undefined) {
      throw new Error('Expected the first page to contain a next cursor.');
    }

    const secondPage = await reader.searchPublic({
      limit: 1,
      cursor: nextCursor,
    });
    expect(secondPage.items).toEqual([
      {
        id: beatrizPublicId,
        slug: 'beatriz-silva',
        displayName: 'Beatriz Silva',
      },
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('resolves current and historical slugs to the current public route', async () => {
    await expect(reader.findPublicByIdOrSlug('ana-perez-anterior')).resolves.toEqual({
      id: anaPublicId,
      slug: 'ana-perez',
      displayName: 'Ana Pérez',
      currentNameEvidenceId: evidencePublicId,
    });
    await expect(reader.findPublicByIdOrSlug(anaPublicId)).resolves.toEqual({
      id: anaPublicId,
      slug: 'ana-perez',
      displayName: 'Ana Pérez',
      currentNameEvidenceId: evidencePublicId,
    });
  });

  it('does not expose suppressed professionals or professionals with revoked evidence', async () => {
    await expect(reader.findPublicByIdOrSlug('persona-suprimida')).resolves.toBeUndefined();
    await expect(
      reader.findPublicByIdOrSlug('persona-evidencia-revocada'),
    ).resolves.toBeUndefined();
    await expect(
      reader.findPublicByIdOrSlug('persona-evidencia-pendiente'),
    ).resolves.toBeUndefined();
  });

  it('returns only the safe approved-evidence projection', async () => {
    await expect(evidenceReader.findApprovedById(evidencePublicId)).resolves.toMatchObject({
      confidence: 'DETERMINISTIC',
      source: {
        kind: 'GOVERNMENT_OPEN_DATA',
        name: 'Synthetic contract source',
        canonicalUrl: 'https://example.invalid/source',
        licenseUrl: 'https://example.invalid/license',
        reuseBasis: 'OPEN_DATA_LICENSE',
        policyId: 'synthetic-integration-policy-v1',
      },
      canonicalUrl: 'https://example.invalid/source',
      sourceCutoffDate: '2026-07-01',
      attribution: 'Synthetic contract fixture',
    });
    await expect(evidenceReader.findApprovedById(revokedEvidencePublicId)).resolves.toBeUndefined();
    await expect(evidenceReader.findApprovedById(pendingEvidencePublicId)).resolves.toBeUndefined();
  });

  it('rejects a professional name without an existing evidence reference', async () => {
    await expect(
      database.insert(professionalTable).values({
        id: '01985bb6-9fd8-75e3-84a7-b9f81fbe7199',
        displayName: 'Fixture inválido',
        normalizedName: 'fixture invalido',
        visibility: 'PUBLIC',
        currentNameEvidenceId: '01985bb6-9fd8-75e3-84a7-b9f81fbe7198',
      }),
    ).rejects.toMatchObject({
      cause: {
        code: '23503',
      },
    });
  });

  it('rejects evidence and professionals that reuse their internal id as public id', async () => {
    const reusedEvidenceId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7196';
    const reusedProfessionalId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7197';

    await expect(
      pool.query(
        `
          insert into provenance.evidence_ref (
            id,
            public_id,
            source_release_id,
            canonical_url,
            observed_at,
            checksum,
            attribution
          ) values ($1, $1, $2, $3, now(), $4, $5)
        `,
        [
          reusedEvidenceId,
          releaseId,
          'https://example.invalid/invalid-equal-id-evidence',
          '8'.repeat(64),
          'Invalid equal-id evidence',
        ],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ck_evidence_ref_distinct_public_id',
    });

    await expect(
      pool.query(
        `
          insert into catalog.professional (
            id,
            public_id,
            display_name,
            normalized_name,
            visibility,
            current_name_evidence_id
          ) values ($1, $1, $2, $3, 'SUPPRESSED', $4)
        `,
        [reusedProfessionalId, 'Invalid Equal ID', 'invalid equal id', evidenceId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'ck_professional_distinct_public_id',
    });
  });

  it('keeps evidence and professional public ids immutable after creation', async () => {
    await expect(
      pool.query('update provenance.evidence_ref set public_id = $1 where id = $2', [
        '21985bb6-9fd8-75e3-84a7-b9f81fbe7103',
        evidenceId,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'public_id is immutable',
    });
    await expect(
      pool.query('update catalog.professional set public_id = $1 where id = $2', [
        '21985bb6-9fd8-75e3-84a7-b9f81fbe7104',
        anaId,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'public_id is immutable',
    });

    const [storedEvidence, storedProfessional] = await Promise.all([
      pool.query<{ readonly public_id: string }>(
        'select public_id from provenance.evidence_ref where id = $1',
        [evidenceId],
      ),
      pool.query<{ readonly public_id: string }>(
        'select public_id from catalog.professional where id = $1',
        [anaId],
      ),
    ]);

    expect(storedEvidence.rows[0]?.public_id).toBe(evidencePublicId);
    expect(storedProfessional.rows[0]?.public_id).toBe(anaPublicId);
  });

  it('gives the public role access only to sanitized projections', async () => {
    const client = await pool.connect();

    try {
      await client.query('set role medicos_catalog_reader');
      const publicProfessionals = await client.query<{ readonly id: string }>(
        'select id from catalog.public_professional order by normalized_name limit 1',
      );
      expect(publicProfessionals.rows).toEqual([
        {
          id: anaPublicId,
        },
      ]);
      expect(publicProfessionals.rows[0]?.id).not.toBe(anaId);
      await expect(
        client.query('select slug from catalog.public_professional_route limit 1'),
      ).resolves.toBeDefined();
      await expect(
        client.query('select evidence_id from provenance.public_evidence_ref limit 1'),
      ).resolves.toBeDefined();
      await expect(
        client.query('select id from catalog.professional limit 1'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        client.query('select id from provenance.evidence_claim limit 1'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        client.query('create table catalog.forbidden_public_table (id integer)'),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.query('reset role');
      client.release();
    }
  });

  it('rejects an invalid cursor instead of silently restarting pagination', async () => {
    await expect(
      reader.searchPublic({
        limit: 20,
        cursor: 'invalid',
      }),
    ).rejects.toBeInstanceOf(InvalidProfessionalCursorError);
  });
});
