import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installCmuEthicsSnapshotAtomically, loadCmuEthicsSnapshot } from './cmu-ethics-snapshot';
import {
  CMU_ETHICS_ROBOTS_URL,
  CMU_ETHICS_SITEMAP_URL,
  CMU_ETHICS_SOURCE,
  CmuEthicsCollectionError,
  collectCmuEthicsMetadata,
  extractCmuDocumentMetadata,
  extractConservativeRespondentNames,
  fetchCmuResource,
  parseCmuEthicsCasePage,
  parseCmuEthicsSitemap,
  parseCmuRobotsPolicy,
  verifyCmuRobotsPolicy,
} from './collect-cmu-ethics-metadata';

import type { CmuEthicsCaseMetadata } from './cmu-ethics-snapshot';
import type { CmuEthicsSourceConfiguration, CmuFetch } from './collect-cmu-ethics-metadata';

const FIXED_NOW = new Date('2026-07-29T15:00:00.000Z');
const ROBOTS_FIXTURE = [
  'User-agent: *',
  'Disallow: /wp-admin/',
  'Disallow: /wp-content/uploads/',
  'Disallow: /fallos-emitidos-por-el-tribunal-de-etica/',
  'Disallow: /fallos/caso-bloqueado/',
  '',
].join('\n');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fetchInputUrl(input: Parameters<CmuFetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function source(
  overrides: Partial<CmuEthicsSourceConfiguration> = {},
): CmuEthicsSourceConfiguration {
  return {
    ...CMU_ETHICS_SOURCE,
    expectedRobotsSha256: hash(ROBOTS_FIXTURE),
    ...overrides,
  };
}

function response(
  body: string,
  contentType: string,
  options: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Response {
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': contentType,
      ...options.headers,
    },
  });
}

function sitemap(
  entries: readonly (
    | string
    | {
        readonly url: string;
        readonly lastModified?: string;
      }
  )[],
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((entry) => {
      const url = typeof entry === 'string' ? entry : entry.url;
      const lastModified = typeof entry === 'string' ? undefined : entry.lastModified;
      return `<url><loc>${url}</loc>${
        lastModified === undefined ? '' : `<lastmod>${lastModified}</lastmod>`
      }</url>`;
    }),
    '</urlset>',
  ].join('');
}

function casePage(
  title: string,
  documents: readonly { readonly label: string; readonly date: string }[] = [],
): string {
  return [
    '<!doctype html><html><body>',
    `<h1>${title}</h1>`,
    '<p class="case-narrative">Texto sustantivo que nunca debe persistirse.</p>',
    ...documents.map(
      ({ label, date }) =>
        `<div class="desc-bloque-text"><h3 class="title file-title">${label}</h3>` +
        `<span class="date">${date}</span>` +
        '<a href="https://www.colegiomedico.org.uy/wp-content/uploads/fixture.pdf">' +
        'Descargar</a></div>',
    ),
    '</body></html>',
  ].join('');
}

describe('CMU robots policy and URL boundary', () => {
  it('pins the reviewed bytes and fails closed before sitemap collection on any change', async () => {
    const fetchImpl = vi.fn<CmuFetch>(() =>
      Promise.resolve(response(`${ROBOTS_FIXTURE}changed`, 'text/plain')),
    );

    await expect(
      collectCmuEthicsMetadata({
        source: source(),
        fetchImpl,
        now: () => FIXED_NOW,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      code: 'ROBOTS_HASH_MISMATCH',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestedUrl = fetchImpl.mock.calls[0]?.[0];
    expect(requestedUrl === undefined ? undefined : fetchInputUrl(requestedUrl)).toBe(
      CMU_ETHICS_ROBOTS_URL,
    );
  });

  it('requires a wildcard policy that permits the dedicated sitemap', () => {
    const fixtureBytes = new TextEncoder().encode(ROBOTS_FIXTURE);
    const verified = verifyCmuRobotsPolicy(fixtureBytes, source());
    expect(verified.sha256).toBe(hash(ROBOTS_FIXTURE));
    expect(verified.policy.allows(new URL(CMU_ETHICS_SITEMAP_URL))).toBe(true);
    expect(
      verified.policy.allows(new URL('https://www.colegiomedico.org.uy/fallos/caso-bloqueado/')),
    ).toBe(false);

    const noWildcard = 'User-agent: named-bot\nDisallow:\n';
    expect(() =>
      verifyCmuRobotsPolicy(
        new TextEncoder().encode(noWildcard),
        source({ expectedRobotsSha256: hash(noWildcard) }),
      ),
    ).toThrow(CmuEthicsCollectionError);
  });

  it('never follows a redirect to uploads or another origin', async () => {
    const policy = parseCmuRobotsPolicy(ROBOTS_FIXTURE);
    const redirects = [
      'https://www.colegiomedico.org.uy/wp-content/uploads/forbidden.pdf',
      'https://evil.example.test/fallos/expediente-1-2020/',
    ];
    for (const location of redirects) {
      const fetchImpl = vi.fn<CmuFetch>(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location },
          }),
        ),
      );
      await expect(
        fetchCmuResource({
          source: source(),
          kind: 'CASE_PAGE',
          url: 'https://www.colegiomedico.org.uy/fallos/expediente-1-2020/',
          robotsPolicy: policy,
          fetchImpl,
          now: () => FIXED_NOW,
          beforeRequest: () => Promise.resolve(),
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_URL',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects source configurations that attempt a sub-second interval', async () => {
    const fetchImpl = vi.fn<CmuFetch>();
    await expect(
      collectCmuEthicsMetadata({
        source: source({ minimumRequestIntervalMs: 999 }),
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SOURCE_CONFIGURATION',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('bounded sequential CMU collection', () => {
  it('fetches only allowed same-origin metadata pages at least one second apart', async () => {
    const allowedOne =
      'https://www.colegiomedico.org.uy/fallos/expediente-142-2021-asse-c-dr-ejemplo/';
    const allowedTwo =
      'https://www.colegiomedico.org.uy/fallos/expediente-172-2024-dra-prueba-c-dr-modelo/';
    const fixtureSitemap = sitemap([
      { url: allowedOne, lastModified: '2022-11-29T10:30:00+00:00' },
      allowedTwo,
      'https://www.colegiomedico.org.uy/fallos/caso-bloqueado/',
      'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/',
      'https://www.colegiomedico.org.uy/wp-content/uploads/fallo.pdf',
      'https://evil.example.test/fallos/expediente-9-2020/',
    ]);
    let clock = 0;
    const requestStarts: number[] = [];
    const sleep = vi.fn((milliseconds: number) => {
      clock += milliseconds;
      return Promise.resolve();
    });
    const fetchImpl = vi.fn<CmuFetch>((input) => {
      requestStarts.push(clock);
      const url = fetchInputUrl(input);
      if (url === CMU_ETHICS_ROBOTS_URL) {
        return Promise.resolve(response(ROBOTS_FIXTURE, 'text/plain'));
      }
      if (url === CMU_ETHICS_SITEMAP_URL) {
        return Promise.resolve(response(fixtureSitemap, 'application/xml'));
      }
      if (url === allowedOne) {
        return Promise.resolve(
          response(
            casePage('142/2021 ASSE C/ DR. FABRICIO EJEMPLO', [
              { label: 'Fallo del Tribunal de Ética Médica', date: '28-11-2022' },
            ]),
            'text/html',
          ),
        );
      }
      if (url === allowedTwo) {
        return Promise.resolve(
          response(
            casePage('172/2024 DRA. HILDA PRUEBA C/ DR. CHRISTIAN MODELO', [
              { label: 'Fallo del Tribunal del Alzada', date: '20-08-2025' },
            ]),
            'text/html',
          ),
        );
      }
      throw new Error(`Unexpected network request: ${url}`);
    });

    const result = await collectCmuEthicsMetadata({
      source: source(),
      fetchImpl,
      now: () => FIXED_NOW,
      clockMilliseconds: () => clock,
      sleep,
    });

    expect(requestStarts).toEqual([0, 1_000, 2_000, 3_000]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual([
      CMU_ETHICS_ROBOTS_URL,
      CMU_ETHICS_SITEMAP_URL,
      allowedOne,
      allowedTwo,
    ]);
    expect(result.aggregates).toEqual({
      sitemapUrlsDiscovered: 6,
      disallowedUrlsSkipped: 3,
      invalidUrlsSkipped: 1,
      pagesFetched: 2,
      pagesFailed: 0,
      duplicateCasesCollapsed: 0,
      casesEmitted: 2,
    });
    expect(result.cases.map(({ respondentNames }) => respondentNames)).toEqual([
      ['FABRICIO EJEMPLO'],
      ['CHRISTIAN MODELO'],
    ]);
    expect(result.cases[0]?.sourceMetadata.sitemapLastModified).toBe('2022-11-29T10:30:00.000Z');
    expect(result.cases[1]?.sourceMetadata.sitemapLastModified).toBeNull();
  });

  it('enforces response bytes, redirect count and timeout', async () => {
    const policy = parseCmuRobotsPolicy(ROBOTS_FIXTURE);
    const common = {
      source: source({ maxCasePageBytes: 10, timeoutMs: 5, maxRedirects: 1 }),
      kind: 'CASE_PAGE' as const,
      url: 'https://www.colegiomedico.org.uy/fallos/expediente-1-2020/',
      robotsPolicy: policy,
      now: () => FIXED_NOW,
      beforeRequest: () => Promise.resolve(),
    };
    await expect(
      fetchCmuResource({
        ...common,
        fetchImpl: () =>
          Promise.resolve(
            response('too large', 'text/html', {
              headers: { 'content-length': '999' },
            }),
          ),
      }),
    ).rejects.toMatchObject({ code: 'BYTE_LIMIT' });

    await expect(
      fetchCmuResource({
        ...common,
        fetchImpl: () =>
          Promise.resolve(
            new Response(null, {
              status: 302,
              headers: {
                location: 'https://www.colegiomedico.org.uy/fallos/expediente-1-2020/',
              },
            }),
          ),
      }),
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });

    const timeoutFetch: CmuFetch = async (_input, init) =>
      await new Promise<Response>((_resolvePromise, rejectPromise) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            rejectPromise(new Error('aborted'));
          },
          { once: true },
        );
      });
    await expect(
      fetchCmuResource({
        ...common,
        fetchImpl: timeoutFetch,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('conservative case metadata parser', () => {
  it('extracts only a safe singular respondent to the right of C/', () => {
    expect(
      extractConservativeRespondentNames(
        '154/2023 DRA. ALICIA DEMANDANTE Y OTROS C/ DRA. MARIELA EJEMPLO',
      ),
    ).toEqual(['MARIELA EJEMPLO']);
    expect(
      extractConservativeRespondentNames(
        '115/2019 DR. NOMBRE IZQUIERDO C/ DRES. PERSONA UNO Y PERSONA DOS',
      ),
    ).toEqual([]);
    expect(extractConservativeRespondentNames('136/2021 D.D C/ F.F, G.G Y H.H')).toEqual([]);
    expect(extractConservativeRespondentNames('100/2018 DR. NOMBRE IZQUIERDO C/ DR. F.F')).toEqual(
      [],
    );
    expect(
      extractConservativeRespondentNames(
        '200/2025 DR. NOMBRE IZQUIERDO C/ DRA. PERSONA UNO Y DR. PERSONA DOS',
      ),
    ).toEqual([]);
  });

  it('retains h1 plus document label/date and never persists links or page content', () => {
    const html = casePage('154/2023 DRA. ALICIA DEMANDANTE C/ DRA. MARIELA EJEMPLO', [
      { label: 'Fallo del Tribunal de Ética Médica', date: '16-02-2024' },
      { label: 'Fallo del Tribunal del Alzada', date: '23-04-2024' },
    ]);
    const record = parseCmuEthicsCasePage(html, {
      canonicalUrl: 'https://www.colegiomedico.org.uy/fallos/expediente-154-2023/',
      observedAt: FIXED_NOW.toISOString(),
      robotsSha256: hash(ROBOTS_FIXTURE),
    });

    expect(record).toMatchObject({
      sourceCaseKey: '154/2023',
      respondentNames: ['MARIELA EJEMPLO'],
      sourceDate: '2024-04-23',
      sourceDatePrecision: 'DAY',
      visibility: 'ORIGINAL',
      outcome: 'UNKNOWN',
      finalityStatus: 'UNKNOWN',
    });
    expect(record.documents).toEqual([
      { label: 'Fallo del Tribunal de Ética Médica', date: '2024-02-16' },
      { label: 'Fallo del Tribunal del Alzada', date: '2024-04-23' },
    ]);
    expect(Object.keys(record.documents[0] ?? {}).sort()).toEqual(['date', 'label']);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('href');
    expect(serialized).not.toContain('/wp-content/uploads/');
    expect(serialized).not.toContain('Texto sustantivo');
    expect(serialized).not.toContain('SANCTIONED');
  });

  it('does not read generic headings or invalid dates as document metadata', () => {
    const html =
      '<h1>1/2020 ASSE C/ DR. PERSONA EJEMPLO</h1>' +
      '<div><h3>Últimas noticias</h3><span class="date">01-01-2020</span></div>' +
      '<div class="desc-bloque-text"><h3 class="file-title">Resolución visible</h3>' +
      '<span class="date">31-02-2020</span><a href="/secret">Descargar</a></div>';
    expect(extractCmuDocumentMetadata(html)).toEqual([{ label: 'Resolución visible', date: null }]);
  });

  it('filters forbidden and off-origin sitemap entries before collection', () => {
    const parsed = parseCmuEthicsSitemap(
      sitemap([
        'https://www.colegiomedico.org.uy/fallos/expediente-1-2020/',
        'https://www.colegiomedico.org.uy/fallos/caso-bloqueado/',
        'https://www.colegiomedico.org.uy/wp-content/uploads/fallo.pdf',
        'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/',
        'http://www.colegiomedico.org.uy/fallos/expediente-2-2020/',
      ]),
      parseCmuRobotsPolicy(ROBOTS_FIXTURE),
    );
    expect(parsed).toEqual({
      allowedCaseEntries: [
        {
          canonicalUrl: 'https://www.colegiomedico.org.uy/fallos/expediente-1-2020/',
          sitemapLastModified: null,
        },
      ],
      allowedCaseUrls: ['https://www.colegiomedico.org.uy/fallos/expediente-1-2020/'],
      urlsDiscovered: 5,
      disallowedUrlsSkipped: 3,
      invalidUrlsSkipped: 1,
    });
  });
});

describe('atomic CMU ethics snapshot contract', () => {
  function fixtureCase(): CmuEthicsCaseMetadata {
    return parseCmuEthicsCasePage(
      casePage('142/2021 ASSE C/ DR. FABRICIO EJEMPLO', [
        { label: 'Fallo del Tribunal de Ética Médica', date: '28-11-2022' },
      ]),
      {
        canonicalUrl:
          'https://www.colegiomedico.org.uy/fallos/expediente-142-2021-asse-c-dr-ejemplo/',
        observedAt: FIXED_NOW.toISOString(),
        robotsSha256: hash(ROBOTS_FIXTURE),
      },
    );
  }

  it('installs NDJSON and manifest together and loads their verified hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medicos-cmu-ethics-'));
    temporaryDirectories.push(root);
    const outputDirectory = join(root, 'snapshot');
    const installed = await installCmuEthicsSnapshotAtomically({
      outputDirectory,
      cases: [fixtureCase()],
      collectorVersion: 'synthetic-test-v1',
      generatedAt: FIXED_NOW.toISOString(),
      policyReviewedAt: '2026-07-29',
      robotsSha256: hash(ROBOTS_FIXTURE),
      aggregates: {
        sitemapUrlsDiscovered: 1,
        disallowedUrlsSkipped: 0,
        invalidUrlsSkipped: 0,
        pagesFetched: 1,
        pagesFailed: 0,
        duplicateCasesCollapsed: 0,
        casesEmitted: 1,
      },
    });

    const loaded = await loadCmuEthicsSnapshot(outputDirectory);
    expect(loaded.records).toBe(1);
    expect(loaded.cases).toEqual([fixtureCase()]);
    expect(loaded.semanticSha256).toBe(installed.semanticSha256);
    expect(loaded.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.policyReviewedAt).toBe('2026-07-29');
    const persisted = await readFile(installed.casesPath, 'utf8');
    expect(persisted).not.toContain('href');
    expect(persisted).not.toContain('Texto sustantivo');
    expect(persisted).not.toContain('/wp-content/uploads/');
  });

  it('rejects a modified NDJSON instead of loading an unverifiable snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medicos-cmu-ethics-tamper-'));
    temporaryDirectories.push(root);
    const outputDirectory = join(root, 'snapshot');
    const installed = await installCmuEthicsSnapshotAtomically({
      outputDirectory,
      cases: [fixtureCase()],
      collectorVersion: 'synthetic-test-v1',
      generatedAt: FIXED_NOW.toISOString(),
      policyReviewedAt: '2026-07-29',
      robotsSha256: hash(ROBOTS_FIXTURE),
      aggregates: {
        sitemapUrlsDiscovered: 1,
        disallowedUrlsSkipped: 0,
        invalidUrlsSkipped: 0,
        pagesFetched: 1,
        pagesFailed: 0,
        duplicateCasesCollapsed: 0,
        casesEmitted: 1,
      },
    });
    await writeFile(installed.casesPath, '', 'utf8');

    await expect(loadCmuEthicsSnapshot(outputDirectory)).rejects.toThrow(
      'failed integrity verification',
    );
  });
});
