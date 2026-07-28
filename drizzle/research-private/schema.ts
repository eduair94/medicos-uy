import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  privateDirectorySnapshotTable,
  privateProfessionalProfileTable,
} from '../ingestion-private/schema';

import type { ProfessionalResearchViewV1 } from '../../packages/modules/discovery/src/domain/professional-research-contracts';

export type ProfessionalResearchRunStatus =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export type ProfessionalResearchWorkStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'NO_CANDIDATE' | 'FAILED';

export type ProfessionalResearchCandidateKind =
  'INSTITUTIONAL_LINKAGE' | 'WEB_ENRICHMENT' | 'PUBLIC_REFERENCE' | 'ETHICS_CASE_REFERENCE';

export const researchPrivateSchema = pgSchema('research_private');

export const professionalResearchRunTable = researchPrivateSchema.table(
  'analysis_run',
  {
    runId: varchar('run_id', { length: 96 }).primaryKey(),
    snapshotId: varchar('snapshot_id', { length: 120 })
      .notNull()
      .references(() => privateDirectorySnapshotTable.snapshotId, {
        onDelete: 'restrict',
      }),
    analysisVersion: varchar('analysis_version', { length: 80 }).notNull(),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 })
      .$type<ProfessionalResearchRunStatus>()
      .default('PENDING')
      .notNull(),
    maxAttempts: smallint('max_attempts').default(3).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    heartbeatAt: timestamp('heartbeat_at', {
      withTimezone: true,
      mode: 'date',
    }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    lastErrorMessage: varchar('last_error_message', { length: 1000 }),
  },
  (table) => [
    uniqueIndex('uq_research_run_snapshot_fingerprint').on(
      table.snapshotId,
      table.analysisVersion,
      table.inputFingerprint,
    ),
    uniqueIndex('uq_research_run_snapshot').on(table.runId, table.snapshotId),
    check('ck_research_run_id', sql`${table.runId} ~ '^research_run_v1_[0-9a-f]{64}$'`),
    check(
      'ck_research_run_analysis_version',
      sql`length(trim(${table.analysisVersion})) between 1 and 80
        and ${table.analysisVersion} ~ '^[A-Za-z0-9._:-]+$'`,
    ),
    check('ck_research_run_input_fingerprint', sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'ck_research_run_status',
      sql`${table.status} in ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')`,
    ),
    check('ck_research_run_max_attempts', sql`${table.maxAttempts} between 1 and 10`),
    check(
      'ck_research_run_started_at',
      sql`${table.status} = 'PENDING' or ${table.startedAt} is not null`,
    ),
    check(
      'ck_research_run_terminal_at',
      sql`${table.status} not in ('COMPLETED', 'PARTIAL', 'FAILED')
        or ${table.completedAt} is not null`,
    ),
  ],
);

export const professionalResearchWorkItemTable = researchPrivateSchema.table(
  'work_item',
  {
    runId: varchar('run_id', { length: 96 }).notNull(),
    snapshotId: varchar('snapshot_id', { length: 120 }).notNull(),
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    status: varchar('status', { length: 20 })
      .$type<ProfessionalResearchWorkStatus>()
      .default('PENDING')
      .notNull(),
    attemptCount: smallint('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    leaseOwner: varchar('lease_owner', { length: 160 }),
    leaseToken: varchar('lease_token', { length: 64 }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    reportId: varchar('report_id', { length: 96 }),
    dossierSha256: varchar('dossier_sha256', { length: 64 }),
    processedAt: timestamp('processed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    lastErrorMessage: varchar('last_error_message', { length: 1000 }),
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
    primaryKey({
      columns: [table.runId, table.internalHmacId],
      name: 'pk_research_work_item',
    }),
    foreignKey({
      columns: [table.runId, table.snapshotId],
      foreignColumns: [professionalResearchRunTable.runId, professionalResearchRunTable.snapshotId],
      name: 'fk_research_work_item_run_snapshot',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.snapshotId, table.internalHmacId],
      foreignColumns: [
        privateProfessionalProfileTable.snapshotId,
        privateProfessionalProfileTable.internalHmacId,
      ],
      name: 'fk_research_work_item_professional',
    }).onDelete('restrict'),
    index('ix_research_work_item_claim')
      .on(
        table.runId,
        table.status,
        table.nextAttemptAt,
        table.leaseExpiresAt,
        table.internalHmacId,
      )
      .where(sql`${table.status} in ('PENDING', 'RUNNING')`),
    index('ix_research_work_item_status').on(table.runId, table.status),
    check(
      'ck_research_work_item_hmac_id',
      sql`${table.internalHmacId} ~ '^msp_doc_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_work_item_status',
      sql`${table.status} in ('PENDING', 'RUNNING', 'SUCCEEDED', 'NO_CANDIDATE', 'FAILED')`,
    ),
    check('ck_research_work_item_attempt_count', sql`${table.attemptCount} between 0 and 10`),
    check(
      'ck_research_work_item_lease',
      sql`(
          ${table.status} = 'RUNNING'
          and ${table.leaseOwner} is not null
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null
        ) or (
          ${table.status} <> 'RUNNING'
          and ${table.leaseOwner} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
        )`,
    ),
    check(
      'ck_research_work_item_terminal_at',
      sql`${table.status} not in ('SUCCEEDED', 'NO_CANDIDATE', 'FAILED')
        or ${table.processedAt} is not null`,
    ),
    check(
      'ck_research_work_item_result',
      sql`(
          ${table.status} = 'SUCCEEDED'
          and ${table.reportId} is not null
          and ${table.dossierSha256} is not null
          and ${table.dossierSha256} ~ '^[0-9a-f]{64}$'
        ) or (
          ${table.status} <> 'SUCCEEDED'
          and ${table.reportId} is null
          and ${table.dossierSha256} is null
        )`,
    ),
  ],
);

export const professionalResearchDossierTable = researchPrivateSchema.table(
  'professional_dossier',
  {
    runId: varchar('run_id', { length: 96 }).notNull(),
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    reportId: varchar('report_id', { length: 96 }).notNull(),
    generatedAt: timestamp('generated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    queryAmbiguity: varchar('query_ambiguity', { length: 24 })
      .$type<'NONE' | 'MULTIPLE_CANDIDATES' | 'NO_CANDIDATE'>()
      .notNull(),
    bestFlexibilityIndex: smallint('best_flexibility_index').$type<0 | 1 | 2 | null>(),
    candidateCount: integer('candidate_count').notNull(),
    officialRegistryRecordCount: integer('official_registry_record_count').notNull(),
    institutionalCandidateCount: integer('institutional_candidate_count').notNull(),
    scheduleRecordCount: integer('schedule_record_count').notNull(),
    webCandidateCount: integer('web_candidate_count').notNull(),
    publicReferenceCandidateCount: integer('public_reference_candidate_count').notNull(),
    ethicsCandidateCount: integer('ethics_candidate_count').default(0).notNull(),
    dossierSha256: varchar('dossier_sha256', { length: 64 }).notNull(),
    researchView: jsonb('research_view').$type<ProfessionalResearchViewV1>().notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.internalHmacId],
      name: 'pk_research_professional_dossier',
    }),
    uniqueIndex('uq_research_professional_dossier_report').on(table.reportId),
    foreignKey({
      columns: [table.runId, table.internalHmacId],
      foreignColumns: [
        professionalResearchWorkItemTable.runId,
        professionalResearchWorkItemTable.internalHmacId,
      ],
      name: 'fk_research_professional_dossier_work_item',
    }).onDelete('cascade'),
    index('ix_research_professional_dossier_latest').on(
      table.internalHmacId,
      table.generatedAt.desc(),
    ),
    check(
      'ck_research_professional_dossier_report_id',
      sql`${table.reportId} ~ '^professional_research_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_professional_dossier_ambiguity',
      sql`${table.queryAmbiguity} in ('NONE', 'MULTIPLE_CANDIDATES', 'NO_CANDIDATE')`,
    ),
    check(
      'ck_research_professional_dossier_flexibility',
      sql`${table.bestFlexibilityIndex} is null or ${table.bestFlexibilityIndex} between 0 and 2`,
    ),
    check('ck_research_professional_dossier_candidate_count', sql`${table.candidateCount} >= 1`),
    check(
      'ck_research_professional_dossier_signal_counts',
      sql`${table.officialRegistryRecordCount} >= 0
        and ${table.institutionalCandidateCount} >= 0
        and ${table.scheduleRecordCount} >= 0
        and ${table.webCandidateCount} >= 0
        and ${table.publicReferenceCandidateCount} >= 0
        and ${table.ethicsCandidateCount} >= 0`,
    ),
    check(
      'ck_research_professional_dossier_sha256',
      sql`${table.dossierSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_professional_dossier_object',
      sql`jsonb_typeof(${table.researchView}) = 'object'`,
    ),
    check(
      'ck_research_professional_dossier_contract',
      sql`${table.researchView} ->> 'schemaVersion' = '1'
        and ${table.researchView} ->> 'reportId' = ${table.reportId}
        and ${table.researchView} ->> 'purpose' = 'INTERNAL_PROFESSIONAL_RESEARCH'
        and ${table.researchView} #>> '{query,mode}' = 'OPAQUE_MSP_ID'
        and ${table.researchView} #>> '{query,ambiguity}' = ${table.queryAmbiguity}
        and (
          (
            ${table.bestFlexibilityIndex} is null
            and ${table.researchView} #>> '{query,bestFlexibilityIndex}' is null
          )
          or ${table.researchView} #>> '{query,bestFlexibilityIndex}' =
            ${table.bestFlexibilityIndex}::text
        )
        and ${table.researchView} #>> '{delivery,intendedSurface}' =
          'AUTHENTICATED_PRIVATE_API'
        and ${table.researchView} #>> '{delivery,privateApiDeliveryAllowed}' = 'true'
        and ${table.researchView} #>> '{delivery,publicApiDeliveryAllowed}' = 'false'
        and ${table.researchView} #>> '{publication,publicExportAllowed}' = 'false'
        and jsonb_typeof(${table.researchView} -> 'candidates') = 'array'
        and ${table.researchView} #>> '{candidates,0,professional,linkageId}' =
          ${table.internalHmacId}
        and jsonb_array_length(${table.researchView} -> 'candidates') =
          ${table.candidateCount}
        and ${table.researchView} #>>
          '{candidates,0,signalSummary,officialRegistryRecords}' =
          ${table.officialRegistryRecordCount}::text
        and ${table.researchView} #>>
          '{candidates,0,signalSummary,institutionalCandidates}' =
          ${table.institutionalCandidateCount}::text
        and ${table.researchView} #>>
          '{candidates,0,signalSummary,scheduleRecords}' =
          ${table.scheduleRecordCount}::text
        and ${table.researchView} #>>
          '{candidates,0,signalSummary,webCandidates}' =
          ${table.webCandidateCount}::text
        and ${table.researchView} #>>
          '{candidates,0,signalSummary,publicReferenceCandidates}' =
          ${table.publicReferenceCandidateCount}::text`,
    ),
  ],
);

export const currentProfessionalResearchDossierTable = researchPrivateSchema.table(
  'current_professional_dossier',
  {
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).primaryKey(),
    runId: varchar('run_id', { length: 96 }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.internalHmacId],
      foreignColumns: [
        professionalResearchDossierTable.runId,
        professionalResearchDossierTable.internalHmacId,
      ],
      name: 'fk_research_current_professional_dossier_revision',
    }).onDelete('restrict'),
    index('ix_research_current_professional_dossier_run').on(table.runId),
    check(
      'ck_research_current_professional_dossier_hmac_id',
      sql`${table.internalHmacId} ~ '^msp_doc_v1_[0-9a-f]{64}$'`,
    ),
  ],
);

export const professionalResearchCandidateTable = researchPrivateSchema.table(
  'candidate',
  {
    runId: varchar('run_id', { length: 96 }).notNull(),
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    candidateKind: varchar('candidate_kind', { length: 32 })
      .$type<ProfessionalResearchCandidateKind>()
      .notNull(),
    candidateKey: varchar('candidate_key', { length: 180 }).notNull(),
    publisher: varchar('publisher', { length: 240 }),
    institution: varchar('institution', { length: 240 }),
    canonicalUrl: varchar('canonical_url', { length: 2048 }),
    matchFlexibilityIndex: smallint('match_flexibility_index').$type<0 | 1 | 2 | null>(),
    identityConfirmed: boolean('identity_confirmed').default(false).notNull(),
    factConfirmed: boolean('fact_confirmed').default(false).notNull(),
    requiresHumanReview: boolean('requires_human_review').default(true).notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.internalHmacId, table.candidateKind, table.candidateKey],
      name: 'pk_research_candidate',
    }),
    foreignKey({
      columns: [table.runId, table.internalHmacId],
      foreignColumns: [
        professionalResearchDossierTable.runId,
        professionalResearchDossierTable.internalHmacId,
      ],
      name: 'fk_research_candidate_dossier',
    }).onDelete('cascade'),
    index('ix_research_candidate_kind_publisher').on(table.candidateKind, table.publisher),
    index('ix_research_candidate_professional').on(table.internalHmacId, table.candidateKind),
    check(
      'ck_research_candidate_kind',
      sql`${table.candidateKind} in (
        'INSTITUTIONAL_LINKAGE',
        'WEB_ENRICHMENT',
        'PUBLIC_REFERENCE',
        'ETHICS_CASE_REFERENCE'
      )`,
    ),
    check('ck_research_candidate_key', sql`length(trim(${table.candidateKey})) between 1 and 180`),
    check(
      'ck_research_candidate_canonical_url',
      sql`${table.canonicalUrl} is null or ${table.canonicalUrl} ~ '^https://'`,
    ),
    check(
      'ck_research_candidate_flexibility',
      sql`${table.matchFlexibilityIndex} is null
        or ${table.matchFlexibilityIndex} between 0 and 2`,
    ),
    check(
      'ck_research_candidate_unconfirmed',
      sql`${table.identityConfirmed} = false
        and ${table.factConfirmed} = false
        and ${table.requiresHumanReview} = true`,
    ),
    check('ck_research_candidate_payload_sha256', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check('ck_research_candidate_payload_object', sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);

export const professionalResearchEthicsCaseTable = researchPrivateSchema.table(
  'ethics_case',
  {
    ethicsCaseId: varchar('ethics_case_id', { length: 96 }).primaryKey(),
    publisher: varchar('publisher', { length: 240 }).notNull(),
    sourceCaseKey: varchar('source_case_key', { length: 240 }).notNull(),
    tribunal: varchar('tribunal', { length: 240 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    canonicalUrl: varchar('canonical_url', { length: 2048 }).notNull(),
    collectionMode: varchar('collection_mode', { length: 48 })
      .$type<'MANUALLY_CURATED_UNVERIFIED_CURRENTNESS'>()
      .default('MANUALLY_CURATED_UNVERIFIED_CURRENTNESS')
      .notNull(),
    visibility: varchar('visibility', { length: 16 })
      .$type<'ORIGINAL' | 'ANONYMIZED' | 'MIXED' | 'UNKNOWN'>()
      .default('UNKNOWN')
      .notNull(),
    outcome: varchar('outcome', { length: 16 })
      .$type<'SANCTIONED' | 'ABSOLVED' | 'DISMISSED' | 'REVOKED' | 'UNKNOWN'>()
      .default('UNKNOWN')
      .notNull(),
    finalityStatus: varchar('finality_status', { length: 24 })
      .$type<'VERIFIED_FINAL' | 'FINALITY_INCOMPLETE' | 'UNKNOWN'>()
      .default('UNKNOWN')
      .notNull(),
    currentnessVerified: boolean('currentness_verified').default(false).notNull(),
    sourceDate: varchar('source_date', { length: 10 }),
    sourceDatePrecision: varchar('source_date_precision', { length: 8 }).$type<
      'DAY' | 'MONTH' | 'YEAR' | null
    >(),
    documentSha256: varchar('document_sha256', { length: 64 }),
    sourceMetadata: jsonb('source_metadata').$type<Record<string, unknown>>().notNull(),
    contentStored: boolean('content_stored').default(false).notNull(),
    firstObservedAt: timestamp('first_observed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastObservedAt: timestamp('last_observed_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
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
    uniqueIndex('uq_research_ethics_case_source').on(table.publisher, table.sourceCaseKey),
    index('ix_research_ethics_case_date').on(table.sourceDate.desc(), table.publisher),
    check(
      'ck_research_ethics_case_id',
      sql`${table.ethicsCaseId} ~ '^ethics_case_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_ethics_case_text',
      sql`length(trim(${table.publisher})) > 0
        and length(trim(${table.sourceCaseKey})) > 0
        and length(trim(${table.tribunal})) > 0
        and length(trim(${table.title})) > 0`,
    ),
    check('ck_research_ethics_case_url', sql`${table.canonicalUrl} ~ '^https://'`),
    check(
      'ck_research_ethics_case_collection_mode',
      sql`${table.collectionMode} = 'MANUALLY_CURATED_UNVERIFIED_CURRENTNESS'`,
    ),
    check(
      'ck_research_ethics_case_visibility',
      sql`${table.visibility} in ('ORIGINAL', 'ANONYMIZED', 'MIXED', 'UNKNOWN')`,
    ),
    check(
      'ck_research_ethics_case_outcome',
      sql`${table.outcome} in (
        'SANCTIONED',
        'ABSOLVED',
        'DISMISSED',
        'REVOKED',
        'UNKNOWN'
      )`,
    ),
    check(
      'ck_research_ethics_case_finality',
      sql`${table.finalityStatus} in ('VERIFIED_FINAL', 'FINALITY_INCOMPLETE', 'UNKNOWN')`,
    ),
    check('ck_research_ethics_case_currentness', sql`${table.currentnessVerified} = false`),
    check(
      'ck_research_ethics_case_date',
      sql`(
          ${table.sourceDate} is null
          and ${table.sourceDatePrecision} is null
        ) or (
          (${table.sourceDatePrecision} = 'DAY'
            and ${table.sourceDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
          or (${table.sourceDatePrecision} = 'MONTH'
            and ${table.sourceDate} ~ '^[0-9]{4}-[0-9]{2}$')
          or (${table.sourceDatePrecision} = 'YEAR'
            and ${table.sourceDate} ~ '^[0-9]{4}$')
        )`,
    ),
    check(
      'ck_research_ethics_case_document_sha256',
      sql`${table.documentSha256} is null
        or ${table.documentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_ethics_case_metadata',
      sql`jsonb_typeof(${table.sourceMetadata}) = 'object'`,
    ),
    check('ck_research_ethics_case_content', sql`${table.contentStored} = false`),
    check(
      'ck_research_ethics_case_observation_order',
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`,
    ),
  ],
);

export const professionalResearchEthicsCandidateTable = researchPrivateSchema.table(
  'professional_ethics_candidate',
  {
    candidateId: varchar('candidate_id', { length: 96 }).primaryKey(),
    runId: varchar('run_id', { length: 96 }).notNull(),
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    ethicsCaseId: varchar('ethics_case_id', { length: 96 })
      .notNull()
      .references(() => professionalResearchEthicsCaseTable.ethicsCaseId, {
        onDelete: 'restrict',
      }),
    observedName: varchar('observed_name', { length: 240 }).notNull(),
    matchKind: varchar('match_kind', { length: 40 })
      .$type<'EXACT_NORMALIZED_NAME' | 'EXACT_TOKEN_MULTISET'>()
      .notNull(),
    matchFlexibilityIndex: smallint('match_flexibility_index').$type<0>().notNull(),
    candidateStatus: varchar('candidate_status', { length: 40 })
      .$type<'CANDIDATE_EXACT_REVIEW_REQUIRED'>()
      .default('CANDIDATE_EXACT_REVIEW_REQUIRED')
      .notNull(),
    matchRationale: jsonb('match_rationale').$type<readonly string[]>().notNull(),
    candidateSha256: varchar('candidate_sha256', { length: 64 }).notNull(),
    identityConfirmed: boolean('identity_confirmed').default(false).notNull(),
    factConfirmed: boolean('fact_confirmed').default(false).notNull(),
    requiresHumanReview: boolean('requires_human_review').default(true).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_research_professional_ethics_candidate').on(
      table.runId,
      table.internalHmacId,
      table.ethicsCaseId,
    ),
    foreignKey({
      columns: [table.runId, table.internalHmacId],
      foreignColumns: [
        professionalResearchWorkItemTable.runId,
        professionalResearchWorkItemTable.internalHmacId,
      ],
      name: 'fk_research_professional_ethics_candidate_work_item',
    }).onDelete('cascade'),
    index('ix_research_professional_ethics_candidate_professional').on(
      table.internalHmacId,
      table.matchFlexibilityIndex,
    ),
    index('ix_research_professional_ethics_candidate_case').on(table.ethicsCaseId),
    check(
      'ck_research_professional_ethics_candidate_id',
      sql`${table.candidateId} ~ '^ethics_candidate_v1_[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_professional_ethics_candidate_name',
      sql`length(trim(${table.observedName})) > 0`,
    ),
    check(
      'ck_research_professional_ethics_candidate_match_kind',
      sql`${table.matchKind} in (
        'EXACT_NORMALIZED_NAME',
        'EXACT_TOKEN_MULTISET'
      )`,
    ),
    check(
      'ck_research_professional_ethics_candidate_flexibility',
      sql`${table.matchFlexibilityIndex} = 0`,
    ),
    check(
      'ck_research_professional_ethics_candidate_status',
      sql`${table.candidateStatus} = 'CANDIDATE_EXACT_REVIEW_REQUIRED'`,
    ),
    check(
      'ck_research_professional_ethics_candidate_rationale',
      sql`jsonb_typeof(${table.matchRationale}) = 'array'`,
    ),
    check(
      'ck_research_professional_ethics_candidate_sha256',
      sql`${table.candidateSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ck_research_professional_ethics_candidate_unconfirmed',
      sql`${table.identityConfirmed} = false
        and ${table.factConfirmed} = false
        and ${table.requiresHumanReview} = true`,
    ),
  ],
);

export const latestProfessionalResearchDossierView = researchPrivateSchema
  .view('latest_professional_dossier', {
    internalHmacId: varchar('internal_hmac_id', { length: 75 }).notNull(),
    runId: varchar('run_id', { length: 96 }).notNull(),
    snapshotId: varchar('snapshot_id', { length: 120 }).notNull(),
    analysisVersion: varchar('analysis_version', { length: 80 }).notNull(),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }).notNull(),
    runStatus: varchar('run_status', { length: 16 })
      .$type<ProfessionalResearchRunStatus>()
      .notNull(),
    reportId: varchar('report_id', { length: 96 }).notNull(),
    generatedAt: timestamp('generated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    queryAmbiguity: varchar('query_ambiguity', { length: 24 }).notNull(),
    bestFlexibilityIndex: smallint('best_flexibility_index'),
    candidateCount: integer('candidate_count').notNull(),
    officialRegistryRecordCount: integer('official_registry_record_count').notNull(),
    institutionalCandidateCount: integer('institutional_candidate_count').notNull(),
    scheduleRecordCount: integer('schedule_record_count').notNull(),
    webCandidateCount: integer('web_candidate_count').notNull(),
    publicReferenceCandidateCount: integer('public_reference_candidate_count').notNull(),
    ethicsCandidateCount: integer('ethics_candidate_count').notNull(),
    dossierSha256: varchar('dossier_sha256', { length: 64 }).notNull(),
    researchView: jsonb('research_view').$type<ProfessionalResearchViewV1>().notNull(),
  })
  .with({
    securityInvoker: true,
  }).as(sql`
    select distinct on (dossier.internal_hmac_id)
      dossier.internal_hmac_id,
      dossier.run_id,
      run.snapshot_id,
      run.analysis_version,
      run.input_fingerprint,
      run.status as run_status,
      dossier.report_id,
      dossier.generated_at,
      dossier.query_ambiguity,
      dossier.best_flexibility_index,
      dossier.candidate_count,
      dossier.official_registry_record_count,
      dossier.institutional_candidate_count,
      dossier.schedule_record_count,
      dossier.web_candidate_count,
      dossier.public_reference_candidate_count,
      dossier.ethics_candidate_count,
      dossier.dossier_sha256,
      dossier.research_view
    from ${professionalResearchDossierTable} as dossier
    inner join ${currentProfessionalResearchDossierTable} as current_dossier
      on current_dossier.run_id = dossier.run_id
      and current_dossier.internal_hmac_id = dossier.internal_hmac_id
    inner join ${professionalResearchRunTable} as run
      on run.run_id = dossier.run_id
    inner join ${professionalResearchWorkItemTable} as work_item
      on work_item.run_id = dossier.run_id
      and work_item.internal_hmac_id = dossier.internal_hmac_id
    where work_item.status = 'SUCCEEDED'
    order by
      dossier.internal_hmac_id,
      dossier.generated_at desc,
      dossier.run_id desc
  `);
