\set ON_ERROR_STOP on

BEGIN READ ONLY;

DO $verification$
DECLARE
  private_table_count integer;
  unexpected_reader_privileges integer;
  forbidden_ingestor_privileges integer;
BEGIN
  IF to_regnamespace('research_private') IS NULL THEN
    RAISE EXCEPTION 'research_private schema is missing';
  END IF;

  SELECT count(*)
  INTO private_table_count
  FROM information_schema.tables
  WHERE table_schema = 'research_private'
    AND table_type = 'BASE TABLE';

  IF private_table_count <> 7 THEN
    RAISE EXCEPTION 'expected 7 research_private tables, found %', private_table_count;
  END IF;

  IF to_regclass('research_private.latest_professional_dossier') IS NULL THEN
    RAISE EXCEPTION 'latest_professional_dossier view is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = 'research_private.latest_professional_dossier'::regclass
      AND COALESCE(reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'latest_professional_dossier must use security_invoker=true';
  END IF;

  SELECT count(*)
  INTO unexpected_reader_privileges
  FROM information_schema.role_table_grants
  WHERE table_schema = 'research_private'
    AND grantee IN ('PUBLIC', 'medicos_catalog_reader', 'medicos_public_query');

  IF unexpected_reader_privileges <> 0 THEN
    RAISE EXCEPTION 'a public/catalog reader has research_private table privileges';
  END IF;

  SELECT count(*)
  INTO forbidden_ingestor_privileges
  FROM information_schema.role_table_grants
  WHERE table_schema = 'research_private'
    AND grantee = 'medicos_private_ingestor'
    AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');

  IF forbidden_ingestor_privileges <> 0 THEN
    RAISE EXCEPTION 'the private ingestor has a forbidden destructive privilege';
  END IF;

  IF NOT has_schema_privilege(
    'medicos_private_ingestor',
    'research_private',
    'USAGE'
  ) THEN
    RAISE EXCEPTION 'the private ingestor cannot use research_private';
  END IF;

  IF has_schema_privilege('medicos_public_query', 'research_private', 'USAGE') THEN
    RAISE EXCEPTION 'the public API role can use research_private';
  END IF;
END
$verification$;

SELECT
  (SELECT count(*) FROM ingestion_private.professional_profile) AS private_profiles,
  (SELECT count(*) FROM research_private.analysis_run) AS analysis_runs,
  (SELECT count(*) FROM research_private.work_item) AS work_items,
  (SELECT count(*) FROM research_private.professional_dossier) AS dossiers,
  (SELECT count(*) FROM research_private.candidate) AS candidates,
  has_table_privilege(
    'medicos_private_ingestor',
    'research_private.analysis_run',
    'SELECT,INSERT,UPDATE'
  ) AS ingestor_run_access,
  has_table_privilege(
    'medicos_private_ingestor',
    'research_private.professional_dossier',
    'SELECT,INSERT'
  ) AS ingestor_immutable_dossier_access,
  has_table_privilege(
    'medicos_private_ingestor',
    'research_private.current_professional_dossier',
    'SELECT,INSERT,UPDATE'
  ) AS ingestor_current_pointer_access,
  NOT has_table_privilege(
    'medicos_public_query',
    'research_private.latest_professional_dossier',
    'SELECT'
  ) AS public_api_denied;

ROLLBACK;
