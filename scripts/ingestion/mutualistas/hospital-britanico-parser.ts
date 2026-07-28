import { load } from 'cheerio';

import {
  normalizeForMatch,
  normalizeWhitespace,
  PUBLIC_DATA_SCHEMA_VERSION,
  sha256,
} from './casmu-hb-artifacts';

export const HOSPITAL_BRITANICO_EXTRACTOR_VERSION = 'hospital-britanico-public-schedules/1.0.0';

export interface HospitalBritanicoInterval {
  readonly endTime: string;
  readonly startTime: string;
}

export interface HospitalBritanicoScheduleRecord {
  readonly clinic: string;
  readonly day: string;
  readonly extractorVersion: string;
  readonly intervals: readonly HospitalBritanicoInterval[];
  readonly physicianName: string;
  readonly provider: 'Hospital Británico';
  readonly recordId: string;
  readonly retrievedAt: string;
  readonly scheduleText: string;
  readonly schemaVersion: string;
  readonly sourceHashSha256: string;
  readonly sourcePageUrl: string;
  readonly sourcePhysicianRow: number;
  readonly sourceUrl: string;
  readonly specialty: string;
}

export interface HospitalBritanicoParseResult {
  readonly candidatePhysicianRows: number;
  readonly candidateScheduleEntries: number;
  readonly duplicateEntriesDiscarded: number;
  readonly htmlLength: number;
  readonly invalidPhysicianRows: number;
  readonly invalidScheduleEntries: number;
  readonly records: readonly HospitalBritanicoScheduleRecord[];
}

export interface HospitalBritanicoTrace {
  readonly extractorVersion: string;
  readonly retrievedAt: string;
  readonly sourceHashSha256: string;
  readonly sourcePageUrl: string;
  readonly sourceUrl: string;
}

interface HospitalBritanicoPayload {
  readonly resultados_html: string;
}

function isHospitalBritanicoPayload(value: unknown): value is HospitalBritanicoPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof (value as Record<string, unknown>)['resultados_html'] === 'string';
}

function normalizedClock(hourText: string, minuteText: string): string | null {
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseHospitalBritanicoIntervals(
  scheduleText: string,
): readonly HospitalBritanicoInterval[] {
  const intervals: HospitalBritanicoInterval[] = [];
  const rangePattern = /(\d{1,2}):(\d{2})\s*a\s*(\d{1,2}):(\d{2})/giu;

  for (const match of scheduleText.matchAll(rangePattern)) {
    const startTime =
      match[1] === undefined || match[2] === undefined ? null : normalizedClock(match[1], match[2]);
    const endTime =
      match[3] === undefined || match[4] === undefined ? null : normalizedClock(match[3], match[4]);
    if (startTime !== null && endTime !== null) {
      intervals.push({ endTime, startTime });
    }
  }

  return intervals;
}

function scheduleRecordId(
  physicianName: string,
  specialty: string,
  clinic: string,
  day: string,
  scheduleText: string,
): string {
  const canonicalValue = [
    normalizeForMatch(physicianName),
    normalizeForMatch(specialty),
    normalizeForMatch(clinic),
    normalizeForMatch(day),
    normalizeForMatch(scheduleText),
  ].join('|');

  return `hb_schedule_${sha256(canonicalValue).slice(0, 24)}`;
}

export function parseHospitalBritanicoHtml(
  html: string,
  trace: HospitalBritanicoTrace,
): HospitalBritanicoParseResult {
  const $ = load(html);
  const records = new Map<string, HospitalBritanicoScheduleRecord>();
  let candidatePhysicianRows = 0;
  let candidateScheduleEntries = 0;
  let duplicateEntriesDiscarded = 0;
  let invalidPhysicianRows = 0;
  let invalidScheduleEntries = 0;

  $('.accordion-item.horarios-v2-grid-especialidad').each((_specialtyIndex, specialtyContainer) => {
    const specialty = normalizeWhitespace(
      $(specialtyContainer)
        .find('.horarios-v2-grid-especialidad-header .fw-semibold')
        .first()
        .text(),
    );

    $(specialtyContainer)
      .find('.horarios-medico')
      .each((physicianIndex, physicianContainer) => {
        candidatePhysicianRows += 1;
        const physicianName = normalizeWhitespace(
          $(physicianContainer)
            .find('.d-none.d-lg-block .fw-medium.text-primary, .d-none.d-lg-block .text-primary')
            .first()
            .text() || $(physicianContainer).find('.text-primary').first().text(),
        );
        const clinicNode = $(physicianContainer).find('.horarios-clinica-mobile').first().clone();
        clinicNode.find('span').remove();
        const clinic = normalizeWhitespace(clinicNode.text());

        if (specialty.length === 0 || physicianName.length === 0) {
          invalidPhysicianRows += 1;
          return;
        }

        const scheduleEntries = $(physicianContainer).find('.horarios-mobile > div.d-lg-none');
        if (scheduleEntries.length === 0) {
          invalidScheduleEntries += 1;
          return;
        }

        scheduleEntries.each((_scheduleIndex, scheduleEntry) => {
          candidateScheduleEntries += 1;
          const dayNode = $(scheduleEntry).find('.fw-medium').first();
          const day = normalizeWhitespace(dayNode.text()).replace(/:\s*$/u, '');
          const scheduleNode = $(scheduleEntry).clone();
          scheduleNode.find('.fw-medium').first().remove();
          const timeExpression = normalizeWhitespace(scheduleNode.text());
          const scheduleText =
            day.length > 0 && timeExpression.length > 0 ? `${day}: ${timeExpression}` : '';

          if (scheduleText.length === 0) {
            invalidScheduleEntries += 1;
            return;
          }

          const recordId = scheduleRecordId(physicianName, specialty, clinic, day, scheduleText);
          if (records.has(recordId)) {
            duplicateEntriesDiscarded += 1;
            return;
          }

          records.set(recordId, {
            clinic,
            day,
            extractorVersion: trace.extractorVersion,
            intervals: parseHospitalBritanicoIntervals(scheduleText),
            physicianName,
            provider: 'Hospital Británico',
            recordId,
            retrievedAt: trace.retrievedAt,
            scheduleText,
            schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
            sourceHashSha256: trace.sourceHashSha256,
            sourcePageUrl: trace.sourcePageUrl,
            sourcePhysicianRow: physicianIndex + 1,
            sourceUrl: trace.sourceUrl,
            specialty,
          });
        });
      });
  });

  return {
    candidatePhysicianRows,
    candidateScheduleEntries,
    duplicateEntriesDiscarded,
    htmlLength: html.length,
    invalidPhysicianRows,
    invalidScheduleEntries,
    records: [...records.values()],
  };
}

export function parseHospitalBritanicoResponse(
  rawResponse: string,
  trace: HospitalBritanicoTrace,
): HospitalBritanicoParseResult {
  const payload: unknown = JSON.parse(rawResponse);
  if (!isHospitalBritanicoPayload(payload)) {
    throw new Error('Hospital Británico response does not contain resultados_html');
  }

  return parseHospitalBritanicoHtml(payload.resultados_html, trace);
}
