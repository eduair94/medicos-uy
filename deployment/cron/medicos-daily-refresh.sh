#!/usr/bin/env sh

set -eu
umask 077

environment_file="${MEDICOS_REFRESH_ENV_FILE:-/etc/medicos-backend/daily-refresh.env}"

if [ ! -r "${environment_file}" ]; then
  echo "Daily refresh environment file is not readable: ${environment_file}" >&2
  exit 1
fi

# The environment file must be root-owned and non-writable by the service user because sourcing it
# executes shell syntax. Mode 0640 with group medicos is recommended.
environment_mode="$(stat -c '%a' "${environment_file}")"
environment_owner="$(stat -c '%u' "${environment_file}")"
if [ "${environment_owner}" -ne 0 ] || [ $((0${environment_mode} & 0022)) -ne 0 ]; then
  echo "Daily refresh environment file must be root-owned and not group/world writable" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${environment_file}"
set +a

application_directory="${MEDICOS_APP_DIRECTORY:-/opt/medicos-backend}"
lock_file="${MEDICOS_REFRESH_LOCK_FILE:-/var/lib/medicos-backend/daily-refresh.lock}"
pnpm_executable="${MEDICOS_PNPM_EXECUTABLE:-/usr/bin/pnpm}"

if [ ! -f "${application_directory}/package.json" ]; then
  echo "Medicos application directory is invalid: ${application_directory}" >&2
  exit 1
fi
if [ ! -x "${pnpm_executable}" ]; then
  echo "pnpm executable is unavailable: ${pnpm_executable}" >&2
  exit 1
fi

cd "${application_directory}"

exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another Medicos daily refresh is already running; skipping this invocation" >&2
  exit 0
fi

exec "${pnpm_executable}" run data:refresh:daily
