\set ON_ERROR_STOP on
\getenv owner_research_query_password MEDICOS_OWNER_RESEARCH_QUERY_PASSWORD

BEGIN;

-- Fail before changing roles when the secret was not supplied or is too short.
SELECT 1 / CASE
  WHEN length(:'owner_research_query_password') >= 43 THEN 1
  ELSE 0
END;

-- The immutable 0006 baseline assigns schema ownership to this role. Existing
-- deployments may already use it as a LOGIN; never downgrade that account.
SELECT
  'CREATE ROLE medicos_migrator
    NOLOGIN
    NOINHERIT
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_migrator'
)
\gexec

SELECT
  'CREATE ROLE medicos_owner_research_reader
    NOLOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_owner_research_reader'
)
\gexec

SELECT
  'CREATE ROLE medicos_owner_research_query
    LOGIN
    INHERIT
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS
    CONNECTION LIMIT 8'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'medicos_owner_research_query'
)
\gexec

ALTER ROLE medicos_owner_research_reader
  NOLOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT -1;

ALTER ROLE medicos_owner_research_query
  LOGIN
  INHERIT
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT 8;

ALTER ROLE medicos_owner_research_query
  PASSWORD :'owner_research_query_password';
ALTER ROLE medicos_owner_research_query
  SET default_transaction_read_only = on;
ALTER ROLE medicos_owner_research_query
  SET statement_timeout = '10s';
ALTER ROLE medicos_owner_research_query
  SET idle_in_transaction_session_timeout = '15s';

GRANT medicos_owner_research_reader TO medicos_owner_research_query;

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO medicos_owner_research_query',
  current_database()
)
\gexec

COMMIT;
