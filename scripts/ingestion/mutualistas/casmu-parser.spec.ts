import { describe, expect, it } from 'vitest';

import { sha256 } from './casmu-hb-artifacts';
import {
  CASMU_EXTRACTOR_VERSION,
  assessCasmuDirectoryQuality,
  enrichCasmuDirectoryWithSchedules,
  parseCasmuCenterSchedules,
  parseCasmuDirectory,
  type CasmuSourceTrace,
} from './casmu-parser';

const DIRECTORY_URL = 'https://casmu.example/nuestros-medicos/';
const RETRIEVED_AT = '2026-07-27T12:00:00.000Z';

function traceFor(html: string): CasmuSourceTrace {
  return {
    extractorVersion: CASMU_EXTRACTOR_VERSION,
    retrievedAt: RETRIEVED_AT,
    sourceHashSha256: sha256(html),
    sourceUrl: DIRECTORY_URL,
  };
}

describe('CASMU directory parser', () => {
  it('extracts and deduplicates complete public directory rows', () => {
    const html = `
      <table id="tablepress-59">
        <tbody>
          <tr>
            <td class="column-1">Acupuntura</td>
            <td class="column-2">Dra. Ada Ejemplo</td>
            <td class="column-3">
              <a href="http://casmu.example/centro-demo/ ">Centro Demo</a>
            </td>
            <td class="column-4">Calle Ejemplo 123</td>
          </tr>
          <tr>
            <td class="column-1">Acupuntura</td>
            <td class="column-2">Dra. Ada Ejemplo</td>
            <td class="column-3">
              <a href="http://casmu.example/centro-demo/ ">Centro Demo</a>
            </td>
            <td class="column-4">Calle Ejemplo 123</td>
          </tr>
          <tr>
            <td class="column-1">Cardiología</td>
            <td class="column-2">Dr. Bruno Ejemplo</td>
            <td class="column-3">
              <a href="/centro-demo/">Centro Demo</a>
            </td>
            <td class="column-4">Calle Ejemplo 123</td>
          </tr>
        </tbody>
      </table>
    `;

    const result = parseCasmuDirectory(html, traceFor(html));
    const quality = assessCasmuDirectoryQuality(result, 2);

    expect(result.totalRows).toBe(3);
    expect(result.completeRows).toBe(3);
    expect(result.duplicateRowsDiscarded).toBe(1);
    expect(result.records).toHaveLength(2);
    expect(result.uniqueCenterUrls).toEqual(['https://casmu.example/centro-demo/']);
    expect(result.records[0]).toMatchObject({
      address: 'Calle Ejemplo 123',
      center: 'Centro Demo',
      centerSourceUrl: 'https://casmu.example/centro-demo/',
      physicianName: 'Dra. Ada Ejemplo',
      scheduleRecordIds: [],
      scheduleType: 'not_published_on_source',
      specialty: 'Acupuntura',
    });
    expect(quality.acceptable).toBe(true);
  });

  it('rejects cleaned HTML that lost directory columns and center links', () => {
    const html = `
      <table id="tablepress-59">
        <tbody>
          <tr>
            <td class="column-1">Acupuntura</td>
            <td class="column-2">Dra. Ada Ejemplo</td>
          </tr>
          <tr><td class="column-2">Dr. Bruno Ejemplo</td></tr>
        </tbody>
      </table>
    `;

    const quality = assessCasmuDirectoryQuality(parseCasmuDirectory(html, traceFor(html)), 1);

    expect(quality.acceptable).toBe(false);
    expect(quality.completeRowRatio).toBe(0);
    expect(quality.issues).toContain('No public center URLs survived extraction');
  });
});

describe('CASMU center schedule parser and exact linkage', () => {
  it('preserves schedule text and links only exact normalized name and center', () => {
    const directoryHtml = `
      <table id="tablepress-59">
        <tbody>
          <tr>
            <td class="column-1">Acupuntura</td>
            <td class="column-2">Dra. Ada Ejemplo</td>
            <td class="column-3">
              <a href="https://casmu.example/centro-demo/">Centro Demo</a>
            </td>
            <td class="column-4">Calle Ejemplo 123</td>
          </tr>
          <tr>
            <td class="column-1">Cardiología</td>
            <td class="column-2">Dr. Sin Horario</td>
            <td class="column-3">
              <a href="https://casmu.example/centro-demo/">Centro Demo</a>
            </td>
            <td class="column-4">Calle Ejemplo 123</td>
          </tr>
        </tbody>
      </table>
    `;
    const centerHtml = `
      <dl class="sc-accordions">
        <dt class="sc-accordion-title">ACUPUNTURA</dt>
        <dd class="sc-accordion-pane">
          <table class="easy-table">
            <tbody>
              <tr><th>Técnico</th><th>Días y Horarios</th></tr>
              <tr>
                <td>Dra. Ada EJEMPLO<br>(procedimiento)</td>
                <td>Viernes: 8 a 10.30 h.<br>Pedir hora al teléfono 144</td>
              </tr>
            </tbody>
          </table>
        </dd>
      </dl>
    `;
    const directory = parseCasmuDirectory(directoryHtml, traceFor(directoryHtml));
    const schedules = parseCasmuCenterSchedules(centerHtml, {
      address: 'Calle Ejemplo 123',
      center: 'Centro Demo',
      finalUrl: 'https://casmu.example/centro-demo/',
      requestedUrl: 'https://casmu.example/centro-demo/',
      retrievedAt: RETRIEVED_AT,
      sourceHashSha256: sha256(centerHtml),
    });
    const enriched = enrichCasmuDirectoryWithSchedules(directory.records, schedules.records);

    expect(schedules.scheduleTables).toBe(1);
    expect(schedules.records).toHaveLength(1);
    expect(schedules.records[0]).toMatchObject({
      physicianName: 'Dra. Ada EJEMPLO',
      scheduleText: 'Viernes: 8 a 10.30 h.\nPedir hora al teléfono 144',
      specialty: 'ACUPUNTURA',
    });
    expect(enriched[0]?.scheduleType).toBe('published_on_center_page');
    expect(enriched[0]?.scheduleRecordIds).toEqual([schedules.records[0]?.recordId]);
    expect(enriched[1]?.scheduleType).toBe('not_published_on_source');
    expect(enriched[1]?.scheduleRecordIds).toEqual([]);
  });
});
