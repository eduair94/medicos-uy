import { describe, expect, it } from 'vitest';

import { sha256 } from './casmu-hb-artifacts';
import {
  HOSPITAL_BRITANICO_EXTRACTOR_VERSION,
  parseHospitalBritanicoIntervals,
  parseHospitalBritanicoResponse,
  type HospitalBritanicoTrace,
} from './hospital-britanico-parser';

const SOURCE_URL = 'https://hospital.example/ajax/horarios-medicos.php?especialidad=0';
const SOURCE_PAGE_URL = 'https://hospital.example/horarios-de-consulta.php';

function traceFor(rawResponse: string): HospitalBritanicoTrace {
  return {
    extractorVersion: HOSPITAL_BRITANICO_EXTRACTOR_VERSION,
    retrievedAt: '2026-07-27T12:00:00.000Z',
    sourceHashSha256: sha256(rawResponse),
    sourcePageUrl: SOURCE_PAGE_URL,
    sourceUrl: SOURCE_URL,
  };
}

describe('Hospital Británico public schedule parser', () => {
  it('extracts physician, specialty, clinic, day and every explicit interval', () => {
    const resultHtml = `
      <div class="accordion-item horarios-v2-grid-especialidad">
        <button class="horarios-v2-grid-especialidad-header">
          <span class="fw-semibold">CARDIOLOGÍA</span>
        </button>
        <div class="horarios-medico">
          <div class="horarios-grid">
            <div class="d-none d-lg-block">
              <span class="fw-medium text-primary">EJEMPLO, ANA</span>
            </div>
            <div class="horarios-clinica-mobile">
              <span class="d-block d-lg-none">Clínica</span>
              CENTRAL
            </div>
            <div class="horarios-mobile d-lg-none">
              <div class="d-lg-none">
                <span class="fw-medium">Lunes:</span>
                08:20 a 12:40
              </div>
              <div class="d-lg-none">
                <span class="fw-medium">Miércoles:</span>
                13:00 a 14:40 (2°,4°) y 15:00 a 16:00 (1°,3°,5°)
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    const rawResponse = JSON.stringify({ resultados_html: resultHtml });
    const result = parseHospitalBritanicoResponse(rawResponse, traceFor(rawResponse));

    expect(result.candidatePhysicianRows).toBe(1);
    expect(result.candidateScheduleEntries).toBe(2);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      clinic: 'CENTRAL',
      day: 'Lunes',
      intervals: [{ endTime: '12:40', startTime: '08:20' }],
      physicianName: 'EJEMPLO, ANA',
      scheduleText: 'Lunes: 08:20 a 12:40',
      specialty: 'CARDIOLOGÍA',
    });
    expect(result.records[1]?.intervals).toEqual([
      { endTime: '14:40', startTime: '13:00' },
      { endTime: '16:00', startTime: '15:00' },
    ]);
  });

  it('detects adjacent time ranges without inventing recurrence rules', () => {
    expect(parseHospitalBritanicoIntervals('Martes: 08:20 a 12:4013:20 a 15:20')).toEqual([
      { endTime: '12:40', startTime: '08:20' },
      { endTime: '15:20', startTime: '13:20' },
    ]);
  });

  it('fails explicitly when resultados_html is absent', () => {
    const rawResponse = JSON.stringify({ result: '<div />' });

    expect(() => parseHospitalBritanicoResponse(rawResponse, traceFor(rawResponse))).toThrowError(
      'Hospital Británico response does not contain resultados_html',
    );
  });
});
