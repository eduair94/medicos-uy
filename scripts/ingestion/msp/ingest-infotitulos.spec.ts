import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXPECTED_IDENTITY_CONFLICTS,
  INFOTITULOS_HEADERS,
  assertValidHmacKey,
  downloadHttps,
  parseExplicitBoolean,
  parseInfotitulosCsv,
  persistSnapshot,
  transformInfotitulos,
  validateInfotitulosHeaders,
  type HttpsRequester,
  type InfotitulosRow,
} from './ingest-infotitulos';

const HMAC_KEY = 'unit-test-key-with-at-least-32-bytes-long';
const createdDirectories: string[] = [];

function row(
  documentNumber: string,
  fullName: string,
  title = 'DOCTOR EN MEDICINA',
  status = 'Habilitado',
  overrides: Partial<InfotitulosRow> = {},
): InfotitulosRow {
  return {
    professionalFundNumber: '000123',
    documentNumber,
    fullName,
    recruiterCode: '310000',
    title,
    status,
    temporaryRegistration: '',
    ...overrides,
  };
}

function threeIdentityConflicts(): InfotitulosRow[] {
  return [
    row('20000001', 'IDENTIDAD UNO'),
    row('20000001', 'IDENTIDAD DOS', 'PEDIATRIA'),
    row('20000002', 'IDENTIDAD TRES'),
    row('20000002', 'IDENTIDAD CUATRO', 'CARDIOLOGIA'),
    row('20000003', 'IDENTIDAD CINCO'),
    row('20000003', 'IDENTIDAD SEIS', 'CIRUGIA'),
  ];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Infotítulos validation and transformation', () => {
  it('requires the seven exact headers in their official order', () => {
    expect(() => validateInfotitulosHeaders(INFOTITULOS_HEADERS)).not.toThrow();
    expect(() => validateInfotitulosHeaders([...INFOTITULOS_HEADERS].reverse())).toThrow(
      /Unexpected Infotítulos headers/,
    );
    expect(() => validateInfotitulosHeaders(INFOTITULOS_HEADERS.slice(0, -1))).toThrow(
      /Unexpected Infotítulos headers/,
    );
  });

  it('parses the official cp1252 schema and rejects a shifted data row', () => {
    const valid =
      `${INFOTITULOS_HEADERS.join(';')}\r\n` +
      ';12345678;MARÍA PÉREZ;310000;DOCTOR EN MEDICINA;Habilitado;\r\n';
    const encoded = Buffer.from(valid, 'latin1');

    expect(parseInfotitulosCsv(encoded)).toEqual([
      {
        professionalFundNumber: '',
        documentNumber: '12345678',
        fullName: 'MARÍA PÉREZ',
        recruiterCode: '310000',
        title: 'DOCTOR EN MEDICINA',
        status: 'Habilitado',
        temporaryRegistration: '',
      },
    ]);

    const invalid = Buffer.from(
      `${INFOTITULOS_HEADERS.join(';')}\r\n;123;NAME;310000;TITLE;Habilitado\r\n`,
      'latin1',
    );
    expect(() => parseInfotitulosCsv(invalid)).toThrow(/data row 2/);
  });

  it('publishes enabled doctors, preserves exact title labels and quarantines 3 conflicts', () => {
    const rows = [
      row('10000001', 'ANA MÉDICA'),
      row('10000001', 'ANA MÉDICA', 'ESPECIALISTA EN PEDIATRÍA'),
      row('10000001', 'ANA MÉDICA', 'PEDIATRIA', 'Inhabilitado'),
      row('10000001', 'ANA MÉDICA', 'ANESTESIOLOGIA', 'Habilitado', {
        recruiterCode: '1120000',
        temporaryRegistration: 'Registro Temporario con Contrato',
      }),
      row('10000002', 'NO ES MÉDICO', 'LICENCIADO EN PSICOLOGIA'),
      ...threeIdentityConflicts(),
    ];

    const result = transformInfotitulos(rows, { hmacKey: HMAC_KEY });

    expect(result.professionals).toHaveLength(1);
    expect(result.quarantine).toHaveLength(EXPECTED_IDENTITY_CONFLICTS);
    expect(result.professionals[0]).toMatchObject({
      fullName: 'ANA MÉDICA',
      enabledTitles: [
        {
          title: 'ANESTESIOLOGIA',
          recruiterCode: '1120000',
          temporaryRegistration: 'Registro Temporario con Contrato',
        },
        {
          title: 'DOCTOR EN MEDICINA',
          recruiterCode: '310000',
          temporaryRegistration: null,
        },
        {
          title: 'ESPECIALISTA EN PEDIATRÍA',
          recruiterCode: '310000',
          temporaryRegistration: null,
        },
      ],
    });
    expect(JSON.stringify(result.professionals)).not.toMatch(
      /documentNumber|professionalFundNumber|Número de documento|Caja Prof|PEDIATRIA"/,
    );
    expect(result.aggregates).toMatchObject({
      enabledDoctorDocuments: 4,
      publishedProfessionals: 1,
      quarantinedIdentityConflicts: 3,
    });
  });

  it('creates stable, key-scoped HMAC identifiers without exposing the document', () => {
    const rows = [row('12345678', 'ANA MÉDICA'), ...threeIdentityConflicts()];
    const first = transformInfotitulos(rows, { hmacKey: HMAC_KEY });
    const repeated = transformInfotitulos(rows, { hmacKey: HMAC_KEY });
    const rotated = transformInfotitulos(rows, {
      hmacKey: `${HMAC_KEY}-rotated`,
    });
    const firstId = first.professionals[0]?.linkageId;

    expect(firstId).toBe(repeated.professionals[0]?.linkageId);
    expect(firstId).not.toBe(rotated.professionals[0]?.linkageId);
    expect(firstId).not.toContain('12345678');
    expect(firstId).toMatch(/^msp_doc_v1_[a-f0-9]{64}$/);
  });

  it('fails the snapshot quality gate when the conflict count drifts', () => {
    expect(() =>
      transformInfotitulos([row('12345678', 'ANA MÉDICA')], {
        hmacKey: HMAC_KEY,
      }),
    ).toThrow(/expected 3, found 0/);
  });

  it('requires a sufficiently strong linkage key and an explicit TLS flag', () => {
    expect(() => assertValidHmacKey(undefined)).toThrow(/MSP_LINKAGE_HMAC_KEY is required/);
    expect(() => assertValidHmacKey('short')).toThrow(/at least 32 bytes/);
    expect(() => assertValidHmacKey(HMAC_KEY)).not.toThrow();
    expect(parseExplicitBoolean(undefined, 'FLAG')).toBe(false);
    expect(parseExplicitBoolean('false', 'FLAG')).toBe(false);
    expect(parseExplicitBoolean('true', 'FLAG')).toBe(true);
    expect(() => parseExplicitBoolean('1', 'FLAG')).toThrow(/exactly "true" or "false"/);
  });
});

describe('HTTPS download controls', () => {
  it('follows HTTPS redirects and retries retryable statuses', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const requester: HttpsRequester = (url, options) => {
      calls += 1;
      expect(options.rejectUnauthorized).toBe(true);

      if (url.pathname === '/start') {
        return Promise.resolve({
          statusCode: 302,
          headers: { location: '/file.csv' },
          body: Buffer.alloc(0),
        });
      }

      if (calls === 2) {
        return Promise.resolve({
          statusCode: 503,
          headers: { retryAfter: '0' },
          body: Buffer.from('retry'),
        });
      }

      return Promise.resolve({
        statusCode: 200,
        headers: { contentType: 'text/csv', etag: '"fixture"' },
        body: Buffer.from('ok'),
      });
    };

    const downloaded = await downloadHttps('https://example.test/start', {
      requester,
      retries: 1,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(downloaded.body.toString()).toBe('ok');
    expect(downloaded.finalUrl).toBe('https://example.test/file.csv');
    expect(downloaded.attempts).toBe(2);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([0]);
  });

  it('rejects plaintext URLs and redirect downgrades', async () => {
    await expect(downloadHttps('http://example.test/file.csv')).rejects.toThrow(/Only HTTPS URLs/);

    const requester: HttpsRequester = () =>
      Promise.resolve({
        statusCode: 302,
        headers: { location: 'http://example.test/file.csv' },
        body: Buffer.alloc(0),
      });
    await expect(
      downloadHttps('https://example.test/start', { requester, retries: 0 }),
    ).rejects.toThrow(/Only HTTPS URLs/);
  });

  it('enables insecure TLS only when the caller explicitly opts in', async () => {
    const requester: HttpsRequester = (_url, options) => {
      expect(options.rejectUnauthorized).toBe(false);
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: Buffer.from('ok'),
      });
    };

    await downloadHttps('https://example.test/file.csv', {
      allowInsecureTls: true,
      requester,
      retries: 0,
    });
  });
});

describe('snapshot persistence', () => {
  it('preserves raw bytes and emits PII-safe NDJSON plus an aggregate manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'medicos-msp-ingestion-'));
    createdDirectories.push(directory);
    const raw = Buffer.from('raw-cp1252-bytes-\xed');
    const transformed = transformInfotitulos(
      [row('12345678', 'ANA MÉDICA'), ...threeIdentityConflicts()],
      { hmacKey: HMAC_KEY },
    );

    const persisted = await persistSnapshot({
      dataDirectory: directory,
      sourceUrl: 'https://example.test/infotitulos.csv',
      download: {
        body: raw,
        attempts: 1,
        finalUrl: 'https://example.test/Infotitulos.csv',
        headers: {
          contentType: 'text/csv',
          etag: '"fixture"',
          lastModified: 'Mon, 06 Jul 2026 15:10:55 GMT',
        },
      },
      transformed,
    });

    expect(await readFile(persisted.rawPath)).toEqual(raw);

    const professionals = await readFile(persisted.professionalsPath, 'utf8');
    const quarantine = await readFile(persisted.quarantinePath, 'utf8');
    const manifest = JSON.parse(await readFile(persisted.manifestPath, 'utf8')) as {
      aggregates: { publishedProfessionals: number };
      linkage: { rawIdentifiersPublished: boolean };
      outputs: { professionals: { records: number } };
      quality: { actualIdentityConflicts: number };
    };

    expect(professionals).not.toContain('12345678');
    expect(professionals).not.toContain('000123');
    expect(quarantine).not.toContain('20000001');
    expect(manifest).toMatchObject({
      aggregates: { publishedProfessionals: 1 },
      linkage: { rawIdentifiersPublished: false },
      outputs: { professionals: { records: 1 } },
      quality: { actualIdentityConflicts: 3 },
    });

    await expect(
      persistSnapshot({
        dataDirectory: directory,
        sourceUrl: 'https://example.test/infotitulos.csv',
        download: {
          body: raw,
          attempts: 1,
          finalUrl: 'https://example.test/Infotitulos.csv',
          headers: {
            contentType: 'text/csv',
            etag: '"changed-with-identical-body"',
            lastModified: 'Tue, 07 Jul 2026 15:10:55 GMT',
          },
        },
        transformed,
      }),
    ).resolves.toEqual(persisted);
  });
});
