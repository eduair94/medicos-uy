import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const MSP_DATASET_URL =
  'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos';
const MSP_LIVE_LOOKUP_URL =
  'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud';
const REVIEWED_BY = 'Synthetic integration reviewer';

const SNAPSHOT_A = 'factual-v3-aaaaaaaaaaaaaaaa';
const SNAPSHOT_B = 'factual-v3-bbbbbbbbbbbbbbbb';
const SNAPSHOT_C = 'factual-v3-cccccccccccccccc';

const AUTO_HMAC_ID = `msp_doc_v1_${'a'.repeat(64)}`;
const MANUAL_HMAC_ID = `msp_doc_v1_${'b'.repeat(64)}`;
const MODERATED_HMAC_ID = `msp_doc_v1_${'c'.repeat(64)}`;
const PINNED_HMAC_ID = `msp_doc_v1_${'d'.repeat(64)}`;
const NEWER_HMAC_ID = `msp_doc_v1_${'e'.repeat(64)}`;

interface SyntheticTitle {
  readonly title: string;
  readonly temporaryRegistration: 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT';
}

interface SyntheticProfile {
  readonly internalHmacId: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly registeredTitles: readonly SyntheticTitle[];
  readonly recordSha256: string;
}

interface ProjectionRow {
  readonly snapshot_id: string;
  readonly projected_professionals: string;
  readonly suppressed_professionals: string;
  readonly enabled_registered_titles: string;
}

interface ProjectionCounts {
  readonly sources: number;
  readonly releases: number;
  readonly evidence: number;
  readonly claims: number;
  readonly professionals: number;
  readonly routes: number;
  readonly titles: number;
  readonly identities: number;
  readonly evidenceIdentities: number;
  readonly titleIdentities: number;
}

const describeWithDocker =
  process.env['RUN_INTEGRATION_TESTS'] === 'true' ? describe : describe.skip;

function syntheticTitle(
  title: string,
  temporaryRegistration: SyntheticTitle['temporaryRegistration'] = 'NONE',
): SyntheticTitle {
  return {
    title,
    temporaryRegistration,
  };
}

describeWithDocker('catalog.refresh_msp_public_projection', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let sourceCutoffDate: string;

  beforeAll(async () => {
    // Production server 104 currently runs PostgreSQL 17.
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('medicos_projection_test')
      .withUsername('medicos')
      .withPassword('medicos_projection_test')
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

    const database = drizzle(pool, {
      casing: 'snake_case',
    });
    await migrate(database, {
      migrationsFolder: resolve(process.cwd(), 'drizzle/catalog/migrations'),
    });

    const cutoff = await pool.query<{ readonly cutoff_date: string }>(
      'select (current_date - 1)::text as cutoff_date',
    );
    const row = cutoff.rows[0];

    if (row === undefined) {
      throw new Error('PostgreSQL did not return a synthetic MSP cutoff date');
    }

    sourceCutoffDate = row.cutoff_date;
  });

  beforeEach(async () => {
    await pool.query(`
      truncate table
        provenance.evidence_claim,
        catalog.professional_route,
        credentials.registered_title,
        catalog.professional,
        provenance.evidence_ref,
        provenance.source_release,
        provenance.source,
        ingestion_private.msp_catalog_evidence_identity,
        ingestion_private.msp_catalog_title_identity,
        ingestion_private.msp_catalog_identity,
        ingestion_private.msp_catalog_source,
        ingestion_private.professional_profile,
        ingestion_private.snapshot
      restart identity cascade
    `);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function seedSnapshot(
    snapshotId: string,
    profiles: readonly SyntheticProfile[],
    importedAt: Date,
    snapshotHashCharacter: string,
  ): Promise<void> {
    await pool.query(
      `insert into ingestion_private.snapshot (
        snapshot_id,
        manifest_sha256,
        profiles_sha256,
        profile_count,
        source_generated_at,
        imported_at
      ) values ($1, $2, $3, $4, $5, $6)`,
      [
        snapshotId,
        snapshotHashCharacter.repeat(64),
        snapshotHashCharacter.repeat(64),
        profiles.length,
        new Date(importedAt.getTime() - 60_000),
        importedAt,
      ],
    );

    for (const profile of profiles) {
      await pool.query(
        `insert into ingestion_private.professional_profile (
          snapshot_id,
          internal_hmac_id,
          display_name,
          normalized_name,
          registered_titles,
          official_registry,
          record_sha256
        ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [
          snapshotId,
          profile.internalHmacId,
          profile.displayName,
          profile.normalizedName,
          JSON.stringify(profile.registeredTitles),
          JSON.stringify({
            publisher: 'Ministerio de Salud Pública',
            dataset: 'Infotítulos',
            sourceCutoffDate,
            datasetUrl: MSP_DATASET_URL,
            liveLookupUrl: MSP_LIVE_LOOKUP_URL,
          }),
          profile.recordSha256,
        ],
      );
    }
  }

  async function projectSnapshot(snapshotId: string, reviewedAt: Date): Promise<ProjectionRow> {
    const connection = await pool.connect();

    try {
      await connection.query('begin isolation level serializable');
      await connection.query('set local role medicos_private_ingestor');
      const projection = await connection.query<ProjectionRow>(
        `select
          snapshot_id,
          projected_professionals::text,
          suppressed_professionals::text,
          enabled_registered_titles::text
        from catalog.refresh_msp_public_projection($1, $2, $3, $4)`,
        [REVIEWED_BY, MSP_DATASET_URL, snapshotId, reviewedAt],
      );
      const row = projection.rows[0];

      if (projection.rowCount !== 1 || row === undefined) {
        throw new Error('MSP projection did not return exactly one row');
      }

      await connection.query('commit');

      await connection.query('set role medicos_private_ingestor');
      try {
        await connection.query('select catalog.analyze_msp_public_projection()');
      } finally {
        await connection.query('reset role');
      }

      return row;
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  }

  async function projectionCounts(): Promise<ProjectionCounts> {
    const result = await pool.query<ProjectionCounts>(`
      select
        (select count(*)::integer from provenance.source) as sources,
        (select count(*)::integer from provenance.source_release) as releases,
        (select count(*)::integer from provenance.evidence_ref) as evidence,
        (select count(*)::integer from provenance.evidence_claim) as claims,
        (select count(*)::integer from catalog.professional) as professionals,
        (select count(*)::integer from catalog.professional_route) as routes,
        (select count(*)::integer from credentials.registered_title) as titles,
        (select count(*)::integer from ingestion_private.msp_catalog_identity) as identities,
        (
          select count(*)::integer
          from ingestion_private.msp_catalog_evidence_identity
        ) as "evidenceIdentities",
        (
          select count(*)::integer
          from ingestion_private.msp_catalog_title_identity
        ) as "titleIdentities"
    `);
    const row = result.rows[0];

    if (row === undefined) {
      throw new Error('PostgreSQL did not return projection counts');
    }

    return row;
  }

  it('projects only the pinned snapshot, records the exact review and is idempotent', async () => {
    const now = Date.now();
    const olderImportedAt = new Date(now - 20 * 60_000);
    const newerImportedAt = new Date(now - 10 * 60_000);
    const reviewedAt = new Date(now - 5 * 60_000);

    await seedSnapshot(
      SNAPSHOT_A,
      [
        {
          internalHmacId: PINNED_HMAC_ID,
          displayName: 'Perfil Fijado',
          normalizedName: 'perfil fijado',
          registeredTitles: [syntheticTitle('Medicina General')],
          recordSha256: '1'.repeat(64),
        },
      ],
      olderImportedAt,
      'a',
    );
    await seedSnapshot(
      SNAPSHOT_B,
      [
        {
          internalHmacId: NEWER_HMAC_ID,
          displayName: 'Perfil Más Nuevo No Aprobado',
          normalizedName: 'perfil mas nuevo no aprobado',
          registeredTitles: [syntheticTitle('Cardiología')],
          recordSha256: '2'.repeat(64),
        },
      ],
      newerImportedAt,
      'b',
    );

    await expect(projectSnapshot(SNAPSHOT_A, reviewedAt)).resolves.toEqual({
      snapshot_id: SNAPSHOT_A,
      projected_professionals: '1',
      suppressed_professionals: '0',
      enabled_registered_titles: '1',
    });

    const firstIdentity = await pool.query<{
      readonly professional_id: string;
      readonly professional_public_id: string;
      readonly route_slug: string;
      readonly registered_title_id: string;
      readonly registered_title_public_id: string;
      readonly evidence_id: string;
      readonly evidence_public_id: string;
    }>(
      `
      select
        identity.professional_id::text,
        identity.professional_public_id::text,
        identity.route_slug,
        title_identity.registered_title_id::text,
        title_identity.registered_title_public_id::text,
        evidence_identity.evidence_id::text,
        evidence_identity.evidence_public_id::text
      from ingestion_private.msp_catalog_identity as identity
      inner join ingestion_private.msp_catalog_title_identity as title_identity
        on title_identity.internal_hmac_id = identity.internal_hmac_id
      inner join ingestion_private.msp_catalog_evidence_identity as evidence_identity
        on evidence_identity.internal_hmac_id = identity.internal_hmac_id
        and evidence_identity.snapshot_id = $1
    `,
      [SNAPSHOT_A],
    );
    const firstCounts = await projectionCounts();

    expect(firstIdentity.rows).toHaveLength(1);
    expect(firstCounts).toEqual({
      sources: 1,
      releases: 1,
      evidence: 1,
      claims: 2,
      professionals: 1,
      routes: 1,
      titles: 1,
      identities: 1,
      evidenceIdentities: 1,
      titleIdentities: 1,
    });

    const analyzedRelations = await pool.query<{
      readonly estimatedRows: number;
      readonly relationName: string;
    }>(`
      select
        namespace.nspname || '.' || relation.relname as "relationName",
        relation.reltuples::integer as "estimatedRows"
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where (namespace.nspname, relation.relname) in (
        ('catalog', 'professional'),
        ('catalog', 'professional_route'),
        ('credentials', 'registered_title'),
        ('provenance', 'evidence_ref'),
        ('provenance', 'evidence_claim')
      )
      order by "relationName"
    `);
    expect(analyzedRelations.rows).toEqual([
      { estimatedRows: 1, relationName: 'catalog.professional' },
      { estimatedRows: 1, relationName: 'catalog.professional_route' },
      { estimatedRows: 1, relationName: 'credentials.registered_title' },
      { estimatedRows: 2, relationName: 'provenance.evidence_claim' },
      { estimatedRows: 1, relationName: 'provenance.evidence_ref' },
    ]);

    const statisticsPrivileges = await pool.query<{
      readonly catalogReaderCanExecute: boolean;
      readonly ingestorCanExecute: boolean;
      readonly ingestorHasMaintain: boolean;
    }>(`
      select
        pg_catalog.has_function_privilege(
          'medicos_catalog_reader',
          'catalog.analyze_msp_public_projection()',
          'EXECUTE'
        ) as "catalogReaderCanExecute",
        pg_catalog.has_function_privilege(
          'medicos_private_ingestor',
          'catalog.analyze_msp_public_projection()',
          'EXECUTE'
        ) as "ingestorCanExecute",
        pg_catalog.has_table_privilege(
          'medicos_private_ingestor',
          'catalog.professional',
          'MAINTAIN'
        ) as "ingestorHasMaintain"
    `);
    expect(statisticsPrivileges.rows[0]).toEqual({
      catalogReaderCanExecute: false,
      ingestorCanExecute: true,
      ingestorHasMaintain: false,
    });

    const publicProfessionals = await pool.query<{ readonly display_name: string }>(
      'select display_name from catalog.public_professional order by display_name',
    );
    expect(publicProfessionals.rows).toEqual([{ display_name: 'Perfil Fijado' }]);

    const source = await pool.query<{
      readonly publication_reviewed_at: Date;
      readonly publication_state: string;
    }>(
      `select publication_reviewed_at, publication_state
       from provenance.source`,
    );
    expect(source.rows[0]?.publication_state).toBe('APPROVED');
    expect(source.rows[0]?.publication_reviewed_at.toISOString()).toBe(reviewedAt.toISOString());

    await expect(projectSnapshot(SNAPSHOT_A, reviewedAt)).resolves.toEqual({
      snapshot_id: SNAPSHOT_A,
      projected_professionals: '1',
      suppressed_professionals: '0',
      enabled_registered_titles: '1',
    });

    const secondIdentity = await pool.query<{
      readonly professional_id: string;
      readonly professional_public_id: string;
      readonly route_slug: string;
      readonly registered_title_id: string;
      readonly registered_title_public_id: string;
      readonly evidence_id: string;
      readonly evidence_public_id: string;
    }>(
      `select
        identity.professional_id::text,
        identity.professional_public_id::text,
        identity.route_slug,
        title_identity.registered_title_id::text,
        title_identity.registered_title_public_id::text,
        evidence_identity.evidence_id::text,
        evidence_identity.evidence_public_id::text
      from ingestion_private.msp_catalog_identity as identity
      inner join ingestion_private.msp_catalog_title_identity as title_identity
        on title_identity.internal_hmac_id = identity.internal_hmac_id
      inner join ingestion_private.msp_catalog_evidence_identity as evidence_identity
        on evidence_identity.internal_hmac_id = identity.internal_hmac_id
        and evidence_identity.snapshot_id = $1`,
      [SNAPSHOT_A],
    );

    expect(secondIdentity.rows).toEqual(firstIdentity.rows);
    await expect(projectionCounts()).resolves.toEqual(firstCounts);
  });

  it('fails closed and rolls back every attempted change while the source is pending', async () => {
    const now = Date.now();
    const firstReviewedAt = new Date(now - 10 * 60_000);
    const rejectedReviewedAt = new Date(now - 5 * 60_000);

    await seedSnapshot(
      SNAPSHOT_A,
      [
        {
          internalHmacId: PINNED_HMAC_ID,
          displayName: 'Perfil Antes de Pendiente',
          normalizedName: 'perfil antes de pendiente',
          registeredTitles: [syntheticTitle('Medicina General')],
          recordSha256: '3'.repeat(64),
        },
      ],
      new Date(now - 15 * 60_000),
      'c',
    );
    await projectSnapshot(SNAPSHOT_A, firstReviewedAt);

    await pool.query(`
      update provenance.source as source
      set publication_state = 'PENDING'
      from ingestion_private.msp_catalog_source as mapping
      where mapping.source_key = 'msp_infotitulos'
        and mapping.source_id = source.id
    `);

    await seedSnapshot(
      SNAPSHOT_B,
      [
        {
          internalHmacId: PINNED_HMAC_ID,
          displayName: 'Perfil Que No Debe Proyectarse',
          normalizedName: 'perfil que no debe proyectarse',
          registeredTitles: [syntheticTitle('Cirugía General')],
          recordSha256: '4'.repeat(64),
        },
      ],
      new Date(now - 8 * 60_000),
      'd',
    );

    const countsBeforeAttempt = await projectionCounts();

    await expect(projectSnapshot(SNAPSHOT_B, rejectedReviewedAt)).rejects.toMatchObject({
      code: '55000',
      message: 'The MSP Infotítulos source is not approved',
    });

    await expect(projectionCounts()).resolves.toEqual(countsBeforeAttempt);

    const stateAfterRollback = await pool.query<{
      readonly publication_state: string;
      readonly publication_reviewed_at: Date;
      readonly display_name: string;
      readonly last_seen_snapshot_id: string;
      readonly rejected_release_count: number;
    }>(
      `select
        source.publication_state,
        source.publication_reviewed_at,
        professional.display_name,
        identity.last_seen_snapshot_id,
        (
          select count(*)::integer
          from provenance.source_release as rejected_release
          where rejected_release.upstream_release_key = $1
        ) as rejected_release_count
      from provenance.source as source
      inner join ingestion_private.msp_catalog_source as source_mapping
        on source_mapping.source_id = source.id
      inner join ingestion_private.msp_catalog_identity as identity
        on identity.internal_hmac_id = $2
      inner join catalog.professional as professional
        on professional.id = identity.professional_id`,
      [SNAPSHOT_B, PINNED_HMAC_ID],
    );

    expect(stateAfterRollback.rows).toHaveLength(1);
    expect(stateAfterRollback.rows[0]).toMatchObject({
      publication_state: 'PENDING',
      display_name: 'Perfil Antes de Pendiente',
      last_seen_snapshot_id: SNAPSHOT_A,
      rejected_release_count: 0,
    });
    expect(stateAfterRollback.rows[0]?.publication_reviewed_at.toISOString()).toBe(
      firstReviewedAt.toISOString(),
    );
  });

  it('preserves moderation while automatically withdrawing and reactivating source facts', async () => {
    const now = Date.now();
    const reviewA = new Date(now - 25 * 60_000);
    const reviewB = new Date(now - 15 * 60_000);
    const reviewC = new Date(now - 5 * 60_000);

    const initialProfiles: readonly SyntheticProfile[] = [
      {
        internalHmacId: AUTO_HMAC_ID,
        displayName: 'Perfil de Supresión Automática',
        normalizedName: 'perfil de supresion automatica',
        registeredTitles: [syntheticTitle('Título Automático')],
        recordSha256: '5'.repeat(64),
      },
      {
        internalHmacId: MANUAL_HMAC_ID,
        displayName: 'Perfil de Supresión Manual',
        normalizedName: 'perfil de supresion manual',
        registeredTitles: [syntheticTitle('Título del Perfil Manual')],
        recordSha256: '6'.repeat(64),
      },
      {
        internalHmacId: MODERATED_HMAC_ID,
        displayName: 'Perfil con Títulos Moderados',
        normalizedName: 'perfil con titulos moderados',
        registeredTitles: [
          syntheticTitle('Título Deshabilitado'),
          syntheticTitle('Título en Revisión', 'WITH_CONTRACT'),
          syntheticTitle('Título Transitorio', 'WITHOUT_CONTRACT'),
        ],
        recordSha256: '7'.repeat(64),
      },
    ];

    await seedSnapshot(SNAPSHOT_A, initialProfiles, new Date(now - 30 * 60_000), '5');
    await projectSnapshot(SNAPSHOT_A, reviewA);

    const transientTitleBeforeAbsence = await pool.query<{ readonly id: string }>(
      `select registered_title.id::text
       from credentials.registered_title as registered_title
       inner join ingestion_private.msp_catalog_title_identity as title_identity
         on title_identity.registered_title_id = registered_title.id
       where title_identity.internal_hmac_id = $1
         and title_identity.normalized_title = 'título transitorio'`,
      [MODERATED_HMAC_ID],
    );
    expect(transientTitleBeforeAbsence.rows).toHaveLength(1);

    await pool.query(
      `update credentials.registered_title as registered_title
       set
         registration_state = case registered_title.normalized_title
           when 'título deshabilitado' then 'DISABLED'::credentials.registered_title_state
           when 'título en revisión' then 'UNDER_REVIEW'::credentials.registered_title_state
           else registered_title.registration_state
         end,
         updated_at = clock_timestamp()
       from ingestion_private.msp_catalog_title_identity as title_identity
       where title_identity.registered_title_id = registered_title.id
         and title_identity.internal_hmac_id = $1`,
      [MODERATED_HMAC_ID],
    );

    await seedSnapshot(
      SNAPSHOT_B,
      [
        {
          internalHmacId: MODERATED_HMAC_ID,
          displayName: 'Perfil con Títulos Moderados',
          normalizedName: 'perfil con titulos moderados',
          registeredTitles: [
            syntheticTitle('Título Deshabilitado'),
            syntheticTitle('Título en Revisión', 'WITHOUT_CONTRACT'),
          ],
          recordSha256: '8'.repeat(64),
        },
      ],
      new Date(now - 20 * 60_000),
      '6',
    );

    await expect(projectSnapshot(SNAPSHOT_B, reviewB)).resolves.toEqual({
      snapshot_id: SNAPSHOT_B,
      projected_professionals: '1',
      suppressed_professionals: '2',
      enabled_registered_titles: '0',
    });

    const suppressedAfterAbsence = await pool.query<{
      readonly internal_hmac_id: string;
      readonly visibility: string;
      readonly absent_suppression_applied: boolean;
      readonly automatic_suppressed_at: Date;
      readonly professional_updated_at: Date;
    }>(
      `select
        identity.internal_hmac_id,
        professional.visibility,
        identity.absent_suppression_applied,
        identity.automatic_suppressed_at,
        professional.updated_at as professional_updated_at
      from ingestion_private.msp_catalog_identity as identity
      inner join catalog.professional as professional
        on professional.id = identity.professional_id
      where identity.internal_hmac_id in ($1, $2)
      order by identity.internal_hmac_id`,
      [AUTO_HMAC_ID, MANUAL_HMAC_ID],
    );

    expect(suppressedAfterAbsence.rows).toHaveLength(2);
    for (const row of suppressedAfterAbsence.rows) {
      expect(row.visibility).toBe('SUPPRESSED');
      expect(row.absent_suppression_applied).toBe(true);
      expect(row.automatic_suppressed_at.getTime()).toBe(row.professional_updated_at.getTime());
    }

    const moderatedTitlesAfterAbsence = await pool.query<{
      readonly normalized_title: string;
      readonly registration_state: string;
      readonly has_current_claim: boolean;
    }>(
      `select
        registered_title.normalized_title,
        registered_title.registration_state,
        exists (
          select 1
          from provenance.evidence_claim as claim
          where claim.evidence_id = registered_title.current_evidence_id
            and claim.subject_id = registered_title.professional_id
            and claim.claim_kind = 'REGISTERED_TITLE'
            and claim.normalized_value = registered_title.normalized_title
        ) as has_current_claim
      from credentials.registered_title as registered_title
      inner join ingestion_private.msp_catalog_title_identity as title_identity
        on title_identity.registered_title_id = registered_title.id
      where title_identity.internal_hmac_id = $1
      order by registered_title.normalized_title`,
      [MODERATED_HMAC_ID],
    );

    expect(moderatedTitlesAfterAbsence.rows).toEqual([
      {
        normalized_title: 'título deshabilitado',
        registration_state: 'DISABLED',
        has_current_claim: true,
      },
      {
        normalized_title: 'título en revisión',
        registration_state: 'UNDER_REVIEW',
        has_current_claim: true,
      },
      {
        normalized_title: 'título transitorio',
        registration_state: 'WITHDRAWN',
        has_current_claim: true,
      },
    ]);

    await pool.query(
      `update catalog.professional as professional
       set updated_at = identity.automatic_suppressed_at + interval '1 second'
       from ingestion_private.msp_catalog_identity as identity
       where identity.professional_id = professional.id
         and identity.internal_hmac_id = $1
         and professional.visibility = 'SUPPRESSED'
         and identity.automatic_suppressed_at is not null`,
      [MANUAL_HMAC_ID],
    );

    await seedSnapshot(
      SNAPSHOT_C,
      initialProfiles.map((profile) => ({
        ...profile,
        recordSha256:
          profile.internalHmacId === AUTO_HMAC_ID
            ? '9'.repeat(64)
            : profile.internalHmacId === MANUAL_HMAC_ID
              ? 'a'.repeat(64)
              : 'b'.repeat(64),
      })),
      new Date(now - 10 * 60_000),
      '7',
    );

    await expect(projectSnapshot(SNAPSHOT_C, reviewC)).resolves.toEqual({
      snapshot_id: SNAPSHOT_C,
      projected_professionals: '3',
      suppressed_professionals: '0',
      enabled_registered_titles: '3',
    });

    const professionalStatesAfterReturn = await pool.query<{
      readonly internal_hmac_id: string;
      readonly visibility: string;
      readonly absent_suppression_applied: boolean;
      readonly automatic_suppressed_at: Date | null;
      readonly professional_updated_at: Date;
    }>(
      `select
        identity.internal_hmac_id,
        professional.visibility,
        identity.absent_suppression_applied,
        identity.automatic_suppressed_at,
        professional.updated_at as professional_updated_at
      from ingestion_private.msp_catalog_identity as identity
      inner join catalog.professional as professional
        on professional.id = identity.professional_id
      where identity.internal_hmac_id in ($1, $2)
      order by identity.internal_hmac_id`,
      [AUTO_HMAC_ID, MANUAL_HMAC_ID],
    );

    expect(professionalStatesAfterReturn.rows[0]).toMatchObject({
      internal_hmac_id: AUTO_HMAC_ID,
      visibility: 'PUBLIC',
      absent_suppression_applied: false,
      automatic_suppressed_at: null,
    });
    expect(professionalStatesAfterReturn.rows[1]).toMatchObject({
      internal_hmac_id: MANUAL_HMAC_ID,
      visibility: 'SUPPRESSED',
      absent_suppression_applied: true,
    });
    expect(professionalStatesAfterReturn.rows[1]?.automatic_suppressed_at?.getTime()).not.toBe(
      professionalStatesAfterReturn.rows[1]?.professional_updated_at.getTime(),
    );

    const moderatedTitlesAfterReturn = await pool.query<{
      readonly id: string;
      readonly normalized_title: string;
      readonly registration_state: string;
      readonly has_current_claim: boolean;
    }>(
      `select
        registered_title.id::text,
        registered_title.normalized_title,
        registered_title.registration_state,
        exists (
          select 1
          from provenance.evidence_claim as claim
          where claim.evidence_id = registered_title.current_evidence_id
            and claim.subject_id = registered_title.professional_id
            and claim.claim_kind = 'REGISTERED_TITLE'
            and claim.normalized_value = registered_title.normalized_title
        ) as has_current_claim
      from credentials.registered_title as registered_title
      inner join ingestion_private.msp_catalog_title_identity as title_identity
        on title_identity.registered_title_id = registered_title.id
      where title_identity.internal_hmac_id = $1
      order by registered_title.normalized_title`,
      [MODERATED_HMAC_ID],
    );

    expect(moderatedTitlesAfterReturn.rows).toEqual([
      {
        id: moderatedTitlesAfterReturn.rows[0]?.id,
        normalized_title: 'título deshabilitado',
        registration_state: 'DISABLED',
        has_current_claim: true,
      },
      {
        id: moderatedTitlesAfterReturn.rows[1]?.id,
        normalized_title: 'título en revisión',
        registration_state: 'UNDER_REVIEW',
        has_current_claim: true,
      },
      {
        id: transientTitleBeforeAbsence.rows[0]?.id,
        normalized_title: 'título transitorio',
        registration_state: 'ENABLED',
        has_current_claim: true,
      },
    ]);

    const publiclyEnabledModeratedTitles = await pool.query<{
      readonly normalized_title: string;
    }>(
      `select public_title.normalized_title
       from credentials.public_registered_title as public_title
       inner join catalog.professional as professional
         on professional.public_id = public_title.professional_id
       inner join ingestion_private.msp_catalog_identity as identity
         on identity.professional_id = professional.id
       where identity.internal_hmac_id = $1
       order by public_title.normalized_title`,
      [MODERATED_HMAC_ID],
    );
    expect(publiclyEnabledModeratedTitles.rows).toEqual([
      {
        normalized_title: 'título transitorio',
      },
    ]);
  });
});
