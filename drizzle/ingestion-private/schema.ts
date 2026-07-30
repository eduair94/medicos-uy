import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export interface PrivateRegisteredTitle {
  readonly title: string;
  readonly temporaryRegistration: 'NONE' | 'WITH_CONTRACT' | 'WITHOUT_CONTRACT';
}

export interface PrivateOfficialRegistry {
  readonly publisher: string;
  readonly dataset: string;
  readonly sourceCutoffDate: string;
  readonly datasetUrl: string;
  readonly liveLookupUrl: string;
}

export const privateIngestionSchema = pgSchema('ingestion_private');

export const privateDirectorySnapshotTable = privateIngestionSchema.table(
  'snapshot',
  {
    snapshotId: varchar('snapshot_id', { length: 120 }).primaryKey(),
    manifestSha256: varchar('manifest_sha256', { length: 64 }).notNull(),
    profilesSha256: varchar('profiles_sha256', { length: 64 }).notNull(),
    profileCount: integer('profile_count').notNull(),
    sourceGeneratedAt: timestamp('source_generated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    importedAt: timestamp('imported_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'ck_private_snapshot_id_factual_v3',
      sql`${table.snapshotId} ~ '^factual-v3-[0-9a-f]{16}$'`,
    ),
    check('ck_private_snapshot_manifest_sha256', sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`),
    check('ck_private_snapshot_profiles_sha256', sql`${table.profilesSha256} ~ '^[0-9a-f]{64}$'`),
    check('ck_private_snapshot_profile_count', sql`${table.profileCount} >= 0`),
  ],
);

export const privateProfessionalProfileTable = privateIngestionSchema.table(
  'professional_profile',
  {
    snapshotId: varchar('snapshot_id', { length: 120 })
      .notNull()
      .references(() => privateDirectorySnapshotTable.snapshotId, {
        onDelete: 'cascade',
      }),
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    normalizedName: varchar('normalized_name', { length: 200 }).notNull(),
    registeredTitles: jsonb('registered_titles')
      .$type<readonly PrivateRegisteredTitle[]>()
      .notNull(),
    officialRegistry: jsonb('official_registry').$type<PrivateOfficialRegistry>().notNull(),
    recordSha256: varchar('record_sha256', { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.snapshotId, table.internalHmacId],
      name: 'pk_private_professional_profile',
    }),
    index('ix_private_professional_profile_name').on(table.snapshotId, table.normalizedName),
    check(
      'ck_private_professional_hmac_id',
      sql`${table.internalHmacId} ~ '^msp_doc_v1_[0-9a-f]{64}$'`,
    ),
    check('ck_private_professional_display_name', sql`length(trim(${table.displayName})) > 0`),
    check(
      'ck_private_professional_normalized_name',
      sql`length(trim(${table.normalizedName})) > 0`,
    ),
    check('ck_private_professional_record_sha256', sql`${table.recordSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'ck_private_professional_registered_titles_array',
      sql`jsonb_typeof(${table.registeredTitles}) = 'array'`,
    ),
    check(
      'ck_private_professional_official_registry_object',
      sql`jsonb_typeof(${table.officialRegistry}) = 'object'`,
    ),
  ],
);

export const privateMspCatalogSourceTable = privateIngestionSchema.table(
  'msp_catalog_source',
  {
    sourceKey: varchar('source_key', { length: 80 }).primaryKey(),
    sourceId: uuid('source_id').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex('uq_private_msp_catalog_source_id').on(table.sourceId)],
);

export const privateMspCatalogIdentityTable = privateIngestionSchema.table(
  'msp_catalog_identity',
  {
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).primaryKey(),
    professionalId: uuid('professional_id').notNull(),
    professionalPublicId: uuid('professional_public_id').notNull(),
    routeSlug: varchar('route_slug', { length: 180 }).notNull(),
    lastSeenSnapshotId: varchar('last_seen_snapshot_id', { length: 120 }).notNull(),
    absentSuppressionApplied: boolean('absent_suppression_applied').default(false).notNull(),
    automaticSuppressedAt: timestamp('automatic_suppressed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_private_msp_catalog_professional_id').on(table.professionalId),
    uniqueIndex('uq_private_msp_catalog_professional_public_id').on(table.professionalPublicId),
    uniqueIndex('uq_private_msp_catalog_route_slug').on(table.routeSlug),
    index('ix_private_msp_catalog_last_seen').on(table.lastSeenSnapshotId),
    check(
      'ck_private_msp_catalog_identity_hmac',
      sql`${table.internalHmacId} ~ '^msp_doc_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_private_msp_catalog_professional_distinct_ids',
      sql`${table.professionalId} <> ${table.professionalPublicId}`,
    ),
    check(
      'ck_private_msp_catalog_route_slug',
      sql`${table.routeSlug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);

export const privateMspCatalogEvidenceIdentityTable = privateIngestionSchema.table(
  'msp_catalog_evidence_identity',
  {
    snapshotId: varchar('snapshot_id', { length: 120 }).notNull(),
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    evidencePublicId: uuid('evidence_public_id').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.snapshotId, table.internalHmacId],
      name: 'pk_private_msp_catalog_evidence_identity',
    }),
    uniqueIndex('uq_private_msp_catalog_evidence_id').on(table.evidenceId),
    uniqueIndex('uq_private_msp_catalog_evidence_public_id').on(table.evidencePublicId),
    check(
      'ck_private_msp_catalog_evidence_hmac',
      sql`${table.internalHmacId} ~ '^msp_doc_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_private_msp_catalog_evidence_distinct_ids',
      sql`${table.evidenceId} <> ${table.evidencePublicId}`,
    ),
  ],
);

export const privateMspCatalogTitleIdentityTable = privateIngestionSchema.table(
  'msp_catalog_title_identity',
  {
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    normalizedTitle: varchar('normalized_title', { length: 250 }).notNull(),
    registeredTitleId: uuid('registered_title_id').notNull(),
    registeredTitlePublicId: uuid('registered_title_public_id').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.internalHmacId, table.normalizedTitle],
      name: 'pk_private_msp_catalog_title_identity',
    }),
    uniqueIndex('uq_private_msp_catalog_registered_title_id').on(table.registeredTitleId),
    uniqueIndex('uq_private_msp_catalog_registered_title_public_id').on(
      table.registeredTitlePublicId,
    ),
    check(
      'ck_private_msp_catalog_title_hmac',
      sql`${table.internalHmacId} ~ '^msp_doc_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_private_msp_catalog_title_normalized_non_blank',
      sql`length(trim(${table.normalizedTitle})) > 0`,
    ),
    check(
      'ck_private_msp_catalog_title_distinct_ids',
      sql`${table.registeredTitleId} <> ${table.registeredTitlePublicId}`,
    ),
  ],
);
