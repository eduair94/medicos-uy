import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  timestamp,
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
