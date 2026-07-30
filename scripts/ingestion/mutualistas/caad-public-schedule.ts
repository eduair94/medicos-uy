import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { load } from 'cheerio';

import { configuredDataDirectory } from '../prepare-data-directories';

export const PUBLISHED_CONSULTATION_ROSTER = 'published_consultation_roster' as const;
export const APPOINTMENT_AVAILABILITY_NOT_OBSERVED = 'not_observed' as const;

const DEFAULT_DELAY_MS = 350;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
const POSSIBLE_SOURCE_PAGE_LIMIT = 20;
const USER_AGENT =
  'medicos-uy-public-research/0.1 (public institutional schedule ingestion; no authenticated data)';

const weekdays = [
  ['monday', 'Lunes', ['Lunes', 'Lun.']],
  ['tuesday', 'Martes', ['Martes', 'Mar.']],
  ['wednesday', 'Miércoles', ['Miércoles', 'Mié.']],
  ['thursday', 'Jueves', ['Jueves', 'Jue.']],
  ['friday', 'Viernes', ['Viernes', 'Vie.']],
  ['saturday', 'Sábado', ['Sábado', 'Sáb.']],
  ['sunday', 'Domingo', ['Domingo', 'Dom.']],
] as const;

export type Weekday = (typeof weekdays)[number][0];

export interface DoctorFilterOption {
  id: string;
  label: string;
}

export interface WeeklyScheduleEntry {
  dayOfWeek: Weekday;
  sourceLabel: string;
  value: string;
}

export interface PublishedScheduleRecord {
  schemaVersion: 1;
  recordId: string;
  source: {
    id: string;
    institution: string;
    url: string;
  };
  observedAt: string;
  scheduleType: typeof PUBLISHED_CONSULTATION_ROSTER;
  appointmentAvailability: typeof APPOINTMENT_AVAILABILITY_NOT_OBSERVED;
  sourceProfessionalId: string;
  sourceProfessionalLabel: string;
  professionalName: string;
  specialty: string;
  venue: {
    name?: string;
    address?: string;
    phone?: string;
    dependency?: string;
  };
  weeklySchedule: WeeklyScheduleEntry[];
  frequency?: string;
  notes?: string;
  evidence: {
    rawSnapshotPath: string;
    rawSnapshotSha256: string;
    sourceRowNumber: number;
  };
}

interface CaadColumnConfiguration {
  professionalName: readonly string[];
  specialty: readonly string[];
  venueName: readonly string[];
  address: readonly string[];
  phone: readonly string[];
  dependency: readonly string[];
  frequency: readonly string[];
  notes: readonly string[];
}

export interface CaadSourceConfiguration {
  slug: 'asociacion-espanola' | 'medica-uruguaya' | 'smi';
  sourceId: string;
  institution: string;
  sourceUrl: string;
  columns: CaadColumnConfiguration;
}

export const SMI_SOURCE: CaadSourceConfiguration = {
  slug: 'smi',
  sourceId: 'smi-public-medical-schedule',
  institution: 'Servicio Médico Integral (SMI)',
  sourceUrl: 'https://www.smi.com.uy/mvdcaad/acasasAdheridas.aspx',
  columns: {
    professionalName: ['Médico/Técnico/Licenciado'],
    specialty: ['Especialidad'],
    venueName: ['Sede'],
    address: ['Dirección'],
    phone: ['Teléfono'],
    dependency: [],
    frequency: [],
    notes: ['Obs.'],
  },
};

export const MEDICA_URUGUAYA_SOURCE: CaadSourceConfiguration = {
  slug: 'medica-uruguaya',
  sourceId: 'medica-uruguaya-public-medical-schedule',
  institution: 'Médica Uruguaya',
  sourceUrl: 'https://www.medicauruguaya.com.uy/mvdcaad/acasasadheridas.aspx',
  columns: {
    professionalName: ['Médico'],
    specialty: ['Especialidad'],
    venueName: ['Policlínica / Lugar'],
    address: [],
    phone: [],
    dependency: ['Dependencia'],
    frequency: ['Frecuencia'],
    notes: [],
  },
};

export const ASOCIACION_ESPANOLA_SOURCE: CaadSourceConfiguration = {
  slug: 'asociacion-espanola',
  sourceId: 'asociacion-espanola-public-medical-schedule',
  institution: 'Asociación Española',
  sourceUrl: 'https://www.asesp.com.uy/mvdcaad35/acasasadheridas.aspx',
  columns: {
    professionalName: ['Médico'],
    specialty: ['Especialidad'],
    venueName: ['Policlínica / Lugar'],
    address: [],
    phone: [],
    dependency: [],
    frequency: [],
    notes: [],
  },
};

export interface ScheduleParseContext {
  observedAt: string;
  sourceProfessionalId: string;
  sourceProfessionalLabel: string;
  rawSnapshotPath: string;
  rawSnapshotSha256: string;
}

export interface IngestionRunOptions {
  delayMs?: number;
  timeoutMs?: number;
  retries?: number;
  limit?: number;
  outputDirectory?: string;
  fetchImplementation?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

interface EffectiveRunOptions {
  delayMs: number;
  timeoutMs: number;
  retries: number;
  limit?: number;
  outputDirectory: string;
  fetchImplementation: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
}

interface DoctorRequestFailure {
  sourceProfessionalId: string;
  sourceProfessionalLabel: string;
  failedAt: string;
  message: string;
}

export interface IngestionManifest {
  schemaVersion: 1;
  runId: string;
  source: {
    id: string;
    institution: string;
    url: string;
  };
  status: 'running' | 'complete' | 'sample_complete' | 'partial';
  scope: 'full_filter_enumeration' | 'limited_sample';
  startedAt: string;
  completedAt?: string;
  scheduleType: typeof PUBLISHED_CONSULTATION_ROSTER;
  appointmentAvailability: typeof APPOINTMENT_AVAILABILITY_NOT_OBSERVED;
  httpPolicy: {
    sequential: true;
    delayMs: number;
    timeoutMs: number;
    retries: number;
    userAgent: string;
  };
  counts: {
    doctorsAdvertisedByFilter: number;
    doctorsSelected: number;
    doctorRequestsSucceeded: number;
    doctorRequestsFailed: number;
    doctorsWithNoPublishedRows: number;
    doctorResponsesAtPossibleSourceLimit: number;
    sourceRowsParsed: number;
    recordsWritten: number;
    duplicateRowsSkipped: number;
  };
  limitations: string[];
  artifacts: {
    initialSnapshot: string;
    doctorFilterOptions: string;
    schedulesNdjson: string;
    failuresNdjson: string;
    doctorSnapshotsDirectory: string;
  };
  initialSnapshotSha256?: string;
  failures: DoctorRequestFailure[];
}

interface FetchTextOptions {
  timeoutMs: number;
  retries: number;
  fetchImplementation?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface FetchTextResult {
  text: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
}

class NonRetryableHttpError extends Error {}

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

interface CliOptions {
  help: boolean;
  runOptions: IngestionRunOptions;
}

function cleanSingleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function cleanCellText(value: string): string {
  return value
    .split(/\r?\n/gu)
    .map((part) => cleanSingleLine(part))
    .filter((part) => part.length > 0)
    .join(' | ');
}

function normalizeHeader(value: string): string {
  return cleanSingleLine(
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^\p{Letter}\p{Number}]+/gu, ' '),
  ).toLocaleLowerCase('es-UY');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function portablePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function getHeaderIndex(
  headers: readonly string[],
  candidates: readonly string[],
): number | undefined {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const candidateSet = new Set(candidates.map((candidate) => normalizeHeader(candidate)));
  const index = normalizedHeaders.findIndex((header) => candidateSet.has(header));
  return index >= 0 ? index : undefined;
}

function getCell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (row[index] ?? '');
}

function extractScheduleTable(html: string): ParsedTable | undefined {
  const $ = load(html);

  for (const table of $('table').toArray()) {
    const rowElements = $(table).find('tr').toArray();
    const headerRow = rowElements[0];

    if (headerRow === undefined) {
      continue;
    }

    const headers = $(headerRow)
      .find('th,td')
      .toArray()
      .map((cell) => cleanSingleLine($(cell).text()));
    const normalizedHeaders = headers.map((header) => normalizeHeader(header));
    const hasProfessional = normalizedHeaders.some((header) => header.startsWith('medico'));
    const hasSpecialty = normalizedHeaders.includes('especialidad');

    if (!hasProfessional || !hasSpecialty) {
      continue;
    }

    const rows = rowElements.slice(1).map((row) =>
      $(row)
        .find('th,td')
        .toArray()
        .map((cell) => {
          const clone = $(cell).clone();
          clone.find('br').replaceWith('\n');
          return cleanCellText(clone.text());
        }),
    );

    return {
      headers,
      rows: rows.filter((row) => row.some((cell) => cell.length > 0)),
    };
  }

  const pageText = cleanSingleLine($('body').text());

  if (/no se encontraron resultados/iu.test(pageText)) {
    return {
      headers: [],
      rows: [],
    };
  }

  return undefined;
}

export function parseDoctorFilterOptions(html: string): DoctorFilterOption[] {
  const $ = load(html);
  const doctorSelect = $('select#FiltroId2').first().length
    ? $('select#FiltroId2').first()
    : $('select[name="FiltroId2"]').first();
  const seenIds = new Set<string>();
  const doctors: DoctorFilterOption[] = [];

  for (const option of doctorSelect.find('option').toArray()) {
    const id = cleanSingleLine($(option).attr('value') ?? '');
    const label = cleanSingleLine($(option).text());

    if (id.length === 0 || id === '0' || label.length === 0 || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    doctors.push({
      id,
      label,
    });
  }

  if (doctors.length === 0) {
    throw new Error('The public form did not expose any doctor options in FiltroId2.');
  }

  return doctors;
}

export function parsePublishedScheduleRows(
  configuration: CaadSourceConfiguration,
  html: string,
  context: ScheduleParseContext,
): PublishedScheduleRecord[] {
  const table = extractScheduleTable(html);

  if (table === undefined) {
    throw new Error(
      `No recognizable medical schedule table or explicit no-results message was found for ${configuration.institution}.`,
    );
  }

  if (table.rows.length === 0) {
    return [];
  }

  const nameIndex = getHeaderIndex(table.headers, configuration.columns.professionalName);
  const specialtyIndex = getHeaderIndex(table.headers, configuration.columns.specialty);

  if (nameIndex === undefined || specialtyIndex === undefined) {
    throw new Error(
      `The schedule table for ${configuration.institution} no longer has the expected professional and specialty columns.`,
    );
  }

  const venueNameIndex = getHeaderIndex(table.headers, configuration.columns.venueName);
  const addressIndex = getHeaderIndex(table.headers, configuration.columns.address);
  const phoneIndex = getHeaderIndex(table.headers, configuration.columns.phone);
  const dependencyIndex = getHeaderIndex(table.headers, configuration.columns.dependency);
  const frequencyIndex = getHeaderIndex(table.headers, configuration.columns.frequency);
  const notesIndex = getHeaderIndex(table.headers, configuration.columns.notes);
  const weekdayIndexes = weekdays.map(([dayOfWeek, defaultSourceLabel, headerAliases]) => {
    const index = getHeaderIndex(table.headers, headerAliases);
    return {
      dayOfWeek,
      sourceLabel:
        index === undefined ? defaultSourceLabel : (table.headers[index] ?? defaultSourceLabel),
      index,
    };
  });

  return table.rows.flatMap((row, rowIndex) => {
    const professionalName = getCell(row, nameIndex);
    const specialty = getCell(row, specialtyIndex);

    if (professionalName.length === 0 && specialty.length === 0) {
      return [];
    }

    const venueName = getCell(row, venueNameIndex);
    const address = getCell(row, addressIndex);
    const phone = getCell(row, phoneIndex);
    const dependency = getCell(row, dependencyIndex);
    const frequency = getCell(row, frequencyIndex);
    const notes = getCell(row, notesIndex);
    const weeklySchedule = weekdayIndexes.flatMap<WeeklyScheduleEntry>(
      ({ dayOfWeek, sourceLabel, index }) => {
        const value = getCell(row, index);
        return value.length > 0
          ? [
              {
                dayOfWeek,
                sourceLabel,
                value,
              },
            ]
          : [];
      },
    );
    const stableRow = {
      sourceId: configuration.sourceId,
      sourceProfessionalId: context.sourceProfessionalId,
      professionalName,
      specialty,
      venueName,
      address,
      phone,
      dependency,
      frequency,
      notes,
      weeklySchedule,
    };

    return [
      {
        schemaVersion: 1,
        recordId: sha256(JSON.stringify(stableRow)),
        source: {
          id: configuration.sourceId,
          institution: configuration.institution,
          url: configuration.sourceUrl,
        },
        observedAt: context.observedAt,
        scheduleType: PUBLISHED_CONSULTATION_ROSTER,
        appointmentAvailability: APPOINTMENT_AVAILABILITY_NOT_OBSERVED,
        sourceProfessionalId: context.sourceProfessionalId,
        sourceProfessionalLabel: context.sourceProfessionalLabel,
        professionalName,
        specialty,
        venue: {
          ...(venueName.length > 0 ? { name: venueName } : {}),
          ...(address.length > 0 ? { address } : {}),
          ...(phone.length > 0 ? { phone } : {}),
          ...(dependency.length > 0 ? { dependency } : {}),
        },
        weeklySchedule,
        ...(frequency.length > 0 ? { frequency } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        evidence: {
          rawSnapshotPath: context.rawSnapshotPath,
          rawSnapshotSha256: context.rawSnapshotSha256,
          sourceRowNumber: rowIndex + 2,
        },
      },
    ];
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const date = Date.parse(value);

  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, date - Date.now());
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export async function fetchTextWithRetry(
  url: string,
  request: RequestInit,
  options: FetchTextOptions,
): Promise<FetchTextResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    }, options.timeoutMs);

    try {
      const response = await fetchImplementation(url, {
        ...request,
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        const httpError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);

        if (!retryable) {
          throw new NonRetryableHttpError(httpError.message);
        }

        if (attempt === options.retries) {
          throw httpError;
        }

        lastError = httpError;
        const retryAfter = parseRetryAfterMilliseconds(response.headers.get('retry-after'));
        await response.body?.cancel();
        await sleep(retryAfter ?? Math.min(500 * 2 ** attempt, 5_000));
        continue;
      }

      return {
        text: await response.text(),
        finalUrl: response.url || url,
        status: response.status,
        contentType: response.headers.get('content-type'),
      };
    } catch (error: unknown) {
      lastError = error;

      if (error instanceof NonRetryableHttpError || attempt === options.retries) {
        throw error;
      }

      await sleep(Math.min(500 * 2 ** attempt, 5_000));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}

function createRunId(date: Date): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function createDefaultOutputDirectory(
  configuration: CaadSourceConfiguration,
  runId: string,
): string {
  return resolve(configuredDataDirectory(), 'raw', 'mutualistas', configuration.slug, runId);
}

function buildEffectiveOptions(
  configuration: CaadSourceConfiguration,
  options: IngestionRunOptions,
  runId: string,
  now: () => Date,
): EffectiveRunOptions {
  return {
    delayMs: options.delayMs ?? DEFAULT_DELAY_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    outputDirectory:
      options.outputDirectory === undefined
        ? createDefaultOutputDirectory(configuration, runId)
        : resolve(options.outputDirectory),
    fetchImplementation: options.fetchImplementation ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    now,
  };
}

function validateRunOptions(options: EffectiveRunOptions): void {
  if (!Number.isInteger(options.delayMs) || options.delayMs < 250) {
    throw new Error('delayMs must be an integer of at least 250 ms.');
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('timeoutMs must be an integer of at least 1000 ms.');
  }

  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new Error('retries must be a non-negative integer.');
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('limit must be a positive integer when provided.');
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createManifest(
  configuration: CaadSourceConfiguration,
  runId: string,
  startedAt: string,
  options: EffectiveRunOptions,
  doctorsAdvertisedByFilter: number,
  doctorsSelected: number,
): IngestionManifest {
  return {
    schemaVersion: 1,
    runId,
    source: {
      id: configuration.sourceId,
      institution: configuration.institution,
      url: configuration.sourceUrl,
    },
    status: 'running',
    scope:
      doctorsSelected < doctorsAdvertisedByFilter ? 'limited_sample' : 'full_filter_enumeration',
    startedAt,
    scheduleType: PUBLISHED_CONSULTATION_ROSTER,
    appointmentAvailability: APPOINTMENT_AVAILABILITY_NOT_OBSERVED,
    httpPolicy: {
      sequential: true,
      delayMs: options.delayMs,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      userAgent: USER_AGENT,
    },
    counts: {
      doctorsAdvertisedByFilter,
      doctorsSelected,
      doctorRequestsSucceeded: 0,
      doctorRequestsFailed: 0,
      doctorsWithNoPublishedRows: 0,
      doctorResponsesAtPossibleSourceLimit: 0,
      sourceRowsParsed: 0,
      recordsWritten: 0,
      duplicateRowsSkipped: 0,
    },
    limitations: [
      'These are institution-published consultation rosters, not real-time appointment slots.',
      'No authenticated portal, member account, or private appointment data was accessed.',
      `The upstream all-results form returned only ${POSSIBLE_SOURCE_PAGE_LIMIT} rows during discovery, so the ingestion enumerates every public doctor filter option sequentially.`,
      `A single-doctor response with ${POSSIBLE_SOURCE_PAGE_LIMIT} or more rows is flagged because the public form may still truncate it.`,
      'Names are source text and are not treated as unique national identifiers.',
      'Public visibility does not by itself establish reuse authorization; downstream publication remains blocked pending a source-specific legal and purpose assessment.',
    ],
    artifacts: {
      initialSnapshot: 'raw/index.html',
      doctorFilterOptions: 'doctor-filter-options.json',
      schedulesNdjson: 'schedules.ndjson',
      failuresNdjson: 'failures.ndjson',
      doctorSnapshotsDirectory: 'raw/doctors',
    },
    failures: [],
  };
}

function postBodyForDoctor(doctorId: string): URLSearchParams {
  return new URLSearchParams({
    FiltroId1: '0',
    FiltroId2: doctorId,
    FiltroId3: '0',
  });
}

export async function runCaadIngestion(
  configuration: CaadSourceConfiguration,
  runOptions: IngestionRunOptions = {},
): Promise<IngestionManifest> {
  const now = runOptions.now ?? (() => new Date());
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const runId = createRunId(startedAtDate);
  const options = buildEffectiveOptions(configuration, runOptions, runId, now);
  validateRunOptions(options);

  const outputDirectory = options.outputDirectory;
  const rawDirectory = resolve(outputDirectory, 'raw');
  const doctorSnapshotsDirectory = resolve(rawDirectory, 'doctors');
  const schedulesPath = resolve(outputDirectory, 'schedules.ndjson');
  const failuresPath = resolve(outputDirectory, 'failures.ndjson');
  const manifestPath = resolve(outputDirectory, 'manifest.json');

  await mkdir(dirname(outputDirectory), {
    recursive: true,
  });
  await mkdir(outputDirectory);
  await mkdir(doctorSnapshotsDirectory, {
    recursive: true,
  });

  const initialResponse = await fetchTextWithRetry(
    configuration.sourceUrl,
    {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': USER_AGENT,
      },
    },
    {
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      fetchImplementation: options.fetchImplementation,
      sleep: options.sleep,
    },
  );
  const initialSnapshotPath = resolve(rawDirectory, 'index.html');
  await writeFile(initialSnapshotPath, initialResponse.text, 'utf8');

  const allDoctors = parseDoctorFilterOptions(initialResponse.text);
  const selectedDoctors =
    options.limit === undefined ? allDoctors : allDoctors.slice(0, options.limit);
  const doctorOptionsArtifact = {
    schemaVersion: 1,
    sourceUrl: configuration.sourceUrl,
    observedAt: startedAt,
    advertisedCount: allDoctors.length,
    selectedCount: selectedDoctors.length,
    selectedDoctors,
  };
  await writeJson(resolve(outputDirectory, 'doctor-filter-options.json'), doctorOptionsArtifact);
  await writeFile(schedulesPath, '', 'utf8');
  await writeFile(failuresPath, '', 'utf8');

  const manifest = createManifest(
    configuration,
    runId,
    startedAt,
    options,
    allDoctors.length,
    selectedDoctors.length,
  );
  manifest.initialSnapshotSha256 = sha256(initialResponse.text);
  await writeJson(manifestPath, manifest);

  const recordIds = new Set<string>();

  for (const [doctorIndex, doctor] of selectedDoctors.entries()) {
    const requestNumber = doctorIndex + 1;
    const snapshotRelativePath = portablePath(
      `raw/doctors/${String(requestNumber).padStart(4, '0')}-${doctor.id}.html`,
    );
    const snapshotAbsolutePath = resolve(outputDirectory, snapshotRelativePath);

    try {
      const response = await fetchTextWithRetry(
        configuration.sourceUrl,
        {
          method: 'POST',
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': USER_AGENT,
          },
          body: postBodyForDoctor(doctor.id),
        },
        {
          timeoutMs: options.timeoutMs,
          retries: options.retries,
          fetchImplementation: options.fetchImplementation,
          sleep: options.sleep,
        },
      );
      const observedAt = options.now().toISOString();
      const snapshotSha256 = sha256(response.text);
      await writeFile(snapshotAbsolutePath, response.text, 'utf8');

      const records = parsePublishedScheduleRows(configuration, response.text, {
        observedAt,
        sourceProfessionalId: doctor.id,
        sourceProfessionalLabel: doctor.label,
        rawSnapshotPath: snapshotRelativePath,
        rawSnapshotSha256: snapshotSha256,
      });
      manifest.counts.doctorRequestsSucceeded += 1;
      manifest.counts.sourceRowsParsed += records.length;

      if (records.length === 0) {
        manifest.counts.doctorsWithNoPublishedRows += 1;
      }

      if (records.length >= POSSIBLE_SOURCE_PAGE_LIMIT) {
        manifest.counts.doctorResponsesAtPossibleSourceLimit += 1;
      }

      const uniqueRecords = records.filter((record) => {
        if (recordIds.has(record.recordId)) {
          manifest.counts.duplicateRowsSkipped += 1;
          return false;
        }

        recordIds.add(record.recordId);
        return true;
      });

      if (uniqueRecords.length > 0) {
        await appendFile(
          schedulesPath,
          `${uniqueRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
          'utf8',
        );
        manifest.counts.recordsWritten += uniqueRecords.length;
      }
    } catch (error: unknown) {
      const failure: DoctorRequestFailure = {
        sourceProfessionalId: doctor.id,
        sourceProfessionalLabel: doctor.label,
        failedAt: options.now().toISOString(),
        message: errorMessage(error),
      };
      manifest.failures.push(failure);
      manifest.counts.doctorRequestsFailed += 1;
      await appendFile(failuresPath, `${JSON.stringify(failure)}\n`, 'utf8');
    }

    if (
      requestNumber === 1 ||
      requestNumber % 25 === 0 ||
      requestNumber === selectedDoctors.length
    ) {
      console.log(
        `[${configuration.slug}] ${requestNumber}/${selectedDoctors.length} doctors; ` +
          `${manifest.counts.recordsWritten} rows; ${manifest.counts.doctorRequestsFailed} failures`,
      );
      await writeJson(manifestPath, manifest);
    }

    if (requestNumber < selectedDoctors.length) {
      await options.sleep(options.delayMs);
    }
  }

  manifest.completedAt = options.now().toISOString();
  manifest.status =
    manifest.counts.doctorRequestsFailed > 0
      ? 'partial'
      : manifest.scope === 'limited_sample'
        ? 'sample_complete'
        : 'complete';
  await writeJson(manifestPath, manifest);

  return manifest;
}

function parseIntegerOption(name: string, value: string | undefined, minimum: number): number {
  if (value === undefined) {
    throw new Error(`${name} requires a value.`);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }

  return parsed;
}

export function parseCaadCliOptions(arguments_: readonly string[]): CliOptions {
  const runOptions: IngestionRunOptions = {};
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === undefined) {
      throw new Error(`Missing argument at position ${index}.`);
    }

    switch (argument) {
      case '--delay-ms':
        runOptions.delayMs = parseIntegerOption(argument, arguments_[index + 1], 250);
        index += 1;
        break;
      case '--timeout-ms':
        runOptions.timeoutMs = parseIntegerOption(argument, arguments_[index + 1], 1_000);
        index += 1;
        break;
      case '--retries':
        runOptions.retries = parseIntegerOption(argument, arguments_[index + 1], 0);
        index += 1;
        break;
      case '--limit':
        runOptions.limit = parseIntegerOption(argument, arguments_[index + 1], 1);
        index += 1;
        break;
      case '--output-dir': {
        const outputDirectory = arguments_[index + 1];

        if (outputDirectory === undefined || outputDirectory.length === 0) {
          throw new Error('--output-dir requires a path.');
        }

        runOptions.outputDirectory = outputDirectory;
        index += 1;
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument ?? '<undefined>'}`);
    }
  }

  return {
    help,
    runOptions,
  };
}

function cliHelp(configuration: CaadSourceConfiguration): string {
  return [
    `Download the complete public ${configuration.institution} consultation roster.`,
    '',
    'This reads only anonymous public pages. The output is not appointment availability.',
    '',
    'Options:',
    '  --delay-ms <n>     Delay between sequential doctor requests (default: 350, minimum: 250)',
    '  --timeout-ms <n>   Per-request timeout (default: 20000)',
    '  --retries <n>      Retries for transient failures (default: 3)',
    '  --limit <n>        Download only the first n public doctor options',
    '  --output-dir <dir> Write into an explicit new directory',
    '  --help             Show this help',
  ].join('\n');
}

export async function runCaadCli(
  configuration: CaadSourceConfiguration,
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const cliOptions = parseCaadCliOptions(arguments_);

  if (cliOptions.help) {
    console.log(cliHelp(configuration));
    return;
  }

  const manifest = await runCaadIngestion(configuration, cliOptions.runOptions);
  console.log(
    `[${configuration.slug}] ${manifest.status}: ${manifest.counts.recordsWritten} rows from ` +
      `${manifest.counts.doctorRequestsSucceeded}/${manifest.counts.doctorsSelected} doctor requests.`,
  );

  if (manifest.status === 'partial') {
    process.exitCode = 2;
  }
}
