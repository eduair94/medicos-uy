CREATE OR REPLACE FUNCTION "catalog"."analyze_msp_public_projection"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  ANALYZE
    "catalog"."professional",
    "catalog"."professional_route",
    "credentials"."registered_title",
    "provenance"."source",
    "provenance"."source_release",
    "provenance"."evidence_ref",
    "provenance"."evidence_claim",
    "ingestion_private"."msp_catalog_source",
    "ingestion_private"."msp_catalog_identity",
    "ingestion_private"."msp_catalog_evidence_identity",
    "ingestion_private"."msp_catalog_title_identity";
END;
$$;
--> statement-breakpoint
COMMENT ON FUNCTION "catalog"."analyze_msp_public_projection"() IS
  'Refreshes planner statistics for the fixed set of relations changed by the official MSP projection.';
--> statement-breakpoint
REVOKE ALL ON FUNCTION "catalog"."analyze_msp_public_projection"()
  FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "catalog"."analyze_msp_public_projection"()
  TO medicos_private_ingestor;
