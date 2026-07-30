CREATE SCHEMA "ingestion_private";
--> statement-breakpoint
CREATE TABLE "ingestion_private"."snapshot" (
	"snapshot_id" varchar(120) PRIMARY KEY NOT NULL,
	"manifest_sha256" varchar(64) NOT NULL,
	"profiles_sha256" varchar(64) NOT NULL,
	"profile_count" integer NOT NULL,
	"source_generated_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_private_snapshot_id_factual_v3" CHECK ("ingestion_private"."snapshot"."snapshot_id" ~ '^factual-v3-[0-9a-f]{16}$'),
	CONSTRAINT "ck_private_snapshot_manifest_sha256" CHECK ("ingestion_private"."snapshot"."manifest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_snapshot_profiles_sha256" CHECK ("ingestion_private"."snapshot"."profiles_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_snapshot_profile_count" CHECK ("ingestion_private"."snapshot"."profile_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ingestion_private"."professional_profile" (
	"snapshot_id" varchar(120) NOT NULL,
	"internal_hmac_id" varchar(75) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"normalized_name" varchar(200) NOT NULL,
	"registered_titles" jsonb NOT NULL,
	"official_registry" jsonb NOT NULL,
	"record_sha256" varchar(64) NOT NULL,
	CONSTRAINT "pk_private_professional_profile" PRIMARY KEY("snapshot_id","internal_hmac_id"),
	CONSTRAINT "ck_private_professional_hmac_id" CHECK ("ingestion_private"."professional_profile"."internal_hmac_id" ~ '^msp_doc_v1_[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_professional_display_name" CHECK (length(trim("ingestion_private"."professional_profile"."display_name")) > 0),
	CONSTRAINT "ck_private_professional_normalized_name" CHECK (length(trim("ingestion_private"."professional_profile"."normalized_name")) > 0),
	CONSTRAINT "ck_private_professional_record_sha256" CHECK ("ingestion_private"."professional_profile"."record_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_private_professional_registered_titles_array" CHECK (jsonb_typeof("ingestion_private"."professional_profile"."registered_titles") = 'array'),
	CONSTRAINT "ck_private_professional_official_registry_object" CHECK (jsonb_typeof("ingestion_private"."professional_profile"."official_registry") = 'object')
);
--> statement-breakpoint
ALTER TABLE "ingestion_private"."professional_profile" ADD CONSTRAINT "professional_profile_snapshot_id_snapshot_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "ingestion_private"."snapshot"("snapshot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_private_professional_profile_name" ON "ingestion_private"."professional_profile" USING btree ("snapshot_id","normalized_name");--> statement-breakpoint
REVOKE ALL ON SCHEMA "ingestion_private" FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "ingestion_private" FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "ingestion_private" FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "ingestion_private" FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "ingestion_private"
  REVOKE ALL ON TABLES FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "ingestion_private"
  REVOKE ALL ON SEQUENCES FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "ingestion_private"
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, medicos_catalog_reader, medicos_private_ingestor;--> statement-breakpoint
GRANT USAGE ON SCHEMA "ingestion_private" TO medicos_private_ingestor;--> statement-breakpoint
GRANT SELECT, INSERT ON
  "ingestion_private"."snapshot",
  "ingestion_private"."professional_profile"
  TO medicos_private_ingestor;
