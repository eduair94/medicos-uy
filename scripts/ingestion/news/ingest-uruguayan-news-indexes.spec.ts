import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseNormalizedNewsArticle } from './build-news-candidates';
import {
  classifyHeadline,
  collectUruguayanNewsIndexes,
  createProfessionalNameIndex,
  extractHeadlinePersonNames,
  fetchXmlIndex,
  parseNewsIndexDocument,
  resolveAuthorizedNewsIndexSources,
  runUruguayanNewsIndexIngestion,
  URUGUAYAN_NEWS_INDEX_SOURCES,
  type AuthorizedNewsIndexSource,
  type NewsFetch,
  type NewsIndexSource,
} from './ingest-uruguayan-news-indexes';

const FIXED_NOW = new Date('2026-07-27T15:00:00.000Z');
const temporaryDirectories: string[] = [];
const noSleep = (_milliseconds: number): Promise<void> => Promise.resolve();

function rawSource(overrides: Partial<NewsIndexSource> = {}): NewsIndexSource {
  return {
    id: 'test_feed',
    publisherKey: 'testpublisher',
    publisher: 'Medio de prueba',
    format: 'RSS',
    indexUrl: 'https://news.example.test/feed.xml',
    discoveryUrl: 'https://news.example.test/rss',
    robotsUrl: 'https://news.example.test/robots.txt',
    allowedIndexHosts: ['news.example.test'],
    allowedArticleHosts: ['news.example.test'],
    minimumRequestIntervalMs: 250,
    timeoutMs: 500,
    maxResponseBytes: 32_768,
    rightsBasis: 'TEST_FIXTURE',
    termsUrl: 'https://news.example.test/terms',
    rightsReviewedOn: '2026-07-01',
    rightsReviewExpiresOn: '2026-12-31',
    ...overrides,
  };
}

function source(overrides: Partial<NewsIndexSource> = {}): AuthorizedNewsIndexSource {
  const resolved = resolveAuthorizedNewsIndexSources(
    [rawSource(overrides)],
    { NODE_ENV: 'test' },
    FIXED_NOW.toISOString(),
  ).sources[0];
  if (resolved === undefined) {
    throw new Error('Fixture source was unexpectedly disabled');
  }
  return resolved;
}

function rss(
  items: readonly {
    readonly title: string;
    readonly link: string;
    readonly publishedAt: string;
    readonly description?: string;
  }[],
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Medio de prueba</title>
        ${items
          .map(
            (item) => `
              <item>
                <title><![CDATA[${item.title}]]></title>
                <link>${item.link}</link>
                <pubDate>${item.publishedAt}</pubDate>
                <description><![CDATA[${item.description ?? ''}]]></description>
              </item>
            `,
          )
          .join('')}
      </channel>
    </rss>`;
}

function xmlResponse(xml: string, headers: Record<string, string> = {}): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      ...headers,
    },
  });
}

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

describe('Uruguayan public news index parsing', () => {
  it('parses Google News sitemap metadata locally', () => {
    const sitemapSource = source({
      id: 'test_sitemap',
      format: 'GOOGLE_NEWS_SITEMAP',
      indexUrl: 'https://news.example.test/news-sitemap-content.xml',
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset
        xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
      >
        <url>
          <loc>https://news.example.test/noticias/medica-reconocida</loc>
          <news:news>
            <news:publication_date>2026-07-27T10:00:00-03:00</news:publication_date>
            <news:title>La Dra. Lucía Prueba recibió un reconocimiento</news:title>
          </news:news>
        </url>
      </urlset>`;

    expect(parseNewsIndexDocument(sitemapSource, xml)).toEqual({
      items: [
        {
          headline: 'La Dra. Lucía Prueba recibió un reconocimiento',
          canonicalUrl: 'https://news.example.test/noticias/medica-reconocida',
          publishedAt: '2026-07-27T13:00:00.000Z',
        },
      ],
      invalidItems: 0,
    });
  });

  it('parses only RSS headline/link/date and ignores descriptions', () => {
    const parsed = parseNewsIndexDocument(
      source(),
      rss([
        {
          title: 'La Dra. Lucía Prueba asumió un cargo académico',
          link: 'https://news.example.test/noticias/cargo',
          publishedAt: 'Mon, 27 Jul 2026 13:00:00 GMT',
          description: 'Texto sensible que no debe formar parte del artefacto.',
        },
      ]),
    );

    expect(parsed.items).toEqual([
      {
        headline: 'La Dra. Lucía Prueba asumió un cargo académico',
        canonicalUrl: 'https://news.example.test/noticias/cargo',
        publishedAt: '2026-07-27T13:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('Texto sensible');
  });
});

describe('headline policy and deterministic name extraction', () => {
  it('restricts adverse, minor and private-health headlines', () => {
    expect(
      classifyHeadline(
        'Imputaron a un médico por la muerte de un bebé luego de atender a un paciente',
      ),
    ).toEqual({
      restricted: true,
      reasons: ['ADVERSE_OR_JUDICIAL', 'MINOR', 'PRIVATE_HEALTH'],
    });
    expect(
      classifyHeadline('Caso médico: el tribunal archivó el juicio y anuló la sanción'),
    ).toEqual({
      restricted: true,
      reasons: ['ADVERSE_OR_JUDICIAL'],
    });
    expect(classifyHeadline('La doctora Lucía Prueba operó a Paciente Ejemplo por cáncer')).toEqual(
      {
        restricted: true,
        reasons: ['PRIVATE_HEALTH'],
      },
    );
    expect(classifyHeadline('El cirujano Roberto Prueba dejó una gasa durante la cirugía')).toEqual(
      {
        restricted: true,
        reasons: ['PRIVATE_HEALTH'],
      },
    );
    expect(
      classifyHeadline('La doctora Lucía Prueba confirmó que Paciente Ejemplo tiene VIH'),
    ).toEqual({
      restricted: true,
      reasons: ['PRIVATE_HEALTH'],
    });
    expect(
      classifyHeadline('La doctora Lucía Prueba atendió el embarazo de Paciente Ejemplo'),
    ).toEqual({
      restricted: true,
      reasons: ['PRIVATE_HEALTH'],
    });
    expect(classifyHeadline('Jugador Ejemplo fue presentado por Club Ficticio')).toEqual({
      restricted: true,
      reasons: ['NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT'],
    });
    expect(
      classifyHeadline('La Dra. Lucía Prueba recibió un reconocimiento académico', [
        'Lucía Prueba',
      ]),
    ).toEqual({
      restricted: false,
      reasons: [],
    });
    expect(
      classifyHeadline('La anestesióloga Lucía Prueba recibió un reconocimiento académico', [
        'Lucía Prueba',
      ]),
    ).toEqual({
      restricted: false,
      reasons: [],
    });
  });

  it('rejects mixed benign-looking headlines unless the entire title matches a closed template', () => {
    for (const privateDetail of [
      'HIV',
      'depresión',
      'hepatitis',
      'diabetes',
      'cesárea',
      'adicción',
    ]) {
      expect(
        classifyHeadline(
          `La doctora Lucía Prueba recibió un premio luego de contar que Paciente Ejemplo vive con ${privateDetail}`,
          ['Lucía Prueba'],
        ),
      ).toMatchObject({
        restricted: true,
      });
    }
  });

  it('finds exact, unique-subset and honorific-anchored names without IDs', () => {
    const index = createProfessionalNameIndex(['LUCIA PRUEBA', 'FEDERICO JOSE FICTICIO']);

    expect(
      extractHeadlinePersonNames(
        'Lucía Prueba y Federico Ficticio presentaron el proyecto de la Dra. Ana Ejemplo',
        index,
      ),
    ).toEqual(['Lucía Prueba', 'Federico Ficticio']);
  });

  it('extracts a dotted initial plus a full token when registry fan-out is bounded', () => {
    const index = createProfessionalNameIndex(['NICOLAS ANDRES NUBE', 'FEDERICO JOSE FICTICIO']);

    expect(
      extractHeadlinePersonNames(
        'N. Nube y la Dra. F. Ficticio presentaron una investigación académica',
        index,
      ),
    ).toEqual(['N. Nube', 'F. Ficticio']);
  });

  it('does not extract an initials mention that exceeds the ambiguity cap', () => {
    const index = createProfessionalNameIndex(
      Array.from({ length: 26 }, (_, position) => `NICOLAS${String(position)} NUBE`),
    );

    expect(extractHeadlinePersonNames('N. Nube presentó una actividad académica', index)).toEqual(
      [],
    );
  });
});

describe('bounded HTTPS fetching', () => {
  it('uses manual redirects without conditional requests and records provenance', async () => {
    const fetchImpl = vi.fn<NewsFetch>((_input, init) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBeNull();
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(
        xmlResponse('<rss><channel></channel></rss>', {
          'last-modified': 'Mon, 27 Jul 2026 14:00:00 GMT',
        }),
      );
    });

    await expect(
      fetchXmlIndex(source(), {
        fetchImpl,
        now: () => FIXED_NOW,
      }),
    ).resolves.toMatchObject({
      status: 'FETCHED',
      finalUrl: 'https://news.example.test/feed.xml',
      retrievedAt: FIXED_NOW.toISOString(),
      lastModified: 'Mon, 27 Jul 2026 14:00:00 GMT',
    });
  });

  it('rejects a redirect outside the per-source HTTPS allowlist', async () => {
    const fetchImpl = vi.fn<NewsFetch>(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://evil.example.test/feed.xml',
          },
        }),
      ),
    );

    await expect(
      fetchXmlIndex(source(), {
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: 'UNTRUSTED_URL',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces byte and timeout limits', async () => {
    const oversizedFetch = vi.fn<NewsFetch>(() =>
      Promise.resolve(
        xmlResponse('<rss><channel /></rss>', {
          'content-length': '999',
        }),
      ),
    );
    await expect(
      fetchXmlIndex(source({ maxResponseBytes: 10 }), {
        fetchImpl: oversizedFetch,
      }),
    ).rejects.toMatchObject({
      code: 'BYTE_LIMIT',
    });

    const timeoutFetch: NewsFetch = async (_input, init) =>
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
      fetchXmlIndex(source({ timeoutMs: 5 }), {
        fetchImpl: timeoutFetch,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

describe('source rights gates', () => {
  it('deep-freezes the production catalog before identity-based authorization', () => {
    const catalogSource = URUGUAYAN_NEWS_INDEX_SOURCES[0];
    expect(Object.isFrozen(URUGUAYAN_NEWS_INDEX_SOURCES)).toBe(true);
    if (catalogSource === undefined) {
      throw new Error('Production source catalog is unexpectedly empty');
    }
    expect(Object.isFrozen(catalogSource)).toBe(true);
    expect(Object.isFrozen(catalogSource.allowedIndexHosts)).toBe(true);
    expect(Object.isFrozen(catalogSource.allowedArticleHosts)).toBe(true);
    expect(
      Reflect.set(
        catalogSource as unknown as Record<string, unknown>,
        'indexUrl',
        'https://evil.example/feed.xml',
      ),
    ).toBe(false);
    expect(catalogSource.indexUrl).not.toBe('https://evil.example/feed.xml');
  });

  it('rejects an unresolved source before making any network request', async () => {
    const fetchImpl = vi.fn<NewsFetch>();

    await expect(
      fetchXmlIndex(rawSource() as AuthorizedNewsIndexSource, {
        fetchImpl,
      }),
    ).rejects.toThrow('has not passed the rights authorization resolver');
    await expect(
      fetchXmlIndex(
        { ...source() },
        {
          fetchImpl,
        },
      ),
    ).rejects.toThrow('has not passed the rights authorization resolver');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits written-authorization sources by default and hashes evidence when enabled', () => {
    const gated = URUGUAYAN_NEWS_INDEX_SOURCES.find(({ id }) => id === 'elpais_content');
    const fallback = URUGUAYAN_NEWS_INDEX_SOURCES.find(({ id }) => id === 'elobservador_home');
    expect(gated).toBeDefined();
    expect(fallback).toBeDefined();
    const resolved = resolveAuthorizedNewsIndexSources(
      [gated!, fallback!],
      {},
      FIXED_NOW.toISOString(),
    );
    expect(resolved.sources.map(({ id }) => id)).toEqual(['elobservador_home']);
    expect(resolved.authorizationGatedSourcesOmitted).toEqual(['elpais_content']);
  });

  it('requires a current written-authorization reference for an enabled source', () => {
    const gated = URUGUAYAN_NEWS_INDEX_SOURCES.find(({ id }) => id === 'elpais_content');
    expect(gated).toBeDefined();

    expect(() =>
      resolveAuthorizedNewsIndexSources(
        [gated!],
        {
          NEWS_ENABLE_ELPAIS: 'true',
        },
        FIXED_NOW.toISOString(),
      ),
    ).toThrow('NEWS_ELPAIS_AUTHORIZATION_REFERENCE');
    expect(() =>
      resolveAuthorizedNewsIndexSources(
        [gated!],
        {
          NEWS_ENABLE_ELPAIS: 'true',
          NEWS_ELPAIS_AUTHORIZATION_REFERENCE: 'placeholder',
          NEWS_ELPAIS_AUTHORIZATION_SHA256_ALLOWLIST: '0'.repeat(64),
        },
        FIXED_NOW.toISOString(),
      ),
    ).toThrow('NEWS_ELPAIS_AUTHORIZATION_SHA256_ALLOWLIST');
    const resolved = resolveAuthorizedNewsIndexSources(
      [gated!],
      {
        NEWS_ENABLE_ELPAIS: 'true',
        NEWS_ELPAIS_AUTHORIZATION_REFERENCE: 'legal-approval-2026-07',
        NEWS_ELPAIS_AUTHORIZATION_SHA256_ALLOWLIST: createHash('sha256')
          .update('legal-approval-2026-07')
          .digest('hex'),
      },
      FIXED_NOW.toISOString(),
    );
    expect(resolved.sources[0]?.authorizationEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(resolved)).not.toContain('legal-approval-2026-07');
  });
});

describe('privacy-preserving collection', () => {
  it('filters sensitive headlines before names and deduplicates benign URLs', async () => {
    const feed = rss([
      {
        title: 'Denuncian al Dr. Nicolás Nube por la muerte de un bebé paciente',
        link: 'https://news.example.test/noticias/restringida',
        publishedAt: 'Mon, 27 Jul 2026 10:00:00 GMT',
      },
      {
        title: 'La Dra. Lucía Prueba asumió un cargo académico',
        link: 'https://news.example.test/noticias/lucia',
        publishedAt: 'Mon, 27 Jul 2026 11:00:00 GMT',
      },
      {
        title: 'El Dr. Federico Ficticio presentó un proyecto universitario',
        link: 'https://news.example.test/noticias/martin',
        publishedAt: 'Mon, 27 Jul 2026 12:00:00 GMT',
      },
      {
        title: 'La facultad presentó su nueva biblioteca',
        link: 'https://news.example.test/noticias/biblioteca',
        publishedAt: 'Mon, 27 Jul 2026 13:00:00 GMT',
        description: 'La Dra. Lucía Prueba aparece solamente en la descripción.',
      },
    ]);
    const collection = await collectUruguayanNewsIndexes({
      sources: [source(), source({ id: 'test_feed_duplicate' })],
      professionalNames: ['NICOLAS NUBE', 'LUCIA PRUEBA', 'FEDERICO JOSE FICTICIO'],
      fetchImpl: () => Promise.resolve(xmlResponse(feed)),
      now: () => FIXED_NOW,
      clockMilliseconds: () => 0,
      sleep: noSleep,
    });

    expect(collection.articles).toHaveLength(2);
    expect(collection.articles.map(({ extractedPersonNames }) => extractedPersonNames)).toEqual([
      ['Lucía Prueba'],
      ['Federico Ficticio'],
    ]);
    expect(
      collection.articles.map(({ source: articleSource }) => articleSource.canonicalUrl),
    ).toEqual([
      'https://news.example.test/noticias/lucia',
      'https://news.example.test/noticias/martin',
    ]);
    expect(collection.sources).toHaveLength(2);
    expect(collection.sources[0]).toMatchObject({
      recordsDiscovered: 4,
      recordsRestricted: 2,
      recordsWithoutMentions: 0,
      recordsWithMentions: 2,
      restrictedReasonCounts: {
        ADVERSE_OR_JUDICIAL: 1,
        MINOR: 1,
        PRIVATE_HEALTH: 1,
        NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT: 1,
      },
    });
    const serialized = JSON.stringify(collection);
    expect(serialized).not.toContain('Nicolás Nube');
    expect(serialized).not.toContain('aparece solamente');
    expect(serialized).not.toContain('msp_doc');
  });

  it('marks an old Subrayado-style feed stale without extracting names', async () => {
    const collection = await collectUruguayanNewsIndexes({
      sources: [
        source({
          id: 'subrayado_nacional',
          freshnessWindowMs: 72 * 60 * 60 * 1_000,
        }),
      ],
      professionalNames: ['LUCIA PRUEBA'],
      fetchImpl: () =>
        Promise.resolve(
          xmlResponse(
            rss([
              {
                title: 'Lucía Prueba asumió un cargo',
                link: 'https://news.example.test/noticias/archivo',
                publishedAt: 'Sat, 01 Jan 2022 12:00:00 GMT',
              },
            ]),
          ),
        ),
      now: () => FIXED_NOW,
      sleep: noSleep,
    });

    expect(collection.articles).toEqual([]);
    expect(collection.sources).toEqual([
      expect.objectContaining({
        status: 'STALE',
        recordsDiscovered: 1,
        recordsSkippedAsStale: 1,
        recordsWithMentions: 0,
      }),
    ]);
    expect(JSON.stringify(collection)).not.toContain('Lucía Prueba');
  });

  it('accepts publication at retrieval time and rejects any future timestamp', async () => {
    const collection = await collectUruguayanNewsIndexes({
      sources: [source()],
      professionalNames: ['LUCIA PRUEBA'],
      fetchImpl: () =>
        Promise.resolve(
          xmlResponse(
            rss([
              {
                title: 'La doctora Lucía Prueba presentó el proyecto académico vigente',
                link: 'https://news.example.test/noticias/frontera-valida',
                publishedAt: FIXED_NOW.toISOString(),
              },
              {
                title: 'La doctora Lucía Prueba presentó el proyecto académico futuro',
                link: 'https://news.example.test/noticias/frontera-invalida',
                publishedAt: new Date(FIXED_NOW.getTime() + 1).toISOString(),
              },
            ]),
          ),
        ),
      now: () => FIXED_NOW,
      sleep: noSleep,
    });

    expect(collection.articles).toHaveLength(1);
    expect(collection.articles[0]?.source.canonicalUrl).toBe(
      'https://news.example.test/noticias/frontera-valida',
    );
    expect(collection.sources[0]).toMatchObject({
      recordsInvalid: 1,
      recordsWithMentions: 1,
    });
  });

  it('skips individual feed items older than the bounded collection window', async () => {
    const collection = await collectUruguayanNewsIndexes({
      sources: [source()],
      professionalNames: ['LUCIA PRUEBA'],
      fetchImpl: () =>
        Promise.resolve(
          xmlResponse(
            rss([
              {
                title: 'La doctora Lucía Prueba presentó un proyecto académico',
                link: 'https://news.example.test/noticias/archivo',
                publishedAt: 'Mon, 01 Jun 2026 12:00:00 GMT',
              },
              {
                title: 'La doctora Lucía Prueba presentó un proyecto académico',
                link: 'https://news.example.test/noticias/reciente',
                publishedAt: 'Mon, 27 Jul 2026 12:00:00 GMT',
              },
            ]),
          ),
        ),
      now: () => FIXED_NOW,
      sleep: noSleep,
    });

    expect(collection.articles).toHaveLength(1);
    expect(collection.articles[0]?.source.canonicalUrl).toBe(
      'https://news.example.test/noticias/reciente',
    );
    expect(collection.sources[0]).toMatchObject({
      recordsSkippedAsStale: 1,
      recordsWithMentions: 1,
    });
    expect(JSON.stringify(collection)).not.toContain('/noticias/archivo');
  });
});

describe('atomic matcher-compatible artifacts', () => {
  it('rejects a professional artifact outside DATA_INGESTION_DIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medicos-news-index-boundary-'));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, 'data');
    const outsideDirectory = join(root, 'outside');
    await Promise.all([
      mkdir(dataDirectory, { recursive: true }),
      mkdir(outsideDirectory, { recursive: true }),
    ]);
    const professionalsPath = join(outsideDirectory, 'professionals.ndjson');
    await writeFile(professionalsPath, `${JSON.stringify({ fullName: 'LUCIA PRUEBA' })}\n`, 'utf8');

    await expect(
      runUruguayanNewsIndexIngestion({
        dataDirectory,
        professionalsPath,
        sources: [source()],
        fetchImpl: () => Promise.resolve(xmlResponse(rss([]))),
        now: () => FIXED_NOW,
        sleep: noSleep,
      }),
    ).rejects.toThrow('Professional input must be inside DATA_INGESTION_DIR');
  });

  it('installs a closed-schema NDJSON and provenance manifest together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medicos-news-index-'));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, 'data');
    const snapshotDirectory = join(
      dataDirectory,
      'processed',
      'msp',
      'infotitulos',
      'test-snapshot',
    );
    await mkdir(snapshotDirectory, { recursive: true });
    const professionalsPath = join(snapshotDirectory, 'professionals.ndjson');
    await writeFile(
      professionalsPath,
      `${JSON.stringify({
        linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
        fullName: 'LUCIA PRUEBA',
      })}\n`,
      'utf8',
    );
    const outputDirectory = join(dataDirectory, 'normalized', 'news', 'test-output');
    const clock = [
      '2026-07-27T15:00:00.000Z',
      '2026-07-27T15:01:00.000Z',
      '2026-07-27T15:01:00.000Z',
      '2026-07-27T15:02:00.000Z',
    ];
    let clockIndex = 0;

    const result = await runUruguayanNewsIndexIngestion({
      dataDirectory,
      professionalsPath,
      outputDirectory,
      sources: [source({ rightsReviewExpiresOn: '2026-07-27' })],
      fetchImpl: () =>
        Promise.resolve(
          xmlResponse(
            rss([
              {
                title: 'La Dra. Lucía Prueba asumió un cargo académico',
                link: 'https://news.example.test/noticias/lucia',
                publishedAt: 'Mon, 27 Jul 2026 13:00:00 GMT',
                description: 'Descripción deliberadamente no persistida.',
              },
            ]),
          ),
        ),
      now: () => new Date(clock[Math.min(clockIndex++, clock.length - 1)]!),
      sleep: noSleep,
    });

    const articleLines = (await readFile(result.articlesPath, 'utf8')).trim().split('\n');
    const article = JSON.parse(articleLines[0] ?? '') as {
      readonly source: {
        readonly retrievedAt: string;
      };
    };
    expect(() => parseNormalizedNewsArticle(article, 1)).not.toThrow();
    expect(article).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        headline: 'La Dra. Lucía Prueba asumió un cargo académico',
        extractedPersonNames: ['Lucía Prueba'],
      }),
    );
    expect(Object.keys(article as Record<string, unknown>).sort()).toEqual([
      'articleId',
      'extractedPersonNames',
      'extraction',
      'headline',
      'schemaVersion',
      'source',
    ]);
    expect(JSON.stringify(article)).not.toContain('Descripción deliberadamente');
    expect(JSON.stringify(article)).not.toContain('msp_doc');

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      readonly generatedAt: string;
      readonly aggregates: {
        readonly recordsEmitted: number;
        readonly recordsSkippedAsStale: number;
      };
      readonly collectionWindow: {
        readonly maxArticleAgeDays: number;
      };
      readonly safeguards: {
        readonly articleBodiesFetched: boolean;
        readonly articleDescriptionsPersisted: boolean;
        readonly professionalIdsPersisted: boolean;
        readonly restrictedItemDetailsPersisted: boolean;
      };
      readonly retention: {
        readonly articlesTtlDays: number;
        readonly expiresAt: string;
      };
    };
    expect(article.source.retrievedAt).toBe('2026-07-27T15:01:00.000Z');
    expect(manifest.generatedAt).toBe('2026-07-27T15:02:00.000Z');
    expect(manifest.generatedAt >= article.source.retrievedAt).toBe(true);
    expect(manifest.aggregates.recordsEmitted).toBe(1);
    expect(manifest.aggregates.recordsSkippedAsStale).toBe(0);
    expect(manifest.collectionWindow).toEqual({
      maxArticleAgeDays: 30,
    });
    expect(manifest.safeguards).toMatchObject({
      articleBodiesFetched: false,
      articleDescriptionsPersisted: false,
      professionalIdsPersisted: false,
      restrictedItemDetailsPersisted: false,
    });
    expect(manifest.retention).toEqual({
      articlesTtlDays: 90,
      expiresAt: '2026-07-28T00:00:00.000Z',
      sourceRightsExpiresAt: '2026-07-28T00:00:00.000Z',
      boundedBySourceRightsExpiry: true,
      disposition: 'DELETE_ARTICLES_AND_DERIVED_NAME_LINKAGE',
    });
    expect(
      (await readdir(dirname(outputDirectory))).filter((name) =>
        name.startsWith('.news-index-stage-'),
      ),
    ).toEqual([]);
  });

  it('aborts without installing an artifact when every source fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'medicos-news-index-failed-'));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, 'data');
    const snapshotDirectory = join(
      dataDirectory,
      'processed',
      'msp',
      'infotitulos',
      'test-snapshot',
    );
    await mkdir(snapshotDirectory, { recursive: true });
    const professionalsPath = join(snapshotDirectory, 'professionals.ndjson');
    await writeFile(professionalsPath, `${JSON.stringify({ fullName: 'LUCIA PRUEBA' })}\n`, 'utf8');
    const outputDirectory = join(dataDirectory, 'normalized', 'news', 'must-not-exist');

    await expect(
      runUruguayanNewsIndexIngestion({
        dataDirectory,
        professionalsPath,
        outputDirectory,
        sources: [source()],
        fetchImpl: () =>
          Promise.resolve(
            new Response(null, {
              status: 503,
            }),
          ),
        now: () => FIXED_NOW,
        sleep: noSleep,
      }),
    ).rejects.toThrow('No news source was fetched successfully');
    await expect(readFile(join(outputDirectory, 'manifest.json'), 'utf8')).rejects.toThrow();
  });
});
