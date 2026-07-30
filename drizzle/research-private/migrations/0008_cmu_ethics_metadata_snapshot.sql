BEGIN;

/*
 * CMU ethics metadata ingestion.
 *
 * Only metadata from the robots-allowed sitemap and individual case landing
 * pages may enter this model. Document bodies and /wp-content/uploads assets
 * remain outside the collection boundary.
 */

ALTER TABLE research_private.ethics_case
  DROP CONSTRAINT ck_research_ethics_case_collection_mode;

ALTER TABLE research_private.ethics_case
  ADD CONSTRAINT ck_research_ethics_case_collection_mode
  CHECK (
    collection_mode IN (
      'MANUALLY_CURATED_UNVERIFIED_CURRENTNESS',
      'AUTOMATED_PUBLIC_METADATA_SNAPSHOT'
    )
  );

ALTER TABLE research_private.ethics_case
  DROP CONSTRAINT IF EXISTS ck_research_ethics_case_automated_metadata;

ALTER TABLE research_private.ethics_case
  ADD CONSTRAINT ck_research_ethics_case_automated_metadata
  CHECK (
    collection_mode <> 'AUTOMATED_PUBLIC_METADATA_SNAPSHOT'
    OR (
      outcome = 'UNKNOWN'
      AND finality_status = 'UNKNOWN'
      AND currentness_verified = false
      AND document_sha256 IS NULL
      AND content_stored = false
      AND source_metadata @> '{
        "safeguards": {
          "pageMetadataOnly": true,
          "pdfFetched": false,
          "documentContentFetched": false,
          "automaticIdentityConfirmation": false,
          "automaticFactConfirmation": false,
          "publicExportAllowed": false
        }
      }'::jsonb
    )
  );

ALTER TABLE research_private.professional_ethics_candidate
  DROP CONSTRAINT ck_research_professional_ethics_candidate_name,
  DROP CONSTRAINT ck_research_professional_ethics_candidate_match_kind,
  DROP CONSTRAINT ck_research_professional_ethics_candidate_flexibility,
  DROP CONSTRAINT ck_research_professional_ethics_candidate_status;

UPDATE research_private.professional_ethics_candidate
SET candidate_status = 'UNVERIFIED_REVIEW_CANDIDATE'
WHERE candidate_status = 'CANDIDATE_EXACT_REVIEW_REQUIRED';

ALTER TABLE research_private.professional_ethics_candidate
  ALTER COLUMN candidate_status SET DEFAULT 'UNVERIFIED_REVIEW_CANDIDATE',
  ADD CONSTRAINT ck_research_professional_ethics_candidate_name
    CHECK (
      trim(observed_name) ~ '^[^[:space:]]+[[:space:]]+[^[:space:]]+'
    ),
  ADD CONSTRAINT ck_research_professional_ethics_candidate_match_kind
    CHECK (
      match_kind IN (
        'EXACT_NORMALIZED_NAME',
        'EXACT_TOKEN_MULTISET',
        'PARTIAL_TOKEN_SUBSET'
      )
    ),
  ADD CONSTRAINT ck_research_professional_ethics_candidate_flexibility
    CHECK (
      (
        match_kind IN ('EXACT_NORMALIZED_NAME', 'EXACT_TOKEN_MULTISET')
        AND match_flexibility_index = 0
      )
      OR (
        match_kind = 'PARTIAL_TOKEN_SUBSET'
        AND match_flexibility_index = 1
      )
    ),
  ADD CONSTRAINT ck_research_professional_ethics_candidate_status
    CHECK (candidate_status = 'UNVERIFIED_REVIEW_CANDIDATE');

ALTER TABLE research_private.professional_dossier
  DROP CONSTRAINT ck_research_professional_dossier_contract;

ALTER TABLE research_private.professional_dossier
  ADD CONSTRAINT ck_research_professional_dossier_contract
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
    AND COALESCE(
      research_view #>> '{candidates,0,signalSummary,ethicsCandidates}',
      '0'
    ) = ethics_candidate_count::text
  );

DROP VIEW research_private.owner_professional_dossier;

ALTER FUNCTION research_private.sanitize_owner_research_view(jsonb)
  RENAME TO sanitize_owner_research_view_v1;

CREATE FUNCTION research_private.sanitize_owner_research_view(
  input jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  WITH base AS (
    SELECT research_private.sanitize_owner_research_view_v1(input) AS value
  ),
  enriched_candidates AS (
    SELECT COALESCE(
      jsonb_agg(
        base_candidate
        || jsonb_build_object(
          'ethicsCaseCandidates',
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'ethicsCase',
                  research_private.owner_jsonb_pick(
                    ethics_candidate -> 'ethicsCase',
                    ARRAY[
                      'schemaVersion',
                      'ethicsCaseId',
                      'sourceCaseKey',
                      'publisher',
                      'tribunal',
                      'title',
                      'canonicalUrl',
                      'collectionMode',
                      'visibility',
                      'outcome',
                      'finalityStatus',
                      'currentnessVerified',
                      'sourceDate',
                      'sourceDatePrecision',
                      'observedRespondentNames',
                      'firstObservedAt',
                      'lastObservedAt',
                      'contentStored'
                    ]
                  )
                  || jsonb_build_object(
                    'documents',
                    COALESCE(
                      (
                        SELECT jsonb_agg(
                          research_private.owner_jsonb_pick(
                            document,
                            ARRAY[
                              'label',
                              'sourceDate',
                              'sourceDatePrecision',
                              'contentFetched'
                            ]
                          )
                          ORDER BY document_order
                        )
                        FROM jsonb_array_elements(
                          COALESCE(
                            ethics_candidate #> '{ethicsCase,documents}',
                            '[]'::jsonb
                          )
                        ) WITH ORDINALITY AS documents(document, document_order)
                      ),
                      '[]'::jsonb
                    ),
                    'source',
                    research_private.owner_jsonb_pick(
                      ethics_candidate #> '{ethicsCase,source}',
                      ARRAY[
                        'sitemapUrl',
                        'sitemapLastModified',
                        'robotsUrl',
                        'pageMetadataOnly'
                      ]
                    )
                  ),
                  'observedName',
                  ethics_candidate -> 'observedName',
                  'nameMatch',
                  research_private.owner_jsonb_pick(
                    ethics_candidate -> 'nameMatch',
                    ARRAY[
                      'kind',
                      'flexibilityIndex',
                      'canonicalTokenCount',
                      'observedTokenCount',
                      'exactObservedTokenCount',
                      'initialObservedTokenCount',
                      'meaning'
                    ]
                  ),
                  'decision',
                  research_private.owner_jsonb_pick(
                    ethics_candidate -> 'decision',
                    ARRAY[
                      'identityConfirmed',
                      'factConfirmed',
                      'linkageDecision',
                      'publicationDecision',
                      'publicExportAllowed',
                      'requiresHumanReview'
                    ]
                  ),
                  'alerts',
                  COALESCE(ethics_candidate -> 'alerts', '[]'::jsonb)
                )
                ORDER BY ethics_candidate_order
              )
              FROM jsonb_array_elements(
                COALESCE(
                  input_candidate -> 'ethicsCaseCandidates',
                  '[]'::jsonb
                )
              ) WITH ORDINALITY AS ethics_candidates(
                ethics_candidate,
                ethics_candidate_order
              )
            ),
            '[]'::jsonb
          ),
          'signalSummary',
          COALESCE(base_candidate -> 'signalSummary', '{}'::jsonb)
          || jsonb_build_object(
            'ethicsCandidates',
            COALESCE(
              input_candidate #> '{signalSummary,ethicsCandidates}',
              '0'::jsonb
            )
          )
        )
        ORDER BY candidate_order
      ),
      '[]'::jsonb
    ) AS value
    FROM base
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(base.value -> 'candidates', '[]'::jsonb)
    ) WITH ORDINALITY AS base_candidates(base_candidate, candidate_order)
    CROSS JOIN LATERAL (
      SELECT input -> 'candidates' -> ((candidate_order - 1)::integer)
        AS input_candidate
    ) AS source_candidate
  )
  SELECT
    jsonb_set(
      jsonb_set(
        base.value,
        '{candidates}',
        enriched_candidates.value,
        true
      ),
      '{coverage}',
      COALESCE(base.value -> 'coverage', '{}'::jsonb)
      || jsonb_build_object(
        'ethicsMetadataSnapshotChecked',
        COALESCE(
          input #> '{coverage,ethicsMetadataSnapshotChecked}',
          'false'::jsonb
        ),
        'ethicsCasesObserved',
        COALESCE(
          input #> '{coverage,ethicsCasesObserved}',
          '0'::jsonb
        )
      ),
      true
    )
  FROM base
  CROSS JOIN enriched_candidates;
$function$;

CREATE VIEW research_private.owner_professional_dossier
WITH (security_barrier = true)
AS
SELECT
  identity.professional_public_id,
  route.slug AS route_slug,
  route.route_kind,
  run.analysis_version,
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
  research_private.sanitize_owner_research_view(dossier.research_view) AS research_view
FROM ingestion_private.msp_catalog_identity AS identity
INNER JOIN catalog.public_professional AS professional
  ON professional.id = identity.professional_public_id
INNER JOIN catalog.public_professional_route AS route
  ON route.professional_id = identity.professional_public_id
INNER JOIN research_private.current_professional_dossier AS current_dossier
  ON current_dossier.internal_hmac_id = identity.internal_hmac_id
INNER JOIN research_private.professional_dossier AS dossier
  ON dossier.internal_hmac_id = identity.internal_hmac_id
  AND dossier.run_id = current_dossier.run_id
INNER JOIN research_private.analysis_run AS run
  ON run.run_id = dossier.run_id
INNER JOIN research_private.work_item AS work_item
  ON work_item.run_id = dossier.run_id
  AND work_item.internal_hmac_id = dossier.internal_hmac_id
WHERE work_item.status = 'SUCCEEDED'
  AND run.status IN ('COMPLETED', 'PARTIAL');

REVOKE ALL ON research_private.owner_professional_dossier
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

REVOKE ALL ON FUNCTION research_private.sanitize_owner_research_view_v1(jsonb)
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

REVOKE ALL ON FUNCTION research_private.sanitize_owner_research_view(jsonb)
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

GRANT EXECUTE ON FUNCTION research_private.sanitize_owner_research_view_v1(jsonb)
  TO medicos_owner_research_reader;
GRANT EXECUTE ON FUNCTION research_private.sanitize_owner_research_view(jsonb)
  TO medicos_owner_research_reader;
GRANT SELECT ON research_private.owner_professional_dossier
  TO medicos_owner_research_reader;

COMMIT;
