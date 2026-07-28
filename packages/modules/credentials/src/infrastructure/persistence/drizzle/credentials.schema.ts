import { sql } from 'drizzle-orm';
import { check, index, pgSchema, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import {
  REGISTERED_TITLE_STATES,
  TEMPORARY_REGISTRATION_KINDS,
} from '../../../domain/registered-title-state';

export const credentialsSchema = pgSchema('credentials');

export const registeredTitleStateEnum = credentialsSchema.enum(
  'registered_title_state',
  REGISTERED_TITLE_STATES,
);

export const temporaryRegistrationKindEnum = credentialsSchema.enum(
  'temporary_registration_kind',
  TEMPORARY_REGISTRATION_KINDS,
);

export const registeredTitleTable = credentialsSchema.table(
  'registered_title',
  {
    id: uuid('id').primaryKey(),
    publicId: uuid('public_id').defaultRandom().notNull(),
    professionalId: uuid('professional_id').notNull(),
    title: varchar('title', { length: 250 }).notNull(),
    normalizedTitle: varchar('normalized_title', { length: 250 }).notNull(),
    registrationState: registeredTitleStateEnum('registration_state').notNull(),
    temporaryRegistration: temporaryRegistrationKindEnum('temporary_registration')
      .default('NONE')
      .notNull(),
    currentEvidenceId: uuid('current_evidence_id').notNull(),
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
    uniqueIndex('uq_registered_title_public_id').on(table.publicId),
    uniqueIndex('uq_registered_title_professional_title').on(
      table.professionalId,
      table.normalizedTitle,
    ),
    index('ix_registered_title_public_lookup').on(
      table.professionalId,
      table.registrationState,
      table.normalizedTitle,
    ),
    check('ck_registered_title_non_blank', sql`length(trim(${table.title})) > 0`),
    check(
      'ck_registered_title_normalized_non_blank',
      sql`length(trim(${table.normalizedTitle})) > 0`,
    ),
    check('ck_registered_title_distinct_public_id', sql`${table.publicId} <> ${table.id}`),
  ],
);

export const publicRegisteredTitleView = credentialsSchema
  .view('public_registered_title', {
    id: uuid('id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    title: varchar('title', { length: 250 }).notNull(),
    normalizedTitle: varchar('normalized_title', { length: 250 }).notNull(),
    temporaryRegistration: temporaryRegistrationKindEnum('temporary_registration').notNull(),
    currentEvidenceId: uuid('current_evidence_id').notNull(),
  })
  .with({
    securityBarrier: true,
  }).as(sql`
    select
      ${registeredTitleTable.publicId} as id,
      professional.public_id as professional_id,
      ${registeredTitleTable.title} as title,
      ${registeredTitleTable.normalizedTitle} as normalized_title,
      ${registeredTitleTable.temporaryRegistration} as temporary_registration,
      evidence.evidence_id as current_evidence_id
    from ${registeredTitleTable}
    inner join catalog.professional as professional
      on professional.id = ${registeredTitleTable.professionalId}
    inner join catalog.public_professional as public_professional
      on public_professional.id = professional.public_id
    inner join provenance.evidence_ref as evidence_ref
      on evidence_ref.id = ${registeredTitleTable.currentEvidenceId}
    inner join provenance.public_evidence_ref as evidence
      on evidence.evidence_id = evidence_ref.public_id
      and evidence.confidence in ('DETERMINISTIC', 'HUMAN_VERIFIED')
      and evidence.source_kind in ('GOVERNMENT_OPEN_DATA', 'OFFICIAL_PUBLICATION')
    inner join provenance.evidence_claim as claim
      on claim.evidence_id = evidence_ref.id
      and claim.subject_id = ${registeredTitleTable.professionalId}
      and claim.claim_kind = 'REGISTERED_TITLE'
      and claim.normalized_value = ${registeredTitleTable.normalizedTitle}
    where ${registeredTitleTable.registrationState} = 'ENABLED'
  `);
