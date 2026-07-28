BEGIN;

CREATE SCHEMA IF NOT EXISTS research_private AUTHORIZATION medicos_migrator;

REVOKE ALL ON SCHEMA research_private
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;

CREATE TABLE IF NOT EXISTS research_private.analysis_run (
  run_id varchar(96) PRIMARY KEY,
  snapshot_id varchar(120) NOT NULL,
  analysis_version varchar(80) NOT NULL,
  input_fingerprint varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  max_attempts smallint NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  last_error_code varchar(80),
  last_error_message varchar(1000),
  CONSTRAINT uq_research_run_snapshot_fingerprint
    UNIQUE (snapshot_id, analysis_version, input_fingerprint),
  CONSTRAINT uq_research_run_snapshot
    UNIQUE (run_id, snapshot_id),
  CONSTRAINT fk_research_run_snapshot
    FOREIGN KEY (snapshot_id)
    REFERENCES ingestion_private.snapshot(snapshot_id)
    ON DELETE RESTRICT,
  CONSTRAINT ck_research_run_id
    CHECK (run_id ~ '^research_run_v1_[0-9a-f]{64}$'),
  CONSTRAINT ck_research_run_analysis_version
    CHECK (
      length(trim(analysis_version)) BETWEEN 1 AND 80
      AND analysis_version ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT ck_research_run_input_fingerprint
    CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_research_run_status
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  CONSTRAINT ck_research_run_max_attempts
    CHECK (max_attempts BETWEEN 1 AND 10),
  CONSTRAINT ck_research_run_started_at
    CHECK (status = 'PENDING' OR started_at IS NOT NULL),
  CONSTRAINT ck_research_run_terminal_at
    CHECK (
      status NOT IN ('COMPLETED', 'PARTIAL', 'FAILED')
      OR completed_at IS NOT NULL
    )
);

CREATE TABLE IF NOT EXISTS research_private.work_item (
  run_id varchar(96) NOT NULL,
  snapshot_id varchar(120) NOT NULL,
  internal_hmac_id varchar(75) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  attempt_count smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(160),
  lease_token varchar(64),
  lease_expires_at timestamptz,
  report_id varchar(96),
  dossier_sha256 varchar(64),
  processed_at timestamptz,
  last_error_code varchar(80),
  last_error_message varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_work_item
    PRIMARY KEY (run_id, internal_hmac_id),
  CONSTRAINT fk_research_work_item_run_snapshot
    FOREIGN KEY (run_id, snapshot_id)
    REFERENCES research_private.analysis_run(run_id, snapshot_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_research_work_item_professional
    FOREIGN KEY (snapshot_id, internal_hmac_id)
    REFERENCES ingestion_private.professional_profile(snapshot_id, internal_hmac_id)
    ON DELETE RESTRICT,
  CONSTRAINT ck_research_work_item_hmac_id
    CHECK (internal_hmac_id ~ '^msp_doc_v1_[0-9a-f]{64}$'),
  CONSTRAINT ck_research_work_item_status
    CHECK (
      status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'NO_CANDIDATE', 'FAILED')
    ),
  CONSTRAINT ck_research_work_item_attempt_count
    CHECK (attempt_count BETWEEN 0 AND 10),
  CONSTRAINT ck_research_work_item_lease
    CHECK (
      (
        status = 'RUNNING'
        AND lease_owner IS NOT NULL
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR
      (
        status <> 'RUNNING'
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT ck_research_work_item_terminal_at
    CHECK (
      status NOT IN ('SUCCEEDED', 'NO_CANDIDATE', 'FAILED')
      OR processed_at IS NOT NULL
    ),
  CONSTRAINT ck_research_work_item_result
    CHECK (
      (
        status = 'SUCCEEDED'
        AND report_id IS NOT NULL
        AND dossier_sha256 IS NOT NULL
        AND dossier_sha256 ~ '^[0-9a-f]{64}$'
      )
      OR
      (
        status <> 'SUCCEEDED'
        AND report_id IS NULL
        AND dossier_sha256 IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS ix_research_work_item_claim
  ON research_private.work_item (
    run_id,
    status,
    next_attempt_at,
    lease_expires_at,
    internal_hmac_id
  )
  WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS ix_research_work_item_status
  ON research_private.work_item (run_id, status);

CREATE TABLE IF NOT EXISTS research_private.professional_dossier (
  run_id varchar(96) NOT NULL,
  internal_hmac_id varchar(75) NOT NULL,
  report_id varchar(96) NOT NULL,
  generated_at timestamptz NOT NULL,
  query_ambiguity varchar(24) NOT NULL,
  best_flexibility_index smallint,
  candidate_count integer NOT NULL,
  official_registry_record_count integer NOT NULL,
  institutional_candidate_count integer NOT NULL,
  schedule_record_count integer NOT NULL,
  web_candidate_count integer NOT NULL,
  public_reference_candidate_count integer NOT NULL,
  ethics_candidate_count integer NOT NULL DEFAULT 0,
  dossier_sha256 varchar(64) NOT NULL,
  research_view jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_professional_dossier
    PRIMARY KEY (run_id, internal_hmac_id),
  CONSTRAINT uq_research_professional_dossier_report
    UNIQUE (report_id),
  CONSTRAINT fk_research_professional_dossier_work_item
    FOREIGN KEY (run_id, internal_hmac_id)
    REFERENCES research_private.work_item(run_id, internal_hmac_id)
    ON DELETE CASCADE,
  CONSTRAINT ck_research_professional_dossier_report_id
    CHECK (report_id ~ '^professional_research_v1_[0-9a-f]{64}$'),
  CONSTRAINT ck_research_professional_dossier_ambiguity
    CHECK (query_ambiguity IN ('NONE', 'MULTIPLE_CANDIDATES', 'NO_CANDIDATE')),
  CONSTRAINT ck_research_professional_dossier_flexibility
    CHECK (best_flexibility_index IS NULL OR best_flexibility_index BETWEEN 0 AND 2),
  CONSTRAINT ck_research_professional_dossier_candidate_count
    CHECK (candidate_count >= 1),
  CONSTRAINT ck_research_professional_dossier_signal_counts
    CHECK (
      official_registry_record_count >= 0
      AND institutional_candidate_count >= 0
      AND schedule_record_count >= 0
      AND web_candidate_count >= 0
      AND public_reference_candidate_count >= 0
      AND ethics_candidate_count >= 0
    ),
  CONSTRAINT ck_research_professional_dossier_sha256
    CHECK (dossier_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_research_professional_dossier_object
    CHECK (jsonb_typeof(research_view) = 'object'),
  CONSTRAINT ck_research_professional_dossier_contract
    CHECK (
      research_view ->> 'schemaVersion' = '1'
      AND research_view ->> 'reportId' = report_id
      AND research_view ->> 'purpose' = 'INTERNAL_PROFESSIONAL_RESEARCH'
      AND research_view #>> '{query,mode}' = 'OPAQUE_MSP_ID'
      AND research_view #>> '{query,ambiguity}' = query_ambiguity
      AND (
        (
          best_flexibility_index IS NULL
          AND research_view #>> '{query,bestFlexibilityIndex}' IS NULL
        )
        OR research_view #>> '{query,bestFlexibilityIndex}' =
          best_flexibility_index::text
      )
      AND research_view #>> '{delivery,intendedSurface}' = 'AUTHENTICATED_PRIVATE_API'
      AND research_view #>> '{delivery,privateApiDeliveryAllowed}' = 'true'
      AND research_view #>> '{delivery,publicApiDeliveryAllowed}' = 'false'
      AND research_view #>> '{publication,publicExportAllowed}' = 'false'
      AND jsonb_typeof(research_view -> 'candidates') = 'array'
      AND research_view #>> '{candidates,0,professional,linkageId}' = internal_hmac_id
      AND jsonb_array_length(research_view -> 'candidates') = candidate_count
      AND research_view #>> '{candidates,0,signalSummary,officialRegistryRecords}' =
        official_registry_record_count::text
      AND research_view #>> '{candidates,0,signalSummary,institutionalCandidates}' =
        institutional_candidate_count::text
      AND research_view #>> '{candidates,0,signalSummary,scheduleRecords}' =
        schedule_record_count::text
      AND research_view #>> '{candidates,0,signalSummary,webCandidates}' =
        web_candidate_count::text
      AND research_view #>> '{candidates,0,signalSummary,publicReferenceCandidates}' =
        public_reference_candidate_count::text
    )
);

CREATE INDEX IF NOT EXISTS ix_research_professional_dossier_latest
  ON research_private.professional_dossier (internal_hmac_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS research_private.current_professional_dossier (
  internal_hmac_id varchar(75) PRIMARY KEY,
  run_id varchar(96) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_research_current_professional_dossier_revision
    FOREIGN KEY (run_id, internal_hmac_id)
    REFERENCES research_private.professional_dossier(run_id, internal_hmac_id)
    ON DELETE RESTRICT,
  CONSTRAINT ck_research_current_professional_dossier_hmac_id
    CHECK (internal_hmac_id ~ '^msp_doc_v1_[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_research_current_professional_dossier_run
  ON research_private.current_professional_dossier (run_id);

CREATE TABLE IF NOT EXISTS research_private.candidate (
  run_id varchar(96) NOT NULL,
  internal_hmac_id varchar(75) NOT NULL,
  candidate_kind varchar(32) NOT NULL,
  candidate_key varchar(180) NOT NULL,
  publisher varchar(240),
  institution varchar(240),
  canonical_url varchar(2048),
  match_flexibility_index smallint,
  identity_confirmed boolean NOT NULL DEFAULT false,
  fact_confirmed boolean NOT NULL DEFAULT false,
  requires_human_review boolean NOT NULL DEFAULT true,
  payload_sha256 varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_candidate
    PRIMARY KEY (run_id, internal_hmac_id, candidate_kind, candidate_key),
  CONSTRAINT fk_research_candidate_dossier
    FOREIGN KEY (run_id, internal_hmac_id)
    REFERENCES research_private.professional_dossier(run_id, internal_hmac_id)
    ON DELETE CASCADE,
  CONSTRAINT ck_research_candidate_kind
    CHECK (
      candidate_kind IN (
        'INSTITUTIONAL_LINKAGE',
        'WEB_ENRICHMENT',
        'PUBLIC_REFERENCE',
        'ETHICS_CASE_REFERENCE'
      )
    ),
  CONSTRAINT ck_research_candidate_key
    CHECK (length(trim(candidate_key)) BETWEEN 1 AND 180),
  CONSTRAINT ck_research_candidate_canonical_url
    CHECK (canonical_url IS NULL OR canonical_url ~ '^https://'),
  CONSTRAINT ck_research_candidate_flexibility
    CHECK (
      match_flexibility_index IS NULL
      OR match_flexibility_index BETWEEN 0 AND 2
    ),
  CONSTRAINT ck_research_candidate_unconfirmed
    CHECK (
      identity_confirmed = false
      AND fact_confirmed = false
      AND requires_human_review = true
    ),
  CONSTRAINT ck_research_candidate_payload_sha256
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_research_candidate_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_research_candidate_kind_publisher
  ON research_private.candidate (candidate_kind, publisher);

CREATE INDEX IF NOT EXISTS ix_research_candidate_professional
  ON research_private.candidate (internal_hmac_id, candidate_kind);

CREATE TABLE IF NOT EXISTS research_private.ethics_case (
  ethics_case_id varchar(96) PRIMARY KEY,
  publisher varchar(240) NOT NULL,
  source_case_key varchar(240) NOT NULL,
  tribunal varchar(240) NOT NULL,
  title varchar(500) NOT NULL,
  canonical_url varchar(2048) NOT NULL,
  collection_mode varchar(48) NOT NULL DEFAULT 'MANUALLY_CURATED_UNVERIFIED_CURRENTNESS',
  visibility varchar(16) NOT NULL DEFAULT 'UNKNOWN',
  outcome varchar(16) NOT NULL DEFAULT 'UNKNOWN',
  finality_status varchar(24) NOT NULL DEFAULT 'UNKNOWN',
  currentness_verified boolean NOT NULL DEFAULT false,
  source_date varchar(10),
  source_date_precision varchar(8),
  document_sha256 varchar(64),
  source_metadata jsonb NOT NULL,
  content_stored boolean NOT NULL DEFAULT false,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_research_ethics_case_source
    UNIQUE (publisher, source_case_key),
  CONSTRAINT ck_research_ethics_case_id
    CHECK (ethics_case_id ~ '^ethics_case_v1_[0-9a-f]{64}$'),
  CONSTRAINT ck_research_ethics_case_text
    CHECK (
      length(trim(publisher)) > 0
      AND length(trim(source_case_key)) > 0
      AND length(trim(tribunal)) > 0
      AND length(trim(title)) > 0
    ),
  CONSTRAINT ck_research_ethics_case_url
    CHECK (canonical_url ~ '^https://'),
  CONSTRAINT ck_research_ethics_case_collection_mode
    CHECK (collection_mode = 'MANUALLY_CURATED_UNVERIFIED_CURRENTNESS'),
  CONSTRAINT ck_research_ethics_case_visibility
    CHECK (visibility IN ('ORIGINAL', 'ANONYMIZED', 'MIXED', 'UNKNOWN')),
  CONSTRAINT ck_research_ethics_case_outcome
    CHECK (
      outcome IN ('SANCTIONED', 'ABSOLVED', 'DISMISSED', 'REVOKED', 'UNKNOWN')
    ),
  CONSTRAINT ck_research_ethics_case_finality
    CHECK (
      finality_status IN ('VERIFIED_FINAL', 'FINALITY_INCOMPLETE', 'UNKNOWN')
    ),
  CONSTRAINT ck_research_ethics_case_currentness
    CHECK (currentness_verified = false),
  CONSTRAINT ck_research_ethics_case_date
    CHECK (
      (
        source_date IS NULL
        AND source_date_precision IS NULL
      )
      OR
      (
        (
          source_date_precision = 'DAY'
          AND source_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        )
        OR
        (
          source_date_precision = 'MONTH'
          AND source_date ~ '^[0-9]{4}-[0-9]{2}$'
        )
        OR
        (
          source_date_precision = 'YEAR'
          AND source_date ~ '^[0-9]{4}$'
        )
      )
    ),
  CONSTRAINT ck_research_ethics_case_document_sha256
    CHECK (
      document_sha256 IS NULL
      OR document_sha256 ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ck_research_ethics_case_metadata
    CHECK (jsonb_typeof(source_metadata) = 'object'),
  CONSTRAINT ck_research_ethics_case_content
    CHECK (content_stored = false),
  CONSTRAINT ck_research_ethics_case_observation_order
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS ix_research_ethics_case_date
  ON research_private.ethics_case (source_date DESC, publisher);

CREATE TABLE IF NOT EXISTS research_private.professional_ethics_candidate (
  candidate_id varchar(96) PRIMARY KEY,
  run_id varchar(96) NOT NULL,
  internal_hmac_id varchar(75) NOT NULL,
  ethics_case_id varchar(96) NOT NULL,
  observed_name varchar(240) NOT NULL,
  match_kind varchar(40) NOT NULL,
  match_flexibility_index smallint NOT NULL,
  candidate_status varchar(40) NOT NULL DEFAULT 'CANDIDATE_EXACT_REVIEW_REQUIRED',
  match_rationale jsonb NOT NULL,
  candidate_sha256 varchar(64) NOT NULL,
  identity_confirmed boolean NOT NULL DEFAULT false,
  fact_confirmed boolean NOT NULL DEFAULT false,
  requires_human_review boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_research_professional_ethics_candidate
    UNIQUE (run_id, internal_hmac_id, ethics_case_id),
  CONSTRAINT fk_research_professional_ethics_candidate_work_item
    FOREIGN KEY (run_id, internal_hmac_id)
    REFERENCES research_private.work_item(run_id, internal_hmac_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_research_professional_ethics_candidate_case
    FOREIGN KEY (ethics_case_id)
    REFERENCES research_private.ethics_case(ethics_case_id)
    ON DELETE RESTRICT,
  CONSTRAINT ck_research_professional_ethics_candidate_id
    CHECK (candidate_id ~ '^ethics_candidate_v1_[0-9a-f]{64}$'),
  CONSTRAINT ck_research_professional_ethics_candidate_name
    CHECK (length(trim(observed_name)) > 0),
  CONSTRAINT ck_research_professional_ethics_candidate_match_kind
    CHECK (
      match_kind IN (
        'EXACT_NORMALIZED_NAME',
        'EXACT_TOKEN_MULTISET'
      )
    ),
  CONSTRAINT ck_research_professional_ethics_candidate_flexibility
    CHECK (match_flexibility_index = 0),
  CONSTRAINT ck_research_professional_ethics_candidate_status
    CHECK (candidate_status = 'CANDIDATE_EXACT_REVIEW_REQUIRED'),
  CONSTRAINT ck_research_professional_ethics_candidate_rationale
    CHECK (jsonb_typeof(match_rationale) = 'array'),
  CONSTRAINT ck_research_professional_ethics_candidate_sha256
    CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_research_professional_ethics_candidate_unconfirmed
    CHECK (
      identity_confirmed = false
      AND fact_confirmed = false
      AND requires_human_review = true
    )
);

CREATE INDEX IF NOT EXISTS ix_research_professional_ethics_candidate_professional
  ON research_private.professional_ethics_candidate (
    internal_hmac_id,
    match_flexibility_index
  );

CREATE INDEX IF NOT EXISTS ix_research_professional_ethics_candidate_case
  ON research_private.professional_ethics_candidate (ethics_case_id);

CREATE OR REPLACE VIEW research_private.latest_professional_dossier
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (dossier.internal_hmac_id)
  dossier.internal_hmac_id,
  dossier.run_id,
  run.snapshot_id,
  run.analysis_version,
  run.input_fingerprint,
  run.status AS run_status,
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
FROM research_private.professional_dossier AS dossier
JOIN research_private.current_professional_dossier AS current_dossier
  ON current_dossier.run_id = dossier.run_id
  AND current_dossier.internal_hmac_id = dossier.internal_hmac_id
JOIN research_private.analysis_run AS run
  ON run.run_id = dossier.run_id
JOIN research_private.work_item AS work_item
  ON work_item.run_id = dossier.run_id
  AND work_item.internal_hmac_id = dossier.internal_hmac_id
WHERE work_item.status = 'SUCCEEDED'
ORDER BY
  dossier.internal_hmac_id,
  dossier.generated_at DESC,
  dossier.run_id DESC;

REVOKE ALL ON ALL TABLES IN SCHEMA research_private
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA research_private
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA research_private
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;

ALTER DEFAULT PRIVILEGES IN SCHEMA research_private
  REVOKE ALL ON TABLES
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;
ALTER DEFAULT PRIVILEGES IN SCHEMA research_private
  REVOKE ALL ON SEQUENCES
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;
ALTER DEFAULT PRIVILEGES IN SCHEMA research_private
  REVOKE ALL ON FUNCTIONS
  FROM PUBLIC, medicos_catalog_reader, medicos_public_query, medicos_private_ingestor;

GRANT USAGE ON SCHEMA research_private TO medicos_private_ingestor;
GRANT SELECT, INSERT, UPDATE ON
  research_private.analysis_run,
  research_private.work_item,
  research_private.current_professional_dossier,
  research_private.ethics_case
  TO medicos_private_ingestor;
GRANT SELECT, INSERT ON
  research_private.professional_dossier,
  research_private.candidate,
  research_private.professional_ethics_candidate
  TO medicos_private_ingestor;
GRANT SELECT ON research_private.latest_professional_dossier
  TO medicos_private_ingestor;

COMMIT;
