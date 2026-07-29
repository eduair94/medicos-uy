CREATE TABLE "ingestion_private"."msp_catalog_identity" (
	"internal_hmac_id" varchar(75) PRIMARY KEY NOT NULL,
	"professional_id" uuid NOT NULL,
	"professional_public_id" uuid NOT NULL,
	"route_slug" varchar(180) NOT NULL,
	"last_seen_snapshot_id" varchar(120) NOT NULL,
	"absent_suppression_applied" boolean DEFAULT false NOT NULL,
	"automatic_suppressed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_private_msp_catalog_identity_hmac" CHECK ("ingestion_private"."msp_catalog_identity"."internal_hmac_id" ~ '^msp_doc_v1_[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_msp_catalog_professional_distinct_ids" CHECK ("ingestion_private"."msp_catalog_identity"."professional_id" <> "ingestion_private"."msp_catalog_identity"."professional_public_id"),
	CONSTRAINT "ck_private_msp_catalog_route_slug" CHECK ("ingestion_private"."msp_catalog_identity"."route_slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "ingestion_private"."msp_catalog_evidence_identity" (
	"snapshot_id" varchar(120) NOT NULL,
	"internal_hmac_id" varchar(75) NOT NULL,
	"evidence_id" uuid NOT NULL,
	"evidence_public_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_private_msp_catalog_evidence_identity" PRIMARY KEY("snapshot_id","internal_hmac_id"),
	CONSTRAINT "ck_private_msp_catalog_evidence_hmac" CHECK ("ingestion_private"."msp_catalog_evidence_identity"."internal_hmac_id" ~ '^msp_doc_v1_[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_msp_catalog_evidence_distinct_ids" CHECK ("ingestion_private"."msp_catalog_evidence_identity"."evidence_id" <> "ingestion_private"."msp_catalog_evidence_identity"."evidence_public_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_private"."msp_catalog_source" (
	"source_key" varchar(80) PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_private"."msp_catalog_title_identity" (
	"internal_hmac_id" varchar(75) NOT NULL,
	"normalized_title" varchar(250) NOT NULL,
	"registered_title_id" uuid NOT NULL,
	"registered_title_public_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_private_msp_catalog_title_identity" PRIMARY KEY("internal_hmac_id","normalized_title"),
	CONSTRAINT "ck_private_msp_catalog_title_hmac" CHECK ("ingestion_private"."msp_catalog_title_identity"."internal_hmac_id" ~ '^msp_doc_v1_[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_msp_catalog_title_normalized_non_blank" CHECK (length(trim("ingestion_private"."msp_catalog_title_identity"."normalized_title")) > 0),
	CONSTRAINT "ck_private_msp_catalog_title_distinct_ids" CHECK ("ingestion_private"."msp_catalog_title_identity"."registered_title_id" <> "ingestion_private"."msp_catalog_title_identity"."registered_title_public_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_professional_id" ON "ingestion_private"."msp_catalog_identity" USING btree ("professional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_professional_public_id" ON "ingestion_private"."msp_catalog_identity" USING btree ("professional_public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_evidence_id" ON "ingestion_private"."msp_catalog_evidence_identity" USING btree ("evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_evidence_public_id" ON "ingestion_private"."msp_catalog_evidence_identity" USING btree ("evidence_public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_route_slug" ON "ingestion_private"."msp_catalog_identity" USING btree ("route_slug");--> statement-breakpoint
CREATE INDEX "ix_private_msp_catalog_last_seen" ON "ingestion_private"."msp_catalog_identity" USING btree ("last_seen_snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_source_id" ON "ingestion_private"."msp_catalog_source" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_registered_title_id" ON "ingestion_private"."msp_catalog_title_identity" USING btree ("registered_title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_private_msp_catalog_registered_title_public_id" ON "ingestion_private"."msp_catalog_title_identity" USING btree ("registered_title_public_id");--> statement-breakpoint
REVOKE ALL ON
  "ingestion_private"."msp_catalog_evidence_identity",
  "ingestion_private"."msp_catalog_identity",
  "ingestion_private"."msp_catalog_source",
  "ingestion_private"."msp_catalog_title_identity"
  FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "catalog"."refresh_msp_public_projection"(
  p_publication_reviewed_by varchar(200),
  p_publication_review_reference text,
  p_expected_snapshot_id varchar(120),
  p_publication_reviewed_at timestamp with time zone
)
RETURNS TABLE (
  snapshot_id varchar(120),
  projected_professionals bigint,
  suppressed_professionals bigint,
  enabled_registered_titles bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_snapshot_id varchar(120);
  v_profile_count integer;
  v_actual_profile_count bigint;
  v_profiles_sha256 varchar(64);
  v_snapshot_imported_at timestamp with time zone;
  v_source_cutoff_date date;
  v_source_id uuid;
  v_source_release_id uuid;
  v_projection_at timestamp with time zone := pg_catalog.transaction_timestamp();
BEGIN
  IF length(trim(p_publication_reviewed_by)) = 0
    OR length(p_publication_reviewed_by) > 200
    OR p_publication_review_reference
      IS DISTINCT FROM
        'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos'
  THEN
    RAISE EXCEPTION 'An explicit operator review and the official MSP reference are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_expected_snapshot_id !~ '^factual-v3-[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'The expected MSP snapshot ID is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_publication_reviewed_at IS NULL
    OR p_publication_reviewed_at > v_projection_at + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'The MSP publication review timestamp is missing or in the future'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize with the factual-v3 import and with other projection runs.
  PERFORM pg_catalog.pg_advisory_xact_lock(1834104, 104234204);

  SELECT
    snapshot.snapshot_id,
    snapshot.profile_count,
    snapshot.profiles_sha256,
    snapshot.imported_at
  INTO
    v_snapshot_id,
    v_profile_count,
    v_profiles_sha256,
    v_snapshot_imported_at
  FROM ingestion_private.snapshot AS snapshot
  WHERE snapshot.snapshot_id = p_expected_snapshot_id;

  IF v_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'The expected private MSP directory snapshot is unavailable'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*)
  INTO v_actual_profile_count
  FROM ingestion_private.professional_profile AS profile
  WHERE profile.snapshot_id = v_snapshot_id;

  IF v_actual_profile_count <> v_profile_count THEN
    RAISE EXCEPTION
      'Latest private MSP snapshot is incomplete: expected %, found %',
      v_profile_count,
      v_actual_profile_count
      USING ERRCODE = '23514';
  END IF;

  -- Fail closed unless every row is the exact, approved MSP Infotítulos source.
  IF EXISTS (
    SELECT 1
    FROM ingestion_private.professional_profile AS profile
    WHERE profile.snapshot_id = v_snapshot_id
      AND (
        profile.official_registry ->> 'publisher'
          IS DISTINCT FROM 'Ministerio de Salud Pública'
        OR profile.official_registry ->> 'dataset'
          IS DISTINCT FROM 'Infotítulos'
        OR profile.official_registry ->> 'datasetUrl'
          IS DISTINCT FROM
            'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos'
        OR profile.official_registry ->> 'liveLookupUrl'
          IS DISTINCT FROM
            'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud'
        OR profile.official_registry ->> 'sourceCutoffDate'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      )
  ) THEN
    RAISE EXCEPTION 'Latest private snapshot contains a non-whitelisted registry source'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    min((profile.official_registry ->> 'sourceCutoffDate')::date),
    count(DISTINCT profile.official_registry ->> 'sourceCutoffDate')
  INTO v_source_cutoff_date, v_actual_profile_count
  FROM ingestion_private.professional_profile AS profile
  WHERE profile.snapshot_id = v_snapshot_id;

  IF v_actual_profile_count <> 1
    OR v_source_cutoff_date IS NULL
    OR v_source_cutoff_date > current_date
    OR now() >= v_source_cutoff_date::timestamp with time zone + interval '62 days'
  THEN
    RAISE EXCEPTION 'Latest private snapshot has an invalid or mixed MSP cutoff date'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ingestion_private.professional_profile AS profile
    CROSS JOIN LATERAL jsonb_array_elements(profile.registered_titles) AS registered_title(value)
    WHERE profile.snapshot_id = v_snapshot_id
      AND (
        jsonb_typeof(registered_title.value) <> 'object'
        OR length(trim(registered_title.value ->> 'title')) = 0
        OR registered_title.value ->> 'temporaryRegistration'
          NOT IN ('NONE', 'WITH_CONTRACT', 'WITHOUT_CONTRACT')
      )
  ) THEN
    RAISE EXCEPTION 'Latest private snapshot has an invalid registered title'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO ingestion_private.msp_catalog_source (
    source_key,
    source_id
  )
  VALUES (
    'msp_infotitulos',
    pg_catalog.gen_random_uuid()
  )
  ON CONFLICT (source_key) DO NOTHING;

  SELECT mapping.source_id
  INTO STRICT v_source_id
  FROM ingestion_private.msp_catalog_source AS mapping
  WHERE mapping.source_key = 'msp_infotitulos';

  INSERT INTO provenance.source (
    id,
    name,
    canonical_url,
    source_kind,
    publication_state,
    purpose_compatibility,
    reuse_basis,
    license_url,
    publication_policy_id,
    publication_reviewed_by,
    publication_reviewed_at,
    publication_review_reference,
    publication_valid_until
  )
  VALUES (
    v_source_id,
    'Ministerio de Salud Pública — Infotítulos',
    'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos',
    'OFFICIAL_PUBLICATION',
    'APPROVED',
    'COMPATIBLE',
    'OFFICIAL_PUBLICATION_REVIEW',
    NULL,
    'msp-infotitulos-official-fields-v1',
    p_publication_reviewed_by,
    p_publication_reviewed_at,
    p_publication_review_reference,
    v_source_cutoff_date::timestamp with time zone + interval '62 days'
  )
  ON CONFLICT (id) DO UPDATE
  SET
    name = EXCLUDED.name,
    canonical_url = EXCLUDED.canonical_url,
    source_kind = EXCLUDED.source_kind,
    purpose_compatibility = EXCLUDED.purpose_compatibility,
    reuse_basis = EXCLUDED.reuse_basis,
    license_url = EXCLUDED.license_url,
    publication_policy_id = EXCLUDED.publication_policy_id,
    publication_reviewed_by = EXCLUDED.publication_reviewed_by,
    publication_reviewed_at = EXCLUDED.publication_reviewed_at,
    publication_review_reference = EXCLUDED.publication_review_reference,
    publication_valid_until = EXCLUDED.publication_valid_until
  WHERE provenance.source.publication_state <> 'REVOKED';

  IF NOT EXISTS (
    SELECT 1
    FROM provenance.source AS source
    WHERE source.id = v_source_id
      AND source.publication_state = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'The MSP Infotítulos source is not approved'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO provenance.source_release (
    id,
    source_id,
    upstream_release_key,
    cutoff_date,
    retrieved_at,
    sha256
  )
  VALUES (
    pg_catalog.gen_random_uuid(),
    v_source_id,
    v_snapshot_id,
    v_source_cutoff_date,
    v_snapshot_imported_at,
    v_profiles_sha256
  )
  ON CONFLICT (source_id, upstream_release_key) DO NOTHING;

  SELECT release.id
  INTO STRICT v_source_release_id
  FROM provenance.source_release AS release
  WHERE release.source_id = v_source_id
    AND release.upstream_release_key = v_snapshot_id
    AND release.cutoff_date = v_source_cutoff_date
    AND release.retrieved_at = v_snapshot_imported_at
    AND release.sha256 = v_profiles_sha256;

  WITH generated_identity AS (
    SELECT
      profile.internal_hmac_id,
      profile.normalized_name,
      pg_catalog.gen_random_uuid() AS professional_id,
      pg_catalog.gen_random_uuid() AS professional_public_id
    FROM ingestion_private.professional_profile AS profile
    WHERE profile.snapshot_id = v_snapshot_id
  ),
  routed_identity AS (
    SELECT
      generated_identity.*,
      concat(
        left(
          coalesce(
            nullif(
              trim(
                both '-'
                FROM regexp_replace(
                  translate(
                    lower(generated_identity.normalized_name),
                    'áéíóúüñ',
                    'aeiouun'
                  ),
                  '[^a-z0-9]+',
                  '-',
                  'g'
                )
              ),
              ''
            ),
            'medico'
          ),
          160
        ),
        '-',
        left(replace(generated_identity.professional_public_id::text, '-', ''), 12)
      ) AS route_slug
    FROM generated_identity
  )
  INSERT INTO ingestion_private.msp_catalog_identity (
    internal_hmac_id,
    professional_id,
    professional_public_id,
    route_slug,
    last_seen_snapshot_id
  )
  SELECT
    routed_identity.internal_hmac_id,
    routed_identity.professional_id,
    routed_identity.professional_public_id,
    routed_identity.route_slug,
    v_snapshot_id
  FROM routed_identity
  ON CONFLICT (internal_hmac_id) DO UPDATE
  SET
    last_seen_snapshot_id = EXCLUDED.last_seen_snapshot_id,
    updated_at = v_projection_at;

  INSERT INTO ingestion_private.msp_catalog_evidence_identity (
    snapshot_id,
    internal_hmac_id,
    evidence_id,
    evidence_public_id
  )
  SELECT
    v_snapshot_id,
    profile.internal_hmac_id,
    pg_catalog.gen_random_uuid(),
    pg_catalog.gen_random_uuid()
  FROM ingestion_private.professional_profile AS profile
  WHERE profile.snapshot_id = v_snapshot_id
  ON CONFLICT ON CONSTRAINT pk_private_msp_catalog_evidence_identity DO NOTHING;

  INSERT INTO provenance.evidence_ref (
    id,
    public_id,
    source_release_id,
    canonical_url,
    observed_at,
    checksum,
    attribution,
    publication_state,
    confidence,
    valid_until
  )
  SELECT
    evidence_identity.evidence_id,
    evidence_identity.evidence_public_id,
    v_source_release_id,
    'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud',
    v_snapshot_imported_at,
    profile.record_sha256,
    'Ministerio de Salud Pública — Infotítulos',
    'APPROVED',
    'DETERMINISTIC',
    v_source_cutoff_date::timestamp with time zone + interval '62 days'
  FROM ingestion_private.professional_profile AS profile
  INNER JOIN ingestion_private.msp_catalog_evidence_identity AS evidence_identity
    ON evidence_identity.snapshot_id = profile.snapshot_id
    AND evidence_identity.internal_hmac_id = profile.internal_hmac_id
  WHERE profile.snapshot_id = v_snapshot_id
  ON CONFLICT (id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM ingestion_private.professional_profile AS profile
    INNER JOIN ingestion_private.msp_catalog_evidence_identity AS evidence_identity
      ON evidence_identity.snapshot_id = profile.snapshot_id
      AND evidence_identity.internal_hmac_id = profile.internal_hmac_id
    INNER JOIN provenance.evidence_ref AS evidence
      ON evidence.id = evidence_identity.evidence_id
    WHERE profile.snapshot_id = v_snapshot_id
      AND (
        evidence.public_id <> evidence_identity.evidence_public_id
        OR evidence.source_release_id <> v_source_release_id
        OR evidence.canonical_url
          <> 'https://www.gub.uy/tramites/infotitulos-consultas-registro-profesionales-salud'
        OR evidence.observed_at <> v_snapshot_imported_at
        OR evidence.checksum <> profile.record_sha256
        OR evidence.attribution <> 'Ministerio de Salud Pública — Infotítulos'
        OR evidence.publication_state <> 'APPROVED'
        OR evidence.confidence <> 'DETERMINISTIC'
        OR evidence.valid_until
          IS DISTINCT FROM
            v_source_cutoff_date::timestamp with time zone + interval '62 days'
      )
  ) THEN
    RAISE EXCEPTION 'Immutable MSP evidence does not match its private snapshot'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO catalog.professional (
    id,
    public_id,
    display_name,
    normalized_name,
    visibility,
    current_name_evidence_id
  )
  SELECT
    identity.professional_id,
    identity.professional_public_id,
    profile.display_name,
    lower(profile.normalized_name),
    'PUBLIC',
    evidence_identity.evidence_id
  FROM ingestion_private.professional_profile AS profile
  INNER JOIN ingestion_private.msp_catalog_identity AS identity
    ON identity.internal_hmac_id = profile.internal_hmac_id
  INNER JOIN ingestion_private.msp_catalog_evidence_identity AS evidence_identity
    ON evidence_identity.snapshot_id = profile.snapshot_id
    AND evidence_identity.internal_hmac_id = profile.internal_hmac_id
  WHERE profile.snapshot_id = v_snapshot_id
  ON CONFLICT (id) DO UPDATE
  SET
    display_name = EXCLUDED.display_name,
    normalized_name = EXCLUDED.normalized_name,
    visibility = CASE
      WHEN catalog.professional.visibility = 'SUPPRESSED'
        AND EXISTS (
          SELECT 1
          FROM ingestion_private.msp_catalog_identity AS identity
          WHERE identity.professional_id = catalog.professional.id
            AND identity.absent_suppression_applied
            AND identity.automatic_suppressed_at IS NOT NULL
            AND identity.automatic_suppressed_at = catalog.professional.updated_at
        )
      THEN 'PUBLIC'::catalog.professional_visibility
      ELSE catalog.professional.visibility
    END,
    current_name_evidence_id = EXCLUDED.current_name_evidence_id,
    updated_at = v_projection_at;

  INSERT INTO catalog.professional_route (
    slug,
    professional_id,
    route_kind
  )
  SELECT
    identity.route_slug,
    identity.professional_id,
    'CURRENT'
  FROM ingestion_private.msp_catalog_identity AS identity
  WHERE identity.last_seen_snapshot_id = v_snapshot_id
  ON CONFLICT (slug) DO UPDATE
  SET route_kind = 'CURRENT'
  WHERE catalog.professional_route.professional_id = EXCLUDED.professional_id;

  WITH current_titles AS (
    SELECT DISTINCT ON (
      profile.internal_hmac_id,
      lower(regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g'))
    )
      profile.internal_hmac_id,
      lower(
        regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g')
      ) AS normalized_title
    FROM ingestion_private.professional_profile AS profile
    CROSS JOIN LATERAL jsonb_array_elements(profile.registered_titles) AS registered_title(value)
    WHERE profile.snapshot_id = v_snapshot_id
    ORDER BY
      profile.internal_hmac_id,
      lower(regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g'))
  )
  INSERT INTO ingestion_private.msp_catalog_title_identity (
    internal_hmac_id,
    normalized_title,
    registered_title_id,
    registered_title_public_id
  )
  SELECT
    current_titles.internal_hmac_id,
    current_titles.normalized_title,
    pg_catalog.gen_random_uuid(),
    pg_catalog.gen_random_uuid()
  FROM current_titles
  ON CONFLICT (internal_hmac_id, normalized_title) DO NOTHING;

  WITH current_titles AS (
    SELECT DISTINCT
      profile.internal_hmac_id,
      lower(
        regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g')
      ) AS normalized_title
    FROM ingestion_private.professional_profile AS profile
    CROSS JOIN LATERAL jsonb_array_elements(profile.registered_titles) AS registered_title(value)
    WHERE profile.snapshot_id = v_snapshot_id
  )
  UPDATE credentials.registered_title AS registered_title
  SET
    registration_state = 'WITHDRAWN',
    updated_at = v_projection_at
  FROM ingestion_private.msp_catalog_title_identity AS title_identity
  WHERE title_identity.registered_title_id = registered_title.id
    AND registered_title.registration_state = 'ENABLED'
    AND NOT EXISTS (
      SELECT 1
      FROM current_titles
      WHERE current_titles.internal_hmac_id = title_identity.internal_hmac_id
        AND current_titles.normalized_title = title_identity.normalized_title
    );

  WITH current_titles AS (
    SELECT
      profile.internal_hmac_id,
      min(trim(registered_title.value ->> 'title')) AS title,
      lower(
        regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g')
      ) AS normalized_title,
      CASE max(
        CASE registered_title.value ->> 'temporaryRegistration'
          WHEN 'WITHOUT_CONTRACT' THEN 2
          WHEN 'WITH_CONTRACT' THEN 1
          ELSE 0
        END
      )
        WHEN 2 THEN 'WITHOUT_CONTRACT'
        WHEN 1 THEN 'WITH_CONTRACT'
        ELSE 'NONE'
      END AS temporary_registration
    FROM ingestion_private.professional_profile AS profile
    CROSS JOIN LATERAL jsonb_array_elements(profile.registered_titles) AS registered_title(value)
    WHERE profile.snapshot_id = v_snapshot_id
    GROUP BY
      profile.internal_hmac_id,
      lower(regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g'))
  )
  INSERT INTO credentials.registered_title (
    id,
    public_id,
    professional_id,
    title,
    normalized_title,
    registration_state,
    temporary_registration,
    current_evidence_id
  )
  SELECT
    title_identity.registered_title_id,
    title_identity.registered_title_public_id,
    identity.professional_id,
    current_titles.title,
    current_titles.normalized_title,
    'ENABLED',
    current_titles.temporary_registration::credentials.temporary_registration_kind,
    evidence_identity.evidence_id
  FROM current_titles
  INNER JOIN ingestion_private.msp_catalog_identity AS identity
    ON identity.internal_hmac_id = current_titles.internal_hmac_id
  INNER JOIN ingestion_private.msp_catalog_evidence_identity AS evidence_identity
    ON evidence_identity.snapshot_id = v_snapshot_id
    AND evidence_identity.internal_hmac_id = current_titles.internal_hmac_id
  INNER JOIN ingestion_private.msp_catalog_title_identity AS title_identity
    ON title_identity.internal_hmac_id = current_titles.internal_hmac_id
    AND title_identity.normalized_title = current_titles.normalized_title
  ON CONFLICT (id) DO UPDATE
  SET
    title = EXCLUDED.title,
    normalized_title = EXCLUDED.normalized_title,
    registration_state = CASE
      WHEN credentials.registered_title.registration_state IN ('DISABLED', 'UNDER_REVIEW')
      THEN credentials.registered_title.registration_state
      ELSE 'ENABLED'::credentials.registered_title_state
    END,
    temporary_registration = EXCLUDED.temporary_registration,
    current_evidence_id = EXCLUDED.current_evidence_id,
    updated_at = v_projection_at;

  INSERT INTO provenance.evidence_claim (
    evidence_id,
    subject_id,
    claim_kind,
    normalized_value
  )
  SELECT
    evidence_identity.evidence_id,
    identity.professional_id,
    'PROFESSIONAL_NAME',
    lower(profile.normalized_name)
  FROM ingestion_private.professional_profile AS profile
  INNER JOIN ingestion_private.msp_catalog_identity AS identity
    ON identity.internal_hmac_id = profile.internal_hmac_id
  INNER JOIN ingestion_private.msp_catalog_evidence_identity AS evidence_identity
    ON evidence_identity.snapshot_id = profile.snapshot_id
    AND evidence_identity.internal_hmac_id = profile.internal_hmac_id
  WHERE profile.snapshot_id = v_snapshot_id
  ON CONFLICT DO NOTHING;

  WITH current_titles AS (
    SELECT DISTINCT
      profile.internal_hmac_id,
      lower(
        regexp_replace(trim(registered_title.value ->> 'title'), '[[:space:]]+', ' ', 'g')
      ) AS normalized_title
    FROM ingestion_private.professional_profile AS profile
    CROSS JOIN LATERAL jsonb_array_elements(profile.registered_titles) AS registered_title(value)
    WHERE profile.snapshot_id = v_snapshot_id
  )
  INSERT INTO provenance.evidence_claim (
    evidence_id,
    subject_id,
    claim_kind,
    normalized_value
  )
  SELECT
    evidence_identity.evidence_id,
    identity.professional_id,
    'REGISTERED_TITLE',
    registered_title.normalized_title
  FROM current_titles
  INNER JOIN ingestion_private.msp_catalog_identity AS identity
    ON identity.internal_hmac_id = current_titles.internal_hmac_id
  INNER JOIN ingestion_private.msp_catalog_evidence_identity AS evidence_identity
    ON evidence_identity.snapshot_id = v_snapshot_id
    AND evidence_identity.internal_hmac_id = identity.internal_hmac_id
  INNER JOIN ingestion_private.msp_catalog_title_identity AS title_identity
    ON title_identity.internal_hmac_id = identity.internal_hmac_id
    AND title_identity.normalized_title = current_titles.normalized_title
  INNER JOIN credentials.registered_title AS registered_title
    ON registered_title.id = title_identity.registered_title_id
  ON CONFLICT DO NOTHING;

  UPDATE provenance.evidence_ref AS evidence
  SET publication_state = 'REVOKED'
  FROM ingestion_private.msp_catalog_evidence_identity AS evidence_identity
  WHERE evidence_identity.evidence_id = evidence.id
    AND evidence_identity.snapshot_id <> v_snapshot_id
    AND evidence.publication_state = 'APPROVED';

  WITH newly_suppressed AS (
    UPDATE catalog.professional AS professional
    SET
      visibility = 'SUPPRESSED',
      updated_at = v_projection_at
    FROM ingestion_private.msp_catalog_identity AS identity
    WHERE identity.professional_id = professional.id
      AND identity.last_seen_snapshot_id <> v_snapshot_id
      AND professional.visibility = 'PUBLIC'
    RETURNING professional.id
  )
  UPDATE ingestion_private.msp_catalog_identity AS identity
  SET
    absent_suppression_applied = true,
    automatic_suppressed_at = v_projection_at,
    updated_at = v_projection_at
  FROM newly_suppressed
  WHERE newly_suppressed.id = identity.professional_id;

  UPDATE ingestion_private.msp_catalog_identity AS identity
  SET
    absent_suppression_applied = false,
    automatic_suppressed_at = NULL,
    updated_at = v_projection_at
  FROM catalog.professional AS professional
  WHERE identity.last_seen_snapshot_id = v_snapshot_id
    AND professional.id = identity.professional_id
    AND professional.visibility = 'PUBLIC';

  RETURN QUERY
  SELECT
    v_snapshot_id,
    count(*) FILTER (WHERE identity.last_seen_snapshot_id = v_snapshot_id),
    count(*) FILTER (WHERE identity.last_seen_snapshot_id <> v_snapshot_id),
    (
      SELECT count(*)
      FROM credentials.registered_title AS registered_title
      INNER JOIN ingestion_private.msp_catalog_title_identity AS title_identity
        ON title_identity.registered_title_id = registered_title.id
      WHERE registered_title.registration_state = 'ENABLED'
    )
  FROM ingestion_private.msp_catalog_identity AS identity;
END;
$$;--> statement-breakpoint
COMMENT ON FUNCTION "catalog"."refresh_msp_public_projection"(varchar, text, varchar, timestamp with time zone) IS
  'Projects only whitelisted MSP Infotítulos names and registered titles from the latest complete private snapshot.';--> statement-breakpoint
REVOKE ALL ON FUNCTION "catalog"."refresh_msp_public_projection"(varchar, text, varchar, timestamp with time zone)
  FROM PUBLIC, medicos_catalog_reader;--> statement-breakpoint
GRANT USAGE ON SCHEMA "catalog" TO medicos_private_ingestor;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "catalog"."refresh_msp_public_projection"(varchar, text, varchar, timestamp with time zone)
  TO medicos_private_ingestor;
