import { load } from 'cheerio';

import {
  canonicalizePublicUrl,
  normalizeForMatch,
  normalizeMultilineText,
  normalizePhysicianForMatch,
  normalizeWhitespace,
  PUBLIC_DATA_SCHEMA_VERSION,
  sha256,
} from './casmu-hb-artifacts';

export const CASMU_EXTRACTOR_VERSION = 'casmu-directory-and-centers/1.0.0';

export interface CasmuSourceTrace {
  readonly extractorVersion: string;
  readonly retrievedAt: string;
  readonly sourceHashSha256: string;
  readonly sourceUrl: string;
}

export interface CasmuDirectoryRecord extends CasmuSourceTrace {
  readonly address: string;
  readonly center: string;
  readonly centerSourceUrl: string | null;
  readonly physicianName: string;
  readonly provider: 'CASMU';
  readonly recordId: string;
  readonly scheduleRecordIds: readonly string[];
  readonly scheduleType: 'not_published_on_source' | 'published_on_center_page';
  readonly schemaVersion: string;
  readonly sourceRow: number;
  readonly specialty: string;
}

export interface CasmuScheduleRecord extends CasmuSourceTrace {
  readonly address: string;
  readonly center: string;
  readonly physicianLabel: string;
  readonly physicianName: string;
  readonly provider: 'CASMU';
  readonly recordId: string;
  readonly scheduleText: string;
  readonly schemaVersion: string;
  readonly sourceRequestedUrl: string;
  readonly sourceRow: number;
  readonly specialty: string | null;
}

export interface CasmuDirectoryParseResult {
  readonly completeRows: number;
  readonly duplicateRowsDiscarded: number;
  readonly invalidRows: number;
  readonly records: readonly CasmuDirectoryRecord[];
  readonly totalRows: number;
  readonly uniqueCenterUrls: readonly string[];
}

export interface CasmuDirectoryQuality {
  readonly acceptable: boolean;
  readonly completeRowRatio: number;
  readonly issues: readonly string[];
  readonly minimumRows: number;
  readonly uniqueCenterUrlCount: number;
}

export interface CasmuCenterContext {
  readonly address: string;
  readonly center: string;
  readonly extractorVersion?: string;
  readonly finalUrl: string;
  readonly requestedUrl: string;
  readonly retrievedAt: string;
  readonly sourceHashSha256: string;
}

export interface CasmuCenterParseResult {
  readonly duplicateRowsDiscarded: number;
  readonly invalidRows: number;
  readonly records: readonly CasmuScheduleRecord[];
  readonly scheduleTables: number;
  readonly tablesWithoutSpecialtyContext: number;
  readonly totalCandidateRows: number;
}

function directoryRecordId(
  physicianName: string,
  specialty: string,
  center: string,
  address: string,
  centerSourceUrl: string | null,
): string {
  const canonicalValue = [
    normalizePhysicianForMatch(physicianName),
    normalizeForMatch(specialty),
    normalizeForMatch(center),
    normalizeForMatch(address),
    centerSourceUrl ?? '',
  ].join('|');

  return `casmu_physician_${sha256(canonicalValue).slice(0, 24)}`;
}

function scheduleRecordId(
  physicianName: string,
  specialty: string | null,
  scheduleText: string,
  sourceRequestedUrl: string,
): string {
  const canonicalValue = [
    sourceRequestedUrl,
    normalizePhysicianForMatch(physicianName),
    normalizeForMatch(specialty ?? ''),
    normalizeForMatch(scheduleText),
  ].join('|');

  return `casmu_schedule_${sha256(canonicalValue).slice(0, 24)}`;
}

function replaceBreaksWithNewlines(htmlFragment: string | null): string {
  const fragment = load(htmlFragment ?? '');
  fragment('br').replaceWith('\n');
  return normalizeMultilineText(fragment.root().text());
}

export function parseCasmuDirectory(
  html: string,
  trace: CasmuSourceTrace,
): CasmuDirectoryParseResult {
  const $ = load(html);
  const table = $('#tablepress-59');
  const rows = table.find('tbody tr');
  const records = new Map<string, CasmuDirectoryRecord>();
  const centerUrls = new Set<string>();
  let completeRows = 0;
  let invalidRows = 0;
  let duplicateRowsDiscarded = 0;
  let carriedSpecialty = '';

  rows.each((rowIndex, row) => {
    const cells = new Map<number, { readonly href: string; readonly text: string }>();

    $(row)
      .find('td')
      .each((_cellIndex, cell) => {
        const className = $(cell).attr('class') ?? '';
        const columnMatch = /(?:^|\s)column-(\d+)(?:\s|$)/u.exec(className);
        if (columnMatch?.[1] !== undefined) {
          cells.set(Number.parseInt(columnMatch[1], 10), {
            href: $(cell).find('a').first().attr('href') ?? '',
            text: normalizeWhitespace($(cell).text()),
          });
        }
      });

    if ([1, 2, 3, 4].every((column) => cells.has(column))) {
      completeRows += 1;
    }

    const explicitSpecialty = cells.get(1)?.text ?? '';
    if (explicitSpecialty.length > 0) {
      carriedSpecialty = explicitSpecialty;
    }

    const specialty = explicitSpecialty || carriedSpecialty;
    const physicianName = cells.get(2)?.text ?? '';
    const center = cells.get(3)?.text ?? '';
    const address = cells.get(4)?.text ?? '';
    const href = cells.get(3)?.href ?? '';
    const centerSourceUrl = href.length > 0 ? canonicalizePublicUrl(href, trace.sourceUrl) : null;

    if (centerSourceUrl !== null) {
      centerUrls.add(centerSourceUrl);
    }

    if (specialty.length === 0 || physicianName.length === 0) {
      invalidRows += 1;
      return;
    }

    const recordId = directoryRecordId(physicianName, specialty, center, address, centerSourceUrl);
    if (records.has(recordId)) {
      duplicateRowsDiscarded += 1;
      return;
    }

    records.set(recordId, {
      address,
      center,
      centerSourceUrl,
      extractorVersion: trace.extractorVersion,
      physicianName,
      provider: 'CASMU',
      recordId,
      retrievedAt: trace.retrievedAt,
      scheduleRecordIds: [],
      scheduleType: 'not_published_on_source',
      schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
      sourceHashSha256: trace.sourceHashSha256,
      sourceRow: rowIndex + 1,
      sourceUrl: trace.sourceUrl,
      specialty,
    });
  });

  return {
    completeRows,
    duplicateRowsDiscarded,
    invalidRows,
    records: [...records.values()],
    totalRows: rows.length,
    uniqueCenterUrls: [...centerUrls].sort(),
  };
}

export function assessCasmuDirectoryQuality(
  result: CasmuDirectoryParseResult,
  minimumRows = 100,
): CasmuDirectoryQuality {
  const completeRowRatio = result.totalRows === 0 ? 0 : result.completeRows / result.totalRows;
  const issues: string[] = [];

  if (result.totalRows < minimumRows) {
    issues.push(`Expected at least ${minimumRows} table rows, found ${result.totalRows}`);
  }
  if (completeRowRatio < 0.9) {
    issues.push(
      `Only ${(completeRowRatio * 100).toFixed(2)}% of rows contain all four directory columns`,
    );
  }
  if (result.uniqueCenterUrls.length === 0) {
    issues.push('No public center URLs survived extraction');
  }

  return {
    acceptable: issues.length === 0,
    completeRowRatio,
    issues,
    minimumRows,
    uniqueCenterUrlCount: result.uniqueCenterUrls.length,
  };
}

export function parseCasmuCenterSchedules(
  html: string,
  context: CasmuCenterContext,
): CasmuCenterParseResult {
  const $ = load(html);
  const records = new Map<string, CasmuScheduleRecord>();
  let duplicateRowsDiscarded = 0;
  let invalidRows = 0;
  let scheduleTables = 0;
  let tablesWithoutSpecialtyContext = 0;
  let totalCandidateRows = 0;

  $('table').each((_tableIndex, table) => {
    const firstRowText = normalizeForMatch($(table).find('tr').first().text());
    if (!firstRowText.includes('tecnico') || !firstRowText.includes('dias y horarios')) {
      return;
    }

    scheduleTables += 1;
    const nearbyHeadingSelectors = 'dt.sc-accordion-title,h2,h3,h4,h5,h6';
    const specialtyCandidates = [
      normalizeWhitespace($(table).find('caption').first().text()),
      normalizeWhitespace(
        $(table).closest('dd.sc-accordion-pane').prevAll('dt.sc-accordion-title').first().text(),
      ),
      normalizeWhitespace($(table).prevAll(nearbyHeadingSelectors).first().text()),
      normalizeWhitespace($(table).parent().prevAll(nearbyHeadingSelectors).first().text()),
    ];
    const specialtyContext = specialtyCandidates.find((candidate) => candidate.length > 0) ?? null;
    if (specialtyContext === null) {
      tablesWithoutSpecialtyContext += 1;
    }

    $(table)
      .find('tr')
      .slice(1)
      .each((rowIndex, row) => {
        totalCandidateRows += 1;
        const cells = $(row).find('td');
        if (cells.length < 2) {
          invalidRows += 1;
          return;
        }

        const physicianLabel = replaceBreaksWithNewlines(cells.eq(0).html());
        const physicianName = normalizeWhitespace(
          (physicianLabel.split('\n')[0] ?? '').replace(/\s*\([^)]*\).*$/u, ''),
        );
        const scheduleText = replaceBreaksWithNewlines(cells.eq(1).html());
        if (physicianName.length === 0 || scheduleText.length === 0) {
          invalidRows += 1;
          return;
        }

        const recordId = scheduleRecordId(
          physicianName,
          specialtyContext,
          scheduleText,
          context.requestedUrl,
        );
        if (records.has(recordId)) {
          duplicateRowsDiscarded += 1;
          return;
        }

        records.set(recordId, {
          address: context.address,
          center: context.center,
          extractorVersion: context.extractorVersion ?? CASMU_EXTRACTOR_VERSION,
          physicianLabel,
          physicianName,
          provider: 'CASMU',
          recordId,
          retrievedAt: context.retrievedAt,
          scheduleText,
          schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
          sourceHashSha256: context.sourceHashSha256,
          sourceRequestedUrl: context.requestedUrl,
          sourceRow: rowIndex + 1,
          sourceUrl: context.finalUrl,
          specialty: specialtyContext,
        });
      });
  });

  return {
    duplicateRowsDiscarded,
    invalidRows,
    records: [...records.values()],
    scheduleTables,
    tablesWithoutSpecialtyContext,
    totalCandidateRows,
  };
}

export function enrichCasmuDirectoryWithSchedules(
  directoryRecords: readonly CasmuDirectoryRecord[],
  scheduleRecords: readonly CasmuScheduleRecord[],
): readonly CasmuDirectoryRecord[] {
  const scheduleIdsByCenterAndPhysician = new Map<string, Set<string>>();

  for (const schedule of scheduleRecords) {
    const key = [
      schedule.sourceRequestedUrl,
      normalizePhysicianForMatch(schedule.physicianName),
    ].join('|');
    const ids = scheduleIdsByCenterAndPhysician.get(key) ?? new Set<string>();
    ids.add(schedule.recordId);
    scheduleIdsByCenterAndPhysician.set(key, ids);
  }

  return directoryRecords.map((record) => {
    if (record.centerSourceUrl === null) {
      return record;
    }

    const key = [record.centerSourceUrl, normalizePhysicianForMatch(record.physicianName)].join(
      '|',
    );
    const scheduleRecordIds = [...(scheduleIdsByCenterAndPhysician.get(key) ?? [])].sort();

    return {
      ...record,
      scheduleRecordIds,
      scheduleType:
        scheduleRecordIds.length > 0 ? 'published_on_center_page' : 'not_published_on_source',
    };
  });
}
