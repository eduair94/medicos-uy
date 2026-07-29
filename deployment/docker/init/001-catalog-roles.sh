#!/usr/bin/env sh

set -eu

if [ -z "${MEDICOS_PUBLIC_QUERY_PASSWORD:-}" ]; then
  echo "MEDICOS_PUBLIC_QUERY_PASSWORD is required" >&2
  exit 1
fi

if [ -z "${MEDICOS_PRIVATE_INGESTOR_PASSWORD:-}" ]; then
  echo "MEDICOS_PRIVATE_INGESTOR_PASSWORD is required" >&2
  exit 1
fi

if [ -z "${MEDICOS_OWNER_RESEARCH_QUERY_PASSWORD:-}" ]; then
  echo "MEDICOS_OWNER_RESEARCH_QUERY_PASSWORD is required" >&2
  exit 1
fi

psql \
  --set=ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --set=public_query_password="${MEDICOS_PUBLIC_QUERY_PASSWORD}" \
  --set=private_ingestor_password="${MEDICOS_PRIVATE_INGESTOR_PASSWORD}" \
  --set=owner_research_query_password="${MEDICOS_OWNER_RESEARCH_QUERY_PASSWORD}" <<'SQL'
SELECT
  'CREATE ROLE medicos_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_migrator'
)
\gexec

ALTER ROLE medicos_migrator
  WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

SELECT
  'CREATE ROLE medicos_catalog_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_catalog_reader'
)
\gexec

SELECT format(
  'CREATE ROLE medicos_public_query LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'public_query_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_public_query'
)
\gexec

SELECT format(
  'CREATE ROLE medicos_private_ingestor LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'private_ingestor_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_private_ingestor'
)
\gexec

SELECT
  'CREATE ROLE medicos_owner_research_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_owner_research_reader'
)
\gexec

SELECT format(
  'CREATE ROLE medicos_owner_research_query LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'owner_research_query_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_owner_research_query'
)
\gexec

GRANT medicos_catalog_reader TO medicos_public_query;
GRANT medicos_owner_research_reader TO medicos_owner_research_query;

ALTER ROLE medicos_owner_research_query SET default_transaction_read_only = on;
ALTER ROLE medicos_owner_research_query SET statement_timeout = '10s';
ALTER ROLE medicos_owner_research_query SET idle_in_transaction_session_timeout = '15s';
SQL
