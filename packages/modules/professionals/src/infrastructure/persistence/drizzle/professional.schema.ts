import { sql } from 'drizzle-orm';
import { check, index, pgSchema, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const catalogSchema = pgSchema('catalog');

export const professionalVisibilityEnum = catalogSchema.enum('professional_visibility', [
  'PUBLIC',
  'SUPPRESSED',
  'MERGED',
  'ARCHIVED',
]);

export const professionalRouteKindEnum = catalogSchema.enum('professional_route_kind', [
  'CURRENT',
  'REDIRECT',
]);

export const professionalTable = catalogSchema.table(
  'professional',
  {
    id: uuid('id').primaryKey(),
    publicId: uuid('public_id').defaultRandom().notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    normalizedName: varchar('normalized_name', { length: 200 }).notNull(),
    visibility: professionalVisibilityEnum('visibility').notNull(),
    currentNameEvidenceId: uuid('current_name_evidence_id').notNull(),
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
    uniqueIndex('uq_professional_public_id').on(table.publicId),
    index('ix_professional_directory').on(table.visibility, table.normalizedName, table.publicId),
    check('ck_professional_distinct_public_id', sql`${table.publicId} <> ${table.id}`),
  ],
);

export const publicProfessionalView = catalogSchema
  .view('public_professional', {
    id: uuid('id').notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    normalizedName: varchar('normalized_name', { length: 200 }).notNull(),
    currentNameEvidenceId: uuid('current_name_evidence_id').notNull(),
  })
  .with({
    securityBarrier: true,
  }).as(sql`
    select
      ${professionalTable.publicId} as id,
      ${professionalTable.displayName} as display_name,
      ${professionalTable.normalizedName} as normalized_name,
      evidence.evidence_id as current_name_evidence_id
    from ${professionalTable}
    inner join provenance.evidence_ref as evidence_ref
      on evidence_ref.id = ${professionalTable.currentNameEvidenceId}
    inner join provenance.public_evidence_ref as evidence
      on evidence.evidence_id = evidence_ref.public_id
    inner join provenance.evidence_claim as claim
      on claim.evidence_id = evidence_ref.id
      and claim.subject_id = ${professionalTable.id}
      and claim.claim_kind = 'PROFESSIONAL_NAME'
      and claim.normalized_value = ${professionalTable.normalizedName}
    where ${professionalTable.visibility} = 'PUBLIC'
  `);

export const professionalRouteTable = catalogSchema.table(
  'professional_route',
  {
    slug: varchar('slug', { length: 180 }).primaryKey(),
    professionalId: uuid('professional_id')
      .notNull()
      .references(() => professionalTable.id, {
        onDelete: 'cascade',
      }),
    routeKind: professionalRouteKindEnum('route_kind').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_professional_current_route')
      .on(table.professionalId)
      .where(sql`${table.routeKind} = 'CURRENT'`),
    index('ix_professional_route_professional').on(table.professionalId),
    check('ck_professional_route_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check(
      'ck_professional_route_slug_not_uuid',
      sql`NOT (${table.slug} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`,
    ),
  ],
);

export const publicProfessionalRouteView = catalogSchema
  .view('public_professional_route', {
    slug: varchar('slug', { length: 180 }).notNull(),
    professionalId: uuid('professional_id').notNull(),
    routeKind: professionalRouteKindEnum('route_kind').notNull(),
  })
  .with({
    securityBarrier: true,
  }).as(sql`
    select
      ${professionalRouteTable.slug} as slug,
      ${publicProfessionalView.id} as professional_id,
      ${professionalRouteTable.routeKind} as route_kind
    from ${professionalRouteTable}
    inner join ${professionalTable}
      on ${professionalTable.id} = ${professionalRouteTable.professionalId}
    inner join ${publicProfessionalView}
      on ${publicProfessionalView.id} = ${professionalTable.publicId}
  `);
