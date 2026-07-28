import path from 'node:path';

import {
  canonicalizePublicUrl,
  createProviderRunPaths,
  createRunId,
  ensureRunDirectories,
  fetchTextWithRetry,
  parseBoundedInteger,
  PUBLIC_DATA_SCHEMA_VERSION,
  relativeArtifactPath,
  sha256,
  writeFileAtomically,
  writeJsonAtomically,
  writeNdjsonAtomically,
  type ProviderRunPaths,
} from './casmu-hb-artifacts';
import {
  CASMU_EXTRACTOR_VERSION,
  assessCasmuDirectoryQuality,
  enrichCasmuDirectoryWithSchedules,
  parseCasmuCenterSchedules,
  parseCasmuDirectory,
  type CasmuCenterParseResult,
  type CasmuDirectoryParseResult,
  type CasmuDirectoryQuality,
  type CasmuDirectoryRecord,
  type CasmuScheduleRecord,
} from './casmu-parser';

const DEFAULT_CASMU_DIRECTORY_URL = 'https://casmu.com.uy/nuestros-medicos/';
const DEFAULT_CRAWL4AI_BASE_URL = 'https://crawl4ai.checkleaked.cc/';
const MINIMUM_EXPECTED_DIRECTORY_ROWS = 100;

interface CasmuIngestionConfig {
  readonly centerConcurrency: number;
  readonly centerDelayMs: number;
  readonly crawl4aiHtmlUrl: string;
  readonly dataRoot: string | undefined;
  readonly directoryUrl: string;
  readonly httpTimeoutMs: number;
}

interface DirectoryAttempt {
  readonly error: string | null;
  readonly finalUrl: string | null;
  readonly quality: CasmuDirectoryQuality | null;
  readonly rawHashSha256: string | null;
  readonly rawPath: string | null;
  readonly retrievedAt: string | null;
  readonly status: number | null;
  readonly transport: 'crawl4ai_html' | 'direct_fetch';
}

interface SelectedDirectory {
  readonly attempt: DirectoryAttempt;
  readonly parseResult: CasmuDirectoryParseResult;
  readonly quality: CasmuDirectoryQuality;
  readonly transport: 'crawl4ai_html' | 'direct_fetch';
}

interface CenterDirectoryContext {
  readonly address: string;
  readonly center: string;
  readonly requestedUrl: string;
}

interface CenterSnapshot {
  readonly error: string | null;
  readonly finalUrl: string | null;
  readonly rawHashSha256: string | null;
  readonly rawPath: string | null;
  readonly requestedUrl: string;
  readonly retrievedAt: string | null;
  readonly scheduleCount: number;
  readonly scheduleTables: number;
  readonly status: number | null;
  readonly tablesWithoutSpecialtyContext: number;
}

interface CenterIngestionResult {
  readonly parseResult: CasmuCenterParseResult | null;
  readonly snapshot: CenterSnapshot;
}

interface Crawl4aiPayload {
  readonly html: string;
  readonly success: boolean;
  readonly url: string;
}

export interface CasmuIngestionSummary {
  readonly manifestPath: string;
  readonly matchedDirectoryRecords: number;
  readonly physicianRecords: number;
  readonly runId: string;
  readonly scheduleRecords: number;
  readonly selectedDirectoryTransport: 'crawl4ai_html' | 'direct_fetch';
}

function resolveConfig(overrides: Partial<CasmuIngestionConfig> = {}): CasmuIngestionConfig {
  const configuredCrawl4aiBase = process.env['CRAWL4AI_BASE_URL'] ?? DEFAULT_CRAWL4AI_BASE_URL;
  const defaultHtmlUrl = new URL('/html', configuredCrawl4aiBase).href;

  return {
    centerConcurrency:
      overrides.centerConcurrency ??
      parseBoundedInteger(process.env['CASMU_CENTER_CONCURRENCY'], 1, 1, 2),
    centerDelayMs:
      overrides.centerDelayMs ??
      parseBoundedInteger(process.env['CASMU_CENTER_DELAY_MS'], 300, 250, 5_000),
    crawl4aiHtmlUrl:
      overrides.crawl4aiHtmlUrl ?? process.env['CASMU_CRAWL4AI_HTML_URL'] ?? defaultHtmlUrl,
    dataRoot: overrides.dataRoot ?? process.env['INGESTION_DATA_DIR'] ?? undefined,
    directoryUrl:
      overrides.directoryUrl ?? process.env['CASMU_DIRECTORY_URL'] ?? DEFAULT_CASMU_DIRECTORY_URL,
    httpTimeoutMs:
      overrides.httpTimeoutMs ??
      parseBoundedInteger(process.env['PUBLIC_SOURCE_TIMEOUT_MS'], 45_000, 5_000, 120_000),
  };
}

function isCrawl4aiPayload(value: unknown): value is Crawl4aiPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['html'] === 'string' &&
    typeof candidate['success'] === 'boolean' &&
    typeof candidate['url'] === 'string'
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceTrace(
  html: string,
  retrievedAt: string,
  sourceUrl: string,
): {
  readonly extractorVersion: string;
  readonly retrievedAt: string;
  readonly sourceHashSha256: string;
  readonly sourceUrl: string;
} {
  return {
    extractorVersion: CASMU_EXTRACTOR_VERSION,
    retrievedAt,
    sourceHashSha256: sha256(html),
    sourceUrl,
  };
}

async function fetchDirectoryThroughCrawl4ai(
  config: CasmuIngestionConfig,
  paths: ProviderRunPaths,
): Promise<{
  readonly attempt: DirectoryAttempt;
  readonly parsed: CasmuDirectoryParseResult | null;
}> {
  const rawPath = path.join(paths.rawDirectory, 'directory-crawl4ai-response.json');

  try {
    const response = await fetchTextWithRetry(config.crawl4aiHtmlUrl, {
      attempts: 2,
      init: {
        body: JSON.stringify({ url: config.directoryUrl }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      timeoutMs: config.httpTimeoutMs,
    });
    await writeFileAtomically(rawPath, response.body);
    const rawHashSha256 = sha256(response.body);

    if (response.status < 200 || response.status >= 300) {
      return {
        attempt: {
          error: `Crawl4AI returned HTTP ${response.status}`,
          finalUrl: response.finalUrl,
          quality: null,
          rawHashSha256,
          rawPath: relativeArtifactPath(rawPath),
          retrievedAt: response.retrievedAt,
          status: response.status,
          transport: 'crawl4ai_html',
        },
        parsed: null,
      };
    }

    const payload: unknown = JSON.parse(response.body);
    if (!isCrawl4aiPayload(payload) || !payload.success) {
      return {
        attempt: {
          error: 'Crawl4AI response does not contain a successful HTML payload',
          finalUrl: response.finalUrl,
          quality: null,
          rawHashSha256,
          rawPath: relativeArtifactPath(rawPath),
          retrievedAt: response.retrievedAt,
          status: response.status,
          transport: 'crawl4ai_html',
        },
        parsed: null,
      };
    }

    const parsed = parseCasmuDirectory(
      payload.html,
      sourceTrace(payload.html, response.retrievedAt, config.directoryUrl),
    );
    const quality = assessCasmuDirectoryQuality(parsed, MINIMUM_EXPECTED_DIRECTORY_ROWS);

    return {
      attempt: {
        error: quality.acceptable ? null : `Integrity checks failed: ${quality.issues.join('; ')}`,
        finalUrl: response.finalUrl,
        quality,
        rawHashSha256,
        rawPath: relativeArtifactPath(rawPath),
        retrievedAt: response.retrievedAt,
        status: response.status,
        transport: 'crawl4ai_html',
      },
      parsed,
    };
  } catch (error) {
    return {
      attempt: {
        error: toErrorMessage(error),
        finalUrl: null,
        quality: null,
        rawHashSha256: null,
        rawPath: null,
        retrievedAt: null,
        status: null,
        transport: 'crawl4ai_html',
      },
      parsed: null,
    };
  }
}

async function fetchDirectoryDirectly(
  config: CasmuIngestionConfig,
  paths: ProviderRunPaths,
): Promise<{
  readonly attempt: DirectoryAttempt;
  readonly parsed: CasmuDirectoryParseResult | null;
}> {
  const rawPath = path.join(paths.rawDirectory, 'directory-direct.html');

  try {
    const response = await fetchTextWithRetry(config.directoryUrl, {
      attempts: 2,
      timeoutMs: config.httpTimeoutMs,
    });
    await writeFileAtomically(rawPath, response.body);
    const rawHashSha256 = sha256(response.body);

    if (response.status < 200 || response.status >= 300) {
      return {
        attempt: {
          error: `CASMU directory returned HTTP ${response.status}`,
          finalUrl: response.finalUrl,
          quality: null,
          rawHashSha256,
          rawPath: relativeArtifactPath(rawPath),
          retrievedAt: response.retrievedAt,
          status: response.status,
          transport: 'direct_fetch',
        },
        parsed: null,
      };
    }

    const parsed = parseCasmuDirectory(
      response.body,
      sourceTrace(response.body, response.retrievedAt, config.directoryUrl),
    );
    const quality = assessCasmuDirectoryQuality(parsed, MINIMUM_EXPECTED_DIRECTORY_ROWS);

    return {
      attempt: {
        error: quality.acceptable ? null : `Integrity checks failed: ${quality.issues.join('; ')}`,
        finalUrl: response.finalUrl,
        quality,
        rawHashSha256,
        rawPath: relativeArtifactPath(rawPath),
        retrievedAt: response.retrievedAt,
        status: response.status,
        transport: 'direct_fetch',
      },
      parsed,
    };
  } catch (error) {
    return {
      attempt: {
        error: toErrorMessage(error),
        finalUrl: null,
        quality: null,
        rawHashSha256: null,
        rawPath: null,
        retrievedAt: null,
        status: null,
        transport: 'direct_fetch',
      },
      parsed: null,
    };
  }
}

async function selectDirectorySource(
  config: CasmuIngestionConfig,
  paths: ProviderRunPaths,
): Promise<{
  readonly attempts: readonly DirectoryAttempt[];
  readonly selected: SelectedDirectory;
}> {
  const crawl4ai = await fetchDirectoryThroughCrawl4ai(config, paths);
  if (crawl4ai.parsed !== null && crawl4ai.attempt.quality?.acceptable === true) {
    return {
      attempts: [crawl4ai.attempt],
      selected: {
        attempt: crawl4ai.attempt,
        parseResult: crawl4ai.parsed,
        quality: crawl4ai.attempt.quality,
        transport: 'crawl4ai_html',
      },
    };
  }

  const direct = await fetchDirectoryDirectly(config, paths);
  if (direct.parsed === null || direct.attempt.quality?.acceptable !== true) {
    throw new Error(
      [
        'Neither CASMU directory transport passed integrity checks.',
        `Crawl4AI: ${crawl4ai.attempt.error ?? 'unknown failure'}.`,
        `Direct: ${direct.attempt.error ?? 'unknown failure'}.`,
      ].join(' '),
    );
  }

  return {
    attempts: [crawl4ai.attempt, direct.attempt],
    selected: {
      attempt: direct.attempt,
      parseResult: direct.parsed,
      quality: direct.attempt.quality,
      transport: 'direct_fetch',
    },
  };
}

function slugForUrl(urlValue: string): string {
  const url = new URL(urlValue);
  const queryPage = url.searchParams.get('p');
  const pathSlug = url.pathname
    .split('/')
    .filter((part) => part.length > 0)
    .at(-1);
  const rawSlug = queryPage === null ? (pathSlug ?? 'homepage') : `page-${queryPage}`;

  return rawSlug
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-UY')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

function createCenterContexts(
  directoryRecords: readonly CasmuDirectoryRecord[],
): readonly CenterDirectoryContext[] {
  const grouped = new Map<
    string,
    { readonly addresses: Set<string>; readonly centers: Set<string> }
  >();

  for (const record of directoryRecords) {
    if (record.centerSourceUrl === null) {
      continue;
    }

    const current = grouped.get(record.centerSourceUrl) ?? {
      addresses: new Set<string>(),
      centers: new Set<string>(),
    };
    if (record.address.length > 0) {
      current.addresses.add(record.address);
    }
    if (record.center.length > 0) {
      current.centers.add(record.center);
    }
    grouped.set(record.centerSourceUrl, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'es'))
    .map(([requestedUrl, values]) => ({
      address:
        [...values.addresses].sort((left, right) => left.localeCompare(right, 'es'))[0] ?? '',
      center: [...values.centers].sort((left, right) => left.localeCompare(right, 'es'))[0] ?? '',
      requestedUrl,
    }));
}

async function ingestCenter(
  context: CenterDirectoryContext,
  index: number,
  config: CasmuIngestionConfig,
  paths: ProviderRunPaths,
): Promise<CenterIngestionResult> {
  const rawPath = path.join(
    paths.rawDirectory,
    'centers',
    `${String(index + 1).padStart(3, '0')}-${slugForUrl(context.requestedUrl)}.html`,
  );

  try {
    const response = await fetchTextWithRetry(context.requestedUrl, {
      attempts: 2,
      timeoutMs: config.httpTimeoutMs,
    });
    await writeFileAtomically(rawPath, response.body);
    const rawHashSha256 = sha256(response.body);

    if (response.status < 200 || response.status >= 300) {
      return {
        parseResult: null,
        snapshot: {
          error: `Center page returned HTTP ${response.status}`,
          finalUrl: response.finalUrl,
          rawHashSha256,
          rawPath: relativeArtifactPath(rawPath),
          requestedUrl: context.requestedUrl,
          retrievedAt: response.retrievedAt,
          scheduleCount: 0,
          scheduleTables: 0,
          status: response.status,
          tablesWithoutSpecialtyContext: 0,
        },
      };
    }

    const parseResult = parseCasmuCenterSchedules(response.body, {
      address: context.address,
      center: context.center,
      extractorVersion: CASMU_EXTRACTOR_VERSION,
      finalUrl: canonicalizePublicUrl(response.finalUrl) ?? response.finalUrl,
      requestedUrl: context.requestedUrl,
      retrievedAt: response.retrievedAt,
      sourceHashSha256: rawHashSha256,
    });

    return {
      parseResult,
      snapshot: {
        error: null,
        finalUrl: response.finalUrl,
        rawHashSha256,
        rawPath: relativeArtifactPath(rawPath),
        requestedUrl: context.requestedUrl,
        retrievedAt: response.retrievedAt,
        scheduleCount: parseResult.records.length,
        scheduleTables: parseResult.scheduleTables,
        status: response.status,
        tablesWithoutSpecialtyContext: parseResult.tablesWithoutSpecialtyContext,
      },
    };
  } catch (error) {
    return {
      parseResult: null,
      snapshot: {
        error: toErrorMessage(error),
        finalUrl: null,
        rawHashSha256: null,
        rawPath: null,
        requestedUrl: context.requestedUrl,
        retrievedAt: null,
        scheduleCount: 0,
        scheduleTables: 0,
        status: null,
        tablesWithoutSpecialtyContext: 0,
      },
    };
  }
}

async function ingestCentersWithLowConcurrency(
  contexts: readonly CenterDirectoryContext[],
  config: CasmuIngestionConfig,
  paths: ProviderRunPaths,
): Promise<readonly CenterIngestionResult[]> {
  const results = new Array<CenterIngestionResult | undefined>(contexts.length);
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (cursor < contexts.length) {
      const index = cursor;
      cursor += 1;
      const context = contexts[index];
      if (context === undefined) {
        continue;
      }

      results[index] = await ingestCenter(context, index, config, paths);
      completed += 1;
      if (completed % 5 === 0 || completed === contexts.length) {
        console.log(`CASMU centers: ${completed}/${contexts.length} snapshots retrieved`);
      }

      if (config.centerDelayMs > 0 && cursor < contexts.length) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, config.centerDelayMs);
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(config.centerConcurrency, contexts.length) }, async () =>
      worker(),
    ),
  );

  return results.filter((result): result is CenterIngestionResult => result !== undefined);
}

function sortSchedules(records: readonly CasmuScheduleRecord[]): readonly CasmuScheduleRecord[] {
  return [...records].sort((left, right) =>
    [left.center, left.specialty ?? '', left.physicianName, left.scheduleText]
      .join('|')
      .localeCompare(
        [right.center, right.specialty ?? '', right.physicianName, right.scheduleText].join('|'),
        'es',
      ),
  );
}

function sortDirectory(records: readonly CasmuDirectoryRecord[]): readonly CasmuDirectoryRecord[] {
  return [...records].sort((left, right) =>
    [left.physicianName, left.specialty, left.center, left.address]
      .join('|')
      .localeCompare(
        [right.physicianName, right.specialty, right.center, right.address].join('|'),
        'es',
      ),
  );
}

export async function runCasmuIngestion(
  overrides: Partial<CasmuIngestionConfig> = {},
): Promise<CasmuIngestionSummary> {
  const config = resolveConfig(overrides);
  const runId = createRunId();
  const paths = createProviderRunPaths('casmu', runId, config.dataRoot);
  await ensureRunDirectories(paths);

  console.log(
    `CASMU directory: retrieving ${config.directoryUrl} through ${config.crawl4aiHtmlUrl}`,
  );
  const directorySelection = await selectDirectorySource(config, paths);
  const centerContexts = createCenterContexts(directorySelection.selected.parseResult.records);

  console.log(
    `CASMU directory selected ${directorySelection.selected.transport}; ${directorySelection.selected.parseResult.records.length} unique physician rows and ${centerContexts.length} center URLs`,
  );
  const centerResults = await ingestCentersWithLowConcurrency(centerContexts, config, paths);
  const scheduleRecords = sortSchedules(
    centerResults.flatMap((result) => result.parseResult?.records ?? []),
  );
  const enrichedDirectory = sortDirectory(
    enrichCasmuDirectoryWithSchedules(
      directorySelection.selected.parseResult.records,
      scheduleRecords,
    ),
  );

  const physiciansPath = path.join(paths.processedDirectory, 'physicians.ndjson');
  const schedulesPath = path.join(paths.processedDirectory, 'schedules.ndjson');
  const manifestPath = path.join(paths.processedDirectory, 'manifest.json');
  await Promise.all([
    writeNdjsonAtomically(physiciansPath, enrichedDirectory),
    writeNdjsonAtomically(schedulesPath, scheduleRecords),
  ]);

  const referencedScheduleIds = new Set(
    enrichedDirectory.flatMap((record) => record.scheduleRecordIds),
  );
  const centerSnapshots = centerResults.map((result) => result.snapshot);
  const matchedDirectoryRecords = enrichedDirectory.filter(
    (record) => record.scheduleType === 'published_on_center_page',
  ).length;
  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
    provider: 'CASMU',
    runId,
    generatedAt,
    extractorVersion: CASMU_EXTRACTOR_VERSION,
    source: {
      directoryUrl: config.directoryUrl,
      crawl4aiHtmlUrl: config.crawl4aiHtmlUrl,
      directoryAttempts: directorySelection.attempts,
      selectedDirectoryTransport: directorySelection.selected.transport,
      selectedDirectoryQuality: directorySelection.selected.quality,
      centerSnapshots,
    },
    extraction: {
      directorySourceRows: directorySelection.selected.parseResult.totalRows,
      directoryUniqueRecords: directorySelection.selected.parseResult.records.length,
      directoryDuplicateRowsDiscarded:
        directorySelection.selected.parseResult.duplicateRowsDiscarded,
      directoryInvalidRows: directorySelection.selected.parseResult.invalidRows,
      centerUrlsDiscovered: centerContexts.length,
      centerSnapshotsHttpOk: centerSnapshots.filter(
        (snapshot) => snapshot.status !== null && snapshot.status >= 200 && snapshot.status < 300,
      ).length,
      centerSnapshotsFailed: centerSnapshots.filter((snapshot) => snapshot.error !== null).length,
      centerScheduleTables: centerResults.reduce(
        (total, result) => total + (result.parseResult?.scheduleTables ?? 0),
        0,
      ),
      centerTablesWithoutSpecialtyContext: centerResults.reduce(
        (total, result) => total + (result.parseResult?.tablesWithoutSpecialtyContext ?? 0),
        0,
      ),
      centerInvalidRows: centerResults.reduce(
        (total, result) => total + (result.parseResult?.invalidRows ?? 0),
        0,
      ),
      centerDuplicateRowsDiscarded: centerResults.reduce(
        (total, result) => total + (result.parseResult?.duplicateRowsDiscarded ?? 0),
        0,
      ),
      scheduleRecords: scheduleRecords.length,
      scheduleRecordsLinked: referencedScheduleIds.size,
      scheduleRecordsUnlinked: scheduleRecords.length - referencedScheduleIds.size,
      directoryRecordsWithPublishedSchedule: matchedDirectoryRecords,
      directoryRecordsWithoutPublishedSchedule: enrichedDirectory.length - matchedDirectoryRecords,
    },
    linkage: {
      method: 'exact canonical center URL plus exact normalized physician name',
      normalization:
        'case-folding, diacritic removal, punctuation collapse and leading professional-title removal',
      fuzzyMatchingUsed: false,
    },
    artifacts: {
      physiciansNdjson: relativeArtifactPath(physiciansPath),
      schedulesNdjson: relativeArtifactPath(schedulesPath),
      rawDirectory: relativeArtifactPath(paths.rawDirectory),
      manifest: relativeArtifactPath(manifestPath),
    },
    limitations: [
      'CASMU directory rows do not publish consultation hours; scheduleType remains not_published_on_source unless an exact physician-and-center match is found on a public center page.',
      'Schedule expressions are preserved as normalized source text and are not converted to recurring calendar intervals.',
      'No fuzzy person linkage is performed, so abbreviations, spelling differences and stale center pages remain unlinked.',
      'A public center URL returning an error or containing no recognized Técnico / Días y Horarios table contributes no schedule record.',
    ],
  };
  await writeJsonAtomically(manifestPath, manifest);
  await writeJsonAtomically(paths.latestPointer, {
    schemaVersion: PUBLIC_DATA_SCHEMA_VERSION,
    provider: 'CASMU',
    runId,
    generatedAt,
    manifestPath: relativeArtifactPath(manifestPath),
  });

  return {
    manifestPath: relativeArtifactPath(manifestPath),
    matchedDirectoryRecords,
    physicianRecords: enrichedDirectory.length,
    runId,
    scheduleRecords: scheduleRecords.length,
    selectedDirectoryTransport: directorySelection.selected.transport,
  };
}

async function main(): Promise<void> {
  const summary = await runCasmuIngestion();
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
