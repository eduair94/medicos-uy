#!/usr/bin/env sh

set -eu
umask 077

environment_file="${MEDICOS_PUBLIC_QUERY_ENV_FILE:-/etc/medicos-backend/public-query-api.env}"

if [ -L "${environment_file}" ] || [ ! -f "${environment_file}" ] || [ ! -r "${environment_file}" ]; then
  echo "Public query API environment file must be a readable regular file, not a symlink: ${environment_file}" >&2
  exit 1
fi

environment_mode="$(stat -c '%a' "${environment_file}")"
environment_owner="$(stat -c '%u' "${environment_file}")"
if [ "${environment_owner}" -ne 0 ] || [ $((0${environment_mode} & 0077)) -ne 0 ]; then
  echo "Public query API environment file must be root-owned and inaccessible to group/others" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${environment_file}"
set +a

application_directory="${MEDICOS_APP_DIRECTORY:-/srv/medicos-backend/current}"
entrypoint="${application_directory}/apps/public-query-api/dist/main.js"

if [ ! -f "${application_directory}/package.json" ] || [ ! -f "${entrypoint}" ]; then
  echo "Medicos application or public query API entrypoint is unavailable: ${application_directory}" >&2
  exit 1
fi
if [ -z "${CATALOG_DATABASE_URL:-}" ]; then
  echo "CATALOG_DATABASE_URL is required" >&2
  exit 1
fi
if [ "${NODE_ENV:-}" != "production" ]; then
  echo "NODE_ENV must be production" >&2
  exit 1
fi
if [ "${API_DOCUMENTATION_ENABLED:-}" != "true" ]; then
  echo "API_DOCUMENTATION_ENABLED must be true for the published developer contract" >&2
  exit 1
fi
if [ "${PUBLIC_QUERY_API_HOST:-}" != "127.0.0.1" ]; then
  echo "PUBLIC_QUERY_API_HOST must remain 127.0.0.1 behind Cloudflare Tunnel" >&2
  exit 1
fi
if [ -z "${PUBLIC_API_BASE_URL:-}" ]; then
  echo "PUBLIC_API_BASE_URL is required" >&2
  exit 1
fi

cd "${application_directory}"
exec node "${entrypoint}"
