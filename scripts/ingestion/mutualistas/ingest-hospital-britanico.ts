import path from 'node:path';

import {
  createProviderRunPaths,
  createRunId,
  ensureRunDirectories,
  fetchTextWithRetry,
  parseBoundedInteger,
  PUBLIC_DATA_SCHEMA_VERSION,
  relativeArtifactPath,
  sha256,
  writeFileAtomically,
  writeJsonAtomically,
  writeNdjsonAtomically,
} from './casmu-hb-artifacts';
import {
  HOSPITAL_BRITANICO_EXTRACTOR_VERSION,
  parseHospitalBritanicoResponse,
  type HospitalBritanicoScheduleRecord,
} from './hospital-britanico-parser';

const DEFAULT_HOSPITAL_BRITANICO_SCHEDULES_URL =
  'https://www.hospitalbritanico.org.uy/ajax/horarios_medicos_2_resultados.php?especialidad=0&medico=0&clinica=ALL&dia=0&desde=08%3A00&hasta=20%3A30';
const DEFAULT_HOSPITAL_BRITANICO_PAGE_URL =
  'https://www.hospitalbritanico.org.uy/medicos_horarios_de_consulta_medica.php';

interface HospitalBritanicoIngestionConfig {
  readonly dataRoot: string | undefined;
  readonly httpTimeoutMs: number;
  readonly sourcePageUrl: string;
  readonly sourceUrl: string;
}

export interface HospitalBritanicoIngestionSummary {
  readonly manifestPath: string;
  readonly physicianCount: number;
  readonly runId: string;
  readonly scheduleRecords: number;
  readonly specialtyCount: number;
}

function resolveConfig(
  overrides: Partial<HospitalBritanicoIngestionConfig> = {},
): HospitalBritanicoIngestionConfig {
  return {
    dataRoot: overrides.dataRoot ?? process.env['INGESTION_DATA_DIR'] ?? undefined,
    httpTimeoutMs:
      overrides.httpTimeoutMs ??
      parseBoundedInteger(process.env['PUBLIC_SOURCE_TIMEOUT_MS'], 60_000, 5_000, 180_000),
    sourcePageUrl:
      overrides.sourcePageUrl ??
      process.env['HOSPITAL_BRITANICO_PAGE_URL'] ??
      DEFAULT_HOSPITAL_BRITANICO_PAGE_URL,
    sourceUrl:
      overrides.sourceUrl ??
      process.env['HOSPITAL_BRITANICO_SCHEDULES_URL'] ??
      DEFAULT_HOSPITAL_BRITANICO_SCHEDULES_URL,
  };
}

function sortRecords(
  records: readonly HospitalBritanicoScheduleRecord[],
): readonly HospitalBritanicoScheduleRecord[] {
  return [...records].sort((left, right) =>
    [left.physicianName, left.specialty, left.clinic, left.day, left.scheduleText]
      .join('|')
      .localeCompare(
        [right.physicianName, right.specialty, right.clinic, right.day, right.scheduleText].join(
          '|',
        ),
        'es',
      ),
  );
}

function queryFilter(sourceUrl: string): Record<string, string> {
  const url = new URL(sourceUrl);
  return Object.fromEntries(url.searchParams.entries());
}

export async function runHospitalBritanicoIngestion(
  overrides: Partial<HospitalBritanicoIngestionConfig> = {},
): Promise<HospitalBritanicoIngestionSummary> {
  const config = resolveConfig(overrides);
  const runId = createRunId();
  const paths = createProviderRunPaths('hospital-britanico', runId, config.dataRoot);
  await ensureRunDirectories(paths);

  console.log(`Hospital Británico: retrieving public JSON schedules from ${config.sourceUrl}`);
  const response = await fetchTextWithRetry(config.sourceUrl, {
    attempts: 2,
    init: {
      headers: {
        accept: 'application/json, text/plain, */*',
        referer: config.sourcePageUrl,
      },
    },
    timeoutMs: config.httpTimeoutMs,
  });
  const rawPath = path.join(paths.rawDirectory, 'schedule-response.json');
  await writeFileAtomically(rawPath, response.body);
  const sourceHashSha256 = sha256(response.body);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Hospital Británico schedules returned HTTP ${response.status}; raw response preserved at ${relativeArtifactPath(rawPath)}`,
    );
  }

  const parsed = parseHospitalBritanicoResponse(response.body, {
    extractorVersion: HOSPITAL_BRITANICO_EXTRACTOR_VERSION,
    retrievedAt: response.retrievedAt,
    sourceHashSha256,
    sourcePageUrl: config.sourcePageUrl,
    sourceUrl: config.sourceUrl,
  });
  if (parsed.candidatePhysicianRows === 0 || parsed.records.length === 0) {
    throw new Error(
      `Hospital Británico response passed HTTP checks but yielded no schedule records; raw response preserved at ${relativeArtifactPath(rawPath)}`,
    );
  }

  const records = sortRecords(parsed.records);
  const schedulesPath = path.join(paths.processedDirectory, 'schedules.ndjson');
  const manifestPath = path.join(paths.processedDirectory, 'manifest.json');
  await writeNdjsonAtomically(schedulesPath, records);

  const physicianNames = new Set(records.map((record) => record.physicianName));
  const specialties = new Set(records.map((record) => record.specialty));
  const clinics = new Set(records.map((record) => record.clinic));
  const recordsWithoutIntervals = records.filter((record) => record.intervals.length === 0).length;
  const recordsWithMultipleIntervals = records.filter(
    (record) => record.intervals.length > 1,
  ).length;
  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
    provider: 'Hospital Británico',
    runId,
    generatedAt,
    extractorVersion: HOSPITAL_BRITANICO_EXTRACTOR_VERSION,
    source: {
      sourcePageUrl: config.sourcePageUrl,
      sourceUrl: config.sourceUrl,
      finalUrl: response.finalUrl,
      retrievedAt: response.retrievedAt,
      httpStatus: response.status,
      contentType: response.contentType,
      sourceHashSha256,
      queryFilter: queryFilter(config.sourceUrl),
    },
    extraction: {
      htmlLength: parsed.htmlLength,
      candidatePhysicianRows: parsed.candidatePhysicianRows,
      candidateScheduleEntries: parsed.candidateScheduleEntries,
      invalidPhysicianRows: parsed.invalidPhysicianRows,
      invalidScheduleEntries: parsed.invalidScheduleEntries,
      duplicateEntriesDiscarded: parsed.duplicateEntriesDiscarded,
      scheduleRecords: records.length,
      distinctPhysicians: physicianNames.size,
      distinctSpecialties: specialties.size,
      distinctClinics: clinics.size,
      recordsWithoutParsedIntervals: recordsWithoutIntervals,
      recordsWithMultipleIntervals,
    },
    artifacts: {
      rawResponse: relativeArtifactPath(rawPath),
      schedulesNdjson: relativeArtifactPath(schedulesPath),
      manifest: relativeArtifactPath(manifestPath),
    },
    limitations: [
      'The endpoint is a public institutional scheduling view, not a professional-licensing registry.',
      'A schedule record reflects the source at retrievedAt and may change without notice.',
      'Day text and all timing qualifiers are preserved in scheduleText; intervals only capture explicit HH:MM a HH:MM ranges and do not encode week-of-month qualifiers.',
      'The default endpoint query carries the institution UI filters; those exact parameters are recorded in source.queryFilter.',
    ],
  };
  await writeJsonAtomically(manifestPath, manifest);
  await writeJsonAtomically(paths.latestPointer, {
    schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
    provider: 'Hospital Británico',
    runId,
    generatedAt,
    manifestPath: relativeArtifactPath(manifestPath),
  });

  return {
    manifestPath: relativeArtifactPath(manifestPath),
    physicianCount: physicianNames.size,
    runId,
    scheduleRecords: records.length,
    specialtyCount: specialties.size,
  };
}

async function main(): Promise<void> {
  const summary = await runHospitalBritanicoIngestion();
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
