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

psql \
  --set=ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --set=public_query_password="${MEDICOS_PUBLIC_QUERY_PASSWORD}" \
  --set=private_ingestor_password="${MEDICOS_PRIVATE_INGESTOR_PASSWORD}" <<'SQL'
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

GRANT medicos_catalog_reader TO medicos_public_query;
SQL
