#!/usr/bin/env sh

set -eu
umask 077

environment_file="${MEDICOS_ANALYSIS_ENV_FILE:-/etc/medicos-backend/private-analysis.env}"

if [ -L "${environment_file}" ] || [ ! -f "${environment_file}" ] || [ ! -r "${environment_file}" ]; then
  echo "Private analysis environment file must be a readable regular file, not a symlink: ${environment_file}" >&2
  exit 1
fi

# Sourcing executes shell syntax. The server 104 PM2 daemon runs as root, so the file must be
# root-owned and completely inaccessible to group/others (root:root 0600).
environment_mode="$(stat -c '%a' "${environment_file}")"
environment_owner="$(stat -c '%u' "${environment_file}")"
if [ "${environment_owner}" -ne 0 ] || [ $((0${environment_mode} & 0077)) -ne 0 ]; then
  echo "Private analysis environment file must be root-owned and inaccessible to group/others" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${environment_file}"
set +a

application_directory="${MEDICOS_APP_DIRECTORY:-/srv/medicos-backend/current}"
tsx_executable="${MEDICOS_TSX_EXECUTABLE:-${application_directory}/node_modules/.bin/tsx}"
node_executable="${MEDICOS_NODE_EXECUTABLE:-$(command -v node)}"
flock_executable="${MEDICOS_FLOCK_EXECUTABLE:-/usr/bin/flock}"
lock_file="${MEDICOS_ANALYSIS_LOCK_FILE:-/var/lib/medicos-backend/private-analysis.lock}"
status_file="${MEDICOS_ANALYSIS_STATUS_FILE:-/var/lib/medicos-backend/logs/private-analysis/latest.json}"
analysis_entrypoint="${application_directory}/scripts/ingestion/research/build-and-persist-all-professionals.ts"
projection_entrypoint="${application_directory}/scripts/ingestion/publication/sync-msp-catalog.ts"
cmu_collector_entrypoint="${application_directory}/scripts/ingestion/ethics/collect-cmu-ethics-metadata.ts"

if [ "${CMU_ETHICS_FETCH_ENABLED:-false}" != "false" ]; then
  echo "CMU_ETHICS_FETCH_ENABLED is a retired unsafe switch and must remain false" >&2
  exit 1
fi
export CMU_ETHICS_FETCH_ENABLED=false
if [ "${CMU_ETHICS_METADATA_COLLECTION_APPROVAL:-}" != "COLLECT_ALLOWED_PUBLIC_METADATA" ]; then
  echo "CMU_ETHICS_METADATA_COLLECTION_APPROVAL is missing or invalid" >&2
  exit 1
fi

if [ ! -f "${application_directory}/package.json" ] ||
  [ ! -f "${analysis_entrypoint}" ] ||
  [ ! -f "${projection_entrypoint}" ] ||
  [ ! -f "${cmu_collector_entrypoint}" ]; then
  echo "Medicos application or private analysis entrypoint is unavailable: ${application_directory}" >&2
  exit 1
fi
if [ ! -x "${tsx_executable}" ]; then
  echo "tsx executable is unavailable: ${tsx_executable}" >&2
  exit 1
fi
if [ ! -x "${node_executable}" ] ||
  ! "${node_executable}" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major === 22 && minor >= 14) || (major === 24 && minor >= 15);
    process.exit(supported ? 0 : 1);
  '; then
  echo "MEDICOS_NODE_EXECUTABLE must point to supported Node.js 22 or 24 LTS" >&2
  exit 1
fi
PATH="$(dirname "${node_executable}"):${PATH}"
export PATH
if [ ! -x "${flock_executable}" ]; then
  echo "flock executable is unavailable: ${flock_executable}" >&2
  exit 1
fi
if [ -z "${PROFESSIONAL_ANALYSIS_DATABASE_URL:-}" ]; then
  echo "PROFESSIONAL_ANALYSIS_DATABASE_URL is required" >&2
  exit 1
fi
if [ "${PROFESSIONAL_ANALYSIS_APPROVAL:-}" != "STORE_PRIVATE_RESEARCH_DOSSIERS" ]; then
  echo "PROFESSIONAL_ANALYSIS_APPROVAL is missing or invalid" >&2
  exit 1
fi
if [ -z "${PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID:-}" ]; then
  echo "PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID is required" >&2
  exit 1
fi
if [ -z "${PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH:-}" ]; then
  echo "PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH is required" >&2
  exit 1
fi
if [ -z "${PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME:-}" ]; then
  echo "PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME is required" >&2
  exit 1
fi
if [ "${MSP_CATALOG_PROJECTION_APPROVAL:-}" != "PROJECT_OFFICIAL_MSP_FIELDS" ]; then
  echo "MSP_CATALOG_PROJECTION_APPROVAL is missing or invalid" >&2
  exit 1
fi
if [ -z "${MSP_CATALOG_PROJECTION_REVIEWED_BY:-}" ]; then
  echo "MSP_CATALOG_PROJECTION_REVIEWED_BY is required" >&2
  exit 1
fi
if [ -z "${MSP_CATALOG_PROJECTION_REVIEWED_AT:-}" ]; then
  echo "MSP_CATALOG_PROJECTION_REVIEWED_AT is required" >&2
  exit 1
fi
if [ "${MSP_CATALOG_PROJECTION_REVIEW_REFERENCE:-}" != "https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos" ]; then
  echo "MSP_CATALOG_PROJECTION_REVIEW_REFERENCE must be the official MSP Infotitulos URL" >&2
  exit 1
fi

data_directory="${DATA_INGESTION_DIR:-/srv/medicos-backend/data}"
cmu_snapshot_root="${CMU_ETHICS_SNAPSHOT_ROOT:-${data_directory}/normalized/ethics/cmu}"
case "${data_directory}" in
  /*) ;;
  *)
    echo "DATA_INGESTION_DIR must be an absolute path" >&2
    exit 1
    ;;
esac
case "${cmu_snapshot_root}" in
  /*) ;;
  *)
    echo "CMU_ETHICS_SNAPSHOT_ROOT must be an absolute path" >&2
    exit 1
    ;;
esac
if [ -L "${data_directory}" ] || [ ! -d "${data_directory}" ]; then
  echo "DATA_INGESTION_DIR must be a provisioned directory, not a symlink" >&2
  exit 1
fi
if [ -L "${cmu_snapshot_root}" ] || [ ! -d "${cmu_snapshot_root}" ]; then
  echo "CMU_ETHICS_SNAPSHOT_ROOT must be a provisioned directory, not a symlink" >&2
  exit 1
fi
canonical_data_directory="$(CDPATH= cd "${data_directory}" && pwd -P)"
canonical_cmu_snapshot_root="$(CDPATH= cd "${cmu_snapshot_root}" && pwd -P)"
data_directory_mode="$(stat -c '%a' "${canonical_data_directory}")"
data_directory_owner="$(stat -c '%u' "${canonical_data_directory}")"
if [ "${data_directory_owner}" -ne 0 ] || [ $((0${data_directory_mode} & 0077)) -ne 0 ]; then
  echo "DATA_INGESTION_DIR must be root-owned and inaccessible to group/others" >&2
  exit 1
fi
if [ "${canonical_cmu_snapshot_root}" = "${canonical_data_directory}" ]; then
  echo "CMU_ETHICS_SNAPSHOT_ROOT must be a dedicated directory below DATA_INGESTION_DIR" >&2
  exit 1
fi
case "${canonical_cmu_snapshot_root}/" in
  "${canonical_data_directory}/"*) ;;
  *)
    echo "CMU_ETHICS_SNAPSHOT_ROOT must resolve below DATA_INGESTION_DIR" >&2
    exit 1
    ;;
esac
cmu_snapshot_root_mode="$(stat -c '%a' "${canonical_cmu_snapshot_root}")"
cmu_snapshot_root_owner="$(stat -c '%u' "${canonical_cmu_snapshot_root}")"
if [ "${cmu_snapshot_root_owner}" -ne 0 ] ||
  [ $((0${cmu_snapshot_root_mode} & 0077)) -ne 0 ]; then
  echo "CMU_ETHICS_SNAPSHOT_ROOT must be root-owned and inaccessible to group/others" >&2
  exit 1
fi
cmu_path_component="${canonical_cmu_snapshot_root}"
while [ "${cmu_path_component}" != "${canonical_data_directory}" ]; do
  cmu_path_mode="$(stat -c '%a' "${cmu_path_component}")"
  cmu_path_owner="$(stat -c '%u' "${cmu_path_component}")"
  if [ "${cmu_path_owner}" -ne 0 ] || [ $((0${cmu_path_mode} & 0022)) -ne 0 ]; then
    echo "Every CMU snapshot path component must be root-owned and not group/world writable" >&2
    exit 1
  fi
  cmu_path_component="$(dirname "${cmu_path_component}")"
done

status_directory="$(dirname "${status_file}")"
mkdir -p "${status_directory}"
chmod 0700 "${status_directory}"

analysis_pid=''
idle_pid=''
run_started_at=''

write_status() {
  status_state="$1"
  status_exit_code="$2"
  status_started_at="$3"
  status_completed_at="$4"
  status_temporary="${status_file}.$$"

  printf '{"schemaVersion":1,"state":"%s","exitCode":%s,"startedAt":"%s","completedAt":%s}\n' \
    "${status_state}" \
    "${status_exit_code}" \
    "${status_started_at}" \
    "${status_completed_at}" >"${status_temporary}"
  chmod 0600 "${status_temporary}"
  mv -f "${status_temporary}" "${status_file}"
}

terminate_scheduler() {
  trap - TERM INT

  if [ -n "${analysis_pid}" ] && kill -0 "${analysis_pid}" 2>/dev/null; then
    kill -TERM "${analysis_pid}" 2>/dev/null || true
    wait "${analysis_pid}" 2>/dev/null || true
  fi
  if [ -n "${idle_pid}" ] && kill -0 "${idle_pid}" 2>/dev/null; then
    kill -TERM "${idle_pid}" 2>/dev/null || true
    wait "${idle_pid}" 2>/dev/null || true
  fi

  if [ -n "${run_started_at}" ]; then
    shutdown_completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    write_status "INTERRUPTED" "null" "${run_started_at}" "\"${shutdown_completed_at}\""
  fi

  echo '{"event":"private_analysis_scheduler_stopped"}'
  exit 0
}

trap terminate_scheduler TERM INT

cd "${application_directory}"
exec 9>"${lock_file}"

run_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if ! "${flock_executable}" -n 9; then
  overlap_completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  write_status "SKIPPED_OVERLAP" "null" "${run_started_at}" "\"${overlap_completed_at}\""
  run_started_at=''
  echo '{"event":"private_analysis_skipped_overlap"}' >&2
else
  write_status "RUNNING" "null" "${run_started_at}" "null"
  echo '{"event":"private_analysis_started"}'

  cmu_snapshot_run_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  CMU_ETHICS_OUTPUT_DIR="${canonical_cmu_snapshot_root}/snapshot-${cmu_snapshot_run_id}"
  export CMU_ETHICS_OUTPUT_DIR
  echo '{"event":"cmu_ethics_metadata_collection_started"}'

  "${tsx_executable}" "${cmu_collector_entrypoint}" &
  analysis_pid="$!"

  if wait "${analysis_pid}"; then
    analysis_pid=''
    cmu_manifest="${CMU_ETHICS_OUTPUT_DIR}/manifest.json"
    cmu_cases="${CMU_ETHICS_OUTPUT_DIR}/cases.ndjson"
    if [ -d "${CMU_ETHICS_OUTPUT_DIR}" ] &&
      [ ! -L "${CMU_ETHICS_OUTPUT_DIR}" ] &&
      [ -f "${cmu_manifest}" ] &&
      [ ! -L "${cmu_manifest}" ] &&
      [ -f "${cmu_cases}" ] &&
      [ ! -L "${cmu_cases}" ]; then
      PROFESSIONAL_ANALYSIS_CMU_SNAPSHOT_PATH="${CMU_ETHICS_OUTPUT_DIR}"
      export PROFESSIONAL_ANALYSIS_CMU_SNAPSHOT_PATH
      echo '{"event":"cmu_ethics_metadata_collection_verified"}'
      echo '{"event":"professional_analysis_stage_started"}'

      "${tsx_executable}" "${analysis_entrypoint}" &
      analysis_pid="$!"

      if wait "${analysis_pid}"; then
        analysis_pid=''
        echo '{"event":"msp_catalog_projection_started"}'
        "${tsx_executable}" "${projection_entrypoint}" &
        analysis_pid="$!"

        if wait "${analysis_pid}"; then
          analysis_exit_code=0
          analysis_state="COMPLETED"
        else
          analysis_exit_code="$?"
          analysis_state="FAILED"
        fi
      else
        analysis_exit_code="$?"
        analysis_state="FAILED"
      fi
    else
      analysis_exit_code=1
      analysis_state="FAILED"
      echo '{"event":"cmu_ethics_metadata_snapshot_invalid"}' >&2
    fi
  else
    analysis_exit_code="$?"
    analysis_state="FAILED"
    printf '{"event":"cmu_ethics_metadata_collection_failed","exitCode":%s}\n' \
      "${analysis_exit_code}" >&2
  fi
  analysis_pid=''
  "${flock_executable}" -u 9

  run_completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  write_status "${analysis_state}" "${analysis_exit_code}" "${run_started_at}" "\"${run_completed_at}\""
  run_started_at=''
  printf '{"event":"private_analysis_finished","exitCode":%s}\n' "${analysis_exit_code}"
fi

# PM2 cron_restart restarts this process at the next UTC schedule. Remaining alive avoids a
# restart storm after an analysis failure while preserving an explicit status for monitoring.
while :; do
  sleep 3600 &
  idle_pid="$!"
  wait "${idle_pid}" || true
  idle_pid=''
done
