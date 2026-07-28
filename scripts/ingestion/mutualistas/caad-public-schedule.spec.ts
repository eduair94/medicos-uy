import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ASOCIACION_ESPANOLA_SOURCE,
  fetchTextWithRetry,
  MEDICA_URUGUAYA_SOURCE,
  parseCaadCliOptions,
  parseDoctorFilterOptions,
  parsePublishedScheduleRows,
  runCaadIngestion,
  SMI_SOURCE,
} from './caad-public-schedule';

const smiHtml = `
  <html>
    <body>
      <table>
        <tr>
          <th>Sede</th>
          <th>Médico/Técnico/Licenciado</th>
          <th>Especialidad</th>
          <th>Dirección</th>
          <th>Teléfono</th>
          <th>Lunes</th>
          <th>Martes</th>
          <th>Miércoles</th>
          <th>Jueves</th>
          <th>Viernes</th>
          <th>Sábado</th>
          <th>Obs.</th>
        </tr>
        <tr>
          <td>SEDE FICTICIA</td>
          <td>PROFESIONAL EJEMPLO UNO</td>
          <td>ESPECIALIDAD SINTÉTICA</td>
          <td>Calle Ejemplo 123</td>
          <td>00000000</td>
          <td></td>
          <td>12:00<br>13:00</td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td>Con pase</td>
        </tr>
      </table>
    </body>
  </html>
`;

const medicaUruguayaHtml = `
  <html>
    <body>
      <table>
        <tr>
          <th>Médico</th>
          <th>Especialidad</th>
          <th>Lunes</th>
          <th>Martes</th>
          <th>Miércoles</th>
          <th>Jueves</th>
          <th>Viernes</th>
          <th>Sábado</th>
          <th>Domingo</th>
          <th>Policlínica / Lugar</th>
          <th>Dependencia</th>
          <th>Frecuencia</th>
        </tr>
        <tr>
          <td>PROFESIONAL EJEMPLO TRES</td>
          <td>ESPECIALIDAD SINTÉTICA</td>
          <td></td>
          <td></td>
          <td>08:00-10:00</td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td>POLICLÍNICA FICTICIA</td>
          <td>dependencia-ejemplo</td>
          <td>tercer miércoles del mes</td>
        </tr>
      </table>
    </body>
  </html>
`;

const asociacionEspanolaHtml = `
  <html>
    <body>
      <table>
        <tr>
          <th>Médico</th>
          <th>Especialidad</th>
          <th>Lun.</th>
          <th>Mar.</th>
          <th>Mié.</th>
          <th>Jue.</th>
          <th>Vie.</th>
          <th>Sáb.</th>
          <th>Dom.</th>
          <th>Policlínica / Lugar</th>
        </tr>
        <tr>
          <td>PROFESIONAL EJEMPLO CUATRO</td>
          <td>ESPECIALIDAD SINTÉTICA</td>
          <td></td>
          <td></td>
          <td></td>
          <td>14:00-16:00</td>
          <td></td>
          <td></td>
          <td></td>
          <td>SEDE FICTICIA</td>
        </tr>
      </table>
    </body>
  </html>
`;

const noResultsHtml =
  '<html><body><p>No se encontraron resultados para los datos ingresados.</p></body></html>';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }),
  );
});

function parseContext() {
  return {
    observedAt: '2026-07-27T12:00:00.000Z',
    sourceProfessionalId: 'synthetic-professional-001',
    sourceProfessionalLabel: 'PROFESIONAL EJEMPLO UNO',
    rawSnapshotPath: 'raw/doctors/0001-synthetic-professional-001.html',
    rawSnapshotSha256: 'a'.repeat(64),
  };
}

describe('public CAAD schedule parsing', () => {
  it('extracts unique public doctor filter options and excludes the all option', () => {
    const html = `
      <select id="FiltroId2">
        <option value="0">- Todos -</option>
        <option value="synthetic-professional-001"> PROFESIONAL EJEMPLO UNO </option>
        <option value="synthetic-professional-001">Duplicate</option>
        <option value="synthetic-professional-002">PROFESIONAL EJEMPLO DOS</option>
      </select>
    `;

    expect(parseDoctorFilterOptions(html)).toEqual([
      {
        id: 'synthetic-professional-001',
        label: 'PROFESIONAL EJEMPLO UNO',
      },
      {
        id: 'synthetic-professional-002',
        label: 'PROFESIONAL EJEMPLO DOS',
      },
    ]);
  });

  it('maps an SMI row without turning it into live appointment availability', () => {
    const records = parsePublishedScheduleRows(SMI_SOURCE, smiHtml, parseContext());

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scheduleType: 'published_consultation_roster',
      appointmentAvailability: 'not_observed',
      sourceProfessionalId: 'synthetic-professional-001',
      professionalName: 'PROFESIONAL EJEMPLO UNO',
      specialty: 'ESPECIALIDAD SINTÉTICA',
      venue: {
        name: 'SEDE FICTICIA',
        address: 'Calle Ejemplo 123',
        phone: '00000000',
      },
      weeklySchedule: [
        {
          dayOfWeek: 'tuesday',
          sourceLabel: 'Martes',
          value: '12:00 | 13:00',
        },
      ],
      notes: 'Con pase',
    });
  });

  it('maps Médica Uruguaya venue, dependency, frequency and weekday position', () => {
    const records = parsePublishedScheduleRows(MEDICA_URUGUAYA_SOURCE, medicaUruguayaHtml, {
      ...parseContext(),
      sourceProfessionalId: 'synthetic-professional-003',
      sourceProfessionalLabel: 'PROFESIONAL EJEMPLO TRES',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      professionalName: 'PROFESIONAL EJEMPLO TRES',
      specialty: 'ESPECIALIDAD SINTÉTICA',
      venue: {
        name: 'POLICLÍNICA FICTICIA',
        dependency: 'dependencia-ejemplo',
      },
      weeklySchedule: [
        {
          dayOfWeek: 'wednesday',
          sourceLabel: 'Miércoles',
          value: '08:00-10:00',
        },
      ],
      frequency: 'tercer miércoles del mes',
    });
  });

  it('maps Asociación Española abbreviated weekday headers', () => {
    const records = parsePublishedScheduleRows(ASOCIACION_ESPANOLA_SOURCE, asociacionEspanolaHtml, {
      ...parseContext(),
      sourceProfessionalId: 'synthetic-professional-004',
      sourceProfessionalLabel: 'PROFESIONAL EJEMPLO CUATRO',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: {
        institution: 'Asociación Española',
      },
      professionalName: 'PROFESIONAL EJEMPLO CUATRO',
      specialty: 'ESPECIALIDAD SINTÉTICA',
      venue: {
        name: 'SEDE FICTICIA',
      },
      weeklySchedule: [
        {
          dayOfWeek: 'thursday',
          sourceLabel: 'Jue.',
          value: '14:00-16:00',
        },
      ],
    });
  });

  it('returns no rows only when the source explicitly reports no results', () => {
    expect(parsePublishedScheduleRows(SMI_SOURCE, noResultsHtml, parseContext())).toEqual([]);
    expect(() =>
      parsePublishedScheduleRows(
        SMI_SOURCE,
        '<html><body>Changed layout</body></html>',
        parseContext(),
      ),
    ).toThrow(/No recognizable medical schedule table/u);
  });
});

describe('public CAAD HTTP policy', () => {
  it('retries a transient response and applies backoff', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await fetchTextWithRetry(
      'https://example.test/schedule',
      {},
      {
        timeoutMs: 1_000,
        retries: 1,
        fetchImplementation,
        sleep,
      },
    );

    expect(result.text).toBe('ok');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});

describe('public CAAD ingestion', () => {
  it('writes raw snapshots, an aggregate NDJSON file and a manifest sequentially', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'medicos-caad-test-'));
    temporaryDirectories.push(temporaryRoot);
    const outputDirectory = join(temporaryRoot, 'run');
    const initialHtml = `
      <html><body>
        <select id="FiltroId2">
          <option value="0">- Todos -</option>
          <option value="synthetic-professional-001">PROFESIONAL EJEMPLO UNO</option>
          <option value="synthetic-professional-002">PROFESIONAL EJEMPLO DOS</option>
        </select>
      </body></html>
    `;
    const requestBodies: string[] = [];
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (init?.method !== 'POST') {
          return Promise.resolve(
            new Response(initialHtml, {
              status: 200,
              headers: {
                'content-type': 'text/html; charset=utf-8',
              },
            }),
          );
        }

        if (!(init.body instanceof URLSearchParams)) {
          throw new TypeError('Expected URLSearchParams request body.');
        }

        requestBodies.push(init.body.toString());
        return Promise.resolve(
          new Response(requestBodies.length === 1 ? smiHtml : noResultsHtml, {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          }),
        );
      },
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const manifest = await runCaadIngestion(SMI_SOURCE, {
      outputDirectory,
      delayMs: 250,
      retries: 0,
      timeoutMs: 1_000,
      fetchImplementation,
      sleep,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });

    expect(requestBodies).toEqual([
      'FiltroId1=0&FiltroId2=synthetic-professional-001&FiltroId3=0',
      'FiltroId1=0&FiltroId2=synthetic-professional-002&FiltroId3=0',
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(manifest.status).toBe('complete');
    expect(manifest.counts).toMatchObject({
      doctorsAdvertisedByFilter: 2,
      doctorsSelected: 2,
      doctorRequestsSucceeded: 2,
      doctorsWithNoPublishedRows: 1,
      recordsWritten: 1,
    });

    const ndjson = await readFile(join(outputDirectory, 'schedules.ndjson'), 'utf8');
    const storedManifest = JSON.parse(
      await readFile(join(outputDirectory, 'manifest.json'), 'utf8'),
    ) as { status: string };
    const rawSnapshot = await readFile(
      join(outputDirectory, 'raw', 'doctors', '0001-synthetic-professional-001.html'),
      'utf8',
    );

    expect(JSON.parse(ndjson.trim())).toMatchObject({
      professionalName: 'PROFESIONAL EJEMPLO UNO',
      scheduleType: 'published_consultation_roster',
    });
    expect(storedManifest.status).toBe('complete');
    expect(rawSnapshot).toContain('ESPECIALIDAD SINTÉTICA');
  });
});

describe('public CAAD CLI validation', () => {
  it('parses respectful rate and sample options', () => {
    expect(
      parseCaadCliOptions([
        '--delay-ms',
        '400',
        '--timeout-ms',
        '25000',
        '--retries',
        '2',
        '--limit',
        '5',
      ]),
    ).toEqual({
      help: false,
      runOptions: {
        delayMs: 400,
        timeoutMs: 25_000,
        retries: 2,
        limit: 5,
      },
    });
  });

  it('rejects a delay below the crawler floor', () => {
    expect(() => parseCaadCliOptions(['--delay-ms', '100'])).toThrow(/at least 250|equal to 250/u);
  });
});
