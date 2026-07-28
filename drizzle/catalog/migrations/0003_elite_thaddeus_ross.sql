DROP VIEW "credentials"."public_registered_title";--> statement-breakpoint
DROP VIEW "catalog"."public_professional_route";--> statement-breakpoint
DROP VIEW "catalog"."public_professional";--> statement-breakpoint
DROP VIEW "provenance"."public_evidence_ref";--> statement-breakpoint
ALTER TABLE "provenance"."source" DROP CONSTRAINT "ck_source_approved_requires_complete_review";--> statement-breakpoint
ALTER TABLE "provenance"."source" ADD CONSTRAINT "ck_source_approved_requires_complete_review" CHECK ("provenance"."source"."publication_state" <> 'APPROVED'
          OR (
            "provenance"."source"."purpose_compatibility" = 'COMPATIBLE'
            AND "provenance"."source"."reuse_basis" <> 'PENDING'
            AND "provenance"."source"."publication_policy_id" IS NOT NULL
            AND "provenance"."source"."publication_reviewed_by" IS NOT NULL
            AND "provenance"."source"."publication_reviewed_at" IS NOT NULL
            AND "provenance"."source"."publication_review_reference" IS NOT NULL
            AND "provenance"."source"."publication_valid_until" IS NOT NULL
            AND length(trim("provenance"."source"."publication_policy_id")) > 0
            AND length(trim("provenance"."source"."publication_reviewed_by")) > 0
            AND length(trim("provenance"."source"."publication_review_reference")) > 0
            AND "provenance"."source"."publication_valid_until" > "provenance"."source"."publication_reviewed_at"
            AND (
              "provenance"."source"."reuse_basis" <> 'OPEN_DATA_LICENSE'
              OR (
                "provenance"."source"."license_url" IS NOT NULL
                AND length(trim("provenance"."source"."license_url")) > 0
              )
            )
            AND (
              "provenance"."source"."reuse_basis" <> 'DATA_SUBJECT_CONSENT'
              OR "provenance"."source"."source_kind" = 'DATA_SUBJECT_CLAIM'
            )
            AND (
              "provenance"."source"."source_kind" <> 'DATA_SUBJECT_CLAIM'
              OR "provenance"."source"."reuse_basis" = 'DATA_SUBJECT_CONSENT'
            )
          ));--> statement-breakpoint
CREATE VIEW "provenance"."public_evidence_ref" WITH (security_barrier = true) AS (
    select
      "provenance"."evidence_ref"."public_id" as evidence_id,
      "provenance"."evidence_ref"."confidence" as confidence,
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
      "credentials"."registered_title"."temporary_registration"
        as temporary_registration,
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
