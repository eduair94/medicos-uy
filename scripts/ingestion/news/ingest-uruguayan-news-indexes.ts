import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { load } from 'cheerio';

import { evaluateFlexiblePersonName } from '../linkage/evaluate-flexible-person-name';
import { normalizePersonName } from '../linkage/normalize-person-name';

import type { ReadableStreamReadResult } from 'node:stream/web';

export const NEWS_INDEX_COLLECTOR_VERSION = 'uruguayan-public-indexes-v5' as const;
export const NEWS_HEADLINE_POLICY_VERSION = 'restricted-headlines-v6' as const;
export const NEWS_SOURCE_RIGHTS_POLICY_VERSION = 'news-source-rights-v3' as const;
export const NEWS_ITEM_MAX_AGE_DAYS = 30 as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_HEADLINE_LENGTH = 1_000;
const ARTICLE_RETENTION_DAYS = 90;
const INITIALS_EXTRACTION_FANOUT_LIMIT = 25;
const NEWS_ITEM_MAX_AGE_MS = NEWS_ITEM_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;

export type NewsIndexFormat = 'GOOGLE_NEWS_SITEMAP' | 'RSS';
export type NewsSourceRightsBasis =
  'OFFICIAL_RSS_REUSE_PAGE' | 'WRITTEN_AUTHORIZATION_REQUIRED' | 'TEST_FIXTURE';

export interface NewsIndexSource {
  readonly id: string;
  readonly publisherKey: string;
  readonly publisher: string;
  readonly format: NewsIndexFormat;
  readonly indexUrl: string;
  readonly discoveryUrl: string;
  readonly robotsUrl: string;
  readonly allowedIndexHosts: readonly string[];
  readonly allowedArticleHosts: readonly string[];
  readonly minimumRequestIntervalMs: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly freshnessWindowMs?: number;
  readonly rightsBasis: NewsSourceRightsBasis;
  readonly termsUrl: string;
  readonly rightsReviewedOn: string;
  readonly rightsReviewExpiresOn: string;
  readonly enableEnvironmentVariable?: string;
  readonly authorizationReferenceEnvironmentVariable?: string;
  readonly authorizationAllowlistEnvironmentVariable?: string;
  readonly authorizationEvidenceSha256?: string;
}

declare const AUTHORIZED_NEWS_SOURCE: unique symbol;
export type AuthorizedNewsIndexSource = NewsIndexSource & {
  readonly [AUTHORIZED_NEWS_SOURCE]: true;
};
const AUTHORIZED_NEWS_SOURCES = new WeakSet<NewsIndexSource>();

/**
 * Only index/RSS endpoints are listed here. The collector never requests an
 * article page, a search result, or an archive page.
 *
 * El País intentionally uses one content sitemap instead of making a second
 * request to `news-sitemap-latest.xml`: it has broader current coverage while
 * respecting the publisher's ten-second crawl delay with a single host request.
 */
const URUGUAYAN_NEWS_INDEX_SOURCE_DEFINITIONS = [
  {
    id: 'elpais_content',
    publisherKey: 'elpais',
    publisher: 'El País',
    format: 'GOOGLE_NEWS_SITEMAP',
    indexUrl: 'https://www.elpais.com.uy/news-sitemap-content.xml',
    discoveryUrl: 'https://www.elpais.com.uy/robots.txt',
    robotsUrl: 'https://www.elpais.com.uy/robots.txt',
    allowedIndexHosts: ['www.elpais.com.uy'],
    allowedArticleHosts: ['www.elpais.com.uy', 'elpais.com.uy'],
    minimumRequestIntervalMs: 10_000,
    timeoutMs: 20_000,
    maxResponseBytes: 8 * 1_024 * 1_024,
    rightsBasis: 'WRITTEN_AUTHORIZATION_REQUIRED',
    termsUrl: 'https://registro.elpais.com.uy/regcondiciones.asp',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
    enableEnvironmentVariable: 'NEWS_ENABLE_ELPAIS',
    authorizationReferenceEnvironmentVariable: 'NEWS_ELPAIS_AUTHORIZATION_REFERENCE',
    authorizationAllowlistEnvironmentVariable: 'NEWS_ELPAIS_AUTHORIZATION_SHA256_ALLOWLIST',
  },
  {
    id: 'elobservador_home',
    publisherKey: 'elobservador',
    publisher: 'El Observador',
    format: 'RSS',
    indexUrl: 'https://www.elobservador.com.uy/rss/pages/home.xml',
    discoveryUrl: 'https://www.elobservador.com.uy/contenidos/rss.html',
    robotsUrl: 'https://www.elobservador.com.uy/robots.txt',
    allowedIndexHosts: ['www.elobservador.com.uy'],
    allowedArticleHosts: ['www.elobservador.com.uy', 'elobservador.com.uy'],
    minimumRequestIntervalMs: 2_000,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1_024 * 1_024,
    rightsBasis: 'OFFICIAL_RSS_REUSE_PAGE',
    termsUrl: 'https://www.elobservador.com.uy/contenidos/terminos.html',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
  },
  {
    id: 'elobservador_nacional',
    publisherKey: 'elobservador',
    publisher: 'El Observador',
    format: 'RSS',
    indexUrl: 'https://www.elobservador.com.uy/rss/pages/nacional.xml',
    discoveryUrl: 'https://www.elobservador.com.uy/contenidos/rss.html',
    robotsUrl: 'https://www.elobservador.com.uy/robots.txt',
    allowedIndexHosts: ['www.elobservador.com.uy'],
    allowedArticleHosts: ['www.elobservador.com.uy', 'elobservador.com.uy'],
    minimumRequestIntervalMs: 2_000,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1_024 * 1_024,
    rightsBasis: 'OFFICIAL_RSS_REUSE_PAGE',
    termsUrl: 'https://www.elobservador.com.uy/contenidos/terminos.html',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
  },
  {
    id: 'elobservador_salud',
    publisherKey: 'elobservador',
    publisher: 'El Observador',
    format: 'RSS',
    indexUrl: 'https://www.elobservador.com.uy/rss/pages/salud.xml',
    discoveryUrl: 'https://www.elobservador.com.uy/contenidos/rss.html',
    robotsUrl: 'https://www.elobservador.com.uy/robots.txt',
    allowedIndexHosts: ['www.elobservador.com.uy'],
    allowedArticleHosts: ['www.elobservador.com.uy', 'elobservador.com.uy'],
    minimumRequestIntervalMs: 2_000,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1_024 * 1_024,
    rightsBasis: 'OFFICIAL_RSS_REUSE_PAGE',
    termsUrl: 'https://www.elobservador.com.uy/contenidos/terminos.html',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
  },
  {
    id: 'montevideo_destacados',
    publisherKey: 'montevideo',
    publisher: 'Montevideo Portal',
    format: 'RSS',
    indexUrl: 'https://www.montevideo.com.uy/anxml.aspx?58',
    discoveryUrl:
      'https://www.montevideo.com.uy/Utiles/Las-noticias-de-Montevideo-Portal-en-formato-RSS-uc27383',
    robotsUrl: 'https://www.montevideo.com.uy/robots.txt',
    allowedIndexHosts: ['www.montevideo.com.uy'],
    allowedArticleHosts: ['www.montevideo.com.uy', 'montevideo.com.uy'],
    minimumRequestIntervalMs: 2_000,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1_024 * 1_024,
    rightsBasis: 'OFFICIAL_RSS_REUSE_PAGE',
    termsUrl:
      'https://www.montevideo.com.uy/Utiles/Las-noticias-de-Montevideo-Portal-en-formato-RSS-uc27383',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
  },
  {
    id: 'montevideo_noticias',
    publisherKey: 'montevideo',
    publisher: 'Montevideo Portal',
    format: 'RSS',
    indexUrl: 'https://www.montevideo.com.uy/anxml.aspx?59',
    discoveryUrl:
      'https://www.montevideo.com.uy/Utiles/Las-noticias-de-Montevideo-Portal-en-formato-RSS-uc27383',
    robotsUrl: 'https://www.montevideo.com.uy/robots.txt',
    allowedIndexHosts: ['www.montevideo.com.uy'],
    allowedArticleHosts: ['www.montevideo.com.uy', 'montevideo.com.uy'],
    minimumRequestIntervalMs: 2_000,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1_024 * 1_024,
    rightsBasis: 'OFFICIAL_RSS_REUSE_PAGE',
    termsUrl:
      'https://www.montevideo.com.uy/Utiles/Las-noticias-de-Montevideo-Portal-en-formato-RSS-uc27383',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
  },
  {
    id: 'subrayado_nacional',
    publisherKey: 'subrayado',
    publisher: 'Subrayado',
    format: 'RSS',
    indexUrl: 'https://www.subrayado.com.uy/rss/pages/nacional.xml',
    discoveryUrl: 'https://www.subrayado.com.uy/contenidos/rss.html',
    robotsUrl: 'https://www.subrayado.com.uy/robots.txt',
    allowedIndexHosts: ['www.subrayado.com.uy'],
    allowedArticleHosts: ['www.subrayado.com.uy', 'subrayado.com.uy'],
    minimumRequestIntervalMs: 2_000,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1_024 * 1_024,
    freshnessWindowMs: 72 * 60 * 60 * 1_000,
    rightsBasis: 'WRITTEN_AUTHORIZATION_REQUIRED',
    termsUrl: 'https://www.subrayado.com.uy/terminos',
    rightsReviewedOn: '2026-07-27',
    rightsReviewExpiresOn: '2026-08-26',
    enableEnvironmentVariable: 'NEWS_ENABLE_SUBRAYADO',
    authorizationReferenceEnvironmentVariable: 'NEWS_SUBRAYADO_AUTHORIZATION_REFERENCE',
    authorizationAllowlistEnvironmentVariable: 'NEWS_SUBRAYADO_AUTHORIZATION_SHA256_ALLOWLIST',
  },
] as const satisfies readonly NewsIndexSource[];

/**
 * The resolver authorizes catalog entries by object identity. Deep-freezing the
 * exported catalog prevents callers from changing a URL or allowlist before
 * that identity check runs.
 */
export const URUGUAYAN_NEWS_INDEX_SOURCES: readonly NewsIndexSource[] = Object.freeze(
  URUGUAYAN_NEWS_INDEX_SOURCE_DEFINITIONS.map((source) =>
    Object.freeze({
      ...source,
      allowedIndexHosts: Object.freeze([...source.allowedIndexHosts]),
      allowedArticleHosts: Object.freeze([...source.allowedArticleHosts]),
    }),
  ),
);

export type RestrictedHeadlineReason =
  'ADVERSE_OR_JUDICIAL' | 'MINOR' | 'PRIVATE_HEALTH' | 'NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT';

export interface HeadlinePolicyDecision {
  readonly restricted: boolean;
  readonly reasons: readonly RestrictedHeadlineReason[];
}

export interface ParsedNewsIndexItem {
  readonly headline: string;
  readonly canonicalUrl: string;
  readonly publishedAt: string;
}

export interface ParsedNewsIndex {
  readonly items: readonly ParsedNewsIndexItem[];
  readonly invalidItems: number;
}

export interface ProfessionalNameEntry {
  readonly normalizedName: string;
  readonly tokens: readonly string[];
}

export interface ProfessionalNameIndex {
  readonly distinctNames: number;
  readonly exactNames: ReadonlySet<string>;
  readonly entriesByFirstToken: ReadonlyMap<string, readonly ProfessionalNameEntry[]>;
  readonly entriesByFirstInitial: ReadonlyMap<string, readonly ProfessionalNameEntry[]>;
  readonly uniqueAliases: ReadonlySet<string>;
}

export interface NormalizedNewsArticleArtifactRecord {
  readonly schemaVersion: 1;
  readonly articleId: string;
  readonly headline: string;
  readonly extractedPersonNames: readonly string[];
  readonly source: {
    readonly sourceId: string;
    readonly publisher: string;
    readonly canonicalUrl: string;
    readonly publishedAt: string;
    readonly retrievedAt: string;
    readonly contentSha256: string;
  };
  readonly extraction: {
    readonly method: 'DETERMINISTIC_PARSER';
    readonly extractedAt: string;
    readonly extractorVersion: typeof NEWS_INDEX_COLLECTOR_VERSION;
  };
}

export interface SourceCollectionReport {
  readonly sourceId: string;
  readonly publisher: string;
  readonly format: NewsIndexFormat;
  readonly indexUrl: string;
  readonly discoveryUrl: string;
  readonly robotsUrl: string;
  readonly rightsBasis: NewsSourceRightsBasis;
  readonly termsUrl: string;
  readonly rightsReviewedOn: string;
  readonly rightsReviewExpiresOn: string;
  readonly authorizationEvidenceSha256?: string;
  readonly status: 'FETCHED' | 'STALE' | 'FAILED';
  readonly errorCode?: NewsIndexFetchErrorCode | 'INVALID_XML';
  readonly finalUrl?: string;
  readonly retrievedAt?: string;
  readonly responseBytes?: number;
  readonly responseSha256?: string;
  readonly lastModified?: string;
  readonly freshestPublishedAt?: string;
  readonly recordsDiscovered: number;
  readonly recordsInvalid: number;
  readonly recordsRestricted: number;
  readonly recordsWithoutMentions: number;
  readonly recordsWithMentions: number;
  readonly recordsSkippedAsStale: number;
  readonly restrictedReasonCounts: Readonly<Record<RestrictedHeadlineReason, number>>;
}

export interface NewsIndexCollection {
  readonly articles: readonly NormalizedNewsArticleArtifactRecord[];
  readonly sources: readonly SourceCollectionReport[];
}

export type NewsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type NewsIndexFetchErrorCode =
  | 'BYTE_LIMIT'
  | 'CONTENT_TYPE'
  | 'HTTP_STATUS'
  | 'INVALID_REDIRECT'
  | 'REDIRECT_LIMIT'
  | 'TIMEOUT'
  | 'UNTRUSTED_URL';

export class NewsIndexFetchError extends Error {
  public constructor(
    public readonly code: NewsIndexFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NewsIndexFetchError';
  }
}

export interface FetchXmlIndexOptions {
  readonly fetchImpl?: NewsFetch;
  readonly now?: () => Date;
  readonly beforeRequest?: (url: URL, minimumIntervalMs: number) => Promise<void>;
}

export interface FetchXmlIndexResult {
  readonly status: 'FETCHED';
  readonly xml: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly lastModified?: string;
}

export interface CollectUruguayanNewsOptions {
  readonly sources: readonly AuthorizedNewsIndexSource[];
  readonly professionalNames: readonly string[];
  readonly fetchImpl?: NewsFetch;
  readonly now?: () => Date;
  readonly clockMilliseconds?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface TokenSpan {
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}

interface MentionSpan {
  readonly normalized: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface ProfessionalNamesArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly records: number;
  readonly names: readonly string[];
}

interface NewsIndexManifest {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly collectorVersion: typeof NEWS_INDEX_COLLECTOR_VERSION;
  readonly headlinePolicyVersion: typeof NEWS_HEADLINE_POLICY_VERSION;
  readonly sourceRightsPolicyVersion: typeof NEWS_SOURCE_RIGHTS_POLICY_VERSION;
  readonly generatedAt: string;
  readonly inputs: {
    readonly professionals: {
      readonly relativePath: string;
      readonly sha256: string;
      readonly records: number;
      readonly distinctNames: number;
    };
  };
  readonly sources: readonly SourceCollectionReport[];
  readonly sourcePolicy: {
    readonly authorizationGatedSourcesOmitted: readonly string[];
  };
  readonly outputs: {
    readonly articles: {
      readonly relativePath: string;
      readonly sha256: string;
      readonly records: number;
      readonly schemaVersion: 1;
    };
  };
  readonly aggregates: {
    readonly sourcesConfigured: number;
    readonly sourcesFetched: number;
    readonly sourcesFailed: number;
    readonly sourcesStale: number;
    readonly recordsDiscovered: number;
    readonly recordsRestricted: number;
    readonly recordsSkippedAsStale: number;
    readonly recordsEmitted: number;
  };
  readonly collectionWindow: {
    readonly maxArticleAgeDays: typeof NEWS_ITEM_MAX_AGE_DAYS;
  };
  readonly safeguards: {
    readonly articleBodiesFetched: false;
    readonly articleDescriptionsPersisted: false;
    readonly articlePagesFetched: false;
    readonly automaticIdentityConfirmation: false;
    readonly publicExportAllowed: false;
    readonly professionalIdsPersisted: false;
    readonly restrictedItemDetailsPersisted: false;
    readonly searchEnginesUsed: false;
    readonly sourceIndexesOnly: true;
  };
  readonly retention: {
    readonly articlesTtlDays: 90;
    readonly expiresAt: string;
    readonly sourceRightsExpiresAt: string;
    readonly boundedBySourceRightsExpiry: boolean;
    readonly disposition: 'DELETE_ARTICLES_AND_DERIVED_NAME_LINKAGE';
  };
}

export interface RunUruguayanNewsIndexIngestionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly dataDirectory?: string;
  readonly professionalsPath?: string;
  readonly outputDirectory?: string;
  readonly sources?: readonly NewsIndexSource[];
  readonly fetchImpl?: NewsFetch;
  readonly now?: () => Date;
  readonly clockMilliseconds?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RunUruguayanNewsIndexIngestionResult {
  readonly artifactId: string;
  readonly outputDirectory: string;
  readonly articlesPath: string;
  readonly manifestPath: string;
  readonly articles: number;
  readonly restricted: number;
  readonly staleItems: number;
  readonly staleSources: number;
  readonly failedSources: number;
  readonly authorizationGatedSourcesOmitted: readonly string[];
}

const ADVERSE_STEMS = [
  'absolv',
  'abus',
  'archiv',
  'arrest',
  'acus',
  'caso',
  'conden',
  'culp',
  'delit',
  'demand',
  'denunci',
  'deten',
  'estafa',
  'fallec',
  'fallo',
  'fiscal',
  'formaliz',
  'homicid',
  'indemn',
  'inhabil',
  'imput',
  'investig',
  'juicio',
  'lesion',
  'mato',
  'muerte',
  'muri',
  'neglig',
  'procesad',
  'prision',
  'querell',
  'responsab',
  'sancion',
  'sentenc',
  'sobrese',
  'sumari',
  'suspend',
  'tribunal',
] as const;

const ADVERSE_PHRASES = ['mala praxis', 'error medico', 'juicio penal'] as const;
const MINOR_STEMS = ['adolesc', 'bebe', 'menor', 'nina', 'nino', 'pediatr'] as const;
const MINOR_PHRASES = ['recien nacido', 'recien nacida'] as const;
const PRIVATE_HEALTH_STEMS = [
  'abort',
  'atendi',
  'cancer',
  'cirugi',
  'consult',
  'diagnostic',
  'dialisis',
  'enfermed',
  'embaraz',
  'fertil',
  'gasa',
  'hospitaliz',
  'infect',
  'internad',
  'medicacion',
  'medicament',
  'mutualista',
  'oncolog',
  'operacion',
  'operad',
  'opero',
  'paciente',
  'padec',
  'parto',
  'procedimiento',
  'reproduccion',
  'sanatorio',
  'sida',
  'sintom',
  'terapia',
  'trat',
  'transplant',
  'tratamiento',
  'tumor',
  'vih',
  'sufr',
] as const;
const PRIVATE_HEALTH_PHRASES = [
  'clinica privada',
  'estado de salud',
  'historia clinica',
  'salud mental',
] as const;
const DISTINCTIVE_PROFESSIONAL_ROLE_PATTERN = String.raw`(?:anestesiolog[oa]|anestesista|cardiolog[oa]|cirujan[oa]|dermatolog[oa]|endocrinolog[oa]|fisiatra|gastroenterolog[oa]|geriatra|ginecolog[oa]|hematolog[oa]|infectolog[oa]|internista|nefrolog[oa]|neumolog[oa]|neurolog[oa]|oftalmolog[oa]|oncolog[oa]|otorrinolaringolog[oa]|psiquiatra|reumatolog[oa]|traumatolog[oa]|urolog[oa])`;
const PROFESSIONAL_PREFIX_PATTERN = String.raw`(?:(?:dr|dra|doctor|doctora)|${DISTINCTIVE_PROFESSIONAL_ROLE_PATTERN})`;
const PROFESSIONAL_SUBJECT_PATTERN = String.raw`(?:(?:el|la) )?(?:${PROFESSIONAL_PREFIX_PATTERN} )?professional(?: y (?:(?:el|la) )?(?:${PROFESSIONAL_PREFIX_PATTERN} )?professional){0,3}`;
const CLOSED_BENIGN_HEADLINE_PATTERNS = [
  new RegExp(
    String.raw`^${PROFESSIONAL_SUBJECT_PATTERN} (?:recibio|recibieron|obtuvo|obtuvieron|gano|ganaron) (?:un|el) (?:premio|reconocimiento)(?: (?:academico|academica|cientifico|cientifica|institucional|nacional|internacional))?$`,
    'u',
  ),
  new RegExp(
    String.raw`^${PROFESSIONAL_SUBJECT_PATTERN} (?:asumio|asumieron) (?:un|el) cargo (?:academico|academica|docente|institucional)$`,
    'u',
  ),
  new RegExp(
    String.raw`^${PROFESSIONAL_SUBJECT_PATTERN} (?:presento|presentaron) (?:un|el) proyecto (?:academico|academica|cientifico|cientifica|universitario|universitaria|institucional)(?: vigente)?$`,
    'u',
  ),
  new RegExp(
    String.raw`^${PROFESSIONAL_SUBJECT_PATTERN} (?:participo|participaron) en (?:un|el) (?:congreso|seminario|evento academico|evento cientifico|jornada academica|jornada cientifica)$`,
    'u',
  ),
  new RegExp(
    String.raw`^${PROFESSIONAL_SUBJECT_PATTERN} (?:fue|fueron) (?:designado|designada|designados|designadas|nombrado|nombrada|nombrados|nombradas|reconocido|reconocida|reconocidos|reconocidas) (?:en|para) (?:un|el) cargo (?:academico|academica|docente|institucional)$`,
    'u',
  ),
] as const;

const HONORIFIC_NAME_PATTERN =
  /\b(?:[Dd]r(?:a)?|[Dd]octor(?:a)?)\.?\s+((?:\p{Lu}\.|(?:\p{Lu}[\p{L}\p{M}'’.-]{1,}))(?:\s+(?:(?:de|del|la|las|los|y)\s+)?(?:\p{Lu}\.|(?:\p{Lu}[\p{L}\p{M}'’.-]{1,}))){1,4})/gu;

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function resolveAuthorizedNewsIndexSources(
  sources: readonly NewsIndexSource[],
  environment: NodeJS.ProcessEnv,
  evaluatedAt: string,
): {
  readonly sources: readonly AuthorizedNewsIndexSource[];
  readonly authorizationGatedSourcesOmitted: readonly string[];
} {
  const evaluatedDate = new Date(evaluatedAt);
  if (Number.isNaN(evaluatedDate.valueOf()) || evaluatedDate.toISOString() !== evaluatedAt) {
    throw new Error('News source rights evaluation time must be a canonical ISO instant');
  }
  const evaluatedOn = evaluatedAt.slice(0, 10);
  const enabled: AuthorizedNewsIndexSource[] = [];
  const omitted: string[] = [];

  for (const source of sources) {
    const isCatalogSource = URUGUAYAN_NEWS_INDEX_SOURCES.some(
      (catalogSource) => catalogSource === source,
    );
    const isTestFixture =
      source.rightsBasis === 'TEST_FIXTURE' && environment['NODE_ENV'] === 'test';
    if (!isCatalogSource && !isTestFixture) {
      throw new Error(`Source ${source.id} is not part of the production catalog`);
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(source.rightsReviewedOn) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(source.rightsReviewExpiresOn) ||
      Number.isNaN(Date.parse(`${source.rightsReviewedOn}T00:00:00.000Z`)) ||
      Number.isNaN(Date.parse(`${source.rightsReviewExpiresOn}T00:00:00.000Z`))
    ) {
      throw new Error(`Source ${source.id} has invalid rights review dates`);
    }
    const termsUrl = new URL(source.termsUrl);
    if (
      termsUrl.protocol !== 'https:' ||
      termsUrl.username.length > 0 ||
      termsUrl.password.length > 0
    ) {
      throw new Error(`Source ${source.id} has an invalid HTTPS terms URL`);
    }

    let authorizationEvidenceSha256: string | undefined;
    if (source.rightsBasis === 'WRITTEN_AUTHORIZATION_REQUIRED') {
      const enableVariable = source.enableEnvironmentVariable;
      const referenceVariable = source.authorizationReferenceEnvironmentVariable;
      const allowlistVariable = source.authorizationAllowlistEnvironmentVariable;
      if (
        enableVariable === undefined ||
        referenceVariable === undefined ||
        allowlistVariable === undefined
      ) {
        throw new Error(`Source ${source.id} is missing its written-authorization gate`);
      }
      const enabledValue = environment[enableVariable]?.trim();
      if (
        enabledValue === undefined ||
        enabledValue.length === 0 ||
        enabledValue.toLowerCase() === 'false'
      ) {
        omitted.push(source.id);
        continue;
      }
      if (enabledValue.toLowerCase() !== 'true') {
        throw new Error(`${enableVariable} must be exactly true or false`);
      }
      const authorizationReference = environment[referenceVariable]?.trim();
      if (authorizationReference === undefined || authorizationReference.length < 8) {
        throw new Error(
          `${referenceVariable} must identify the current written authorization for ${source.id}`,
        );
      }
      authorizationEvidenceSha256 = sha256(authorizationReference);
      const approvedHashes = (environment[allowlistVariable] ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (
        approvedHashes.length === 0 ||
        approvedHashes.some((value) => !/^[0-9a-f]{64}$/u.test(value)) ||
        !approvedHashes.includes(authorizationEvidenceSha256)
      ) {
        throw new Error(
          `${allowlistVariable} must contain the SHA-256 of the approved written authorization`,
        );
      }
    } else if (
      source.enableEnvironmentVariable !== undefined ||
      source.authorizationReferenceEnvironmentVariable !== undefined ||
      source.authorizationAllowlistEnvironmentVariable !== undefined
    ) {
      throw new Error(`Source ${source.id} has an authorization gate inconsistent with its basis`);
    }

    if (source.rightsReviewedOn > evaluatedOn) {
      throw new Error(`Source ${source.id} rights review is dated in the future`);
    }
    if (source.rightsReviewExpiresOn < evaluatedOn) {
      throw new Error(
        `Source ${source.id} rights review expired on ${source.rightsReviewExpiresOn}; review before fetching`,
      );
    }
    const authorizedSource = Object.freeze({
      ...source,
      allowedIndexHosts: Object.freeze([...source.allowedIndexHosts]),
      allowedArticleHosts: Object.freeze([...source.allowedArticleHosts]),
      ...(authorizationEvidenceSha256 === undefined ? {} : { authorizationEvidenceSha256 }),
    }) as AuthorizedNewsIndexSource;
    AUTHORIZED_NEWS_SOURCES.add(authorizedSource);
    enabled.push(authorizedSource);
  }

  if (enabled.length === 0) {
    throw new Error('No news source is enabled by the current rights policy');
  }
  return {
    sources: enabled,
    authorizationGatedSourcesOmitted: omitted.sort(),
  };
}

function normalizeForPolicy(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function hasStem(tokens: readonly string[], stems: readonly string[]): boolean {
  return tokens.some((token) => stems.some((stem) => token.startsWith(stem)));
}

function hasPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

function sensitiveHeadlineReasons(
  normalized: string,
  tokens: readonly string[],
): RestrictedHeadlineReason[] {
  const reasons: RestrictedHeadlineReason[] = [];
  if (
    hasStem(tokens, ADVERSE_STEMS) ||
    ADVERSE_PHRASES.some((phrase) => hasPhrase(normalized, phrase))
  ) {
    reasons.push('ADVERSE_OR_JUDICIAL');
  }
  if (
    hasStem(tokens, MINOR_STEMS) ||
    MINOR_PHRASES.some((phrase) => hasPhrase(normalized, phrase))
  ) {
    reasons.push('MINOR');
  }
  if (
    hasStem(tokens, PRIVATE_HEALTH_STEMS) ||
    PRIVATE_HEALTH_PHRASES.some((phrase) => hasPhrase(normalized, phrase))
  ) {
    reasons.push('PRIVATE_HEALTH');
  }
  return reasons;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function maskExtractedPersonNames(
  normalizedHeadline: string,
  extractedPersonNames: readonly string[],
): string {
  return [...extractedPersonNames]
    .map((name) => normalizePersonName(name).toLowerCase())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((masked, normalizedName) => {
      const namePattern = escapeRegularExpression(normalizedName).replace(/\s+/gu, String.raw`\s+`);
      return masked.replace(
        new RegExp(String.raw`(^| )${namePattern}(?= |$)`, 'gu'),
        '$1professional',
      );
    }, normalizedHeadline);
}

function isClosedBenignPublicHeadline(
  normalizedHeadline: string,
  extractedPersonNames: readonly string[],
): boolean {
  if (extractedPersonNames.length === 0) {
    return false;
  }
  const maskedHeadline = maskExtractedPersonNames(normalizedHeadline, extractedPersonNames);
  const maskedProfessionals = maskedHeadline.match(/\bprofessional\b/gu)?.length ?? 0;
  if (maskedProfessionals !== extractedPersonNames.length) {
    return false;
  }
  return CLOSED_BENIGN_HEADLINE_PATTERNS.some((pattern) => pattern.test(maskedHeadline));
}

/**
 * This check is fail-closed. The collector first applies the sensitive lexical
 * gates, then performs an in-memory name extraction and calls this function
 * again with those exact names. Only a complete, closed benign template may be
 * persisted; all other items contribute aggregate counters only.
 */
export function classifyHeadline(
  headline: string,
  extractedPersonNames: readonly string[] = [],
): HeadlinePolicyDecision {
  const normalized = normalizeForPolicy(headline);
  const tokens = normalized.split(' ').filter(Boolean);
  const reasons = sensitiveHeadlineReasons(normalized, tokens);
  if (reasons.length === 0 && !isClosedBenignPublicHeadline(normalized, extractedPersonNames)) {
    reasons.push('NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT');
  }

  return {
    restricted: reasons.length > 0,
    reasons,
  };
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokenizeWithSpans(value: string): readonly TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0];
    const start = match.index;
    const normalized = normalizeToken(raw);
    if (normalized.length === 0) {
      continue;
    }
    spans.push({
      normalized,
      start,
      end: start + raw.length,
    });
  }
  return spans;
}

function isUsableNameToken(token: string): boolean {
  return token.length >= 2 && !/^\d+$/u.test(token);
}

export function createProfessionalNameIndex(
  professionalNames: readonly string[],
): ProfessionalNameIndex {
  const entriesByNormalizedName = new Map<string, ProfessionalNameEntry>();

  for (const name of professionalNames) {
    const normalizedName = normalizePersonName(name);
    const tokens = normalizedName.split(' ').filter(Boolean);
    if (
      tokens.length < 2 ||
      tokens.length > 10 ||
      tokens.some((token) => !isUsableNameToken(token))
    ) {
      continue;
    }
    entriesByNormalizedName.set(normalizedName, {
      normalizedName,
      tokens,
    });
  }

  const entriesByFirstToken = new Map<string, ProfessionalNameEntry[]>();
  const entriesByFirstInitial = new Map<string, ProfessionalNameEntry[]>();
  const aliasOwners = new Map<string, Set<string>>();
  for (const entry of entriesByNormalizedName.values()) {
    const firstToken = entry.tokens[0];
    if (firstToken === undefined) {
      continue;
    }
    const existing = entriesByFirstToken.get(firstToken) ?? [];
    existing.push(entry);
    entriesByFirstToken.set(firstToken, existing);
    const firstInitial = firstToken.slice(0, 1);
    const existingInitialEntries = entriesByFirstInitial.get(firstInitial) ?? [];
    existingInitialEntries.push(entry);
    entriesByFirstInitial.set(firstInitial, existingInitialEntries);

    if (entry.tokens.length >= 3) {
      for (const laterToken of entry.tokens.slice(1)) {
        const alias = `${firstToken} ${laterToken}`;
        const owners = aliasOwners.get(alias) ?? new Set<string>();
        owners.add(entry.normalizedName);
        aliasOwners.set(alias, owners);
      }
    }
  }

  for (const entries of entriesByFirstToken.values()) {
    entries.sort(
      (left, right) =>
        right.tokens.length - left.tokens.length ||
        left.normalizedName.localeCompare(right.normalizedName),
    );
  }
  for (const entries of entriesByFirstInitial.values()) {
    entries.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
  }

  const uniqueAliases = new Set(
    [...aliasOwners.entries()].filter(([, owners]) => owners.size === 1).map(([alias]) => alias),
  );

  return {
    distinctNames: entriesByNormalizedName.size,
    exactNames: new Set(entriesByNormalizedName.keys()),
    entriesByFirstToken,
    entriesByFirstInitial,
    uniqueAliases,
  };
}

function tokenSequenceMatches(
  headlineTokens: readonly TokenSpan[],
  start: number,
  nameTokens: readonly string[],
): boolean {
  if (start + nameTokens.length > headlineTokens.length) {
    return false;
  }
  return nameTokens.every((token, offset) => headlineTokens[start + offset]?.normalized === token);
}

function spansOverlap(left: MentionSpan, right: MentionSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function addMention(
  mentions: Map<string, MentionSpan>,
  headline: string,
  tokens: readonly TokenSpan[],
  startTokenIndex: number,
  tokenLength: number,
): MentionSpan | undefined {
  const first = tokens[startTokenIndex];
  const last = tokens[startTokenIndex + tokenLength - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const value = headline.slice(first.start, last.end).trim();
  const normalized = normalizePersonName(value);
  if (normalized.split(' ').filter(Boolean).length < 2) {
    return undefined;
  }
  const mention = {
    normalized,
    value,
    start: first.start,
    end: last.end,
  };
  const existing = mentions.get(normalized);
  if (existing === undefined || mention.start < existing.start) {
    mentions.set(normalized, mention);
  }
  return mention;
}

function matchingRegistryEntries(
  index: ProfessionalNameIndex,
  candidateTokens: readonly string[],
): readonly ProfessionalNameEntry[] {
  const first = candidateTokens[0];
  if (first === undefined) {
    return [];
  }
  const entries =
    first.length === 1
      ? (index.entriesByFirstInitial.get(first) ?? [])
      : (index.entriesByFirstToken.get(first) ?? []);
  const candidateName = candidateTokens.join(' ');
  return entries.filter(
    (entry) => evaluateFlexiblePersonName(entry.normalizedName, candidateName) !== null,
  );
}

function registryContainsTokenSubset(
  index: ProfessionalNameIndex,
  candidateTokens: readonly string[],
): boolean {
  const matches = matchingRegistryEntries(index, candidateTokens);
  return (
    matches.length > 0 &&
    (candidateTokens[0]?.length !== 1 || matches.length <= INITIALS_EXTRACTION_FANOUT_LIMIT)
  );
}

function extractHonorificMentions(
  headline: string,
  index: ProfessionalNameIndex,
): readonly MentionSpan[] {
  const mentions: MentionSpan[] = [];
  for (const match of headline.matchAll(HONORIFIC_NAME_PATTERN)) {
    const capturedName = match[1];
    if (capturedName === undefined) {
      continue;
    }
    const capturedTokens = tokenizeWithSpans(capturedName);
    if (capturedTokens.length < 2) {
      continue;
    }

    let selectedLength: number | undefined;
    for (let length = capturedTokens.length; length >= 2; length -= 1) {
      const candidateTokens = capturedTokens.slice(0, length).map(({ normalized }) => normalized);
      if (registryContainsTokenSubset(index, candidateTokens)) {
        selectedLength = length;
        break;
      }
    }

    if (selectedLength === undefined) {
      continue;
    }
    const selectedLastToken = capturedTokens[selectedLength - 1];
    if (selectedLastToken === undefined) {
      continue;
    }
    const relativeCaptureStart = match[0].lastIndexOf(capturedName);
    const start = match.index + relativeCaptureStart;
    const end = start + selectedLastToken.end;
    const value = headline.slice(start, end).trim();
    const normalized = normalizePersonName(value);
    if (normalized.split(' ').filter(Boolean).length < 2) {
      continue;
    }
    mentions.push({
      normalized,
      value,
      start,
      end,
    });
  }
  return mentions;
}

/**
 * Extracts only deterministic headline mentions:
 * - a complete MSP name appearing as a contiguous token sequence;
 * - a two-token alias unique among distinct MSP names;
 * - an MSP-compatible subset anchored by Dr./Dra./Doctor/Doctora.
 *
 * It never returns a professional identifier. The downstream matcher still
 * treats every name-only result as an unconfirmed, human-review candidate.
 */
export function extractHeadlinePersonNames(
  headline: string,
  index: ProfessionalNameIndex,
): readonly string[] {
  const headlineTokens = tokenizeWithSpans(headline);
  const mentions = new Map<string, MentionSpan>();
  const exactSpans: MentionSpan[] = [];

  for (const [startIndex, headlineToken] of headlineTokens.entries()) {
    const candidates = index.entriesByFirstToken.get(headlineToken.normalized) ?? [];
    const matches = candidates.filter((entry) =>
      tokenSequenceMatches(headlineTokens, startIndex, entry.tokens),
    );
    const longestMatch = matches[0];
    if (longestMatch === undefined) {
      continue;
    }
    const longestLength = longestMatch.tokens.length;
    for (const entry of matches.filter(({ tokens }) => tokens.length === longestLength)) {
      const mention = addMention(
        mentions,
        headline,
        headlineTokens,
        startIndex,
        entry.tokens.length,
      );
      if (mention !== undefined) {
        exactSpans.push(mention);
      }
    }
  }

  for (let indexPosition = 0; indexPosition < headlineTokens.length - 1; indexPosition += 1) {
    const first = headlineTokens[indexPosition];
    const second = headlineTokens[indexPosition + 1];
    if (first === undefined || second === undefined) {
      continue;
    }
    const alias = `${first.normalized} ${second.normalized}`;
    if (!index.uniqueAliases.has(alias)) {
      continue;
    }
    const aliasSpan: MentionSpan = {
      normalized: alias,
      value: headline.slice(first.start, second.end),
      start: first.start,
      end: second.end,
    };
    if (exactSpans.some((exactSpan) => spansOverlap(aliasSpan, exactSpan))) {
      continue;
    }
    addMention(mentions, headline, headlineTokens, indexPosition, 2);
  }

  for (let indexPosition = 0; indexPosition < headlineTokens.length - 1; indexPosition += 1) {
    const first = headlineTokens[indexPosition];
    const second = headlineTokens[indexPosition + 1];
    if (
      first?.normalized.length !== 1 ||
      second === undefined ||
      headline.slice(first.end, second.start).includes('.') === false
    ) {
      continue;
    }
    const maximumLength = Math.min(5, headlineTokens.length - indexPosition);
    for (let length = maximumLength; length >= 2; length -= 1) {
      const candidateSpans = headlineTokens.slice(indexPosition, indexPosition + length);
      const candidateTokens = candidateSpans.map(({ normalized }) => normalized);
      const lastToken = candidateTokens.at(-1);
      if (
        lastToken === undefined ||
        lastToken.length < 2 ||
        !candidateTokens.some((token) => token.length === 1)
      ) {
        continue;
      }
      const matchingEntries = matchingRegistryEntries(index, candidateTokens);
      if (
        matchingEntries.length === 0 ||
        matchingEntries.length > INITIALS_EXTRACTION_FANOUT_LIMIT
      ) {
        continue;
      }
      addMention(mentions, headline, headlineTokens, indexPosition, length);
      break;
    }
  }

  for (const honorificMention of extractHonorificMentions(headline, index)) {
    const existing = mentions.get(honorificMention.normalized);
    if (existing === undefined || honorificMention.start < existing.start) {
      mentions.set(honorificMention.normalized, honorificMention);
    }
  }

  return [...mentions.values()]
    .sort(
      (left, right) => left.start - right.start || left.normalized.localeCompare(right.normalized),
    )
    .map(({ value }) => value);
}

function validateTrustedUrl(
  rawUrl: string | URL,
  allowedHosts: readonly string[],
  context: string,
): URL {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  } catch {
    throw new NewsIndexFetchError('UNTRUSTED_URL', `${context} is not a valid URL`);
  }
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== '443') ||
    !allowed.has(url.hostname.toLowerCase())
  ) {
    throw new NewsIndexFetchError('UNTRUSTED_URL', `${context} is outside the HTTPS allowlist`);
  }
  return url;
}

function isXmlContentType(contentType: string | null): boolean {
  if (contentType === null || contentType.trim().length === 0) {
    return true;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    mediaType === 'application/atom+xml' ||
    mediaType === 'application/rss+xml' ||
    mediaType === 'application/xml' ||
    mediaType === 'text/xml'
  );
}

async function readLimitedResponseBody(
  response: Response,
  maxResponseBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxResponseBytes) {
      throw new NewsIndexFetchError('BYTE_LIMIT', 'Index response exceeds the byte limit');
    }
  }

  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (result.done) {
      break;
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel();
      throw new NewsIndexFetchError('BYTE_LIMIT', 'Index response exceeds the byte limit');
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function optionalHeader(headers: Headers, name: string): Readonly<Record<string, string>> {
  const value = headers.get(name);
  return value === null || value.trim().length === 0 ? {} : { [name]: value };
}

export async function fetchXmlIndex(
  source: AuthorizedNewsIndexSource,
  options: FetchXmlIndexOptions = {},
): Promise<FetchXmlIndexResult> {
  if (!AUTHORIZED_NEWS_SOURCES.has(source)) {
    throw new Error(`Source ${source.id} has not passed the rights authorization resolver`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  let currentUrl = validateTrustedUrl(
    source.indexUrl,
    source.allowedIndexHosts,
    `${source.id} index URL`,
  );

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await options.beforeRequest?.(currentUrl, source.minimumRequestIntervalMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, source.timeoutMs);
    try {
      const headers = new Headers({
        accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
        'user-agent': 'MedicosUYPublicIndexCollector/1.0 (public index metadata only)',
      });

      const response = await fetchImpl(currentUrl, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      const retrievedAt = now().toISOString();
      const responseHeaders = {
        ...optionalHeader(response.headers, 'last-modified'),
      };

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location === null) {
          throw new NewsIndexFetchError(
            'INVALID_REDIRECT',
            `${source.id} redirect omitted Location`,
          );
        }
        if (redirectCount === MAX_REDIRECTS) {
          throw new NewsIndexFetchError(
            'REDIRECT_LIMIT',
            `${source.id} exceeded the redirect limit`,
          );
        }
        currentUrl = validateTrustedUrl(
          new URL(location, currentUrl),
          source.allowedIndexHosts,
          `${source.id} redirect`,
        );
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new NewsIndexFetchError(
          'HTTP_STATUS',
          `${source.id} returned HTTP ${String(response.status)}`,
        );
      }
      if (!isXmlContentType(response.headers.get('content-type'))) {
        await response.body?.cancel();
        throw new NewsIndexFetchError(
          'CONTENT_TYPE',
          `${source.id} did not return an XML media type`,
        );
      }

      const body = await readLimitedResponseBody(response, source.maxResponseBytes);
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(body);
      return {
        status: 'FETCHED',
        xml,
        finalUrl: currentUrl.toString(),
        retrievedAt,
        bytes: body.byteLength,
        sha256: sha256(body),
        ...(responseHeaders['last-modified'] === undefined
          ? {}
          : { lastModified: responseHeaders['last-modified'] }),
      };
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new NewsIndexFetchError('TIMEOUT', `${source.id} request timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new NewsIndexFetchError('REDIRECT_LIMIT', `${source.id} exceeded the redirect limit`);
}

function canonicalArticleUrl(rawUrl: string, source: NewsIndexSource): string | undefined {
  let url: URL;
  try {
    url = validateTrustedUrl(rawUrl, source.allowedArticleHosts, `${source.id} article URL`);
  } catch {
    return undefined;
  }
  url.hash = '';
  if (url.port === '443') {
    url.port = '';
  }
  return url.toString();
}

function canonicalPublicationDate(rawDate: string): string | undefined {
  const parsed = new Date(rawDate.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function textFromFirst(
  readText: (selector: string) => string,
  selectors: readonly string[],
): string {
  for (const selector of selectors) {
    const value = readText(selector).trim().replace(/\s+/gu, ' ');
    if (value.length > 0) {
      return value;
    }
  }
  return '';
}

export function parseNewsIndexDocument(source: NewsIndexSource, xml: string): ParsedNewsIndex {
  const $ = load(xml, { xml: true });
  const itemSelector =
    source.format === 'GOOGLE_NEWS_SITEMAP' ? 'urlset > url' : 'rss channel item';
  const rootSelector = source.format === 'GOOGLE_NEWS_SITEMAP' ? 'urlset' : 'rss';
  if ($(rootSelector).length === 0) {
    throw new Error(`${source.id} XML has an unexpected root element`);
  }

  const itemsByUrl = new Map<string, ParsedNewsIndexItem>();
  let invalidItems = 0;
  $(itemSelector).each((_index, element) => {
    const item = $(element);
    const headline =
      source.format === 'GOOGLE_NEWS_SITEMAP'
        ? textFromFirst((selector) => item.find(selector).first().text(), ['news\\:title'])
        : textFromFirst((selector) => item.find(selector).first().text(), ['title']);
    const rawUrl = textFromFirst((selector) => item.find(selector).first().text(), ['loc', 'link']);
    const rawDate =
      source.format === 'GOOGLE_NEWS_SITEMAP'
        ? textFromFirst(
            (selector) => item.find(selector).first().text(),
            ['news\\:publication_date', 'lastmod'],
          )
        : textFromFirst((selector) => item.find(selector).first().text(), ['pubDate', 'dc\\:date']);
    const canonicalUrl = canonicalArticleUrl(rawUrl, source);
    const publishedAt = canonicalPublicationDate(rawDate);
    if (
      headline.length === 0 ||
      headline.length > MAX_HEADLINE_LENGTH ||
      canonicalUrl === undefined ||
      publishedAt === undefined
    ) {
      invalidItems += 1;
      return;
    }
    itemsByUrl.set(canonicalUrl, {
      headline,
      canonicalUrl,
      publishedAt,
    });
  });

  return {
    items: [...itemsByUrl.values()],
    invalidItems,
  };
}

class HostRequestPacer {
  readonly #lastRequestAt = new Map<string, number>();

  public constructor(
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly clockMilliseconds: () => number,
  ) {}

  public async beforeRequest(url: URL, minimumIntervalMs: number): Promise<void> {
    const host = url.hostname.toLowerCase();
    const previous = this.#lastRequestAt.get(host);
    const current = this.clockMilliseconds();
    if (previous !== undefined) {
      const remaining = minimumIntervalMs - (current - previous);
      if (remaining > 0) {
        await this.sleep(remaining);
      }
    }
    this.#lastRequestAt.set(host, this.clockMilliseconds());
  }
}

function emptyRestrictedReasonCounts(): Record<RestrictedHeadlineReason, number> {
  return {
    ADVERSE_OR_JUDICIAL: 0,
    MINOR: 0,
    PRIVATE_HEALTH: 0,
    NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT: 0,
  };
}

function sourceReportBase(
  source: NewsIndexSource,
): Pick<
  SourceCollectionReport,
  | 'sourceId'
  | 'publisher'
  | 'format'
  | 'indexUrl'
  | 'discoveryUrl'
  | 'robotsUrl'
  | 'rightsBasis'
  | 'termsUrl'
  | 'rightsReviewedOn'
  | 'rightsReviewExpiresOn'
  | 'authorizationEvidenceSha256'
> {
  return {
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
    ...(source.authorizationEvidenceSha256 === undefined
      ? {}
      : { authorizationEvidenceSha256: source.authorizationEvidenceSha256 }),
  };
}

function contentSha256(item: ParsedNewsIndexItem): string {
  return sha256([item.headline, item.canonicalUrl, item.publishedAt].join('\u0000'));
}

function articleId(source: NewsIndexSource, canonicalUrl: string): string {
  return `${source.publisherKey}:${sha256(canonicalUrl).slice(0, 40)}`;
}

function latestPublishedAt(items: readonly ParsedNewsIndexItem[]): string | undefined {
  return items.reduce<string | undefined>(
    (latest, item) =>
      latest === undefined || item.publishedAt > latest ? item.publishedAt : latest,
    undefined,
  );
}

function mergeArticle(
  existing: NormalizedNewsArticleArtifactRecord,
  incoming: NormalizedNewsArticleArtifactRecord,
): NormalizedNewsArticleArtifactRecord {
  const names = new Map<string, string>();
  for (const name of [...existing.extractedPersonNames, ...incoming.extractedPersonNames]) {
    names.set(normalizePersonName(name), name);
  }
  return {
    ...existing,
    extractedPersonNames: [...names.values()].sort((left, right) =>
      normalizePersonName(left).localeCompare(normalizePersonName(right)),
    ),
  };
}

function fetchErrorCode(error: unknown): NewsIndexFetchErrorCode | 'INVALID_XML' {
  return error instanceof NewsIndexFetchError ? error.code : 'INVALID_XML';
}

export async function collectUruguayanNewsIndexes(
  options: CollectUruguayanNewsOptions,
): Promise<NewsIndexCollection> {
  const sources = options.sources;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    (async (milliseconds: number) => {
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
      });
    });
  const pacer = new HostRequestPacer(sleep, options.clockMilliseconds ?? Date.now);
  const nameIndex = createProfessionalNameIndex(options.professionalNames);
  const reports: SourceCollectionReport[] = [];
  const articlesByUrl = new Map<string, NormalizedNewsArticleArtifactRecord>();
  const restrictedUrls = new Set<string>();

  for (const source of sources) {
    let fetched: FetchXmlIndexResult;
    try {
      fetched = await fetchXmlIndex(source, {
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        now,
        beforeRequest: async (url, minimumIntervalMs) => {
          await pacer.beforeRequest(url, minimumIntervalMs);
        },
      });
    } catch (error: unknown) {
      reports.push({
        ...sourceReportBase(source),
        status: 'FAILED',
        errorCode: fetchErrorCode(error),
        recordsDiscovered: 0,
        recordsInvalid: 0,
        recordsRestricted: 0,
        recordsWithoutMentions: 0,
        recordsWithMentions: 0,
        recordsSkippedAsStale: 0,
        restrictedReasonCounts: emptyRestrictedReasonCounts(),
      });
      continue;
    }

    let parsed: ParsedNewsIndex;
    try {
      parsed = parseNewsIndexDocument(source, fetched.xml);
    } catch {
      reports.push({
        ...sourceReportBase(source),
        status: 'FAILED',
        errorCode: 'INVALID_XML',
        finalUrl: fetched.finalUrl,
        retrievedAt: fetched.retrievedAt,
        responseBytes: fetched.bytes,
        responseSha256: fetched.sha256,
        ...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
        recordsDiscovered: 0,
        recordsInvalid: 0,
        recordsRestricted: 0,
        recordsWithoutMentions: 0,
        recordsWithMentions: 0,
        recordsSkippedAsStale: 0,
        restrictedReasonCounts: emptyRestrictedReasonCounts(),
      });
      continue;
    }

    const freshestPublishedAt = latestPublishedAt(parsed.items);
    const evaluationTime = now().getTime();
    if (
      source.freshnessWindowMs !== undefined &&
      (freshestPublishedAt === undefined ||
        new Date(freshestPublishedAt).getTime() < evaluationTime - source.freshnessWindowMs)
    ) {
      reports.push({
        ...sourceReportBase(source),
        status: 'STALE',
        finalUrl: fetched.finalUrl,
        retrievedAt: fetched.retrievedAt,
        responseBytes: fetched.bytes,
        responseSha256: fetched.sha256,
        ...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
        ...(freshestPublishedAt === undefined ? {} : { freshestPublishedAt }),
        recordsDiscovered: parsed.items.length,
        recordsInvalid: parsed.invalidItems,
        recordsRestricted: 0,
        recordsWithoutMentions: 0,
        recordsWithMentions: 0,
        recordsSkippedAsStale: parsed.items.length,
        restrictedReasonCounts: emptyRestrictedReasonCounts(),
      });
      continue;
    }

    const restrictedReasonCounts = emptyRestrictedReasonCounts();
    let recordsRestricted = 0;
    let recordsWithoutMentions = 0;
    let recordsWithMentions = 0;
    let recordsInvalid = parsed.invalidItems;
    let recordsSkippedAsStale = 0;
    const retrievedAtMilliseconds = new Date(fetched.retrievedAt).getTime();

    for (const item of parsed.items) {
      const publishedAtMilliseconds = new Date(item.publishedAt).getTime();
      if (publishedAtMilliseconds > retrievedAtMilliseconds) {
        recordsInvalid += 1;
        continue;
      }
      if (publishedAtMilliseconds < retrievedAtMilliseconds - NEWS_ITEM_MAX_AGE_MS) {
        recordsSkippedAsStale += 1;
        continue;
      }

      const preliminaryPolicy = classifyHeadline(item.headline);
      if (
        preliminaryPolicy.reasons.some((reason) => reason !== 'NOT_CLEARLY_BENIGN_PUBLIC_CONTEXT')
      ) {
        recordsRestricted += 1;
        restrictedUrls.add(item.canonicalUrl);
        articlesByUrl.delete(item.canonicalUrl);
        for (const reason of preliminaryPolicy.reasons) {
          restrictedReasonCounts[reason] += 1;
        }
        continue;
      }
      if (restrictedUrls.has(item.canonicalUrl)) {
        recordsRestricted += 1;
        continue;
      }

      const extractedPersonNames = extractHeadlinePersonNames(item.headline, nameIndex);
      const policy = classifyHeadline(item.headline, extractedPersonNames);
      if (policy.restricted) {
        recordsRestricted += 1;
        restrictedUrls.add(item.canonicalUrl);
        articlesByUrl.delete(item.canonicalUrl);
        for (const reason of policy.reasons) {
          restrictedReasonCounts[reason] += 1;
        }
        continue;
      }
      if (extractedPersonNames.length === 0) {
        recordsWithoutMentions += 1;
        continue;
      }

      recordsWithMentions += 1;
      const record: NormalizedNewsArticleArtifactRecord = {
        schemaVersion: 1,
        articleId: articleId(source, item.canonicalUrl),
        headline: item.headline,
        extractedPersonNames,
        source: {
          sourceId: source.id,
          publisher: source.publisher,
          canonicalUrl: item.canonicalUrl,
          publishedAt: item.publishedAt,
          retrievedAt: fetched.retrievedAt,
          contentSha256: contentSha256(item),
        },
        extraction: {
          method: 'DETERMINISTIC_PARSER',
          extractedAt: fetched.retrievedAt,
          extractorVersion: NEWS_INDEX_COLLECTOR_VERSION,
        },
      };
      const existing = articlesByUrl.get(item.canonicalUrl);
      articlesByUrl.set(
        item.canonicalUrl,
        existing === undefined ? record : mergeArticle(existing, record),
      );
    }

    reports.push({
      ...sourceReportBase(source),
      status: 'FETCHED',
      finalUrl: fetched.finalUrl,
      retrievedAt: fetched.retrievedAt,
      responseBytes: fetched.bytes,
      responseSha256: fetched.sha256,
      ...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
      ...(freshestPublishedAt === undefined ? {} : { freshestPublishedAt }),
      recordsDiscovered: parsed.items.length,
      recordsInvalid,
      recordsRestricted,
      recordsWithoutMentions,
      recordsWithMentions,
      recordsSkippedAsStale,
      restrictedReasonCounts,
    });
  }

  return {
    articles: [...articlesByUrl.values()].sort(
      (left, right) =>
        left.source.publishedAt.localeCompare(right.source.publishedAt) ||
        left.articleId.localeCompare(right.articleId),
    ),
    sources: reports,
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseProfessionalNamesNdjson(content: Buffer): readonly string[] {
  const text = content.toString('utf8');
  if (text.startsWith('\uFEFF')) {
    throw new Error('Professional NDJSON must not contain a byte order mark');
  }
  const names: string[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      if (index !== lines.length - 1) {
        throw new Error(`Professional NDJSON has an empty row at ${String(index + 1)}`);
      }
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Professional NDJSON row ${String(index + 1)} is invalid JSON`);
    }
    if (!isObject(value)) {
      throw new Error(`Professional NDJSON row ${String(index + 1)} is not an object`);
    }
    const name =
      typeof value['fullName'] === 'string'
        ? value['fullName']
        : typeof value['displayName'] === 'string'
          ? value['displayName']
          : undefined;
    if (name === undefined || name.trim().length === 0) {
      throw new Error(`Professional NDJSON row ${String(index + 1)} has no name`);
    }
    names.push(name.trim());
  }
  if (names.length === 0) {
    throw new Error('Professional NDJSON is empty');
  }
  return names;
}

async function loadProfessionalNamesArtifact(path: string): Promise<ProfessionalNamesArtifact> {
  const content = await readFile(path);
  const names = parseProfessionalNamesNdjson(content);
  return {
    path,
    sha256: sha256(content),
    records: names.length,
    names,
  };
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length === 0 ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function portableRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join('/');
}

async function latestMspProfessionalsPath(dataDirectory: string): Promise<string> {
  const snapshotsRoot = join(dataDirectory, 'processed', 'msp', 'infotitulos');
  const entries = await readdir(snapshotsRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(snapshotsRoot, entry.name, 'professionals.ndjson');
        try {
          return {
            path,
            modifiedAt: (await stat(path)).mtimeMs,
          };
        } catch {
          return undefined;
        }
      }),
  );
  const latest = candidates
    .filter(
      (candidate): candidate is { readonly path: string; readonly modifiedAt: number } =>
        candidate !== undefined,
    )
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
  if (latest === undefined) {
    throw new Error(`No MSP professionals.ndjson found under ${snapshotsRoot}`);
  }
  return latest.path;
}

function articlesNdjson(records: readonly NormalizedNewsArticleArtifactRecord[]): string {
  return records.length === 0
    ? ''
    : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function sourceRightsExpiresAt(sources: readonly AuthorizedNewsIndexSource[]): string {
  const earliestExclusiveExpiry = sources
    .map(({ rightsReviewExpiresOn }) =>
      new Date(
        Date.parse(`${rightsReviewExpiresOn}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
      ).toISOString(),
    )
    .sort()
    .at(0);
  if (earliestExclusiveExpiry === undefined) {
    throw new Error('Cannot calculate rights expiration without an authorized source');
  }
  return earliestExclusiveExpiry;
}

async function installArtifactAtomically(
  outputDirectory: string,
  articlesContent: string,
  manifestContent: string,
): Promise<void> {
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const stagingDirectory = await mkdtemp(join(outputParent, '.news-index-stage-'));
  try {
    await Promise.all([
      writeFile(join(stagingDirectory, 'articles.ndjson'), articlesContent, {
        encoding: 'utf8',
        flag: 'wx',
      }),
      writeFile(join(stagingDirectory, 'manifest.json'), manifestContent, {
        encoding: 'utf8',
        flag: 'wx',
      }),
    ]);
    await rename(stagingDirectory, outputDirectory);
  } catch (error: unknown) {
    await rm(stagingDirectory, {
      recursive: true,
      force: true,
    });
    throw error;
  }
}

export async function runUruguayanNewsIndexIngestion(
  options: RunUruguayanNewsIndexIngestionOptions = {},
): Promise<RunUruguayanNewsIndexIngestionResult> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const rightsEvaluatedAt = now().toISOString();
  const dataDirectory = await realpath(
    resolve(options.dataDirectory ?? environment['DATA_INGESTION_DIR'] ?? 'data'),
  );
  const configuredProfessionalsPath =
    options.professionalsPath ?? environment['NEWS_PROFESSIONALS_PATH'];
  const professionalsPath = await realpath(
    configuredProfessionalsPath === undefined || configuredProfessionalsPath.trim().length === 0
      ? await latestMspProfessionalsPath(dataDirectory)
      : resolve(configuredProfessionalsPath),
  );
  if (!isInside(dataDirectory, professionalsPath)) {
    throw new Error('Professional input must be inside DATA_INGESTION_DIR');
  }
  const professionalArtifact = await loadProfessionalNamesArtifact(professionalsPath);
  const sourceResolution = resolveAuthorizedNewsIndexSources(
    options.sources ?? URUGUAYAN_NEWS_INDEX_SOURCES,
    environment,
    rightsEvaluatedAt,
  );
  const sources = sourceResolution.sources;
  const rightsExpiresAt = sourceRightsExpiresAt(sources);
  const collection = await collectUruguayanNewsIndexes({
    sources,
    professionalNames: professionalArtifact.names,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    now,
    ...(options.clockMilliseconds === undefined
      ? {}
      : { clockMilliseconds: options.clockMilliseconds }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  if (!collection.sources.some(({ status }) => status === 'FETCHED')) {
    throw new Error('No news source was fetched successfully; artifact installation aborted');
  }
  const generatedAt = now().toISOString();
  if (
    collection.sources.some(
      ({ retrievedAt }) => retrievedAt !== undefined && retrievedAt > generatedAt,
    )
  ) {
    throw new Error('News ingestion completion time predates a source retrieval');
  }
  const articleContent = articlesNdjson(collection.articles);
  const fingerprint = sha256(
    [
      NEWS_INDEX_COLLECTOR_VERSION,
      NEWS_HEADLINE_POLICY_VERSION,
      NEWS_SOURCE_RIGHTS_POLICY_VERSION,
      professionalArtifact.sha256,
      generatedAt,
      articleContent,
      JSON.stringify(
        collection.sources.map(
          ({
            sourceId,
            status,
            responseSha256,
            rightsBasis,
            rightsReviewExpiresOn,
            authorizationEvidenceSha256,
          }) => ({
            sourceId,
            status,
            rightsBasis,
            rightsReviewExpiresOn,
            ...(responseSha256 === undefined ? {} : { responseSha256 }),
            ...(authorizationEvidenceSha256 === undefined ? {} : { authorizationEvidenceSha256 }),
          }),
        ),
      ),
    ].join('\u0000'),
  ).slice(0, 16);
  const artifactId = `news-index-v1-${fingerprint}`;
  const configuredOutputDirectory = options.outputDirectory ?? environment['NEWS_INDEX_OUTPUT_DIR'];
  const outputDirectory = resolve(
    configuredOutputDirectory === undefined || configuredOutputDirectory.trim().length === 0
      ? join(dataDirectory, 'normalized', 'news', artifactId)
      : configuredOutputDirectory,
  );
  if (!isInside(dataDirectory, outputDirectory)) {
    throw new Error('News index output must be inside DATA_INGESTION_DIR');
  }
  const articlesPath = join(outputDirectory, 'articles.ndjson');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const sourceStatuses = collection.sources.map(({ status }) => status);
  const recordsRestricted = collection.sources.reduce(
    (total, source) => total + source.recordsRestricted,
    0,
  );
  const recordsSkippedAsStale = collection.sources.reduce(
    (total, source) => total + source.recordsSkippedAsStale,
    0,
  );
  const distinctNames = createProfessionalNameIndex(professionalArtifact.names).distinctNames;
  const ttlExpiresAt = new Date(
    new Date(generatedAt).getTime() + ARTICLE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const expiresAt = [ttlExpiresAt, rightsExpiresAt].sort().at(0);
  if (expiresAt === undefined) {
    throw new Error('Could not determine news article expiration');
  }
  const manifest: NewsIndexManifest = {
    schemaVersion: 1,
    artifactId,
    collectorVersion: NEWS_INDEX_COLLECTOR_VERSION,
    headlinePolicyVersion: NEWS_HEADLINE_POLICY_VERSION,
    sourceRightsPolicyVersion: NEWS_SOURCE_RIGHTS_POLICY_VERSION,
    generatedAt,
    inputs: {
      professionals: {
        relativePath: portableRelative(dataDirectory, professionalsPath),
        sha256: professionalArtifact.sha256,
        records: professionalArtifact.records,
        distinctNames,
      },
    },
    sources: collection.sources,
    sourcePolicy: {
      authorizationGatedSourcesOmitted: sourceResolution.authorizationGatedSourcesOmitted,
    },
    outputs: {
      articles: {
        relativePath: portableRelative(dataDirectory, articlesPath),
        sha256: sha256(articleContent),
        records: collection.articles.length,
        schemaVersion: 1,
      },
    },
    aggregates: {
      sourcesConfigured: sources.length,
      sourcesFetched: sourceStatuses.filter((status) => status === 'FETCHED').length,
      sourcesFailed: sourceStatuses.filter((status) => status === 'FAILED').length,
      sourcesStale: sourceStatuses.filter((status) => status === 'STALE').length,
      recordsDiscovered: collection.sources.reduce(
        (total, source) => total + source.recordsDiscovered,
        0,
      ),
      recordsRestricted,
      recordsSkippedAsStale,
      recordsEmitted: collection.articles.length,
    },
    collectionWindow: {
      maxArticleAgeDays: NEWS_ITEM_MAX_AGE_DAYS,
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
      articlesTtlDays: ARTICLE_RETENTION_DAYS,
      expiresAt,
      sourceRightsExpiresAt: rightsExpiresAt,
      boundedBySourceRightsExpiry: rightsExpiresAt < ttlExpiresAt,
      disposition: 'DELETE_ARTICLES_AND_DERIVED_NAME_LINKAGE',
    },
  };
  await installArtifactAtomically(
    outputDirectory,
    articleContent,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    artifactId,
    outputDirectory,
    articlesPath,
    manifestPath,
    articles: collection.articles.length,
    restricted: recordsRestricted,
    staleItems: recordsSkippedAsStale,
    staleSources: manifest.aggregates.sourcesStale,
    failedSources: manifest.aggregates.sourcesFailed,
    authorizationGatedSourcesOmitted: sourceResolution.authorizationGatedSourcesOmitted,
  };
}

async function main(): Promise<void> {
  const result = await runUruguayanNewsIndexIngestion();
  console.log(JSON.stringify({ event: 'uruguayan_news_indexes_completed', ...result }));
}

function loadOptionalDataEnvironment(): void {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error: unknown) {
    if (!(isObject(error) && error['code'] === 'ENOENT')) {
      throw error;
    }
  }
}

if (require.main === module) {
  loadOptionalDataEnvironment();
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
