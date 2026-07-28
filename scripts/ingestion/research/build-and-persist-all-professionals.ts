import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parse as parseEnvironmentFile } from 'dotenv';
import { Client } from 'pg';

import {
  buildProfessionalResearchView,
  type ProfessionalResearchCandidateView,
  type ProfessionalResearchViewV1,
  type ResearchInstitutionalLinkageCandidate,
  type ResearchMspProfessional,
  type WebEnrichmentCandidate,
} from '../../../packages/modules/discovery/src';

import {
  loadLinkageSelection,
  loadMspSelection,
  loadReferences,
  loadSchedules,
  loadWebSelection,
  type InputDescriptor,
} from './build-professional-research-view';
import { cmuEthicsBlockedCoverage } from './restricted-source-coverage';

const ANALYSIS_VERSION = 'professional-research-v1.1';
const ANALYSIS_APPROVAL = 'STORE_PRIVATE_RESEARCH_DOSSIERS';
const REQUIRED_DATABASE_USER = 'medicos_private_ingestor';
const REQUIRED_DATABASE_NAME = 'medicos_catalog';
const ADVISORY_LOCK_NAMESPACE = 1_834_104;
const ADVISORY_LOCK_RESOURCE = 104_234_205;
const SNAPSHOT_ID_PATTERN = /^factual-v3-[0-9a-f]{16}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INTERNAL_HMAC_ID_PATTERN = /^msp_doc_v1_[0-9a-f]{64}$/u;

type UnknownRecord = Record<string, unknown>;

export interface ProfessionalAnalysisConfiguration {
  readonly approval: typeof ANALYSIS_APPROVAL;
  readonly dataDirectory: string;
  readonly snapshotId: string;
  readonly databaseUrl: string;
  readonly databaseCa: string;
  readonly databaseSslServername: string;
  readonly referencesPath?: string;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly leaseMinutes: number;
  readonly maxItemsPerInvocation: number | null;
}

export interface ProfessionalAnalysisProgress {
  readonly event:
    | 'analysis_inputs_loaded'
    | 'analysis_run_reused'
    | 'analysis_batch_persisted'
    | 'analysis_batch_failed';
  readonly runId: string;
  readonly processed?: number;
  readonly total?: number;
  readonly batchSize?: number;
  readonly error?: string;
}

export interface ProfessionalAnalysisResult {
  readonly status: 'completed' | 'partial' | 'already_completed' | 'already_running';
  readonly runId: string;
  readonly snapshotId: string;
  readonly inputFingerprint: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly pending: number;
  readonly candidateRows: number;
}

interface AnalysisInputs {
  readonly professionals: readonly ResearchMspProfessional[];
  readonly professionalById: ReadonlyMap<string, ResearchMspProfessional>;
  readonly linkageByProfessionalId: ReadonlyMap<
    string,
    readonly ResearchInstitutionalLinkageCandidate[]
  >;
  readonly webByProfessionalId: ReadonlyMap<string, readonly WebEnrichmentCandidate[]>;
  readonly schedules: Awaited<ReturnType<typeof loadSchedules>>['schedules'];
  readonly scheduleDescriptors: readonly InputDescriptor[];
  readonly references: Awaited<ReturnType<typeof loadReferences>>['references'];
  readonly checkedScheduleArtifacts: number;
  readonly webEnrichmentSnapshotChecked: boolean;
  readonly curatedReferenceLedgerChecked: boolean;
  readonly inputFingerprint: string;
}

interface RunRow extends UnknownRecord {
  readonly run_id: string;
  readonly status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  readonly created_at: Date | string;
}

interface WorkCountRow extends UnknownRecord {
  readonly status: string;
  readonly records: number | string;
}

interface DossierRow {
  readonly internal_hmac_id: string;
  readonly report_id: string;
  readonly generated_at: string;
  readonly query_ambiguity: string;
  readonly best_flexibility_index: number | null;
  readonly candidate_count: number;
  readonly official_registry_record_count: number;
  readonly institutional_candidate_count: number;
  readonly schedule_record_count: number;
  readonly web_candidate_count: number;
  readonly public_reference_candidate_count: number;
  readonly ethics_candidate_count: number;
  readonly dossier_sha256: string;
  readonly research_view: ProfessionalResearchViewV1;
}

interface CandidateRow {
  readonly internal_hmac_id: string;
  readonly candidate_kind: 'INSTITUTIONAL_LINKAGE' | 'WEB_ENRICHMENT' | 'PUBLIC_REFERENCE';
  readonly candidate_key: string;
  readonly publisher: string | null;
  readonly institution: string | null;
  readonly canonical_url: string | null;
  readonly match_flexibility_index: number | null;
  readonly payload_sha256: string;
  readonly payload: UnknownRecord;
}

interface PreparedDossier {
  readonly dossier: DossierRow;
  readonly candidates: readonly CandidateRow[];
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return parsed;
}

function parseDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PROFESSIONAL_ANALYSIS_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('PROFESSIONAL_ANALYSIS_DATABASE_URL must use PostgreSQL.');
  }
  if (
    parsed.username.length === 0 ||
    parsed.password.length === 0 ||
    parsed.hostname.length === 0
  ) {
    throw new Error(
      'PROFESSIONAL_ANALYSIS_DATABASE_URL must include host, username, and password.',
    );
  }
  if ([...parsed.searchParams].length > 0 || parsed.hash.length > 0) {
    throw new Error(
      'PROFESSIONAL_ANALYSIS_DATABASE_URL must not contain query parameters or a fragment.',
    );
  }
  if (decodeURIComponent(parsed.username) !== REQUIRED_DATABASE_USER) {
    throw new Error(`Professional analysis requires the ${REQUIRED_DATABASE_USER} role.`);
  }
  if (decodeURIComponent(parsed.pathname.replace(/^\//u, '')) !== REQUIRED_DATABASE_NAME) {
    throw new Error(`Professional analysis requires the ${REQUIRED_DATABASE_NAME} database.`);
  }
  return value;
}

async function mergedEnvironment(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const configuredPath = environment['PROFESSIONAL_ANALYSIS_ENV_PATH']?.trim();
  if (configuredPath === undefined || configuredPath.length === 0) {
    return environment;
  }
  const path = resolve(configuredPath);
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error('PROFESSIONAL_ANALYSIS_ENV_PATH must point to a regular file.');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('PROFESSIONAL_ANALYSIS_ENV_PATH must not be accessible by group or others.');
  }
  const parsed = parseEnvironmentFile(await readFile(path));
  return { ...parsed, ...environment };
}

export async function loadProfessionalAnalysisConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProfessionalAnalysisConfiguration> {
  const merged = await mergedEnvironment(environment);
  const approval = requiredEnvironmentValue(merged, 'PROFESSIONAL_ANALYSIS_APPROVAL');
  if (approval !== ANALYSIS_APPROVAL) {
    throw new Error(
      `Professional analysis refused. Set PROFESSIONAL_ANALYSIS_APPROVAL=${ANALYSIS_APPROVAL}.`,
    );
  }
  if (merged['CMU_ETHICS_FETCH_ENABLED']?.trim().toLowerCase() === 'true') {
    throw new Error(
      'CMU_ETHICS_FETCH_ENABLED=true is prohibited: the official source blocks automated access.',
    );
  }
  const snapshotId = requiredEnvironmentValue(merged, 'PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID');
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error('PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID is invalid.');
  }
  const caPath = resolve(
    requiredEnvironmentValue(merged, 'PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH'),
  );
  const databaseCa = await readFile(caPath, 'utf8');
  if (
    !databaseCa.includes('-----BEGIN CERTIFICATE-----') ||
    !databaseCa.includes('-----END CERTIFICATE-----')
  ) {
    throw new Error('PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH is not a PEM certificate.');
  }
  const databaseSslServername = requiredEnvironmentValue(
    merged,
    'PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME',
  );
  if (
    databaseSslServername.includes('://') ||
    databaseSslServername.includes('/') ||
    databaseSslServername.length > 253
  ) {
    throw new Error('PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME is invalid.');
  }
  const configuredDataDirectory = merged['DATA_INGESTION_DIR']?.trim();
  const configuredReferencesPath = merged['PROFESSIONAL_RESEARCH_REFERENCES_PATH']?.trim();
  return {
    approval: ANALYSIS_APPROVAL,
    dataDirectory: await realpath(
      resolve(
        configuredDataDirectory === undefined || configuredDataDirectory.length === 0
          ? 'data'
          : configuredDataDirectory,
      ),
    ),
    snapshotId,
    databaseUrl: parseDatabaseUrl(
      requiredEnvironmentValue(merged, 'PROFESSIONAL_ANALYSIS_DATABASE_URL'),
    ),
    databaseCa,
    databaseSslServername,
    ...(configuredReferencesPath === undefined || configuredReferencesPath.length === 0
      ? {}
      : { referencesPath: configuredReferencesPath }),
    batchSize: parseBoundedInteger(
      merged['PROFESSIONAL_ANALYSIS_BATCH_SIZE'],
      100,
      1,
      500,
      'PROFESSIONAL_ANALYSIS_BATCH_SIZE',
    ),
    maxAttempts: parseBoundedInteger(
      merged['PROFESSIONAL_ANALYSIS_MAX_ATTEMPTS'],
      3,
      1,
      10,
      'PROFESSIONAL_ANALYSIS_MAX_ATTEMPTS',
    ),
    leaseMinutes: parseBoundedInteger(
      merged['PROFESSIONAL_ANALYSIS_LEASE_MINUTES'],
      15,
      1,
      120,
      'PROFESSIONAL_ANALYSIS_LEASE_MINUTES',
    ),
    maxItemsPerInvocation: (() => {
      const configured = parseBoundedInteger(
        merged['PROFESSIONAL_ANALYSIS_MAX_ITEMS_PER_INVOCATION'],
        0,
        0,
        100_000,
        'PROFESSIONAL_ANALYSIS_MAX_ITEMS_PER_INVOCATION',
      );
      return configured === 0 ? null : configured;
    })(),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as UnknownRecord;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return JSON.stringify(value);
  }
  throw new Error('Research dossier contains a non-JSON value.');
}

function groupByProfessionalId<T>(
  values: readonly T[],
  ids: (value: T) => readonly string[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    for (const id of ids(value)) {
      const existing = grouped.get(id) ?? [];
      existing.push(value);
      grouped.set(id, existing);
    }
  }
  return grouped;
}

async function loadAnalysisInputs(
  configuration: ProfessionalAnalysisConfiguration,
  now: Date,
): Promise<AnalysisInputs> {
  const [msp, linkage, web, references] = await Promise.all([
    loadMspSelection(configuration.dataDirectory, undefined),
    loadLinkageSelection(configuration.dataDirectory, undefined),
    loadWebSelection(configuration.dataDirectory, now),
    loadReferences(configuration.dataDirectory, configuration.referencesPath),
  ]);
  const schedules = await loadSchedules(configuration.dataDirectory, linkage, linkage.candidates);
  const professionalById = new Map(
    msp.professionals.map((professional) => [professional.linkageId, professional]),
  );
  if (professionalById.size !== msp.professionals.length) {
    throw new Error('MSP input contains duplicate opaque professional identifiers.');
  }
  const sourceCoverage = cmuEthicsBlockedCoverage();
  const inputFingerprint = sha256(
    canonicalJson({
      analysisVersion: ANALYSIS_VERSION,
      msp: { records: msp.records, sha256: msp.sha256 },
      linkage: { records: linkage.records, sha256: linkage.sha256 },
      schedules: schedules.descriptors,
      web:
        web === undefined
          ? null
          : {
              records: web.records,
              sha256: web.sha256,
            },
      references:
        references.content === undefined
          ? null
          : {
              records: references.references.length,
              sha256: sha256(references.content),
            },
      restrictedSources: [sourceCoverage],
    }),
  );
  return {
    professionals: msp.professionals,
    professionalById,
    linkageByProfessionalId: groupByProfessionalId(linkage.candidates, (candidate) =>
      candidate.mspCandidates.map(({ linkageId }) => linkageId),
    ),
    webByProfessionalId: groupByProfessionalId(web?.candidates ?? [], (candidate) => [
      candidate.subject.opaqueProfessionalId,
    ]),
    schedules: schedules.schedules,
    scheduleDescriptors: schedules.descriptors,
    references: references.references,
    checkedScheduleArtifacts: schedules.descriptors.length,
    webEnrichmentSnapshotChecked: web !== undefined,
    curatedReferenceLedgerChecked: references.content !== undefined,
    inputFingerprint,
  };
}

function candidateRows(
  internalHmacId: string,
  candidate: ProfessionalResearchCandidateView,
): readonly CandidateRow[] {
  const institutional: CandidateRow[] = candidate.institutionalCandidates.map((value) => {
    const payload = value as unknown as UnknownRecord;
    return {
      internal_hmac_id: internalHmacId,
      candidate_kind: 'INSTITUTIONAL_LINKAGE',
      candidate_key: value.candidateId,
      publisher: value.institution,
      institution: value.institution,
      canonical_url: value.schedules[0]?.source.url ?? null,
      match_flexibility_index: null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    };
  });
  const web: CandidateRow[] = candidate.webCandidates.map((value) => {
    const payload = value as unknown as UnknownRecord;
    return {
      internal_hmac_id: internalHmacId,
      candidate_kind: 'WEB_ENRICHMENT',
      candidate_key: value.candidateId,
      publisher: value.claim.publisher,
      institution: null,
      canonical_url: value.provenance.canonicalUrl,
      match_flexibility_index: value.match.flexibilityIndex,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    };
  });
  const publicReferences: CandidateRow[] = candidate.publicReferenceCandidates.map((value) => {
    const payload = value as unknown as UnknownRecord;
    return {
      internal_hmac_id: internalHmacId,
      candidate_kind: 'PUBLIC_REFERENCE',
      candidate_key: value.reference.referenceId,
      publisher: value.reference.publisher,
      institution: value.reference.claim.institutionContext[0] ?? null,
      canonical_url: value.reference.canonicalUrl,
      match_flexibility_index: value.nameMatch?.flexibilityIndex ?? null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    };
  });
  return [...institutional, ...web, ...publicReferences];
}

export function buildPersistableDossier(
  inputs: AnalysisInputs,
  professional: ResearchMspProfessional,
  runGeneratedAt: string,
): PreparedDossier {
  const reportId = `professional_research_v1_${sha256(
    `${inputs.inputFingerprint}\u001f${professional.linkageId}`,
  )}`;
  const view = buildProfessionalResearchView({
    reportId,
    generatedAt: runGeneratedAt,
    query: {
      mode: 'OPAQUE_MSP_ID',
      value: professional.linkageId,
    },
    mspProfessionals: [professional],
    institutionalLinkageCandidates:
      inputs.linkageByProfessionalId.get(professional.linkageId) ?? [],
    schedulesBySourceRecord: inputs.schedules,
    webCandidates: inputs.webByProfessionalId.get(professional.linkageId) ?? [],
    publicReferences: inputs.references,
    sourceCoverage: [cmuEthicsBlockedCoverage()],
    checkedScheduleArtifacts: inputs.checkedScheduleArtifacts,
    webEnrichmentSnapshotChecked: inputs.webEnrichmentSnapshotChecked,
    curatedReferenceLedgerChecked: inputs.curatedReferenceLedgerChecked,
  });
  const candidate = view.candidates[0];
  if (
    candidate === undefined ||
    view.candidates.length !== 1 ||
    candidate.professional.linkageId !== professional.linkageId
  ) {
    throw new Error(`Could not build one deterministic dossier for ${professional.linkageId}.`);
  }
  const signal = candidate.signalSummary;
  return {
    dossier: {
      internal_hmac_id: professional.linkageId,
      report_id: reportId,
      generated_at: runGeneratedAt,
      query_ambiguity: view.query.ambiguity,
      best_flexibility_index: view.query.bestFlexibilityIndex,
      candidate_count: view.candidates.length,
      official_registry_record_count: signal.officialRegistryRecords,
      institutional_candidate_count: signal.institutionalCandidates,
      schedule_record_count: signal.scheduleRecords,
      web_candidate_count: signal.webCandidates,
      public_reference_candidate_count: signal.publicReferenceCandidates,
      ethics_candidate_count: 0,
      dossier_sha256: sha256(canonicalJson(view)),
      research_view: view,
    },
    candidates: candidateRows(professional.linkageId, candidate),
  };
}

function createClient(configuration: ProfessionalAnalysisConfiguration): Client {
  return new Client({
    connectionString: configuration.databaseUrl,
    application_name: 'medicos-professional-analysis',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    idle_in_transaction_session_timeout: 120_000,
    ssl: {
      ca: configuration.databaseCa,
      rejectUnauthorized: true,
      servername: configuration.databaseSslServername,
    },
  });
}

async function verifyDatabaseBoundary(
  client: Client,
  configuration: ProfessionalAnalysisConfiguration,
): Promise<void> {
  const result = await client.query<{
    readonly database_name: string;
    readonly role_name: string;
    readonly is_superuser: boolean;
    readonly ssl: boolean;
  }>(`
    SELECT
      current_database() AS database_name,
      current_user AS role_name,
      role.rolsuper AS is_superuser,
      COALESCE(connection.ssl, false) AS ssl
    FROM pg_roles AS role
    LEFT JOIN pg_stat_ssl AS connection
      ON connection.pid = pg_backend_pid()
    WHERE role.rolname = current_user
  `);
  const row = result.rows[0];
  if (
    row?.database_name !== REQUIRED_DATABASE_NAME ||
    row?.role_name !== REQUIRED_DATABASE_USER ||
    row?.is_superuser !== false ||
    row?.ssl !== true
  ) {
    throw new Error('PostgreSQL connection violates the private analysis boundary.');
  }
  if (!SNAPSHOT_ID_PATTERN.test(configuration.snapshotId)) {
    throw new Error('The configured private snapshot identifier is invalid.');
  }
}

async function acquireAnalysisLock(client: Client): Promise<boolean> {
  const result = await client.query<{ readonly acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS acquired',
    [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_RESOURCE],
  );
  return result.rows[0]?.acquired === true;
}

async function releaseAnalysisLock(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1, $2)', [
    ADVISORY_LOCK_NAMESPACE,
    ADVISORY_LOCK_RESOURCE,
  ]);
}

async function verifySnapshotIdentitySet(
  client: Client,
  configuration: ProfessionalAnalysisConfiguration,
  inputs: AnalysisInputs,
): Promise<void> {
  const result = await client.query<{ readonly internal_hmac_id: string }>(
    `
      SELECT internal_hmac_id
      FROM ingestion_private.professional_profile
      WHERE snapshot_id = $1
      ORDER BY internal_hmac_id
    `,
    [configuration.snapshotId],
  );
  if (result.rows.length !== inputs.professionals.length) {
    throw new Error(
      `Snapshot/profile count mismatch: database=${String(result.rows.length)}, artifact=${String(
        inputs.professionals.length,
      )}.`,
    );
  }
  for (const row of result.rows) {
    if (!INTERNAL_HMAC_ID_PATTERN.test(row.internal_hmac_id)) {
      throw new Error('Private snapshot contains an invalid opaque professional identifier.');
    }
    if (!inputs.professionalById.has(row.internal_hmac_id)) {
      throw new Error('Database and artifact MSP identity sets do not match.');
    }
  }
}

async function initializeRun(
  client: Client,
  configuration: ProfessionalAnalysisConfiguration,
  inputFingerprint: string,
): Promise<RunRow> {
  const runId = `research_run_v1_${sha256(
    `${configuration.snapshotId}\u001f${ANALYSIS_VERSION}\u001f${inputFingerprint}`,
  )}`;
  const result = await client.query<RunRow>(
    `
      INSERT INTO research_private.analysis_run (
        run_id,
        snapshot_id,
        analysis_version,
        input_fingerprint,
        status,
        max_attempts,
        started_at,
        heartbeat_at
      )
      VALUES ($1, $2, $3, $4, 'RUNNING', $5, now(), now())
      ON CONFLICT (snapshot_id, analysis_version, input_fingerprint)
      DO UPDATE SET
        status = CASE
          WHEN research_private.analysis_run.status = 'COMPLETED' THEN 'COMPLETED'
          ELSE 'RUNNING'
        END,
        started_at = COALESCE(research_private.analysis_run.started_at, now()),
        heartbeat_at = CASE
          WHEN research_private.analysis_run.status = 'COMPLETED'
            THEN research_private.analysis_run.heartbeat_at
          ELSE now()
        END,
        completed_at = CASE
          WHEN research_private.analysis_run.status = 'COMPLETED'
            THEN research_private.analysis_run.completed_at
          ELSE NULL
        END,
        last_error_code = CASE
          WHEN research_private.analysis_run.status = 'COMPLETED'
            THEN research_private.analysis_run.last_error_code
          ELSE NULL
        END,
        last_error_message = CASE
          WHEN research_private.analysis_run.status = 'COMPLETED'
            THEN research_private.analysis_run.last_error_message
          ELSE NULL
        END
      RETURNING run_id, status, created_at
    `,
    [
      runId,
      configuration.snapshotId,
      ANALYSIS_VERSION,
      inputFingerprint,
      configuration.maxAttempts,
    ],
  );
  const row = result.rows[0];
  if (row?.run_id !== runId) {
    throw new Error('Could not initialize the deterministic analysis run.');
  }
  return row;
}

async function seedWorkItems(
  client: Client,
  runId: string,
  configuration: ProfessionalAnalysisConfiguration,
  expectedCount: number,
): Promise<void> {
  await client.query(
    `
      INSERT INTO research_private.work_item (
        run_id,
        snapshot_id,
        internal_hmac_id
      )
      SELECT $1, profile.snapshot_id, profile.internal_hmac_id
      FROM ingestion_private.professional_profile AS profile
      WHERE profile.snapshot_id = $2
      ON CONFLICT (run_id, internal_hmac_id) DO NOTHING
    `,
    [runId, configuration.snapshotId],
  );
  const result = await client.query<{ readonly records: number | string }>(
    `
      SELECT count(*)::bigint AS records
      FROM research_private.work_item
      WHERE run_id = $1
    `,
    [runId],
  );
  if (Number(result.rows[0]?.records) !== expectedCount) {
    throw new Error('The analysis work queue does not match the verified MSP snapshot.');
  }
  await client.query(
    `
      UPDATE research_private.work_item
      SET
        status = CASE WHEN attempt_count >= $2 THEN 'FAILED' ELSE 'PENDING' END,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        processed_at = CASE WHEN attempt_count >= $2 THEN now() ELSE NULL END,
        last_error_code = CASE
          WHEN attempt_count >= $2 THEN 'ATTEMPTS_EXHAUSTED'
          ELSE last_error_code
        END,
        last_error_message = CASE
          WHEN attempt_count >= $2 THEN 'The previous worker stopped before completing this item.'
          ELSE last_error_message
        END,
        updated_at = now()
      WHERE run_id = $1
        AND status = 'RUNNING'
    `,
    [runId, configuration.maxAttempts],
  );
}

async function claimWorkItems(
  client: Client,
  runId: string,
  configuration: ProfessionalAnalysisConfiguration,
  leaseOwner: string,
  leaseToken: string,
  limit: number,
): Promise<readonly string[]> {
  const result = await client.query<{ readonly internal_hmac_id: string }>(
    `
      WITH selected AS (
        SELECT internal_hmac_id
        FROM research_private.work_item
        WHERE run_id = $1
          AND status = 'PENDING'
          AND next_attempt_at <= now()
          AND attempt_count < $2
        ORDER BY internal_hmac_id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE research_private.work_item AS work_item
      SET
        status = 'RUNNING',
        attempt_count = work_item.attempt_count + 1,
        lease_owner = $4,
        lease_token = $5,
        lease_expires_at = now() + ($6::text || ' minutes')::interval,
        processed_at = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      FROM selected
      WHERE work_item.run_id = $1
        AND work_item.internal_hmac_id = selected.internal_hmac_id
      RETURNING work_item.internal_hmac_id
    `,
    [runId, configuration.maxAttempts, limit, leaseOwner, leaseToken, configuration.leaseMinutes],
  );
  return result.rows.map(({ internal_hmac_id: id }) => id);
}

async function persistBatch(
  client: Client,
  runId: string,
  leaseToken: string,
  prepared: readonly PreparedDossier[],
): Promise<number> {
  const dossiers = prepared.map(({ dossier }) => dossier);
  const candidates = prepared.flatMap(({ candidates: rows }) => rows);
  await client.query('BEGIN');
  try {
    await client.query(
      `
        INSERT INTO research_private.professional_dossier (
          run_id,
          internal_hmac_id,
          report_id,
          generated_at,
          query_ambiguity,
          best_flexibility_index,
          candidate_count,
          official_registry_record_count,
          institutional_candidate_count,
          schedule_record_count,
          web_candidate_count,
          public_reference_candidate_count,
          ethics_candidate_count,
          dossier_sha256,
          research_view
        )
        SELECT
          $1,
          value.internal_hmac_id,
          value.report_id,
          value.generated_at,
          value.query_ambiguity,
          value.best_flexibility_index,
          value.candidate_count,
          value.official_registry_record_count,
          value.institutional_candidate_count,
          value.schedule_record_count,
          value.web_candidate_count,
          value.public_reference_candidate_count,
          value.ethics_candidate_count,
          value.dossier_sha256,
          value.research_view
        FROM jsonb_to_recordset($2::jsonb) AS value (
          internal_hmac_id varchar(75),
          report_id varchar(96),
          generated_at timestamptz,
          query_ambiguity varchar(24),
          best_flexibility_index smallint,
          candidate_count integer,
          official_registry_record_count integer,
          institutional_candidate_count integer,
          schedule_record_count integer,
          web_candidate_count integer,
          public_reference_candidate_count integer,
          ethics_candidate_count integer,
          dossier_sha256 varchar(64),
          research_view jsonb
        )
        ON CONFLICT (run_id, internal_hmac_id) DO NOTHING
      `,
      [runId, JSON.stringify(dossiers)],
    );
    if (candidates.length > 0) {
      await client.query(
        `
          INSERT INTO research_private.candidate (
            run_id,
            internal_hmac_id,
            candidate_kind,
            candidate_key,
            publisher,
            institution,
            canonical_url,
            match_flexibility_index,
            identity_confirmed,
            fact_confirmed,
            requires_human_review,
            payload_sha256,
            payload
          )
          SELECT
            $1,
            value.internal_hmac_id,
            value.candidate_kind,
            value.candidate_key,
            value.publisher,
            value.institution,
            value.canonical_url,
            value.match_flexibility_index,
            false,
            false,
            true,
            value.payload_sha256,
            value.payload
          FROM jsonb_to_recordset($2::jsonb) AS value (
            internal_hmac_id varchar(75),
            candidate_kind varchar(32),
            candidate_key varchar(180),
            publisher varchar(240),
            institution varchar(240),
            canonical_url varchar(2048),
            match_flexibility_index smallint,
            payload_sha256 varchar(64),
            payload jsonb
          )
          ON CONFLICT (run_id, internal_hmac_id, candidate_kind, candidate_key)
          DO NOTHING
        `,
        [runId, JSON.stringify(candidates)],
      );
    }
    const hashes = await client.query<{
      readonly internal_hmac_id: string;
      readonly dossier_sha256: string;
    }>(
      `
        SELECT internal_hmac_id, dossier_sha256
        FROM research_private.professional_dossier
        WHERE run_id = $1
          AND internal_hmac_id = ANY($2::varchar[])
      `,
      [runId, dossiers.map(({ internal_hmac_id: id }) => id)],
    );
    const expectedHashes = new Map(
      dossiers.map(({ internal_hmac_id: id, dossier_sha256: hash }) => [id, hash]),
    );
    if (
      hashes.rows.length !== dossiers.length ||
      hashes.rows.some(
        ({ internal_hmac_id: id, dossier_sha256: hash }) => expectedHashes.get(id) !== hash,
      )
    ) {
      throw new Error('An immutable dossier collision was detected.');
    }
    await client.query(
      `
        INSERT INTO research_private.current_professional_dossier (
          internal_hmac_id,
          run_id,
          updated_at
        )
        SELECT value.internal_hmac_id, $1, now()
        FROM jsonb_to_recordset($2::jsonb) AS value (
          internal_hmac_id varchar(75)
        )
        ON CONFLICT (internal_hmac_id)
        DO UPDATE SET
          run_id = excluded.run_id,
          updated_at = now()
        WHERE (
          SELECT newer.generated_at
          FROM research_private.professional_dossier AS newer
          WHERE newer.run_id = excluded.run_id
            AND newer.internal_hmac_id = excluded.internal_hmac_id
        ) >= (
          SELECT current_revision.generated_at
          FROM research_private.professional_dossier AS current_revision
          WHERE current_revision.run_id =
              research_private.current_professional_dossier.run_id
            AND current_revision.internal_hmac_id =
              research_private.current_professional_dossier.internal_hmac_id
        )
      `,
      [
        runId,
        JSON.stringify(dossiers.map(({ internal_hmac_id: id }) => ({ internal_hmac_id: id }))),
      ],
    );
    const updated = await client.query(
      `
        UPDATE research_private.work_item AS work_item
        SET
          status = 'SUCCEEDED',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          report_id = value.report_id,
          dossier_sha256 = value.dossier_sha256,
          processed_at = now(),
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = now()
        FROM jsonb_to_recordset($2::jsonb) AS value (
          internal_hmac_id varchar(75),
          report_id varchar(96),
          dossier_sha256 varchar(64)
        )
        WHERE work_item.run_id = $1
          AND work_item.internal_hmac_id = value.internal_hmac_id
          AND work_item.status = 'RUNNING'
          AND work_item.lease_token = $3
      `,
      [
        runId,
        JSON.stringify(
          dossiers.map(
            ({ internal_hmac_id: id, report_id: reportId, dossier_sha256: dossierSha256 }) => ({
              internal_hmac_id: id,
              report_id: reportId,
              dossier_sha256: dossierSha256,
            }),
          ),
        ),
        leaseToken,
      ],
    );
    if (updated.rowCount !== dossiers.length) {
      throw new Error('The work-item lease changed while persisting a dossier batch.');
    }
    await client.query(
      `
        UPDATE research_private.analysis_run
        SET heartbeat_at = now()
        WHERE run_id = $1
      `,
      [runId],
    );
    await client.query('COMMIT');
    return candidates.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function releaseFailedBatch(
  client: Client,
  runId: string,
  leaseToken: string,
  configuration: ProfessionalAnalysisConfiguration,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown batch failure.';
  await client.query(
    `
      UPDATE research_private.work_item
      SET
        status = CASE WHEN attempt_count >= $3 THEN 'FAILED' ELSE 'PENDING' END,
        next_attempt_at = CASE
          WHEN attempt_count >= $3 THEN next_attempt_at
          ELSE now()
        END,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        report_id = NULL,
        dossier_sha256 = NULL,
        processed_at = CASE WHEN attempt_count >= $3 THEN now() ELSE NULL END,
        last_error_code = 'BATCH_PERSIST_FAILED',
        last_error_message = $4,
        updated_at = now()
      WHERE run_id = $1
        AND status = 'RUNNING'
        AND lease_token = $2
    `,
    [runId, leaseToken, configuration.maxAttempts, message],
  );
}

async function workCounts(client: Client, runId: string): Promise<ReadonlyMap<string, number>> {
  const result = await client.query<WorkCountRow>(
    `
      SELECT status, count(*)::bigint AS records
      FROM research_private.work_item
      WHERE run_id = $1
      GROUP BY status
    `,
    [runId],
  );
  return new Map(result.rows.map(({ status, records }) => [status, Number(records)]));
}

async function finishRun(
  client: Client,
  runId: string,
  signalAborted: boolean,
): Promise<ReadonlyMap<string, number>> {
  const counts = await workCounts(client, runId);
  const failed = counts.get('FAILED') ?? 0;
  const pending =
    (counts.get('PENDING') ?? 0) + (counts.get('RUNNING') ?? 0) + (counts.get('NO_CANDIDATE') ?? 0);
  const status = failed === 0 && pending === 0 && !signalAborted ? 'COMPLETED' : 'PARTIAL';
  await client.query(
    `
      UPDATE research_private.analysis_run
      SET
        status = $2::text,
        heartbeat_at = now(),
        completed_at = now(),
        last_error_code = CASE
          WHEN $2::text = 'COMPLETED' THEN NULL
          ELSE 'INCOMPLETE_RUN'
        END,
        last_error_message = CASE
          WHEN $2::text = 'COMPLETED' THEN NULL
          WHEN $3 THEN 'The worker received a termination signal and stopped at a batch boundary.'
          ELSE 'One or more professional dossiers could not be completed.'
        END
      WHERE run_id = $1
    `,
    [runId, status, signalAborted],
  );
  return counts;
}

function emptyResult(
  status: 'already_completed' | 'already_running',
  runId: string,
  configuration: ProfessionalAnalysisConfiguration,
  inputFingerprint: string,
  total: number,
): ProfessionalAnalysisResult {
  return {
    status,
    runId,
    snapshotId: configuration.snapshotId,
    inputFingerprint,
    total,
    succeeded: status === 'already_completed' ? total : 0,
    failed: 0,
    pending: status === 'already_running' ? total : 0,
    candidateRows: 0,
  };
}

export async function runAllProfessionalAnalysis(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  report: (progress: ProfessionalAnalysisProgress) => void = () => undefined,
): Promise<ProfessionalAnalysisResult> {
  const configuration = await loadProfessionalAnalysisConfiguration(environment);
  const client = createClient(configuration);
  await client.connect();
  let lockAcquired = false;
  let runId = `research_run_v1_${'0'.repeat(64)}`;
  let inputFingerprint = '0'.repeat(64);
  try {
    await verifyDatabaseBoundary(client, configuration);
    lockAcquired = await acquireAnalysisLock(client);
    if (!lockAcquired) {
      return emptyResult('already_running', runId, configuration, inputFingerprint, 0);
    }
    const now = new Date();
    const inputs = await loadAnalysisInputs(configuration, now);
    inputFingerprint = inputs.inputFingerprint;
    runId = `research_run_v1_${sha256(
      `${configuration.snapshotId}\u001f${ANALYSIS_VERSION}\u001f${inputFingerprint}`,
    )}`;
    report({
      event: 'analysis_inputs_loaded',
      runId,
      total: inputs.professionals.length,
    });
    await verifySnapshotIdentitySet(client, configuration, inputs);
    const run = await initializeRun(client, configuration, inputFingerprint);
    if (run.status === 'COMPLETED') {
      report({ event: 'analysis_run_reused', runId, total: inputs.professionals.length });
      return emptyResult(
        'already_completed',
        runId,
        configuration,
        inputFingerprint,
        inputs.professionals.length,
      );
    }
    await seedWorkItems(client, runId, configuration, inputs.professionals.length);
    const runGeneratedAt = new Date(run.created_at).toISOString();
    const leaseOwner = `${process.pid}@${process.env['HOSTNAME'] ?? 'unknown-host'}`.slice(0, 160);
    let candidateRowCount = 0;
    let processedThisInvocation = 0;
    while (signal?.aborted !== true) {
      const remainingInvocationCapacity =
        configuration.maxItemsPerInvocation === null
          ? configuration.batchSize
          : Math.min(
              configuration.batchSize,
              configuration.maxItemsPerInvocation - processedThisInvocation,
            );
      if (remainingInvocationCapacity <= 0) {
        break;
      }
      const leaseToken = randomBytes(32).toString('hex');
      const claimed = await claimWorkItems(
        client,
        runId,
        configuration,
        leaseOwner,
        leaseToken,
        remainingInvocationCapacity,
      );
      if (claimed.length === 0) {
        break;
      }
      try {
        const prepared = claimed.map((id) => {
          const professional = inputs.professionalById.get(id);
          if (professional === undefined) {
            throw new Error(`Claimed professional ${id} is absent from the verified MSP input.`);
          }
          return buildPersistableDossier(inputs, professional, runGeneratedAt);
        });
        candidateRowCount += await persistBatch(client, runId, leaseToken, prepared);
        processedThisInvocation += claimed.length;
        const counts = await workCounts(client, runId);
        report({
          event: 'analysis_batch_persisted',
          runId,
          processed: counts.get('SUCCEEDED') ?? 0,
          total: inputs.professionals.length,
          batchSize: claimed.length,
        });
      } catch (error) {
        await releaseFailedBatch(client, runId, leaseToken, configuration, error);
        report({
          event: 'analysis_batch_failed',
          runId,
          batchSize: claimed.length,
          error: error instanceof Error ? error.message : 'Unknown batch failure.',
        });
      }
    }
    const counts = await finishRun(client, runId, signal?.aborted === true);
    const succeeded = counts.get('SUCCEEDED') ?? 0;
    const failed = counts.get('FAILED') ?? 0;
    const pending =
      (counts.get('PENDING') ?? 0) +
      (counts.get('RUNNING') ?? 0) +
      (counts.get('NO_CANDIDATE') ?? 0);
    return {
      status: succeeded === inputs.professionals.length ? 'completed' : 'partial',
      runId,
      snapshotId: configuration.snapshotId,
      inputFingerprint,
      total: inputs.professionals.length,
      succeeded,
      failed,
      pending,
      candidateRows: candidateRowCount,
    };
  } catch (error) {
    if (SHA256_PATTERN.test(runId.slice('research_run_v1_'.length))) {
      try {
        await client.query(
          `
            UPDATE research_private.analysis_run
            SET
              status = 'FAILED',
              heartbeat_at = now(),
              completed_at = now(),
              last_error_code = 'ANALYSIS_RUN_FAILED',
              last_error_message = $2
            WHERE run_id = $1
              AND status <> 'COMPLETED'
          `,
          [
            runId,
            error instanceof Error ? error.message.slice(0, 1000) : 'Unknown analysis failure.',
          ],
        );
      } catch {
        // Preserve the original failure; deployment diagnostics will inspect PostgreSQL separately.
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      await releaseAnalysisLock(client);
    }
    await client.end();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await runAllProfessionalAnalysis(process.env, controller.signal, (progress) => {
    console.log(JSON.stringify(progress));
  });
  console.log(
    JSON.stringify({
      event: 'professional_analysis_finished',
      ...result,
      ethicsAutomatedFetchPerformed: false,
      publicCatalogMutationPerformed: false,
    }),
  );
  if (result.status === 'partial') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'professional_analysis_failed',
        error: error instanceof Error ? error.message : 'Unknown professional analysis failure.',
        ethicsAutomatedFetchPerformed: false,
        publicCatalogMutationPerformed: false,
      }),
    );
    process.exitCode = 1;
  });
}
