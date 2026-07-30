import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { load } from 'cheerio';

import {
  CMU_ETHICS_COLLECTION_MODE,
  installCmuEthicsSnapshotAtomically,
  parseCmuEthicsCaseMetadata,
} from './cmu-ethics-snapshot';

import type {
  CmuEthicsCaseMetadata,
  CmuEthicsDocumentMetadata,
  CmuEthicsSnapshotManifest,
  InstalledCmuEthicsSnapshot,
} from './cmu-ethics-snapshot';
import type { ReadableStreamReadResult } from 'node:stream/web';

export const CMU_ETHICS_COLLECTOR_VERSION = 'cmu-public-metadata-v1' as const;
export const CMU_ETHICS_ORIGIN = 'https://www.colegiomedico.org.uy' as const;
export const CMU_ETHICS_ROBOTS_URL = 'https://www.colegiomedico.org.uy/robots.txt' as const;
export const CMU_ETHICS_SITEMAP_URL =
  'https://www.colegiomedico.org.uy/fallos-sitemap.xml' as const;
export const CMU_ETHICS_REVIEWED_ROBOTS_SHA256 =
  '1504e29351ac010985f7c827a688442fec3d5ce1240099fb5d89a9ac1d946ffb' as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_PATH_PREFIXES = [
  '/fallos-emitidos-por-el-tribunal-de-etica/',
  '/wp-content/uploads/',
] as const;
const CASE_PATH_PATTERN = /^\/fallos\/[a-z0-9][a-z0-9-]*\/$/u;
const MAX_DOCUMENTS_PER_CASE = 20;

export type CmuResourceKind = 'ROBOTS' | 'SITEMAP' | 'CASE_PAGE';
export type CmuFetch = typeof fetch;
export type CmuSleep = (milliseconds: number) => Promise<void>;

export interface CmuEthicsSourceConfiguration {
  readonly origin: typeof CMU_ETHICS_ORIGIN;
  readonly robotsUrl: typeof CMU_ETHICS_ROBOTS_URL;
  readonly sitemapUrl: typeof CMU_ETHICS_SITEMAP_URL;
  readonly expectedRobotsSha256: string;
  readonly policyReviewedAt: string;
  readonly minimumRequestIntervalMs: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxRobotsBytes: number;
  readonly maxSitemapBytes: number;
  readonly maxCasePageBytes: number;
  readonly maxSitemapUrls: number;
}

export const CMU_ETHICS_SOURCE: Readonly<CmuEthicsSourceConfiguration> = Object.freeze({
  origin: CMU_ETHICS_ORIGIN,
  robotsUrl: CMU_ETHICS_ROBOTS_URL,
  sitemapUrl: CMU_ETHICS_SITEMAP_URL,
  expectedRobotsSha256: CMU_ETHICS_REVIEWED_ROBOTS_SHA256,
  policyReviewedAt: '2026-07-29',
  minimumRequestIntervalMs: 1_000,
  timeoutMs: 20_000,
  maxRedirects: 2,
  maxRobotsBytes: 128 * 1_024,
  maxSitemapBytes: 8 * 1_024 * 1_024,
  maxCasePageBytes: 1 * 1_024 * 1_024,
  maxSitemapUrls: 5_000,
});

export type CmuEthicsCollectionErrorCode =
  | 'BYTE_LIMIT'
  | 'CONTENT_TYPE'
  | 'HTTP_STATUS'
  | 'INVALID_REDIRECT'
  | 'INVALID_SOURCE_CONFIGURATION'
  | 'INVALID_URL'
  | 'REDIRECT_LIMIT'
  | 'ROBOTS_HASH_MISMATCH'
  | 'ROBOTS_POLICY'
  | 'TIMEOUT'
  | 'UTF8';

export class CmuEthicsCollectionError extends Error {
  public constructor(
    public readonly code: CmuEthicsCollectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CmuEthicsCollectionError';
  }
}

interface RobotsRule {
  readonly directive: 'allow' | 'disallow';
  readonly value: string;
}

interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

export interface CmuRobotsPolicy {
  readonly groups: readonly RobotsGroup[];
  readonly allows: (url: URL) => boolean;
}

export interface FetchedCmuResource {
  readonly kind: CmuResourceKind;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly text: string;
  readonly lastModified: string | null;
}

export interface ParsedCmuSitemap {
  readonly allowedCaseEntries: readonly ParsedCmuSitemapEntry[];
  readonly allowedCaseUrls: readonly string[];
  readonly urlsDiscovered: number;
  readonly disallowedUrlsSkipped: number;
  readonly invalidUrlsSkipped: number;
}

export interface ParsedCmuSitemapEntry {
  readonly canonicalUrl: string;
  readonly sitemapLastModified: string | null;
}

export interface ParseCmuEthicsCasePageOptions {
  readonly canonicalUrl: string;
  readonly observedAt: string;
  readonly robotsSha256: string;
  readonly sitemapLastModified?: string | null;
}

export interface CollectCmuEthicsMetadataOptions {
  readonly source?: CmuEthicsSourceConfiguration;
  readonly fetchImpl?: CmuFetch;
  readonly now?: () => Date;
  readonly clockMilliseconds?: () => number;
  readonly sleep?: CmuSleep;
}

export interface CollectedCmuEthicsMetadata {
  readonly cases: readonly CmuEthicsCaseMetadata[];
  readonly robotsSha256: string;
  readonly aggregates: CmuEthicsSnapshotManifest['aggregates'];
}

export interface RunCmuEthicsMetadataCollectionOptions extends CollectCmuEthicsMetadataOptions {
  readonly dataDirectory?: string;
  readonly outputDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface RunCmuEthicsMetadataCollectionResult extends InstalledCmuEthicsSnapshot {
  readonly pagesFetched: number;
  readonly pagesFailed: number;
  readonly disallowedUrlsSkipped: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateSourceConfiguration(source: CmuEthicsSourceConfiguration): void {
  const positiveIntegers = [
    source.timeoutMs,
    source.maxRobotsBytes,
    source.maxSitemapBytes,
    source.maxCasePageBytes,
    source.maxSitemapUrls,
  ];
  if (
    source.origin !== CMU_ETHICS_ORIGIN ||
    source.robotsUrl !== CMU_ETHICS_ROBOTS_URL ||
    source.sitemapUrl !== CMU_ETHICS_SITEMAP_URL ||
    !/^[0-9a-f]{64}$/u.test(source.expectedRobotsSha256) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(source.policyReviewedAt) ||
    !Number.isSafeInteger(source.minimumRequestIntervalMs) ||
    source.minimumRequestIntervalMs < 1_000 ||
    !Number.isSafeInteger(source.maxRedirects) ||
    source.maxRedirects < 0 ||
    source.maxRedirects > 5 ||
    positiveIntegers.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new CmuEthicsCollectionError(
      'INVALID_SOURCE_CONFIGURATION',
      'CMU source configuration violates the fixed safety policy',
    );
  }
}

function hasForbiddenPath(pathname: string): boolean {
  const lowerPath = pathname.toLocaleLowerCase('en-US');
  return FORBIDDEN_PATH_PREFIXES.some((prefix) => lowerPath.startsWith(prefix));
}

function validateBaseCmuUrl(rawUrl: string | URL, context: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CmuEthicsCollectionError('INVALID_URL', `${context} is not an absolute URL`);
  }
  if (
    url.origin !== CMU_ETHICS_ORIGIN ||
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    /%(?:2e|2f|5c)/iu.test(url.pathname) ||
    hasForbiddenPath(url.pathname)
  ) {
    throw new CmuEthicsCollectionError(
      'INVALID_URL',
      `${context} is outside the approved same-origin HTTPS surface`,
    );
  }
  return url;
}

function validateCmuResourceUrl(
  rawUrl: string | URL,
  kind: CmuResourceKind,
  robotsPolicy?: CmuRobotsPolicy,
): URL {
  const url = validateBaseCmuUrl(rawUrl, `${kind} URL`);
  const correctShape =
    (kind === 'ROBOTS' && url.pathname === '/robots.txt') ||
    (kind === 'SITEMAP' && url.pathname === '/fallos-sitemap.xml') ||
    (kind === 'CASE_PAGE' && CASE_PATH_PATTERN.test(url.pathname));
  if (!correctShape) {
    throw new CmuEthicsCollectionError(
      'INVALID_URL',
      `${kind} URL does not match its approved endpoint shape`,
    );
  }
  if (kind !== 'ROBOTS' && !robotsPolicy?.allows(url)) {
    throw new CmuEthicsCollectionError(
      'ROBOTS_POLICY',
      `${kind} URL is not permitted by the reviewed robots policy`,
    );
  }
  return url;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function robotsRuleMatches(url: URL, ruleValue: string): boolean {
  if (ruleValue.length === 0) {
    return false;
  }
  if (/^https?:\/\//iu.test(ruleValue)) {
    return url.toString().startsWith(ruleValue);
  }
  if (!ruleValue.startsWith('/')) {
    return false;
  }
  const anchored = ruleValue.endsWith('$');
  const value = anchored ? ruleValue.slice(0, -1) : ruleValue;
  const pattern = value
    .split('*')
    .map((part) => escapeRegExp(part))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`, 'u').test(`${url.pathname}${url.search}`);
}

export function parseCmuRobotsPolicy(robotsText: string): CmuRobotsPolicy {
  const groups: { agents: string[]; rules: RobotsRule[]; rulesStarted: boolean }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const rawLine of robotsText.split(/\r?\n/gu)) {
    const line = rawLine.split('#', 1)[0]?.trim() ?? '';
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 1) {
      continue;
    }
    const directive = line.slice(0, separator).trim().toLocaleLowerCase('en-US');
    const value = line.slice(separator + 1).trim();
    if (directive === 'user-agent') {
      if (value.length === 0) {
        throw new CmuEthicsCollectionError('ROBOTS_POLICY', 'robots.txt has an empty user-agent');
      }
      if (current === undefined || current.rulesStarted) {
        current = { agents: [], rules: [], rulesStarted: false };
        groups.push(current);
      }
      current.agents.push(value.toLocaleLowerCase('en-US'));
    } else if (directive === 'allow' || directive === 'disallow') {
      if (current === undefined || current.agents.length === 0) {
        throw new CmuEthicsCollectionError(
          'ROBOTS_POLICY',
          'robots.txt contains a rule without a user-agent group',
        );
      }
      current.rulesStarted = true;
      current.rules.push({ directive, value });
    }
  }
  const wildcardGroups = groups.filter(({ agents }) => agents.includes('*'));
  if (wildcardGroups.length === 0) {
    throw new CmuEthicsCollectionError(
      'ROBOTS_POLICY',
      'robots.txt has no wildcard policy for this collector',
    );
  }
  const immutableGroups: readonly RobotsGroup[] = groups.map(({ agents, rules }) => ({
    agents: [...agents],
    rules: [...rules],
  }));
  return {
    groups: immutableGroups,
    allows: (url: URL): boolean => {
      const matches = wildcardGroups
        .flatMap(({ rules }) => rules)
        .filter((rule) => robotsRuleMatches(url, rule.value))
        .sort((left, right) => {
          const difference =
            right.value.replaceAll('*', '').length - left.value.replaceAll('*', '').length;
          return difference === 0 ? (left.directive === 'allow' ? -1 : 1) : difference;
        });
      return matches[0]?.directive !== 'disallow';
    },
  };
}

export function verifyCmuRobotsPolicy(
  robotsBytes: Uint8Array,
  source: CmuEthicsSourceConfiguration,
): {
  readonly sha256: string;
  readonly text: string;
  readonly policy: CmuRobotsPolicy;
} {
  const responseSha256 = sha256(robotsBytes);
  if (responseSha256 !== source.expectedRobotsSha256) {
    throw new CmuEthicsCollectionError(
      'ROBOTS_HASH_MISMATCH',
      'CMU robots.txt changed; collection requires a new human policy review',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(robotsBytes);
  } catch {
    throw new CmuEthicsCollectionError('UTF8', 'CMU robots.txt is not valid UTF-8');
  }
  const policy = parseCmuRobotsPolicy(text);
  if (!policy.allows(new URL(source.sitemapUrl))) {
    throw new CmuEthicsCollectionError(
      'ROBOTS_POLICY',
      'The reviewed robots policy does not permit the CMU ethics sitemap',
    );
  }
  return { sha256: responseSha256, text, policy };
}

function createSequentialRequestGate(
  minimumRequestIntervalMs: number,
  clockMilliseconds: () => number,
  sleep: CmuSleep,
): () => Promise<void> {
  let previousRequestStartedAt: number | undefined;
  return async (): Promise<void> => {
    const currentTime = clockMilliseconds();
    if (previousRequestStartedAt !== undefined) {
      const waitMilliseconds = Math.max(
        0,
        previousRequestStartedAt + minimumRequestIntervalMs - currentTime,
      );
      if (waitMilliseconds > 0) {
        await sleep(waitMilliseconds);
      }
    }
    previousRequestStartedAt = Math.max(
      clockMilliseconds(),
      previousRequestStartedAt === undefined
        ? Number.NEGATIVE_INFINITY
        : previousRequestStartedAt + minimumRequestIntervalMs,
    );
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number.parseInt(contentLength, 10) > maximumBytes) {
    await response.body?.cancel();
    throw new CmuEthicsCollectionError('BYTE_LIMIT', 'CMU response exceeds the byte limit');
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
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new CmuEthicsCollectionError('BYTE_LIMIT', 'CMU response exceeds the byte limit');
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

function maximumBytes(kind: CmuResourceKind, source: CmuEthicsSourceConfiguration): number {
  switch (kind) {
    case 'ROBOTS':
      return source.maxRobotsBytes;
    case 'SITEMAP':
      return source.maxSitemapBytes;
    case 'CASE_PAGE':
      return source.maxCasePageBytes;
  }
}

function validContentType(kind: CmuResourceKind, raw: string | null): boolean {
  const contentType = raw?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') ?? '';
  if (kind === 'ROBOTS') {
    return contentType === 'text/plain';
  }
  if (kind === 'SITEMAP') {
    return ['application/xml', 'text/xml', 'application/rss+xml'].includes(contentType);
  }
  return ['text/html', 'application/xhtml+xml'].includes(contentType);
}

interface FetchCmuResourceOptions {
  readonly source: CmuEthicsSourceConfiguration;
  readonly kind: CmuResourceKind;
  readonly url: string;
  readonly robotsPolicy?: CmuRobotsPolicy;
  readonly fetchImpl: CmuFetch;
  readonly now: () => Date;
  readonly beforeRequest: () => Promise<void>;
}

export async function fetchCmuResource(
  options: FetchCmuResourceOptions,
): Promise<FetchedCmuResource> {
  let currentUrl = validateCmuResourceUrl(options.url, options.kind, options.robotsPolicy);
  for (let redirectCount = 0; redirectCount <= options.source.maxRedirects; redirectCount += 1) {
    await options.beforeRequest();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, options.source.timeoutMs);
    try {
      const accept =
        options.kind === 'ROBOTS'
          ? 'text/plain'
          : options.kind === 'SITEMAP'
            ? 'application/xml, text/xml;q=0.9'
            : 'text/html, application/xhtml+xml;q=0.9';
      const response = await options.fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept,
          'user-agent': 'MedicosUYPublicMetadataCollector/1.0 (CMU metadata only)',
        },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location === null) {
          throw new CmuEthicsCollectionError('INVALID_REDIRECT', 'CMU redirect omitted Location');
        }
        if (redirectCount === options.source.maxRedirects) {
          throw new CmuEthicsCollectionError(
            'REDIRECT_LIMIT',
            'CMU response exceeded the redirect limit',
          );
        }
        currentUrl = validateCmuResourceUrl(
          new URL(location, currentUrl),
          options.kind,
          options.robotsPolicy,
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CmuEthicsCollectionError(
          'HTTP_STATUS',
          `CMU returned HTTP ${String(response.status)}`,
        );
      }
      if (!validContentType(options.kind, response.headers.get('content-type'))) {
        await response.body?.cancel();
        throw new CmuEthicsCollectionError(
          'CONTENT_TYPE',
          `CMU ${options.kind} response has an unexpected media type`,
        );
      }
      const body = await readBoundedBody(response, maximumBytes(options.kind, options.source));
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch {
        throw new CmuEthicsCollectionError(
          'UTF8',
          `CMU ${options.kind} response is not valid UTF-8`,
        );
      }
      return {
        kind: options.kind,
        finalUrl: currentUrl.toString(),
        retrievedAt: options.now().toISOString(),
        bytes: body.byteLength,
        sha256: sha256(body),
        text,
        lastModified: response.headers.get('last-modified'),
      };
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new CmuEthicsCollectionError('TIMEOUT', `CMU ${options.kind} request timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new CmuEthicsCollectionError('REDIRECT_LIMIT', 'CMU response exceeded redirect limit');
}

function classifySitemapUrl(
  rawUrl: string,
  policy: CmuRobotsPolicy,
): 'ALLOWED' | 'DISALLOWED' | 'INVALID' {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'INVALID';
  }
  if (
    url.origin !== CMU_ETHICS_ORIGIN ||
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    /%(?:2e|2f|5c)/iu.test(url.pathname)
  ) {
    return 'INVALID';
  }
  if (hasForbiddenPath(url.pathname)) {
    return 'DISALLOWED';
  }
  if (!CASE_PATH_PATTERN.test(url.pathname)) {
    return 'INVALID';
  }
  return policy.allows(url) ? 'ALLOWED' : 'DISALLOWED';
}

export function parseCmuEthicsSitemap(
  sitemapXml: string,
  robotsPolicy: CmuRobotsPolicy,
  maximumUrls = CMU_ETHICS_SOURCE.maxSitemapUrls,
): ParsedCmuSitemap {
  const $ = load(sitemapXml, { xml: true });
  if ($('urlset').length !== 1 || $('sitemapindex').length > 0) {
    throw new Error('CMU ethics sitemap has an unexpected XML root');
  }
  const rawEntries = $('urlset > url')
    .toArray()
    .map((element) => {
      const entry = $(element);
      return {
        rawUrl: entry.find('loc').first().text().trim(),
        rawLastModified: entry.find('lastmod').first().text().trim(),
      };
    });
  if (rawEntries.length > maximumUrls) {
    throw new Error('CMU ethics sitemap exceeds the configured URL limit');
  }
  const allowed = new Map<string, ParsedCmuSitemapEntry>();
  let disallowedUrlsSkipped = 0;
  let invalidUrlsSkipped = 0;
  for (const { rawUrl, rawLastModified } of rawEntries) {
    const classification = classifySitemapUrl(rawUrl, robotsPolicy);
    if (classification === 'DISALLOWED') {
      disallowedUrlsSkipped += 1;
    } else if (classification === 'INVALID') {
      invalidUrlsSkipped += 1;
    } else {
      const canonicalUrl = new URL(rawUrl).toString();
      const sitemapLastModified = parseSitemapLastModified(rawLastModified);
      const existing = allowed.get(canonicalUrl);
      if (
        existing === undefined ||
        (sitemapLastModified !== null &&
          (existing.sitemapLastModified === null ||
            sitemapLastModified > existing.sitemapLastModified))
      ) {
        allowed.set(canonicalUrl, { canonicalUrl, sitemapLastModified });
      }
    }
  }
  const allowedCaseEntries = [...allowed.values()].sort((left, right) =>
    left.canonicalUrl.localeCompare(right.canonicalUrl, 'en'),
  );
  return {
    allowedCaseEntries,
    allowedCaseUrls: allowedCaseEntries.map(({ canonicalUrl }) => canonicalUrl),
    urlsDiscovered: rawEntries.length,
    disallowedUrlsSkipped,
    invalidUrlsSkipped,
  };
}

function parseSitemapLastModified(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  const candidate = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function extractSourceCaseKey(title: string): string | undefined {
  const match = /(?:\bEXPEDIENTE\s+)?\b(\d{1,4})\s*\/\s*(20\d{2})\b/iu.exec(title);
  return match?.[1] === undefined || match[2] === undefined ? undefined : `${match[1]}/${match[2]}`;
}

export function extractConservativeRespondentNames(title: string): readonly string[] {
  const separators = [...title.matchAll(/\s+C\s*\/\s*/giu)];
  const separator = separators[0];
  if (separators.length !== 1 || separator?.index === undefined) {
    return [];
  }
  const rightSide = normalizeText(
    title.slice(separator.index + separator[0].length).replace(/\s+\d{2}-\d{2}-\d{4}\s*$/u, ''),
  );
  const match =
    /^(?:DR\.?|DRA\.?|DOCTOR|DOCTORA)\s+([\p{L}]{2,}(?:[-'’][\p{L}]{2,})?(?:\s+[\p{L}]{2,}(?:[-'’][\p{L}]{2,})?){1,6})$/iu.exec(
      rightSide,
    );
  const name = match?.[1];
  if (name === undefined || /[,;&/]/u.test(name)) {
    return [];
  }
  const unsafe = new Set(['NN', 'OTRO', 'OTROS', 'OTRA', 'OTRAS']);
  const normalizedName = normalizeText(name);
  return normalizedName.split(' ').some((token) => unsafe.has(token.toLocaleUpperCase('es-UY')))
    ? []
    : [normalizedName];
}

function parseDocumentDate(rawDate: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/u.exec(rawDate.trim());
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const isoDate = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate
    ? null
    : isoDate;
}

export function extractCmuDocumentMetadata(html: string): readonly CmuEthicsDocumentMetadata[] {
  const $ = load(html);
  const documents = new Map<string, CmuEthicsDocumentMetadata>();
  $('.desc-bloque-text').each((_index, element) => {
    if (documents.size >= MAX_DOCUMENTS_PER_CASE) {
      return;
    }
    const container = $(element);
    const label = normalizeText(container.find('h3.file-title').first().text());
    if (label.length === 0 || label.length > 240) {
      return;
    }
    const date = parseDocumentDate(normalizeText(container.find('.date').first().text()));
    documents.set(`${label}\u0000${date ?? ''}`, { label, date });
  });
  return [...documents.values()].sort(
    (left, right) =>
      (left.date ?? '').localeCompare(right.date ?? '', 'en') ||
      left.label.localeCompare(right.label, 'es'),
  );
}

export function parseCmuEthicsCasePage(
  html: string,
  options: ParseCmuEthicsCasePageOptions,
): CmuEthicsCaseMetadata {
  const parsedUrl = validateBaseCmuUrl(options.canonicalUrl, 'CMU case canonical URL');
  if (!CASE_PATH_PATTERN.test(parsedUrl.pathname)) {
    throw new Error('CMU case canonical URL is not an approved case path');
  }
  const $ = load(html);
  const headings = $('h1')
    .toArray()
    .map((element) => normalizeText($(element).text()))
    .filter((heading) => heading.length > 0);
  const title = headings[0];
  if (headings.length !== 1 || title === undefined || title.length > 500) {
    throw new Error('CMU case page must contain one bounded non-empty h1');
  }
  const sourceCaseKey = extractSourceCaseKey(title);
  if (sourceCaseKey === undefined) {
    throw new Error('CMU case h1 has no conservative source case key');
  }
  const documents = extractCmuDocumentMetadata(html);
  const sourceDate = documents
    .map(({ date }) => date)
    .filter((date): date is string => date !== null)
    .sort()
    .at(-1);
  const respondentNames = extractConservativeRespondentNames(title);
  return parseCmuEthicsCaseMetadata({
    ethicsCaseId: `ethics_case_v1_${sha256(`Colegio Médico del Uruguay\u0000${sourceCaseKey}`)}`,
    sourceCaseKey,
    title,
    canonicalUrl: parsedUrl.toString(),
    respondentNames,
    documents,
    sourceDate: sourceDate ?? null,
    sourceDatePrecision: sourceDate === undefined ? null : 'DAY',
    visibility: respondentNames.length === 1 ? 'ORIGINAL' : 'UNKNOWN',
    outcome: 'UNKNOWN',
    finalityStatus: 'UNKNOWN',
    firstObservedAt: options.observedAt,
    lastObservedAt: options.observedAt,
    sourceMetadata: {
      schemaVersion: 1,
      sourceId: 'cmu-tribunal-etica',
      publisher: 'Colegio Médico del Uruguay',
      tribunal: 'Tribunal de Ética Médica',
      collectionMode: CMU_ETHICS_COLLECTION_MODE,
      robotsUrl: CMU_ETHICS_ROBOTS_URL,
      robotsSha256: options.robotsSha256,
      sitemapUrl: CMU_ETHICS_SITEMAP_URL,
      sitemapLastModified: options.sitemapLastModified ?? null,
      pageMetadataOnly: true,
      contentStored: false,
      currentnessVerified: false,
    },
  });
}

function mergeDuplicateCases(records: readonly CmuEthicsCaseMetadata[]): {
  readonly cases: readonly CmuEthicsCaseMetadata[];
  readonly duplicateCasesCollapsed: number;
} {
  const groups = new Map<string, CmuEthicsCaseMetadata[]>();
  for (const record of records) {
    const group = groups.get(record.sourceCaseKey) ?? [];
    group.push(record);
    groups.set(record.sourceCaseKey, group);
  }
  const merged: CmuEthicsCaseMetadata[] = [];
  let duplicateCasesCollapsed = 0;
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        new URL(left.canonicalUrl).pathname.length - new URL(right.canonicalUrl).pathname.length ||
        left.canonicalUrl.localeCompare(right.canonicalUrl, 'en'),
    );
    const preferred = ordered[0];
    if (preferred === undefined) {
      continue;
    }
    duplicateCasesCollapsed += ordered.length - 1;
    const namesAgree =
      new Set(ordered.map(({ respondentNames }) => JSON.stringify(respondentNames))).size === 1;
    const respondentNames = namesAgree ? preferred.respondentNames : ([] as const);
    const documentMap = new Map<string, CmuEthicsDocumentMetadata>();
    for (const record of ordered) {
      for (const document of record.documents) {
        documentMap.set(`${document.label}\u0000${document.date ?? ''}`, document);
      }
    }
    const documents = [...documentMap.values()].sort(
      (left, right) =>
        (left.date ?? '').localeCompare(right.date ?? '', 'en') ||
        left.label.localeCompare(right.label, 'es'),
    );
    const sourceDate = documents
      .map(({ date }) => date)
      .filter((date): date is string => date !== null)
      .sort()
      .at(-1);
    const sitemapLastModified =
      ordered
        .map(({ sourceMetadata }) => sourceMetadata.sitemapLastModified)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
    merged.push(
      parseCmuEthicsCaseMetadata({
        ...preferred,
        respondentNames,
        documents,
        sourceDate: sourceDate ?? null,
        sourceDatePrecision: sourceDate === undefined ? null : 'DAY',
        visibility: respondentNames.length === 1 ? 'ORIGINAL' : 'UNKNOWN',
        firstObservedAt: ordered
          .map(({ firstObservedAt }) => firstObservedAt)
          .sort()
          .at(0),
        lastObservedAt: ordered
          .map(({ lastObservedAt }) => lastObservedAt)
          .sort()
          .at(-1),
        sourceMetadata: {
          ...preferred.sourceMetadata,
          sitemapLastModified,
        },
      }),
    );
  }
  return {
    cases: merged.sort((left, right) =>
      left.sourceCaseKey.localeCompare(right.sourceCaseKey, 'en'),
    ),
    duplicateCasesCollapsed,
  };
}

export async function collectCmuEthicsMetadata(
  options: CollectCmuEthicsMetadataOptions = {},
): Promise<CollectedCmuEthicsMetadata> {
  const source = options.source ?? CMU_ETHICS_SOURCE;
  validateSourceConfiguration(source);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const clockMilliseconds = options.clockMilliseconds ?? Date.now;
  const sleep =
    options.sleep ??
    (async (milliseconds: number): Promise<void> => {
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
      });
    });
  const beforeRequest = createSequentialRequestGate(
    source.minimumRequestIntervalMs,
    clockMilliseconds,
    sleep,
  );
  const robotsResponse = await fetchCmuResource({
    source,
    kind: 'ROBOTS',
    url: source.robotsUrl,
    fetchImpl,
    now,
    beforeRequest,
  });
  const verified = verifyCmuRobotsPolicy(new TextEncoder().encode(robotsResponse.text), source);
  if (verified.sha256 !== robotsResponse.sha256) {
    throw new CmuEthicsCollectionError(
      'ROBOTS_HASH_MISMATCH',
      'CMU robots fingerprint changed during verification',
    );
  }
  const sitemapResponse = await fetchCmuResource({
    source,
    kind: 'SITEMAP',
    url: source.sitemapUrl,
    robotsPolicy: verified.policy,
    fetchImpl,
    now,
    beforeRequest,
  });
  const sitemap = parseCmuEthicsSitemap(
    sitemapResponse.text,
    verified.policy,
    source.maxSitemapUrls,
  );
  const cases: CmuEthicsCaseMetadata[] = [];
  let pagesFetched = 0;
  let pagesFailed = 0;
  for (const sitemapEntry of sitemap.allowedCaseEntries) {
    try {
      const response = await fetchCmuResource({
        source,
        kind: 'CASE_PAGE',
        url: sitemapEntry.canonicalUrl,
        robotsPolicy: verified.policy,
        fetchImpl,
        now,
        beforeRequest,
      });
      pagesFetched += 1;
      cases.push(
        parseCmuEthicsCasePage(response.text, {
          canonicalUrl: response.finalUrl,
          observedAt: response.retrievedAt,
          robotsSha256: verified.sha256,
          sitemapLastModified: sitemapEntry.sitemapLastModified,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof CmuEthicsCollectionError &&
        (error.code === 'ROBOTS_POLICY' || error.code === 'INVALID_URL')
      ) {
        throw error;
      }
      pagesFailed += 1;
    }
  }
  const deduplicated = mergeDuplicateCases(cases);
  return {
    cases: deduplicated.cases,
    robotsSha256: verified.sha256,
    aggregates: {
      sitemapUrlsDiscovered: sitemap.urlsDiscovered,
      disallowedUrlsSkipped: sitemap.disallowedUrlsSkipped,
      invalidUrlsSkipped: sitemap.invalidUrlsSkipped,
      pagesFetched,
      pagesFailed,
      duplicateCasesCollapsed: deduplicated.duplicateCasesCollapsed,
      casesEmitted: deduplicated.cases.length,
    },
  };
}

function isInside(parentDirectory: string, candidatePath: string): boolean {
  const fromParent = relative(parentDirectory, candidatePath);
  return (
    fromParent.length === 0 ||
    (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent))
  );
}

export async function runCmuEthicsMetadataCollection(
  options: RunCmuEthicsMetadataCollectionOptions = {},
): Promise<RunCmuEthicsMetadataCollectionResult> {
  const environment = options.environment ?? process.env;
  const source = options.source ?? CMU_ETHICS_SOURCE;
  const now = options.now ?? (() => new Date());
  const configuredDataDirectory =
    options.dataDirectory ?? environment['DATA_INGESTION_DIR'] ?? 'data';
  await mkdir(resolve(configuredDataDirectory), { recursive: true });
  const dataDirectory = await realpath(resolve(configuredDataDirectory));
  const collection = await collectCmuEthicsMetadata({
    source,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    now,
    ...(options.clockMilliseconds === undefined
      ? {}
      : { clockMilliseconds: options.clockMilliseconds }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  const generatedAt = now().toISOString();
  const configuredOutputDirectory = options.outputDirectory ?? environment['CMU_ETHICS_OUTPUT_DIR'];
  const outputDirectory = resolve(
    configuredOutputDirectory === undefined || configuredOutputDirectory.trim().length === 0
      ? join(
          dataDirectory,
          'normalized',
          'ethics',
          'cmu',
          `snapshot-${generatedAt.replaceAll(':', '').replaceAll('.', '')}`,
        )
      : configuredOutputDirectory,
  );
  if (!isInside(dataDirectory, outputDirectory)) {
    throw new Error('CMU ethics output must be inside DATA_INGESTION_DIR');
  }
  const installed = await installCmuEthicsSnapshotAtomically({
    outputDirectory,
    cases: collection.cases,
    collectorVersion: CMU_ETHICS_COLLECTOR_VERSION,
    generatedAt,
    policyReviewedAt: source.policyReviewedAt,
    robotsSha256: collection.robotsSha256,
    aggregates: collection.aggregates,
  });
  return {
    ...installed,
    pagesFetched: collection.aggregates.pagesFetched,
    pagesFailed: collection.aggregates.pagesFailed,
    disallowedUrlsSkipped: collection.aggregates.disallowedUrlsSkipped,
  };
}

async function main(): Promise<void> {
  const result = await runCmuEthicsMetadataCollection();
  console.log(
    JSON.stringify({
      event: 'cmu_ethics_metadata_snapshot_completed',
      artifactId: result.artifactId,
      outputDirectory: result.outputDirectory,
      records: result.records,
      pagesFetched: result.pagesFetched,
      pagesFailed: result.pagesFailed,
      disallowedUrlsSkipped: result.disallowedUrlsSkipped,
      semanticSha256: result.semanticSha256,
    }),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
