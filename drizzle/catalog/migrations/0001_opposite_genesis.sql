CREATE SCHEMA "credentials";
--> statement-breakpoint
CREATE TYPE "provenance"."evidence_confidence" AS ENUM(
  'CANDIDATE',
  'DETERMINISTIC',
  'HUMAN_VERIFIED',
  'DATA_SUBJECT_CLAIMED'
);
--> statement-breakpoint
CREATE TYPE "credentials"."registered_title_state" AS ENUM(
  'ENABLED',
  'DISABLED',
  'UNDER_REVIEW',
  'WITHDRAWN'
);
--> statement-breakpoint
CREATE TYPE "credentials"."temporary_registration_kind" AS ENUM(
  'NONE',
  'WITH_CONTRACT',
  'WITHOUT_CONTRACT'
);
--> statement-breakpoint
CREATE TYPE "provenance"."source_publication_state" AS ENUM(
  'PENDING',
  'APPROVED',
  'REVOKED'
);
--> statement-breakpoint
CREATE TYPE "provenance"."source_purpose_compatibility" AS ENUM(
  'PENDING',
  'COMPATIBLE',
  'INCOMPATIBLE'
);
--> statement-breakpoint
CREATE TYPE "provenance"."source_reuse_basis" AS ENUM(
  'PENDING',
  'OPEN_DATA_LICENSE',
  'WRITTEN_AUTHORIZATION',
  'OFFICIAL_PUBLICATION_REVIEW',
  'DATA_SUBJECT_CONSENT'
);
--> statement-breakpoint
ALTER TYPE "provenance"."source_kind" ADD VALUE 'OFFICIAL_PUBLICATION'
  BEFORE 'PROVIDER_AUTHORIZED_FEED';
--> statement-breakpoint
ALTER TYPE "provenance"."source_kind" ADD VALUE 'ACADEMIC_METADATA';
--> statement-breakpoint
ALTER TYPE "provenance"."source_kind" ADD VALUE 'DATA_SUBJECT_CLAIM';
--> statement-breakpoint
DROP VIEW "catalog"."public_professional_route";
--> statement-breakpoint
DROP VIEW "catalog"."public_professional";
--> statement-breakpoint
DROP VIEW "provenance"."public_evidence_ref";
--> statement-breakpoint
ALTER TABLE "provenance"."evidence_ref"
  ADD COLUMN "confidence" "provenance"."evidence_confidence"
    DEFAULT 'CANDIDATE' NOT NULL,
  ADD COLUMN "valid_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "provenance"."source"
  ADD COLUMN "publication_state" "provenance"."source_publication_state"
    DEFAULT 'PENDING' NOT NULL,
  ADD COLUMN "purpose_compatibility" "provenance"."source_purpose_compatibility"
    DEFAULT 'PENDING' NOT NULL,
  ADD COLUMN "reuse_basis" "provenance"."source_reuse_basis"
    DEFAULT 'PENDING' NOT NULL;
--> statement-breakpoint
UPDATE "provenance"."evidence_ref"
SET "publication_state" = 'PENDING'
WHERE "publication_state" = 'APPROVED';
--> statement-breakpoint
CREATE TABLE "credentials"."registered_title" (
  "id" uuid PRIMARY KEY NOT NULL,
  "professional_id" uuid NOT NULL,
  "title" varchar(250) NOT NULL,
  "normalized_title" varchar(250) NOT NULL,
  "registration_state" "credentials"."registered_title_state" NOT NULL,
  "temporary_registration" "credentials"."temporary_registration_kind"
    DEFAULT 'NONE' NOT NULL,
  "current_evidence_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ck_registered_title_non_blank"
    CHECK (length(trim("title")) > 0),
  CONSTRAINT "ck_registered_title_normalized_non_blank"
    CHECK (length(trim("normalized_title")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_registered_title_professional_title"
  ON "credentials"."registered_title"
  USING btree ("professional_id", "normalized_title");
--> statement-breakpoint
CREATE INDEX "ix_registered_title_public_lookup"
  ON "credentials"."registered_title"
  USING btree ("professional_id", "registration_state", "normalized_title");
--> statement-breakpoint
ALTER TABLE "provenance"."evidence_ref"
  ADD CONSTRAINT "ck_approved_evidence_requires_publishable_confidence"
  CHECK ("publication_state" <> 'APPROVED' OR "confidence" <> 'CANDIDATE');
--> statement-breakpoint
ALTER TABLE "provenance"."source"
  ADD CONSTRAINT "ck_source_approved_requires_complete_review"
  CHECK (
    "publication_state" <> 'APPROVED'
    OR (
      "purpose_compatibility" = 'COMPATIBLE'
      AND "reuse_basis" <> 'PENDING'
    )
  );
--> statement-breakpoint
ALTER TABLE "credentials"."registered_title"
  ADD CONSTRAINT "registered_title_professional_id_professional_id_fk"
  FOREIGN KEY ("professional_id")
  REFERENCES "catalog"."professional"("id")
  ON DELETE cascade
  ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credentials"."registered_title"
  ADD CONSTRAINT "registered_title_current_evidence_id_evidence_ref_id_fk"
  FOREIGN KEY ("current_evidence_id")
  REFERENCES "provenance"."evidence_ref"("id")
  ON DELETE restrict
  ON UPDATE no action;
--> statement-breakpoint
CREATE VIEW "provenance"."public_evidence_ref"
WITH (security_barrier = true) AS (
  SELECT
    "provenance"."evidence_ref"."id" AS evidence_id,
    "provenance"."source"."name" AS source_name,
    "provenance"."source"."canonical_url" AS source_canonical_url,
    "provenance"."source"."license_url" AS source_license_url,
    "provenance"."source"."reuse_basis" AS source_reuse_basis,
    "provenance"."evidence_ref"."canonical_url" AS canonical_url,
    "provenance"."evidence_ref"."observed_at" AS observed_at,
    "provenance"."source_release"."cutoff_date" AS source_cutoff_date,
    "provenance"."evidence_ref"."valid_until" AS valid_until,
    "provenance"."evidence_ref"."attribution" AS attribution
  FROM "provenance"."evidence_ref"
  INNER JOIN "provenance"."source_release"
    ON "provenance"."source_release"."id" =
      "provenance"."evidence_ref"."source_release_id"
  INNER JOIN "provenance"."source"
    ON "provenance"."source"."id" = "provenance"."source_release"."source_id"
  WHERE "provenance"."evidence_ref"."publication_state" = 'APPROVED'
    AND "provenance"."evidence_ref"."confidence" <> 'CANDIDATE'
    AND (
      "provenance"."evidence_ref"."valid_until" IS NULL
      OR "provenance"."evidence_ref"."valid_until" > now()
    )
    AND "provenance"."source"."publication_state" = 'APPROVED'
    AND "provenance"."source"."purpose_compatibility" = 'COMPATIBLE'
    AND "provenance"."source"."reuse_basis" <> 'PENDING'
);
--> statement-breakpoint
CREATE VIEW "catalog"."public_professional"
WITH (security_barrier = true) AS (
  SELECT
    "catalog"."professional"."id" AS id,
    "catalog"."professional"."display_name" AS display_name,
    "catalog"."professional"."normalized_name" AS normalized_name,
    "catalog"."professional"."current_name_evidence_id"
      AS current_name_evidence_id
  FROM "catalog"."professional"
  WHERE "catalog"."professional"."visibility" = 'PUBLIC'
    AND EXISTS (
      SELECT 1
      FROM "provenance"."public_evidence_ref" AS evidence
      WHERE evidence.evidence_id =
        "catalog"."professional"."current_name_evidence_id"
    )
);
--> statement-breakpoint
CREATE VIEW "catalog"."public_professional_route"
WITH (security_barrier = true) AS (
  SELECT
    "catalog"."professional_route"."slug" AS slug,
    "catalog"."professional_route"."professional_id" AS professional_id,
    "catalog"."professional_route"."route_kind" AS route_kind
  FROM "catalog"."professional_route"
  INNER JOIN "catalog"."public_professional"
    ON "catalog"."public_professional"."id" =
      "catalog"."professional_route"."professional_id"
);
--> statement-breakpoint
CREATE VIEW "credentials"."public_registered_title"
WITH (security_barrier = true) AS (
  SELECT
    "credentials"."registered_title"."id" AS id,
    "credentials"."registered_title"."professional_id" AS professional_id,
    "credentials"."registered_title"."title" AS title,
    "credentials"."registered_title"."normalized_title" AS normalized_title,
    "credentials"."registered_title"."temporary_registration"
      AS temporary_registration,
    "credentials"."registered_title"."current_evidence_id"
      AS current_evidence_id
  FROM "credentials"."registered_title"
  INNER JOIN "catalog"."public_professional" AS professional
    ON professional.id = "credentials"."registered_title"."professional_id"
  WHERE "credentials"."registered_title"."registration_state" = 'ENABLED'
    AND EXISTS (
      SELECT 1
      FROM "provenance"."public_evidence_ref" AS evidence
      WHERE evidence.evidence_id =
        "credentials"."registered_title"."current_evidence_id"
    )
);
--> statement-breakpoint
REVOKE ALL ON "credentials"."registered_title" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "catalog", "provenance", "credentials"
  TO medicos_catalog_reader;
--> statement-breakpoint
GRANT SELECT ON
  "catalog"."public_professional",
  "catalog"."public_professional_route",
  "provenance"."public_evidence_ref",
  "credentials"."public_registered_title"
  TO medicos_catalog_reader;
