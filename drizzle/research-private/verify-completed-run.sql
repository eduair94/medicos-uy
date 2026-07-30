\set ON_ERROR_STOP on

BEGIN READ ONLY;

DO $verification$
DECLARE
  latest_run_id varchar(96);
  latest_snapshot_id varchar(120);
  latest_status varchar(16);
  expected_profiles bigint;
  successful_items bigint;
  dossier_records bigint;
  current_records bigint;
  unsafe_dossiers bigint;
  invalid_ethics_coverage bigint;
BEGIN
  SELECT run_id, snapshot_id, status
  INTO latest_run_id, latest_snapshot_id, latest_status
  FROM research_private.analysis_run
  ORDER BY created_at DESC, run_id DESC
  LIMIT 1;

  IF latest_run_id IS NULL OR latest_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'latest private analysis run is not completed';
  END IF;

  SELECT count(*)
  INTO expected_profiles
  FROM ingestion_private.professional_profile
  WHERE snapshot_id = latest_snapshot_id;

  SELECT count(*)
  INTO successful_items
  FROM research_private.work_item
  WHERE run_id = latest_run_id
    AND status = 'SUCCEEDED';

  SELECT count(*)
  INTO dossier_records
  FROM research_private.professional_dossier
  WHERE run_id = latest_run_id;

  SELECT count(*)
  INTO current_records
  FROM research_private.current_professional_dossier
  WHERE run_id = latest_run_id;

  IF expected_profiles = 0
    OR successful_items <> expected_profiles
    OR dossier_records <> expected_profiles
    OR current_records <> expected_profiles
  THEN
    RAISE EXCEPTION
      'profile/work/dossier/current counts differ: expected %, work %, dossier %, current %',
      expected_profiles,
      successful_items,
      dossier_records,
      current_records;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM research_private.work_item
    WHERE run_id = latest_run_id
      AND status <> 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'latest run has a non-successful work item';
  END IF;

  SELECT count(*)
  INTO unsafe_dossiers
  FROM research_private.professional_dossier
  WHERE run_id = latest_run_id
    AND (
      research_view #>> '{delivery,intendedSurface}' <>
        'AUTHENTICATED_PRIVATE_API'
      OR research_view #>> '{delivery,publicApiDeliveryAllowed}' <> 'false'
      OR research_view #>> '{publication,publicExportAllowed}' <> 'false'
      OR research_view #>> '{publication,automaticIdentityConfirmation}' <> 'false'
      OR research_view #>> '{publication,automaticFactConfirmation}' <> 'false'
    );

  IF unsafe_dossiers <> 0 THEN
    RAISE EXCEPTION '% dossiers violate the private publication boundary', unsafe_dossiers;
  END IF;

  SELECT count(*)
  INTO invalid_ethics_coverage
  FROM research_private.professional_dossier
  WHERE run_id = latest_run_id
    AND (
      research_view #>> '{candidates,0,sourceCoverage,0,sourceUrl}' IS DISTINCT FROM
        'https://www.colegiomedico.org.uy/fallos-sitemap.xml'
      OR research_view #>> '{candidates,0,sourceCoverage,0,status}' IS DISTINCT FROM
        'CHECKED'
      OR research_view #>> '{candidates,0,sourceCoverage,0,automatedFetchPerformed}' IS DISTINCT FROM
        'true'
      OR research_view #>> '{candidates,0,sourceCoverage,0,identityDecision}' IS DISTINCT FROM
        'NOT_LINKED'
      OR research_view #>> '{candidates,0,sourceCoverage,0,noFindingProvesAbsence}' IS DISTINCT FROM
        'false'
      OR COALESCE(
        jsonb_array_length(
          research_view #> '{candidates,0,ethicsCaseCandidates}'
        ),
        0
      ) <> ethics_candidate_count
      OR (
        SELECT count(*)
        FROM research_private.professional_ethics_candidate AS ethics_candidate
        WHERE ethics_candidate.run_id = latest_run_id
          AND ethics_candidate.internal_hmac_id =
            professional_dossier.internal_hmac_id
      ) <> ethics_candidate_count
      OR (
        SELECT count(*)
        FROM research_private.candidate AS candidate
        WHERE candidate.run_id = latest_run_id
          AND candidate.internal_hmac_id =
            professional_dossier.internal_hmac_id
          AND candidate.candidate_kind = 'ETHICS_CASE_REFERENCE'
      ) <> ethics_candidate_count
    );

  IF invalid_ethics_coverage <> 0 THEN
    RAISE EXCEPTION '% dossiers have invalid ethics-source coverage', invalid_ethics_coverage;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM research_private.professional_ethics_candidate
    WHERE run_id = latest_run_id
      AND (
        match_kind NOT IN (
          'EXACT_NORMALIZED_NAME',
          'EXACT_TOKEN_MULTISET',
          'PARTIAL_TOKEN_SUBSET'
        )
        OR (
          match_kind IN ('EXACT_NORMALIZED_NAME', 'EXACT_TOKEN_MULTISET')
          AND match_flexibility_index <> 0
        )
        OR (
          match_kind = 'PARTIAL_TOKEN_SUBSET'
          AND match_flexibility_index <> 1
        )
        OR candidate_status <> 'UNVERIFIED_REVIEW_CANDIDATE'
        OR identity_confirmed
        OR fact_confirmed
        OR NOT requires_human_review
      )
  ) THEN
    RAISE EXCEPTION 'latest run contains an unsafe ethics candidate';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM research_private.ethics_case
    WHERE collection_mode = 'AUTOMATED_PUBLIC_METADATA_SNAPSHOT'
      AND (
        outcome <> 'UNKNOWN'
        OR finality_status <> 'UNKNOWN'
        OR currentness_verified
        OR document_sha256 IS NOT NULL
        OR content_stored
        OR NOT (
          source_metadata @> '{
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
      )
  ) THEN
    RAISE EXCEPTION 'automated ethics metadata violates its safety contract';
  END IF;
END
$verification$;

SELECT
  run.run_id,
  run.snapshot_id,
  run.status,
  count(DISTINCT work_item.internal_hmac_id) AS successful_profiles,
  count(DISTINCT dossier.internal_hmac_id) AS dossiers,
  count(candidate.candidate_key) AS review_candidates
FROM research_private.analysis_run AS run
JOIN research_private.work_item AS work_item
  ON work_item.run_id = run.run_id
  AND work_item.status = 'SUCCEEDED'
JOIN research_private.professional_dossier AS dossier
  ON dossier.run_id = run.run_id
  AND dossier.internal_hmac_id = work_item.internal_hmac_id
LEFT JOIN research_private.candidate AS candidate
  ON candidate.run_id = dossier.run_id
  AND candidate.internal_hmac_id = dossier.internal_hmac_id
WHERE run.run_id = (
  SELECT run_id
  FROM research_private.analysis_run
  ORDER BY created_at DESC, run_id DESC
  LIMIT 1
)
GROUP BY run.run_id, run.snapshot_id, run.status;

SELECT
  research_view #>> '{candidates,0,professional,fullName}' AS professional,
  official_registry_record_count AS registry_records,
  institutional_candidate_count AS institutions,
  schedule_record_count AS schedules,
  web_candidate_count AS web_candidates,
  public_reference_candidate_count AS public_references,
  ethics_candidate_count AS ethics_candidates,
  research_view #>> '{candidates,0,sourceCoverage,0,status}' AS ethics_source_status,
  research_view #>> '{candidates,0,sourceCoverage,0,automatedFetchPerformed}'
    AS ethics_automated_fetch
FROM research_private.latest_professional_dossier
WHERE research_view #>> '{candidates,0,professional,fullName}' =
  'TAMARA - DIAZ SANZ FERNANDEZ';

ROLLBACK;
