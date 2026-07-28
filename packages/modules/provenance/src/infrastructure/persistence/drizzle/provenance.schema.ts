import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  EVIDENCE_CLAIM_KINDS,
  EVIDENCE_CONFIDENCE_LEVELS,
  EVIDENCE_PUBLICATION_STATES,
  SOURCE_KINDS,
  SOURCE_PUBLICATION_STATES,
  SOURCE_PURPOSE_COMPATIBILITY_STATES,
  SOURCE_REUSE_BASES,
} from '../../../domain/source-publication-policy';

export const provenanceSchema = pgSchema('provenance');

export const sourceKindEnum = provenanceSchema.enum('source_kind', SOURCE_KINDS);

export const sourcePublicationStateEnum = provenanceSchema.enum(
  'source_publication_state',
  SOURCE_PUBLICATION_STATES,
);

export const sourcePurposeCompatibilityEnum = provenanceSchema.enum(
  'source_purpose_compatibility',
  SOURCE_PURPOSE_COMPATIBILITY_STATES,
);

export const sourceReuseBasisEnum = provenanceSchema.enum('source_reuse_basis', SOURCE_REUSE_BASES);

export const evidencePublicationStateEnum = provenanceSchema.enum(
  'evidence_publication_state',
  EVIDENCE_PUBLICATION_STATES,
);

export const evidenceConfidenceEnum = provenanceSchema.enum(
  'evidence_confidence',
  EVIDENCE_CONFIDENCE_LEVELS,
);

export const evidenceClaimKindEnum = provenanceSchema.enum(
  'evidence_claim_kind',
  EVIDENCE_CLAIM_KINDS,
);

export const sourceTable = provenanceSchema.table(
  'source',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    sourceKind: sourceKindEnum('source_kind').notNull(),
    publicationState: sourcePublicationStateEnum('publication_state').default('PENDING').notNull(),
    purposeCompatibility: sourcePurposeCompatibilityEnum('purpose_compatibility')
      .default('PENDING')
      .notNull(),
    reuseBasis: sourceReuseBasisEnum('reuse_basis').default('PENDING').notNull(),
    licenseUrl: text('license_url'),
    publicationPolicyId: varchar('publication_policy_id', { length: 200 }),
    publicationReviewedBy: varchar('publication_reviewed_by', { length: 200 }),
    publicationReviewedAt: timestamp('publication_reviewed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    publicationReviewReference: text('publication_review_reference'),
    publicationValidUntil: timestamp('publication_valid_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'ck_source_approved_requires_complete_review',
      sql`${table.publicationState} <> 'APPROVED'
          OR (
            ${table.purposeCompatibility} = 'COMPATIBLE'
            AND ${table.reuseBasis} <> 'PENDING'
            AND ${table.publicationPolicyId} IS NOT NULL
            AND ${table.publicationReviewedBy} IS NOT NULL
            AND ${table.publicationReviewedAt} IS NOT NULL
            AND ${table.publicationReviewReference} IS NOT NULL
            AND ${table.publicationValidUntil} IS NOT NULL
            AND length(trim(${table.publicationPolicyId})) > 0
            AND length(trim(${table.publicationReviewedBy})) > 0
            AND length(trim(${table.publicationReviewReference})) > 0
            AND ${table.publicationValidUntil} > ${table.publicationReviewedAt}
            AND (
              ${table.reuseBasis} <> 'OPEN_DATA_LICENSE'
              OR (
                ${table.licenseUrl} IS NOT NULL
                AND length(trim(${table.licenseUrl})) > 0
              )
            )
            AND (
              ${table.reuseBasis} <> 'DATA_SUBJECT_CONSENT'
              OR ${table.sourceKind} = 'DATA_SUBJECT_CLAIM'
            )
            AND (
              ${table.sourceKind} <> 'DATA_SUBJECT_CLAIM'
              OR ${table.reuseBasis} = 'DATA_SUBJECT_CONSENT'
            )
          )`,
    ),
  ],
);

export const sourceReleaseTable = provenanceSchema.table(
  'source_release',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sourceTable.id, {
        onDelete: 'restrict',
      }),
    upstreamReleaseKey: varchar('upstream_release_key', { length: 200 }).notNull(),
    cutoffDate: date('cutoff_date', { mode: 'string' }).notNull(),
    retrievedAt: timestamp('retrieved_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_source_release_upstream_key').on(table.sourceId, table.upstreamReleaseKey),
    index('ix_source_release_freshness').on(table.sourceId, table.cutoffDate, table.retrievedAt),
  ],
);

export const evidenceRefTable = provenanceSchema.table(
  'evidence_ref',
  {
    id: uuid('id').primaryKey(),
    publicId: uuid('public_id').defaultRandom().notNull(),
    sourceReleaseId: uuid('source_release_id')
      .notNull()
      .references(() => sourceReleaseTable.id, {
        onDelete: 'restrict',
      }),
    canonicalUrl: text('canonical_url').notNull(),
    observedAt: timestamp('observed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    checksum: char('checksum', { length: 64 }).notNull(),
    attribution: varchar('attribution', { length: 500 }).notNull(),
    publicationState: evidencePublicationStateEnum('publication_state')
      .default('PENDING')
      .notNull(),
    confidence: evidenceConfidenceEnum('confidence').default('CANDIDATE').notNull(),
    validUntil: timestamp('valid_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_evidence_ref_public_id').on(table.publicId),
    index('ix_evidence_ref_source_release').on(table.sourceReleaseId),
    check(
      'ck_approved_evidence_requires_publishable_confidence',
      sql`${table.publicationState} <> 'APPROVED' OR ${table.confidence} <> 'CANDIDATE'`,
    ),
    check('ck_evidence_ref_distinct_public_id', sql`${table.publicId} <> ${table.id}`),
  ],
);

export const evidenceClaimTable = provenanceSchema.table(
  'evidence_claim',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidenceRefTable.id, {
        onDelete: 'cascade',
      }),
    subjectId: uuid('subject_id').notNull(),
    claimKind: evidenceClaimKindEnum('claim_kind').notNull(),
    normalizedValue: varchar('normalized_value', { length: 250 }).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_evidence_claim_fact').on(
      table.evidenceId,
      table.subjectId,
      table.claimKind,
      table.normalizedValue,
    ),
    index('ix_evidence_claim_subject').on(table.subjectId, table.claimKind, table.normalizedValue),
    check('ck_evidence_claim_value_non_blank', sql`length(trim(${table.normalizedValue})) > 0`),
  ],
);

export const publicEvidenceRefView = provenanceSchema
  .view('public_evidence_ref', {
    evidenceId: uuid('evidence_id').notNull(),
    confidence: evidenceConfidenceEnum('confidence').notNull(),
    sourceKind: sourceKindEnum('source_kind').notNull(),
    sourceName: varchar('source_name', { length: 200 }).notNull(),
    sourceCanonicalUrl: text('source_canonical_url').notNull(),
    sourceLicenseUrl: text('source_license_url'),
    sourceReuseBasis: sourceReuseBasisEnum('source_reuse_basis').notNull(),
    sourcePolicyId: varchar('source_policy_id', { length: 200 }).notNull(),
    sourceValidUntil: timestamp('source_valid_until', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    observedAt: timestamp('observed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    sourceCutoffDate: date('source_cutoff_date', {
      mode: 'string',
    }).notNull(),
    validUntil: timestamp('valid_until', {
      withTimezone: true,
      mode: 'date',
    }),
    attribution: varchar('attribution', { length: 500 }).notNull(),
  })
  .with({
    securityBarrier: true,
  }).as(sql`
    select
      ${evidenceRefTable.publicId} as evidence_id,
      ${evidenceRefTable.confidence} as confidence,
      ${sourceTable.sourceKind} as source_kind,
      ${sourceTable.name} as source_name,
      ${sourceTable.canonicalUrl} as source_canonical_url,
      ${sourceTable.licenseUrl} as source_license_url,
      ${sourceTable.reuseBasis} as source_reuse_basis,
      ${sourceTable.publicationPolicyId} as source_policy_id,
      ${sourceTable.publicationValidUntil} as source_valid_until,
      ${evidenceRefTable.canonicalUrl} as canonical_url,
      ${evidenceRefTable.observedAt} as observed_at,
      ${sourceReleaseTable.cutoffDate} as source_cutoff_date,
      ${evidenceRefTable.validUntil} as valid_until,
      ${evidenceRefTable.attribution} as attribution
    from ${evidenceRefTable}
    inner join ${sourceReleaseTable}
      on ${sourceReleaseTable.id} = ${evidenceRefTable.sourceReleaseId}
    inner join ${sourceTable}
      on ${sourceTable.id} = ${sourceReleaseTable.sourceId}
    where ${evidenceRefTable.publicationState} = 'APPROVED'
      and ${evidenceRefTable.confidence} <> 'CANDIDATE'
      and ${evidenceRefTable.observedAt} <= now()
      and (
        ${evidenceRefTable.validUntil} is null
        or ${evidenceRefTable.validUntil} > now()
      )
      and ${sourceTable.publicationState} = 'APPROVED'
      and ${sourceTable.purposeCompatibility} = 'COMPATIBLE'
      and ${sourceTable.reuseBasis} <> 'PENDING'
      and ${sourceTable.publicationReviewedAt} <= now()
      and ${sourceTable.publicationValidUntil} > now()
      and ${sourceReleaseTable.cutoffDate} <= current_date
      and ${sourceReleaseTable.retrievedAt} <= now()
  `);
