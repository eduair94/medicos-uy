CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE SCHEMA "provenance";
--> statement-breakpoint
CREATE TYPE "provenance"."evidence_publication_state" AS ENUM('PENDING', 'APPROVED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "catalog"."professional_route_kind" AS ENUM('CURRENT', 'REDIRECT');--> statement-breakpoint
CREATE TYPE "catalog"."professional_visibility" AS ENUM('PUBLIC', 'SUPPRESSED', 'MERGED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "provenance"."source_kind" AS ENUM('GOVERNMENT_OPEN_DATA', 'PROVIDER_AUTHORIZED_FEED');--> statement-breakpoint
CREATE TABLE "provenance"."evidence_ref" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_release_id" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"checksum" char(64) NOT NULL,
	"attribution" varchar(500) NOT NULL,
	"publication_state" "provenance"."evidence_publication_state" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."professional_route" (
	"slug" varchar(180) PRIMARY KEY NOT NULL,
	"professional_id" uuid NOT NULL,
	"route_kind" "catalog"."professional_route_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_professional_route_slug_format" CHECK ("catalog"."professional_route"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "ck_professional_route_slug_not_uuid" CHECK (NOT ("catalog"."professional_route"."slug" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
);
--> statement-breakpoint
CREATE TABLE "catalog"."professional" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"normalized_name" varchar(200) NOT NULL,
	"visibility" "catalog"."professional_visibility" NOT NULL,
	"current_name_evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provenance"."source_release" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"upstream_release_key" varchar(200) NOT NULL,
	"cutoff_date" date NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"sha256" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provenance"."source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"canonical_url" text NOT NULL,
	"source_kind" "provenance"."source_kind" NOT NULL,
	"license_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provenance"."evidence_ref" ADD CONSTRAINT "evidence_ref_source_release_id_source_release_id_fk" FOREIGN KEY ("source_release_id") REFERENCES "provenance"."source_release"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."professional_route" ADD CONSTRAINT "professional_route_professional_id_professional_id_fk" FOREIGN KEY ("professional_id") REFERENCES "catalog"."professional"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance"."source_release" ADD CONSTRAINT "source_release_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "provenance"."source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_evidence_ref_source_release" ON "provenance"."evidence_ref" USING btree ("source_release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_professional_current_route" ON "catalog"."professional_route" USING btree ("professional_id") WHERE "catalog"."professional_route"."route_kind" = 'CURRENT';--> statement-breakpoint
CREATE INDEX "ix_professional_route_professional" ON "catalog"."professional_route" USING btree ("professional_id");--> statement-breakpoint
CREATE INDEX "ix_professional_directory" ON "catalog"."professional" USING btree ("visibility","normalized_name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_release_upstream_key" ON "provenance"."source_release" USING btree ("source_id","upstream_release_key");--> statement-breakpoint
CREATE INDEX "ix_source_release_freshness" ON "provenance"."source_release" USING btree ("source_id","cutoff_date","retrieved_at");--> statement-breakpoint
CREATE VIEW "provenance"."public_evidence_ref" WITH (security_barrier = true) AS (
    select
      "provenance"."evidence_ref"."id" as evidence_id,
      "provenance"."source"."name" as source_name,
      "provenance"."source"."canonical_url" as source_canonical_url,
      "provenance"."evidence_ref"."canonical_url" as canonical_url,
      "provenance"."evidence_ref"."observed_at" as observed_at,
      "provenance"."source_release"."cutoff_date" as source_cutoff_date,
      "provenance"."evidence_ref"."attribution" as attribution
    from "provenance"."evidence_ref"
    inner join "provenance"."source_release"
      on "provenance"."source_release"."id" = "provenance"."evidence_ref"."source_release_id"
    inner join "provenance"."source"
      on "provenance"."source"."id" = "provenance"."source_release"."source_id"
    where "provenance"."evidence_ref"."publication_state" = 'APPROVED'
  );--> statement-breakpoint
CREATE VIEW "catalog"."public_professional" WITH (security_barrier = true) AS (
    select
      "catalog"."professional"."id" as id,
      "catalog"."professional"."display_name" as display_name,
      "catalog"."professional"."normalized_name" as normalized_name,
      "catalog"."professional"."current_name_evidence_id" as current_name_evidence_id
    from "catalog"."professional"
    where "catalog"."professional"."visibility" = 'PUBLIC'
      and exists (
        select 1
        from provenance.public_evidence_ref as evidence
        where evidence.evidence_id = "catalog"."professional"."current_name_evidence_id"
      )
  );--> statement-breakpoint
CREATE VIEW "catalog"."public_professional_route" WITH (security_barrier = true) AS (
    select
      "catalog"."professional_route"."slug" as slug,
      "catalog"."professional_route"."professional_id" as professional_id,
      "catalog"."professional_route"."route_kind" as route_kind
    from "catalog"."professional_route"
    inner join "catalog"."public_professional"
      on "public_professional"."id" = "catalog"."professional_route"."professional_id"
  );--> statement-breakpoint
ALTER TABLE "catalog"."professional"
  ADD CONSTRAINT "professional_current_name_evidence_id_evidence_ref_id_fk"
  FOREIGN KEY ("current_name_evidence_id")
  REFERENCES "provenance"."evidence_ref"("id")
  ON DELETE restrict
  ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON "catalog"."professional", "catalog"."professional_route" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "provenance"."source", "provenance"."source_release", "provenance"."evidence_ref" FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "catalog", "provenance" TO medicos_catalog_reader;--> statement-breakpoint
GRANT SELECT ON "catalog"."public_professional", "catalog"."public_professional_route" TO medicos_catalog_reader;--> statement-breakpoint
GRANT SELECT ON "provenance"."public_evidence_ref" TO medicos_catalog_reader;
