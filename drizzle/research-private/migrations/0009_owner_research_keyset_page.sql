BEGIN;

/*
 * Bounded owner-only list read path.
 *
 * The security-barrier dossier view remains the lookup boundary for individual
 * records.  It is intentionally not used for the list endpoint: PostgreSQL may
 * evaluate its JSON sanitizer for every visible dossier before applying the
 * caller's LIMIT.  This function materializes at most 51 unsanitized rows
 * first, then sanitizes only that bounded page.
 */
CREATE FUNCTION research_private.list_owner_professional_dossiers_page(
  after_route_slug text,
  after_professional_public_id uuid,
  requested_limit integer
)
RETURNS TABLE (
  professional_public_id uuid,
  route_slug text,
  analysis_version text,
  run_status text,
  report_id text,
  generated_at timestamptz,
  query_ambiguity text,
  best_flexibility_index smallint,
  candidate_count integer,
  official_registry_record_count integer,
  institutional_candidate_count integer,
  schedule_record_count integer,
  web_candidate_count integer,
  public_reference_candidate_count integer,
  ethics_candidate_count integer,
  research_view jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF requested_limit IS NULL OR requested_limit < 1 OR requested_limit > 51 THEN
    RAISE EXCEPTION 'requested_limit must be between 1 and 51'
      USING ERRCODE = '22023';
  END IF;

  IF (after_route_slug IS NULL) <> (after_professional_public_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor fields must be null or non-null'
      USING ERRCODE = '22023';
  END IF;

  IF after_route_slug IS NOT NULL
    AND (
      length(after_route_slug) > 200
      OR after_route_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    )
  THEN
    RAISE EXCEPTION 'after_route_slug is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH page AS MATERIALIZED (
    SELECT
      identity.professional_public_id,
      route.slug::text AS route_slug,
      run.analysis_version::text AS analysis_version,
      run.status::text AS run_status,
      dossier.report_id::text AS report_id,
      dossier.generated_at,
      dossier.query_ambiguity::text AS query_ambiguity,
      dossier.best_flexibility_index,
      dossier.candidate_count,
      dossier.official_registry_record_count,
      dossier.institutional_candidate_count,
      dossier.schedule_record_count,
      dossier.web_candidate_count,
      dossier.public_reference_candidate_count,
      dossier.ethics_candidate_count,
      dossier.research_view
    FROM ingestion_private.msp_catalog_identity AS identity
    INNER JOIN catalog.public_professional AS professional
      ON professional.id = identity.professional_public_id
    INNER JOIN catalog.public_professional_route AS route
      ON route.professional_id = identity.professional_public_id
      AND route.route_kind = 'CURRENT'
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
      AND run.status IN ('COMPLETED', 'PARTIAL')
      AND (
        after_route_slug IS NULL
        OR (
          route.slug,
          identity.professional_public_id
        ) > (
          after_route_slug,
          after_professional_public_id
        )
      )
    ORDER BY route.slug ASC, identity.professional_public_id ASC
    LIMIT requested_limit
  )
  SELECT
    page.professional_public_id,
    page.route_slug,
    page.analysis_version,
    page.run_status,
    page.report_id,
    page.generated_at,
    page.query_ambiguity,
    page.best_flexibility_index,
    page.candidate_count,
    page.official_registry_record_count,
    page.institutional_candidate_count,
    page.schedule_record_count,
    page.web_candidate_count,
    page.public_reference_candidate_count,
    page.ethics_candidate_count,
    research_private.sanitize_owner_research_view(page.research_view)
  FROM page
  ORDER BY page.route_slug ASC, page.professional_public_id ASC;
END;
$function$;

REVOKE ALL ON FUNCTION
  research_private.list_owner_professional_dossiers_page(text, uuid, integer)
  FROM
    PUBLIC,
    medicos_catalog_reader,
    medicos_public_query,
    medicos_private_ingestor,
    medicos_owner_research_reader;

GRANT EXECUTE ON FUNCTION
  research_private.list_owner_professional_dossiers_page(text, uuid, integer)
  TO medicos_owner_research_reader;

COMMIT;
