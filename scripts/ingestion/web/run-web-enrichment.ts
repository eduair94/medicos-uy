import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { load as loadHtml } from 'cheerio';

import {
  buildCoverage,
  Crawl4AiPageFetcher,
  createSourceUrlPolicy,
  DirectHttpPageFetcher,
  matchSourcePage,
  type BenignClaimCategory,
  type ProfessionalSeed,
  type SourcePage,
  type WebEnrichmentCandidate,
} from '../../../packages/modules/discovery/src';

interface SourcePolicyEntry {
  readonly sourceId: string;
  readonly publisher: string;
  readonly category: BenignClaimCategory;
  readonly enabled: boolean;
  readonly allowedHosts: readonly string[];
  readonly seedUrls: readonly string[];
  readonly directFetchAllowed: boolean;
  readonly rightsStatus: string;
  readonly internalResearchAllowed: boolean;
  readonly publicationAllowed: false;
  readonly retentionDays: number;
}

interface WebEnrichmentPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly purpose: 'INTERNAL_DIRECTORY_RESEARCH';
  readonly reviewedAt: string;
  readonly validUntil: string;
  readonly sources: readonly SourcePolicyEntry[];
  readonly safeguards: {
    readonly sourceFirst: true;
    readonly searchResultsAreEvidence: false;
    readonly automaticIdentityConfirmation: false;
    readonly automaticFactConfirmation: false;
    readonly automaticPublication: false;
    readonly publicExportAllowed: false;
    readonly noFindingsProvesAbsence: false;
  };
}

interface SourceOutcome {
  readonly sourceId: string;
  readonly plannedPages: number;
  readonly completedPages: number;
  readonly candidateCount: number;
  readonly restrictedCounts: Readonly<Record<string, number>>;
  readonly failureCount: number;
  readonly transportCounts: Readonly<Record<string, number>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
  return result.trim();
}

function requiredBoolean(value: Record<string, unknown>, key: string, context: string): boolean {
  const result = value[key];
  if (typeof result !== 'boolean') {
    throw new Error(`${context}.${key} must be a boolean`);
  }
  return result;
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
  context: string,
): readonly string[] {
  const result = value[key];
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    result.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${context}.${key} must be a non-empty string array`);
  }
  return result.map((item) => (item as string).trim());
}

function parseIsoDate(value: string, context: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${context} must be an ISO date`);
  }
  return value;
}

export function parseWebEnrichmentPolicy(value: unknown, now = new Date()): WebEnrichmentPolicy {
  if (!isObject(value) || value['schemaVersion'] !== 1) {
    throw new Error('Web enrichment policy must use schemaVersion 1');
  }
  if (value['purpose'] !== 'INTERNAL_DIRECTORY_RESEARCH') {
    throw new Error('Web enrichment policy purpose is not supported');
  }
  const safeguards = value['safeguards'];
  if (
    !isObject(safeguards) ||
    safeguards['sourceFirst'] !== true ||
    safeguards['searchResultsAreEvidence'] !== false ||
    safeguards['automaticIdentityConfirmation'] !== false ||
    safeguards['automaticFactConfirmation'] !== false ||
    safeguards['automaticPublication'] !== false ||
    safeguards['publicExportAllowed'] !== false ||
    safeguards['noFindingsProvesAbsence'] !== false
  ) {
    throw new Error('Web enrichment policy safeguards must remain fail-closed');
  }
  const reviewedAt = parseIsoDate(requiredString(value, 'reviewedAt', 'policy'), 'reviewedAt');
  const validUntil = parseIsoDate(requiredString(value, 'validUntil', 'policy'), 'validUntil');
  if (Date.parse(`${reviewedAt}T00:00:00Z`) > now.getTime()) {
    throw new Error('Web enrichment policy review date is in the future');
  }
  if (validUntil < reviewedAt) {
    throw new Error('Web enrichment policy validity ends before its review date');
  }
  if (Date.parse(`${validUntil}T23:59:59.999Z`) < now.getTime()) {
    throw new Error('Web enrichment policy is expired');
  }
  if (!Array.isArray(value['sources'])) {
    throw new Error('Web enrichment policy sources must be an array');
  }
  const sources = value['sources'].map((source, index): SourcePolicyEntry => {
    const context = `sources[${String(index)}]`;
    if (!isObject(source)) {
      throw new Error(`${context} must be an object`);
    }
    const category = requiredString(source, 'category', context);
    if (
      ![
        'ACADEMIC_MENTION',
        'INSTITUTIONAL_DIRECTORY_MENTION',
        'OFFICIAL_PUBLICATION_MENTION',
        'PROFESSIONAL_DIRECTORY_PROFILE',
      ].includes(category)
    ) {
      throw new Error(`${context}.category is unsupported`);
    }
    const retentionDays = source['retentionDays'];
    if (
      !Number.isInteger(retentionDays) ||
      (retentionDays as number) < 1 ||
      (retentionDays as number) > 90
    ) {
      throw new Error(`${context}.retentionDays must be between 1 and 90`);
    }
    const entry: SourcePolicyEntry = {
      sourceId: requiredString(source, 'sourceId', context),
      publisher: requiredString(source, 'publisher', context),
      category: category as BenignClaimCategory,
      enabled: requiredBoolean(source, 'enabled', context),
      allowedHosts: requiredStringArray(source, 'allowedHosts', context),
      seedUrls: requiredStringArray(source, 'seedUrls', context),
      directFetchAllowed: requiredBoolean(source, 'directFetchAllowed', context),
      rightsStatus: requiredString(source, 'rightsStatus', context),
      internalResearchAllowed: requiredBoolean(source, 'internalResearchAllowed', context),
      publicationAllowed: false,
      retentionDays: retentionDays as number,
    };
    if (source['publicationAllowed'] !== false) {
      throw new Error(`${context}.publicationAllowed must remain false`);
    }
    const urlPolicy = createSourceUrlPolicy({ allowedHostnames: entry.allowedHosts });
    for (const seedUrl of entry.seedUrls) {
      urlPolicy.assertAllowed(seedUrl);
    }
    if (entry.enabled && !entry.internalResearchAllowed) {
      throw new Error(`${context} is enabled without internal research authorization`);
    }
    return entry;
  });
  const sourceIds = sources.map(({ sourceId }) => sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('Web enrichment source IDs must be unique');
  }
  return {
    schemaVersion: 1,
    policyId: requiredString(value, 'policyId', 'policy'),
    purpose: 'INTERNAL_DIRECTORY_RESEARCH',
    reviewedAt,
    validUntil,
    sources,
    safeguards: {
      sourceFirst: true,
      searchResultsAreEvidence: false,
      automaticIdentityConfirmation: false,
      automaticFactConfirmation: false,
      automaticPublication: false,
      publicExportAllowed: false,
      noFindingsProvesAbsence: false,
    },
  };
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function walk(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

async function latestProfessionalPath(dataDirectory: string): Promise<string> {
  const paths = (await walk(join(dataDirectory, 'processed', 'msp', 'infotitulos')))
    .filter((path) => basename(path) === 'professionals.ndjson')
    .sort((left, right) => right.localeCompare(left, 'en'));
  const selected = paths[0];
  if (selected === undefined) {
    throw new Error('No MSP professionals.ndjson found; run data:ingest:msp first');
  }
  return selected;
}

export function parseProfessionalSeeds(content: string): readonly ProfessionalSeed[] {
  const forbiddenKeys = new Set(['document', 'documento', 'cedula', 'cédula', 'ci']);
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index): ProfessionalSeed => {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) {
        throw new Error(`Professional row ${String(index + 1)} is not an object`);
      }
      for (const key of forbiddenKeys) {
        if (key in value) {
          throw new Error(`Professional row ${String(index + 1)} contains raw identity data`);
        }
      }
      const opaqueProfessionalId = requiredString(value, 'linkageId', 'professional');
      if (!/^msp_doc_v1_[a-f0-9]{64}$/u.test(opaqueProfessionalId)) {
        throw new Error(`Professional row ${String(index + 1)} has invalid opaque ID`);
      }
      return {
        opaqueProfessionalId,
        displayName: requiredString(value, 'fullName', 'professional'),
      };
    });
}

function visibleText(content: string): string {
  const repaired = repairUtf8Mojibake(content);
  if (!/<[a-z][\s\S]*>/iu.test(repaired)) {
    return repaired;
  }
  const document = loadHtml(repaired);
  document('script,style,noscript,svg').remove();
  return document.root().text().replace(/\s+/gu, ' ').trim();
}

export function repairUtf8Mojibake(value: string): string {
  const markerCount = (candidate: string): number => [...candidate.matchAll(/[ÃÂâð]/gu)].length;
  if (markerCount(value) === 0) {
    return value;
  }
  const repaired = Buffer.from(value, 'latin1').toString('utf8');
  return markerCount(repaired) < markerCount(value) ? repaired : value;
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[key];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${key} must be an integer between 1 and ${String(maximum)}`);
  }
  return parsed;
}

function booleanEnvironment(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = environment[key];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  if (['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase())) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase())) {
    return false;
  }
  throw new Error(`${key} must be an explicit boolean`);
}

async function writeArtifact(options: {
  readonly dataDirectory: string;
  readonly requestedOutputDirectory?: string;
  readonly candidates: readonly WebEnrichmentCandidate[];
  readonly coverage: ReturnType<typeof buildCoverage>;
  readonly manifest: Record<string, unknown>;
}): Promise<string> {
  const candidatesContent = options.candidates.map((value) => JSON.stringify(value)).join('\n');
  const coverageContent = options.coverage.map((value) => JSON.stringify(value)).join('\n');
  const outputHashes = {
    candidates: sha256(`${candidatesContent}${candidatesContent.length > 0 ? '\n' : ''}`),
    coverage: sha256(`${coverageContent}${coverageContent.length > 0 ? '\n' : ''}`),
  };
  const fingerprint = sha256(
    JSON.stringify({
      manifest: options.manifest,
      outputHashes,
    }),
  ).slice(0, 16);
  const finalDirectory = resolve(
    options.requestedOutputDirectory ??
      join(
        options.dataDirectory,
        'processed',
        'web-enrichment',
        `web-enrichment-v1-${fingerprint}`,
      ),
  );
  if (!pathInside(options.dataDirectory, finalDirectory)) {
    throw new Error('WEB_ENRICHMENT_OUTPUT_DIR must stay inside DATA_INGESTION_DIR');
  }
  const temporaryDirectory = `${finalDirectory}.tmp-${randomUUID()}`;
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(temporaryDirectory, 'candidates.ndjson'),
    `${candidatesContent}${candidatesContent.length > 0 ? '\n' : ''}`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await writeFile(
    join(temporaryDirectory, 'coverage.ndjson'),
    `${coverageContent}${coverageContent.length > 0 ? '\n' : ''}`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const manifest = {
    ...options.manifest,
    outputs: {
      candidates: {
        relativePath: 'candidates.ndjson',
        records: options.candidates.length,
        sha256: outputHashes.candidates,
      },
      coverage: {
        relativePath: 'coverage.ndjson',
        records: options.coverage.length,
        sha256: outputHashes.coverage,
      },
    },
  };
  await writeFile(
    join(temporaryDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  try {
    await rename(temporaryDirectory, finalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const existing = await stat(finalDirectory);
    if (!existing.isDirectory()) {
      throw error;
    }
  }
  return finalDirectory;
}

export async function runWebEnrichment(
  environment: NodeJS.ProcessEnv = process.env,
  dryRun = process.argv.includes('--dry-run'),
): Promise<void> {
  const dataDirectory = resolve(environment['DATA_INGESTION_DIR'] ?? 'data');
  const policyPathValue = environment['WEB_ENRICHMENT_SOURCE_POLICY_PATH']?.trim();
  if (policyPathValue === undefined || policyPathValue.length === 0) {
    throw new Error('WEB_ENRICHMENT_SOURCE_POLICY_PATH is required');
  }
  const policyPath = resolve(policyPathValue);
  if (!pathInside(dataDirectory, policyPath)) {
    throw new Error('WEB_ENRICHMENT_SOURCE_POLICY_PATH must stay inside DATA_INGESTION_DIR');
  }
  const policyContent = await readFile(policyPath, 'utf8');
  const policy = parseWebEnrichmentPolicy(JSON.parse(policyContent));
  const sourcePolicySha256 = sha256(policyContent);
  const configuredProfessionalPath = environment['WEB_ENRICHMENT_PROFESSIONALS_PATH']?.trim();
  const professionalPath =
    configuredProfessionalPath === undefined || configuredProfessionalPath.length === 0
      ? await latestProfessionalPath(dataDirectory)
      : resolve(configuredProfessionalPath);
  if (!pathInside(dataDirectory, professionalPath)) {
    throw new Error('WEB_ENRICHMENT_PROFESSIONALS_PATH must stay inside DATA_INGESTION_DIR');
  }
  const professionalContent = await readFile(professionalPath, 'utf8');
  const professionals = parseProfessionalSeeds(professionalContent);
  const professionalSnapshotSha256 = sha256(professionalContent);
  const enabledSources = policy.sources.filter(({ enabled }) => enabled);
  const maximumPages = integerEnvironment(
    environment,
    'WEB_ENRICHMENT_MAX_SOURCE_PAGES_PER_RUN',
    25,
    100,
  );
  const plannedPages = enabledSources
    .flatMap((source) => source.seedUrls.map((url) => ({ source, url })))
    .slice(0, maximumPages);
  const duckDuckGoEnabled = booleanEnvironment(
    environment,
    'WEB_ENRICHMENT_DUCKDUCKGO_ENABLED',
    false,
  );

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          event: 'web_enrichment_plan',
          policyId: policy.policyId,
          professionals: professionals.length,
          enabledSources: enabledSources.length,
          plannedSourcePages: plannedPages.length,
          strategy: 'SOURCE_FIRST',
          nominalExternalSearchQueries: 0,
          duckDuckGo: duckDuckGoEnabled
            ? 'CONFIGURED_LOW_VOLUME_FALLBACK_NOT_USED_BY_SOURCE_FIRST_TICK'
            : 'DISABLED',
          expectedCoverageRows: professionals.length,
          publicExportAllowed: false,
          noFindingsProvesAbsence: false,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (!booleanEnvironment(environment, 'WEB_ENRICHMENT_CRAWL4AI_ENABLED', true)) {
    throw new Error(
      'WEB_ENRICHMENT_CRAWL4AI_ENABLED must be true for an enabled source-first tick',
    );
  }
  const fetcher = new Crawl4AiPageFetcher({
    baseUrl: environment['WEB_ENRICHMENT_CRAWL4AI_BASE_URL'] ?? 'https://crawl4ai.checkleaked.cc',
    timeoutMs: integerEnvironment(environment, 'WEB_ENRICHMENT_CRAWL_TIMEOUT_MS', 45_000, 120_000),
    maximumResponseBytes: integerEnvironment(
      environment,
      'WEB_ENRICHMENT_MAX_RESPONSE_BYTES',
      10 * 1024 * 1024,
      25 * 1024 * 1024,
    ),
  });
  const directFetcher = new DirectHttpPageFetcher({
    timeoutMs: integerEnvironment(environment, 'WEB_ENRICHMENT_CRAWL_TIMEOUT_MS', 45_000, 120_000),
    maximumResponseBytes: integerEnvironment(
      environment,
      'WEB_ENRICHMENT_MAX_RESPONSE_BYTES',
      10 * 1024 * 1024,
      25 * 1024 * 1024,
    ),
  });
  const observedAt = new Date().toISOString();
  const allCandidates: WebEnrichmentCandidate[] = [];
  const outcomes = new Map<string, SourceOutcome>();
  let completedPages = 0;
  let sourceFailures = 0;
  let restrictedPageCount = 0;

  for (const source of enabledSources) {
    outcomes.set(source.sourceId, {
      sourceId: source.sourceId,
      plannedPages: plannedPages.filter((item) => item.source.sourceId === source.sourceId).length,
      completedPages: 0,
      candidateCount: 0,
      restrictedCounts: {},
      failureCount: 0,
      transportCounts: {},
    });
  }

  for (const { source, url } of plannedPages) {
    const current = outcomes.get(source.sourceId);
    if (current === undefined) {
      throw new Error('Internal source outcome invariant failed');
    }
    try {
      const policyForUrl = createSourceUrlPolicy({ allowedHostnames: source.allowedHosts });
      const crawled = await fetcher.fetch(url, policyForUrl);
      let fetched = crawled;
      let transport: SourcePage['transport'] = 'CRAWL4AI';
      if (source.directFetchAllowed) {
        const directlyFetched = await directFetcher.fetch(url, policyForUrl);
        if (visibleText(directlyFetched.text).length > visibleText(crawled.text).length) {
          fetched = directlyFetched;
          transport = 'DIRECT_FETCH';
        }
      }
      const text = visibleText(fetched.text);
      const sourcePage: SourcePage = {
        pageId: `source_page_v1_${sha256(`${source.sourceId}\u001f${fetched.finalUrl}\u001f${sha256(text)}`)}`,
        sourceId: source.sourceId,
        publisher: source.publisher,
        category: source.category,
        canonicalUrl: fetched.finalUrl,
        text,
        contentSha256: sha256(text),
        retrievedAt: observedAt,
        transport,
      };
      const result = matchSourcePage({
        professionals,
        page: sourcePage,
        professionalSnapshotSha256,
        sourcePolicySha256,
        observedAt,
        retentionDays: source.retentionDays,
      });
      completedPages += 1;
      if (result.restrictedReason !== undefined) {
        restrictedPageCount += 1;
        const restrictedCounts = {
          ...current.restrictedCounts,
          [result.restrictedReason]: (current.restrictedCounts[result.restrictedReason] ?? 0) + 1,
        };
        outcomes.set(source.sourceId, {
          ...current,
          completedPages: current.completedPages + 1,
          restrictedCounts,
          transportCounts: {
            ...current.transportCounts,
            [transport]: (current.transportCounts[transport] ?? 0) + 1,
          },
        });
        continue;
      }
      allCandidates.push(...result.candidates);
      outcomes.set(source.sourceId, {
        ...current,
        completedPages: current.completedPages + 1,
        candidateCount: current.candidateCount + result.candidates.length,
        transportCounts: {
          ...current.transportCounts,
          [transport]: (current.transportCounts[transport] ?? 0) + 1,
        },
      });
    } catch {
      sourceFailures += 1;
      outcomes.set(source.sourceId, {
        ...current,
        failureCount: current.failureCount + 1,
      });
    }
  }

  const deduplicatedCandidates = [
    ...new Map(allCandidates.map((candidate) => [candidate.candidateId, candidate])).values(),
  ].sort((left, right) => left.candidateId.localeCompare(right.candidateId, 'en'));
  const coverage = buildCoverage({
    professionals,
    candidates: deduplicatedCandidates,
    sourceFailures,
    restrictedPageCount,
    plannedSourcePages: plannedPages.length,
    completedSourcePages: completedPages,
    professionalSnapshotSha256,
    sourcePolicySha256,
    observedAt,
  });
  const outputDirectory = await writeArtifact({
    dataDirectory,
    ...(environment['WEB_ENRICHMENT_OUTPUT_DIR']?.trim()
      ? { requestedOutputDirectory: environment['WEB_ENRICHMENT_OUTPUT_DIR'].trim() }
      : {}),
    candidates: deduplicatedCandidates,
    coverage,
    manifest: {
      schemaVersion: 1,
      artifactKind: 'WEB_ENRICHMENT_INTERNAL_QUARANTINE',
      generatedAt: observedAt,
      policy: {
        policyId: policy.policyId,
        sha256: sourcePolicySha256,
        reviewedAt: policy.reviewedAt,
        validUntil: policy.validUntil,
      },
      professionalSnapshot: {
        relativePath: relative(dataDirectory, professionalPath).replaceAll('\\', '/'),
        sha256: professionalSnapshotSha256,
        records: professionals.length,
      },
      strategy: {
        kind: 'SOURCE_FIRST',
        plannedSourcePages: plannedPages.length,
        completedSourcePages: completedPages,
        nominalExternalSearchQueries: 0,
        duckDuckGo: duckDuckGoEnabled
          ? 'CONFIGURED_LOW_VOLUME_FALLBACK_NOT_USED_BY_SOURCE_FIRST_TICK'
          : 'DISABLED',
      },
      sourceOutcomes: [...outcomes.values()],
      safeguards: {
        searchResultsAreEvidence: false,
        crawlServiceReceivedSearchQueries: false,
        namesSentToExternalSearchProvider: false,
        automaticIdentityConfirmation: false,
        automaticFactConfirmation: false,
        automaticPublication: false,
        publicExportAllowed: false,
        noFindingsProvesAbsence: false,
        adverseDetailsPersisted: false,
      },
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      event: 'web_enrichment_completed',
      outputDirectory,
      professionals: professionals.length,
      coverageRows: coverage.length,
      candidates: deduplicatedCandidates.length,
      completedPages,
      sourceFailures,
      restrictedPageCount,
      publicExportAllowed: false,
    })}\n`,
  );
}

if (require.main === module) {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  void runWebEnrichment().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ event: 'web_enrichment_failed', message })}\n`);
    process.exitCode = 1;
  });
}
