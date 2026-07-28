DROP VIEW "credentials"."public_registered_title";--> statement-breakpoint
DROP VIEW "catalog"."public_professional_route";--> statement-breakpoint
DROP VIEW "catalog"."public_professional";--> statement-breakpoint
DROP VIEW "provenance"."public_evidence_ref";--> statement-breakpoint
ALTER TABLE "provenance"."evidence_ref" ADD CONSTRAINT "ck_evidence_ref_distinct_public_id" CHECK ("provenance"."evidence_ref"."public_id" <> "provenance"."evidence_ref"."id");--> statement-breakpoint
ALTER TABLE "catalog"."professional" ADD CONSTRAINT "ck_professional_distinct_public_id" CHECK ("catalog"."professional"."public_id" <> "catalog"."professional"."id");--> statement-breakpoint
ALTER TABLE "credentials"."registered_title" ADD CONSTRAINT "ck_registered_title_distinct_public_id" CHECK ("credentials"."registered_title"."public_id" <> "credentials"."registered_title"."id");--> statement-breakpoint
CREATE FUNCTION "provenance"."reject_public_id_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'public_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "provenance"."reject_public_id_update"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "trg_evidence_ref_public_id_immutable"
  BEFORE UPDATE OF "public_id" ON "provenance"."evidence_ref"
  FOR EACH ROW EXECUTE FUNCTION "provenance"."reject_public_id_update"();--> statement-breakpoint
CREATE TRIGGER "trg_professional_public_id_immutable"
  BEFORE UPDATE OF "public_id" ON "catalog"."professional"
  FOR EACH ROW EXECUTE FUNCTION "provenance"."reject_public_id_update"();--> statement-breakpoint
CREATE TRIGGER "trg_registered_title_public_id_immutable"
  BEFORE UPDATE OF "public_id" ON "credentials"."registered_title"
  FOR EACH ROW EXECUTE FUNCTION "provenance"."reject_public_id_update"();--> statement-breakpoint
CREATE VIEW "provenance"."public_evidence_ref" WITH (security_barrier = true) AS (
    select
      "provenance"."evidence_ref"."public_id" as evidence_id,
      "provenance"."evidence_ref"."confidence" as confidence,
      "provenance"."source"."source_kind" as source_kind,
      "provenance"."source"."name" as source_name,
      "provenance"."source"."canonical_url" as source_canonical_url,
      "provenance"."source"."license_url" as source_license_url,
      "provenance"."source"."reuse_basis" as source_reuse_basis,
      "provenance"."source"."publication_policy_id" as source_policy_id,
      "provenance"."source"."publication_valid_until" as source_valid_until,
      "provenance"."evidence_ref"."canonical_url" as canonical_url,
      "provenance"."evidence_ref"."observed_at" as observed_at,
      "provenance"."source_release"."cutoff_date" as source_cutoff_date,
      "provenance"."evidence_ref"."valid_until" as valid_until,
      "provenance"."evidence_ref"."attribution" as attribution
    from "provenance"."evidence_ref"
    inner join "provenance"."source_release"
      on "provenance"."source_release"."id" = "provenance"."evidence_ref"."source_release_id"
    inner join "provenance"."source"
      on "provenance"."source"."id" = "provenance"."source_release"."source_id"
    where "provenance"."evidence_ref"."publication_state" = 'APPROVED'
      and "provenance"."evidence_ref"."confidence" <> 'CANDIDATE'
      and "provenance"."evidence_ref"."observed_at" <= now()
      and (
        "provenance"."evidence_ref"."valid_until" is null
        or "provenance"."evidence_ref"."valid_until" > now()
      )
      and "provenance"."source"."publication_state" = 'APPROVED'
      and "provenance"."source"."purpose_compatibility" = 'COMPATIBLE'
      and "provenance"."source"."reuse_basis" <> 'PENDING'
      and "provenance"."source"."publication_reviewed_at" <= now()
      and "provenance"."source"."publication_valid_until" > now()
      and "provenance"."source_release"."cutoff_date" <= current_date
      and "provenance"."source_release"."retrieved_at" <= now()
  );--> statement-breakpoint
CREATE VIEW "catalog"."public_professional" WITH (security_barrier = true) AS (
    select
      "catalog"."professional"."public_id" as id,
      "catalog"."professional"."display_name" as display_name,
      "catalog"."professional"."normalized_name" as normalized_name,
      evidence.evidence_id as current_name_evidence_id
    from "catalog"."professional"
    inner join provenance.evidence_ref as evidence_ref
      on evidence_ref.id = "catalog"."professional"."current_name_evidence_id"
    inner join provenance.public_evidence_ref as evidence
      on evidence.evidence_id = evidence_ref.public_id
    inner join provenance.evidence_claim as claim
      on claim.evidence_id = evidence_ref.id
      and claim.subject_id = "catalog"."professional"."id"
      and claim.claim_kind = 'PROFESSIONAL_NAME'
      and claim.normalized_value = "catalog"."professional"."normalized_name"
    where "catalog"."professional"."visibility" = 'PUBLIC'
  );--> statement-breakpoint
CREATE VIEW "catalog"."public_professional_route" WITH (security_barrier = true) AS (
    select
      "catalog"."professional_route"."slug" as slug,
      "public_professional"."id" as professional_id,
      "catalog"."professional_route"."route_kind" as route_kind
    from "catalog"."professional_route"
    inner join "catalog"."professional"
      on "catalog"."professional"."id" = "catalog"."professional_route"."professional_id"
    inner join "catalog"."public_professional"
      on "public_professional"."id" = "catalog"."professional"."public_id"
  );--> statement-breakpoint
CREATE VIEW "credentials"."public_registered_title" WITH (security_barrier = true) AS (
    select
      "credentials"."registered_title"."public_id" as id,
      professional.public_id as professional_id,
      "credentials"."registered_title"."title" as title,
      "credentials"."registered_title"."normalized_title" as normalized_title,
      "credentials"."registered_title"."temporary_registration" as temporary_registration,
      evidence.evidence_id as current_evidence_id
    from "credentials"."registered_title"
    inner join catalog.professional as professional
      on professional.id = "credentials"."registered_title"."professional_id"
    inner join catalog.public_professional as public_professional
      on public_professional.id = professional.public_id
    inner join provenance.evidence_ref as evidence_ref
      on evidence_ref.id = "credentials"."registered_title"."current_evidence_id"
    inner join provenance.public_evidence_ref as evidence
      on evidence.evidence_id = evidence_ref.public_id
      and evidence.confidence in ('DETERMINISTIC', 'HUMAN_VERIFIED')
      and evidence.source_kind in ('GOVERNMENT_OPEN_DATA', 'OFFICIAL_PUBLICATION')
    inner join provenance.evidence_claim as claim
      on claim.evidence_id = evidence_ref.id
      and claim.subject_id = "credentials"."registered_title"."professional_id"
      and claim.claim_kind = 'REGISTERED_TITLE'
      and claim.normalized_value = "credentials"."registered_title"."normalized_title"
    where "credentials"."registered_title"."registration_state" = 'ENABLED'
  );--> statement-breakpoint
GRANT SELECT ON
  "catalog"."public_professional",
  "catalog"."public_professional_route",
  "provenance"."public_evidence_ref",
  "credentials"."public_registered_title"
  TO medicos_catalog_reader;
