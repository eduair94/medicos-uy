import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseNormalizedNewsArticle, runNewsCandidateBuild } from './build-news-candidates';
import {
  createProfessionalNameIndex,
  NEWS_HEADLINE_POLICY_VERSION,
  NEWS_INDEX_COLLECTOR_VERSION,
  NEWS_SOURCE_RIGHTS_POLICY_VERSION,
  URUGUAYAN_NEWS_INDEX_SOURCES,
} from './ingest-uruguayan-news-indexes';

const temporaryDirectories: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function articleManifest(options: {
  readonly articlesContent: string;
  readonly professionalsContent: string;
  readonly records: number;
  readonly generatedAt?: string;
  readonly expiresAt?: string;
  readonly articlesRelativePath?: string;
}): string {
  const generatedAt = options.generatedAt ?? '2026-07-27T14:00:00.000Z';
  const firstArticle =
    options.articlesContent.trim().length === 0
      ? undefined
      : (JSON.parse(options.articlesContent.trim().split(/\r?\n/u)[0]!) as {
          readonly source?: {
            readonly retrievedAt?: string;
          };
        });
  const fetchedAt = firstArticle?.source?.retrievedAt ?? generatedAt;
  const professionalNames = options.professionalsContent
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const professional = JSON.parse(line) as {
        readonly fullName?: string;
        readonly displayName?: string;
      };
      return professional.fullName ?? professional.displayName ?? '';
    });
  const includedSources = URUGUAYAN_NEWS_INDEX_SOURCES.filter(
    ({ rightsBasis }) => rightsBasis === 'OFFICIAL_RSS_REUSE_PAGE',
  );
  const omittedSources = URUGUAYAN_NEWS_INDEX_SOURCES.filter(
    ({ rightsBasis }) => rightsBasis === 'WRITTEN_AUTHORIZATION_REQUIRED',
  ).map(({ id }) => id);
  const sourceRightsExpiresAt = includedSources
    .map(({ rightsReviewExpiresOn }) =>
      new Date(
        Date.parse(`${rightsReviewExpiresOn}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
      ).toISOString(),
    )
    .sort()
    .at(0)!;
  const ttlExpiresAt = new Date(Date.parse(generatedAt) + 90 * 24 * 60 * 60 * 1_000).toISOString();
  const expiresAt =
    options.expiresAt ?? [ttlExpiresAt, sourceRightsExpiresAt].sort().at(0) ?? ttlExpiresAt;
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactId: 'news-index-v1-fixture',
    collectorVersion: NEWS_INDEX_COLLECTOR_VERSION,
    headlinePolicyVersion: NEWS_HEADLINE_POLICY_VERSION,
    sourceRightsPolicyVersion: NEWS_SOURCE_RIGHTS_POLICY_VERSION,
    generatedAt,
    inputs: {
      professionals: {
        relativePath: 'normalized/professionals.ndjson',
        sha256: sha256(options.professionalsContent),
        records: professionalNames.length,
        distinctNames: createProfessionalNameIndex(professionalNames).distinctNames,
      },
    },
    sources: includedSources.map((source) => ({
      sourceId: source.id,
      publisher: source.publisher,
      format: source.format,
      indexUrl: source.indexUrl,
      discoveryUrl: source.discoveryUrl,
      robotsUrl: source.robotsUrl,
      rightsBasis: source.rightsBasis,
      termsUrl: source.termsUrl,
      rightsReviewedOn: source.rightsReviewedOn,
      rightsReviewExpiresOn: source.rightsReviewExpiresOn,
      ...(source.id === 'elobservador_home'
        ? {
            status: 'FETCHED',
            finalUrl: source.indexUrl,
            retrievedAt: fetchedAt,
            responseBytes: 1,
            responseSha256: 'f'.repeat(64),
          }
        : {
            status: 'FAILED',
            errorCode: 'HTTP_STATUS',
          }),
      recordsDiscovered: source.id === 'elobservador_home' ? options.records : 0,
      recordsInvalid: 0,
      recordsRestricted: 0,
      recordsWithoutMentions: 0,
      recordsWithMentions: source.id === 'elobservador_home' ? options.records : 0,
      recordsSkippedAsStale: 0,
      restrictedReasonCounts: {
        ADVERSE_OR_JUDICIAL: 0,
        MINOR: 0,
        PRIVATE_HEALTH: 0,
        NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT: 0,
      },
    })),
    sourcePolicy: {
      authorizationGatedSourcesOmitted: omittedSources,
    },
    outputs: {
      articles: {
        relativePath: options.articlesRelativePath ?? 'normalized/articles.ndjson',
        sha256: sha256(options.articlesContent),
        records: options.records,
        schemaVersion: 1,
      },
    },
    aggregates: {},
    collectionWindow: {
      maxArticleAgeDays: 30,
    },
    safeguards: {
      articleBodiesFetched: false,
      articleDescriptionsPersisted: false,
      articlePagesFetched: false,
      automaticIdentityConfirmation: false,
      publicExportAllowed: false,
      professionalIdsPersisted: false,
      restrictedItemDetailsPersisted: false,
      searchEnginesUsed: false,
      sourceIndexesOnly: true,
    },
    retention: {
      articlesTtlDays: 90,
      expiresAt,
      sourceRightsExpiresAt,
      boundedBySourceRightsExpiry: sourceRightsExpiresAt < ttlExpiresAt,
      disposition: 'DELETE_ARTICLES_AND_DERIVED_NAME_LINKAGE',
    },
  })}\n`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe('runNewsCandidateBuild', () => {
  it('installs a hash-manifested quarantine artifact and refuses to overwrite it', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-candidates-'));
    temporaryDirectories.push(dataDirectory);
    const inputDirectory = join(dataDirectory, 'normalized');
    const newsInputDirectory = join(inputDirectory, 'news', 'news-index-v1-fixture');
    await mkdir(newsInputDirectory, { recursive: true });
    const professionalsPath = join(inputDirectory, 'professionals.ndjson');
    const articlesPath = join(newsInputDirectory, 'articles.ndjson');
    const professional = {
      linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
      fullName: 'Ada Prueba Médica Uno',
      enabledTitles: [
        {
          recruiterCode: '1',
          temporaryRegistration: null,
          title: 'ESPECIALISTA EN ANESTESIOLOGÍA',
        },
      ],
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate: '2026-06-30',
      },
    };
    const articleUrl = 'https://www.elobservador.com.uy/noticia/prueba-sintetica-123';
    const articleHeadline =
      'La anestesióloga Ada Prueba Médica Uno recibió un reconocimiento académico';
    const articlePublishedAt = '2026-07-01T12:00:00.000Z';
    const article = {
      schemaVersion: 1,
      articleId: `elobservador:${sha256(articleUrl).slice(0, 40)}`,
      headline: articleHeadline,
      extractedPersonNames: ['Ada Prueba Medica Uno'],
      source: {
        sourceId: 'elobservador_home',
        publisher: 'El Observador',
        canonicalUrl: articleUrl,
        publishedAt: articlePublishedAt,
        retrievedAt: '2026-07-02T12:00:00.000Z',
        contentSha256: sha256([articleHeadline, articleUrl, articlePublishedAt].join('\u0000')),
      },
      extraction: {
        method: 'DETERMINISTIC_PARSER',
        extractedAt: '2026-07-02T12:00:00.000Z',
        extractorVersion: NEWS_INDEX_COLLECTOR_VERSION,
      },
    };
    const professionalsContent = `${JSON.stringify(professional)}\n`;
    const articlesContent = `${JSON.stringify(article)}\n`;
    await Promise.all([
      writeFile(professionalsPath, professionalsContent),
      writeFile(articlesPath, articlesContent),
      writeFile(
        join(newsInputDirectory, 'manifest.json'),
        articleManifest({
          articlesContent,
          professionalsContent,
          records: 1,
          articlesRelativePath: 'normalized/news/news-index-v1-fixture/articles.ndjson',
        }),
      ),
    ]);
    const environment = {
      DATA_INGESTION_DIR: dataDirectory,
      NEWS_PROFESSIONALS_PATH: professionalsPath,
    };

    const result = await runNewsCandidateBuild(environment, {
      now: () => new Date('2026-07-27T15:00:00.000Z'),
    });
    const candidatesContent = await readFile(result.candidatesPath, 'utf8');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      schemaVersion: number;
      outputs: { quarantineCandidates: { records: number; sha256: string } };
      retention: {
        ttlDays: number;
        expiresAt: string;
        sourceExpiresAt: string;
        boundedBySourceExpiry: boolean;
        disposition: string;
      };
      safeguards: Record<string, boolean>;
    };
    const candidate = JSON.parse(candidatesContent.trim()) as {
      schemaVersion: number;
      state: string;
      match: {
        contextualCorroboration: {
          profession: { available: boolean; matched: boolean };
          matchedDimensions: readonly string[];
        };
        alert: { codes: readonly string[] };
      };
      publicationDecision: { publicExportAllowed: boolean };
    };

    expect(candidate).toMatchObject({
      schemaVersion: 2,
      state: 'NEEDS_HUMAN_REVIEW',
      match: {
        contextualCorroboration: {
          profession: {
            available: true,
            matched: true,
          },
          matchedDimensions: ['PROFESSION'],
        },
      },
      publicationDecision: {
        publicExportAllowed: false,
      },
    });
    expect(candidate.match.alert.codes).toContain('CONTEXTUAL_SIGNAL_IS_NOT_IDENTITY_PROOF');
    expect(manifest.outputs.quarantineCandidates).toEqual(
      expect.objectContaining({
        records: 1,
        sha256: sha256(candidatesContent),
      }),
    );
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.safeguards).toEqual(
      expect.objectContaining({
        automaticallyLinked: false,
        automaticallyPublished: false,
        contextualCorroborationUsed: true,
        deterministicFlexibleNameMatchingUsed: true,
        missingContextTreatedAsContradiction: false,
        nameMatchingOnly: false,
        publicExportAllowed: false,
        quarantineOnly: true,
        requiresHumanReview: true,
      }),
    );
    expect(manifest.retention).toEqual({
      ttlDays: 90,
      expiresAt: '2026-08-27T00:00:00.000Z',
      sourceExpiresAt: '2026-08-27T00:00:00.000Z',
      boundedBySourceExpiry: true,
      disposition: 'DELETE_OR_REVALIDATE',
    });
    await expect(
      runNewsCandidateBuild(environment, {
        now: () => new Date('2026-07-27T15:00:00.000Z'),
      }),
    ).rejects.toThrow('Refusing to overwrite existing news quarantine artifact');
  });

  it('produces a valid empty quarantine when the normalized article batch is empty', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-candidates-empty-'));
    temporaryDirectories.push(dataDirectory);
    const inputDirectory = join(dataDirectory, 'normalized');
    await mkdir(inputDirectory, { recursive: true });
    const professionalsPath = join(inputDirectory, 'professionals.ndjson');
    const articlesPath = join(inputDirectory, 'articles.ndjson');
    const professionalsContent = `${[
      {
        linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
        fullName: 'Nombre Profesional',
        enabledTitles: [
          {
            recruiterCode: '310000',
            temporaryRegistration: null,
            title: 'DOCTOR EN MEDICINA',
          },
        ],
        provenance: {
          publisher: 'Ministerio de Salud Pública',
          dataset: 'Infotítulos',
          sourceCutoffDate: '2026-06-30',
        },
      },
      {
        linkageId: `msp_doc_v1_${'b'.repeat(64)}`,
        fullName: 'Uno Dos Tres Cuatro Cinco Seis Siete Ocho Nueve Diez Once',
        enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
        provenance: {
          publisher: 'Ministerio de Salud Pública',
          dataset: 'Infotítulos',
          sourceCutoffDate: '2026-06-30',
        },
      },
    ]
      .map((professional) => JSON.stringify(professional))
      .join('\n')}\n`;
    await Promise.all([
      writeFile(professionalsPath, professionalsContent),
      writeFile(articlesPath, ''),
      writeFile(
        join(inputDirectory, 'manifest.json'),
        articleManifest({
          articlesContent: '',
          professionalsContent,
          records: 0,
        }),
      ),
    ]);

    const result = await runNewsCandidateBuild(
      {
        DATA_INGESTION_DIR: dataDirectory,
        NEWS_PROFESSIONALS_PATH: professionalsPath,
        NEWS_ARTICLES_PATH: articlesPath,
      },
      {
        now: () => new Date('2026-07-27T15:00:00.000Z'),
      },
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      readonly outputs: {
        readonly quarantineCandidates: {
          readonly records: number;
        };
      };
    };

    await expect(readFile(result.candidatesPath, 'utf8')).resolves.toBe('');
    expect(manifest.outputs.quarantineCandidates.records).toBe(0);
  });

  it('rejects a manifest that does not attest the current collection policies', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-candidates-policy-'));
    temporaryDirectories.push(dataDirectory);
    const inputDirectory = join(dataDirectory, 'normalized');
    await mkdir(inputDirectory, { recursive: true });
    const professionalsPath = join(inputDirectory, 'professionals.ndjson');
    const articlesPath = join(inputDirectory, 'articles.ndjson');
    const articlesContent = `${JSON.stringify({
      schemaVersion: 1,
      articleId: 'source:policy-1',
      headline: 'La doctora Nombre Profesional recibió un reconocimiento académico',
      extractedPersonNames: ['Nombre Profesional'],
      source: {
        sourceId: 'elobservador_home',
        publisher: 'Medio',
        canonicalUrl: 'https://example.test/policy',
        publishedAt: '2026-07-27T12:00:00.000Z',
        retrievedAt: '2026-07-27T13:00:00.000Z',
        contentSha256: 'd'.repeat(64),
      },
      extraction: {
        method: 'HUMAN_CURATED',
        extractedAt: '2026-07-27T13:30:00.000Z',
        extractorVersion: 'fixture-v1',
      },
    })}\n`;
    const professionalsContent = `${JSON.stringify({
      linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
      fullName: 'Nombre Profesional',
      enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate: '2026-06-30',
      },
    })}\n`;
    const manifest = JSON.parse(
      articleManifest({
        articlesContent,
        professionalsContent,
        records: 1,
      }),
    ) as Record<string, unknown>;
    manifest['headlinePolicyVersion'] = 'restricted-headlines-v4';
    await Promise.all([
      writeFile(professionalsPath, professionalsContent),
      writeFile(articlesPath, articlesContent),
      writeFile(join(inputDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`),
    ]);

    await expect(
      runNewsCandidateBuild(
        {
          DATA_INGESTION_DIR: dataDirectory,
          NEWS_PROFESSIONALS_PATH: professionalsPath,
          NEWS_ARTICLES_PATH: articlesPath,
        },
        {
          now: () => new Date('2026-07-27T15:00:00.000Z'),
        },
      ),
    ).rejects.toThrow('policy versions are not approved');
  });

  it('rejects matching against a different professional snapshot than the collector used', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-candidates-snapshot-'));
    temporaryDirectories.push(dataDirectory);
    const inputDirectory = join(dataDirectory, 'normalized');
    await mkdir(inputDirectory, { recursive: true });
    const professionalsPath = join(inputDirectory, 'professionals.ndjson');
    const articlesPath = join(inputDirectory, 'articles.ndjson');
    const collectedProfessionalsContent = `${JSON.stringify({
      linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
      fullName: 'Nombre Original',
      enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate: '2026-06-30',
      },
    })}\n`;
    const substitutedProfessionalsContent = `${JSON.stringify({
      linkageId: `msp_doc_v1_${'b'.repeat(64)}`,
      fullName: 'Nombre Sustituido',
      enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate: '2026-06-30',
      },
    })}\n`;
    await Promise.all([
      writeFile(professionalsPath, substitutedProfessionalsContent),
      writeFile(articlesPath, ''),
      writeFile(
        join(inputDirectory, 'manifest.json'),
        articleManifest({
          articlesContent: '',
          professionalsContent: collectedProfessionalsContent,
          records: 0,
        }),
      ),
    ]);

    await expect(
      runNewsCandidateBuild(
        {
          DATA_INGESTION_DIR: dataDirectory,
          NEWS_PROFESSIONALS_PATH: professionalsPath,
          NEWS_ARTICLES_PATH: articlesPath,
        },
        {
          now: () => new Date('2026-07-27T15:00:00.000Z'),
        },
      ),
    ).rejects.toThrow('professional hash does not match professionals.ndjson');
  });

  it('rejects articles outside the declared source host or 30-day collection window', async () => {
    const scenarios = [
      {
        label: 'rogue-host',
        canonicalUrl: 'https://rogue.example/noticia/1',
        publishedAt: '2026-07-27T12:00:00.000Z',
        expectedError: 'outside its approved publisher hosts',
      },
      {
        label: 'stale-item',
        canonicalUrl: 'https://www.elobservador.com.uy/noticia/archivo',
        publishedAt: '2020-01-01T12:00:00.000Z',
        expectedError: 'outside the approved collection window',
      },
    ] as const;

    for (const scenario of scenarios) {
      const dataDirectory = await mkdtemp(
        join(tmpdir(), `medicos-news-candidates-${scenario.label}-`),
      );
      temporaryDirectories.push(dataDirectory);
      const inputDirectory = join(dataDirectory, 'normalized');
      await mkdir(inputDirectory, { recursive: true });
      const professionalsPath = join(inputDirectory, 'professionals.ndjson');
      const articlesPath = join(inputDirectory, 'articles.ndjson');
      const headline = 'La doctora Nombre Profesional recibió un reconocimiento académico';
      const retrievedAt = '2026-07-27T13:00:00.000Z';
      const article = {
        schemaVersion: 1,
        articleId: `elobservador:${sha256(scenario.canonicalUrl).slice(0, 40)}`,
        headline,
        extractedPersonNames: ['Nombre Profesional'],
        source: {
          sourceId: 'elobservador_home',
          publisher: 'El Observador',
          canonicalUrl: scenario.canonicalUrl,
          publishedAt: scenario.publishedAt,
          retrievedAt,
          contentSha256: sha256(
            [headline, scenario.canonicalUrl, scenario.publishedAt].join('\u0000'),
          ),
        },
        extraction: {
          method: 'DETERMINISTIC_PARSER',
          extractedAt: retrievedAt,
          extractorVersion: NEWS_INDEX_COLLECTOR_VERSION,
        },
      };
      const articlesContent = `${JSON.stringify(article)}\n`;
      const professionalsContent = `${JSON.stringify({
        linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
        fullName: 'Nombre Profesional',
        enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
        provenance: {
          publisher: 'Ministerio de Salud Pública',
          dataset: 'Infotítulos',
          sourceCutoffDate: '2026-06-30',
        },
      })}\n`;
      await Promise.all([
        writeFile(professionalsPath, professionalsContent),
        writeFile(articlesPath, articlesContent),
        writeFile(
          join(inputDirectory, 'manifest.json'),
          articleManifest({
            articlesContent,
            professionalsContent,
            records: 1,
          }),
        ),
      ]);

      await expect(
        runNewsCandidateBuild(
          {
            DATA_INGESTION_DIR: dataDirectory,
            NEWS_PROFESSIONALS_PATH: professionalsPath,
            NEWS_ARTICLES_PATH: articlesPath,
          },
          {
            now: () => new Date('2026-07-27T15:00:00.000Z'),
          },
        ),
      ).rejects.toThrow(scenario.expectedError);
    }
  });

  it('requires gated-source evidence to match the independent authorization environment', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-candidates-gated-'));
    temporaryDirectories.push(dataDirectory);
    const inputDirectory = join(dataDirectory, 'normalized');
    await mkdir(inputDirectory, { recursive: true });
    const professionalsPath = join(inputDirectory, 'professionals.ndjson');
    const articlesPath = join(inputDirectory, 'articles.ndjson');
    const manifestPath = join(inputDirectory, 'manifest.json');
    const gatedSource = URUGUAYAN_NEWS_INDEX_SOURCES.find(({ id }) => id === 'elpais_content');
    if (gatedSource === undefined) {
      throw new Error('El País source is missing from the production catalog');
    }
    const professionalsContent = `${JSON.stringify({
      linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
      fullName: 'Nombre Profesional',
      enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate: '2026-06-30',
      },
    })}\n`;
    const manifest = JSON.parse(
      articleManifest({
        articlesContent: '',
        professionalsContent,
        records: 0,
      }),
    ) as {
      sources: Record<string, unknown>[];
      sourcePolicy: {
        authorizationGatedSourcesOmitted: string[];
      };
    };
    const gatedReport: Record<string, unknown> = {
      sourceId: gatedSource.id,
      publisher: gatedSource.publisher,
      format: gatedSource.format,
      indexUrl: gatedSource.indexUrl,
      discoveryUrl: gatedSource.discoveryUrl,
      robotsUrl: gatedSource.robotsUrl,
      rightsBasis: gatedSource.rightsBasis,
      termsUrl: gatedSource.termsUrl,
      rightsReviewedOn: gatedSource.rightsReviewedOn,
      rightsReviewExpiresOn: gatedSource.rightsReviewExpiresOn,
      authorizationEvidenceSha256: '0'.repeat(64),
      status: 'FETCHED',
      finalUrl: gatedSource.indexUrl,
      retrievedAt: '2026-07-27T13:00:00.000Z',
      responseBytes: 1,
      responseSha256: 'f'.repeat(64),
      recordsDiscovered: 0,
      recordsInvalid: 0,
      recordsRestricted: 0,
      recordsWithoutMentions: 0,
      recordsWithMentions: 0,
      recordsSkippedAsStale: 0,
      restrictedReasonCounts: {
        ADVERSE_OR_JUDICIAL: 0,
        MINOR: 0,
        PRIVATE_HEALTH: 0,
        NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT: 0,
      },
    };
    manifest.sources.push(gatedReport);
    manifest.sourcePolicy.authorizationGatedSourcesOmitted =
      manifest.sourcePolicy.authorizationGatedSourcesOmitted.filter(
        (sourceId) => sourceId !== gatedSource.id,
      );
    await Promise.all([
      writeFile(professionalsPath, professionalsContent),
      writeFile(articlesPath, ''),
      writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
    ]);
    const baseEnvironment = {
      DATA_INGESTION_DIR: dataDirectory,
      NEWS_PROFESSIONALS_PATH: professionalsPath,
      NEWS_ARTICLES_PATH: articlesPath,
    };
    const now = { now: () => new Date('2026-07-27T15:00:00.000Z') };

    await expect(runNewsCandidateBuild(baseEnvironment, now)).rejects.toThrow(
      'not enabled by the independent authorization environment',
    );
    await expect(
      runNewsCandidateBuild(
        {
          ...baseEnvironment,
          NEWS_ENABLE_ELPAIS: 'true',
          NEWS_ELPAIS_AUTHORIZATION_REFERENCE: 'legal-approval-2026-07',
          NEWS_ELPAIS_AUTHORIZATION_SHA256_ALLOWLIST: '0'.repeat(64),
        },
        now,
      ),
    ).rejects.toThrow('not in the independent authorization allowlist');

    const authorizationReference = 'legal-approval-2026-07';
    const authorizationHash = sha256(authorizationReference);
    gatedReport['authorizationEvidenceSha256'] = authorizationHash;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      runNewsCandidateBuild(
        {
          ...baseEnvironment,
          NEWS_ENABLE_ELPAIS: 'true',
          NEWS_ELPAIS_AUTHORIZATION_REFERENCE: authorizationReference,
          NEWS_ELPAIS_AUTHORIZATION_SHA256_ALLOWLIST: authorizationHash,
        },
        now,
      ),
    ).resolves.toMatchObject({
      aggregates: {
        candidates: 0,
      },
    });
  });

  it('rejects an expired article manifest instead of renewing its TTL', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'medicos-news-candidates-expired-'));
    temporaryDirectories.push(dataDirectory);
    const inputDirectory = join(dataDirectory, 'normalized');
    await mkdir(inputDirectory, { recursive: true });
    const professionalsPath = join(inputDirectory, 'professionals.ndjson');
    const articlesPath = join(inputDirectory, 'articles.ndjson');
    const professional = {
      linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
      fullName: 'Nombre Profesional',
      enabledTitles: [{ title: 'DOCTOR EN MEDICINA' }],
      provenance: {
        publisher: 'Ministerio de Salud Pública',
        dataset: 'Infotítulos',
        sourceCutoffDate: '2026-06-30',
      },
    };
    const article = {
      schemaVersion: 1,
      articleId: 'source:expired-1',
      headline: 'El doctor Nombre Profesional recibió un reconocimiento académico',
      extractedPersonNames: ['Nombre Profesional'],
      source: {
        sourceId: 'elobservador_home',
        publisher: 'Medio',
        canonicalUrl: 'https://example.test/expired',
        publishedAt: '2020-01-01T12:00:00.000Z',
        retrievedAt: '2020-01-02T12:00:00.000Z',
        contentSha256: 'c'.repeat(64),
      },
      extraction: {
        method: 'HUMAN_CURATED',
        extractedAt: '2020-01-02T13:00:00.000Z',
        extractorVersion: 'fixture-v1',
      },
    };
    const articlesContent = `${JSON.stringify(article)}\n`;
    const professionalsContent = `${JSON.stringify(professional)}\n`;
    await Promise.all([
      writeFile(professionalsPath, professionalsContent),
      writeFile(articlesPath, articlesContent),
      writeFile(
        join(inputDirectory, 'manifest.json'),
        articleManifest({
          articlesContent,
          professionalsContent,
          records: 1,
          generatedAt: '2020-01-02T14:00:00.000Z',
          expiresAt: '2020-04-01T14:00:00.000Z',
        }),
      ),
    ]);

    await expect(
      runNewsCandidateBuild(
        {
          DATA_INGESTION_DIR: dataDirectory,
          NEWS_PROFESSIONALS_PATH: professionalsPath,
          NEWS_ARTICLES_PATH: articlesPath,
        },
        {
          now: () => new Date('2026-07-27T15:00:00.000Z'),
        },
      ),
    ).rejects.toThrow('Article manifest is expired');
  });
});

describe('parseNormalizedNewsArticle', () => {
  it('rejects article bodies and other fields outside the minimal contract', () => {
    expect(() =>
      parseNormalizedNewsArticle(
        {
          schemaVersion: 1,
          articleId: 'source:opaque-123',
          headline: 'Titular',
          body: 'El cuerpo no debe ingresar al matcher.',
          extractedPersonNames: ['Nombre Apellido'],
          source: {
            sourceId: 'elobservador_home',
            publisher: 'Medio',
            canonicalUrl: 'https://example.test/noticia/123',
            publishedAt: '2026-07-01T12:00:00.000Z',
            retrievedAt: '2026-07-02T12:00:00.000Z',
            contentSha256: 'b'.repeat(64),
          },
          extraction: {
            method: 'HUMAN_CURATED',
            extractedAt: '2026-07-02T13:00:00.000Z',
            extractorVersion: 'fixture-v1',
          },
        },
        1,
      ),
    ).toThrow('unexpected=body');
  });

  it('rejects restricted headlines even when an upstream producer bypasses its filter', () => {
    expect(() =>
      parseNormalizedNewsArticle(
        {
          schemaVersion: 1,
          articleId: 'source:opaque-456',
          headline: 'Imputaron al médico por la muerte de un bebé paciente',
          extractedPersonNames: ['Nombre Apellido'],
          source: {
            sourceId: 'elobservador_home',
            publisher: 'Medio',
            canonicalUrl: 'https://example.test/noticia/456',
            publishedAt: '2026-07-01T12:00:00.000Z',
            retrievedAt: '2026-07-02T12:00:00.000Z',
            contentSha256: 'c'.repeat(64),
          },
          extraction: {
            method: 'DETERMINISTIC_PARSER',
            extractedAt: '2026-07-02T13:00:00.000Z',
            extractorVersion: 'fixture-v1',
          },
        },
        1,
      ),
    ).toThrow('headline is restricted by the fail-closed news policy');
  });
});
