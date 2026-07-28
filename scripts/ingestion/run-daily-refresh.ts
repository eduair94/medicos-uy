import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const MUTUALISTA_STAGE_NAMES = [
  'casmu',
  'asociacion-espanola',
  'smi',
  'medica-uruguaya',
  'hospital-britanico',
] as const;

type MutualistaStageName = (typeof MUTUALISTA_STAGE_NAMES)[number];
type StageState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface DailyRefreshStage {
  readonly name: string;
  readonly packageScript: string;
  readonly publicationBoundary:
    | 'LOCAL_MAINTENANCE'
    | 'INTERNAL_INGESTION'
    | 'INTERNAL_LINKAGE'
    | 'INTERNAL_DIRECTORY'
    | 'SIGNED_PUBLIC_EXPORT';
}

export interface DailyRefreshPlanOptions {
  readonly mutualistas?: readonly MutualistaStageName[];
  readonly newsEnabled?: boolean;
  readonly publicExportEnabled?: boolean;
}

interface StageExecution {
  readonly name: string;
  readonly packageScript: string;
  readonly publicationBoundary: DailyRefreshStage['publicationBoundary'];
  readonly state: StageState;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly exitCode?: number;
}

interface DailyRefreshStatus {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly state: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly failedStage?: string;
  readonly safeguards: {
    readonly automaticIdentityConfirmation: false;
    readonly automaticAdversePublication: false;
    readonly databaseMutationPerformed: false;
    readonly publicExportRequested: boolean;
    readonly publicExportRequiresSignedPolicy: true;
  };
  readonly stages: readonly StageExecution[];
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
  environmentName: string,
): boolean {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`${environmentName} must be an explicit boolean`);
}

export function parseMutualistaSelection(
  value: string | undefined,
): readonly MutualistaStageName[] {
  if (value === undefined || value.trim().length === 0) {
    return MUTUALISTA_STAGE_NAMES;
  }

  const requested = [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0),
    ),
  ];
  const allowed = new Set<string>(MUTUALISTA_STAGE_NAMES);
  const unsupported = requested.filter((item) => !allowed.has(item));

  if (unsupported.length > 0) {
    throw new Error(
      `DAILY_REFRESH_MUTUALISTAS contains unsupported values: ${unsupported.join(', ')}`,
    );
  }

  return MUTUALISTA_STAGE_NAMES.filter((name) => requested.includes(name));
}

export function buildDailyRefreshPlan(
  options: DailyRefreshPlanOptions = {},
): readonly DailyRefreshStage[] {
  const mutualistas = options.mutualistas ?? MUTUALISTA_STAGE_NAMES;
  const stages: DailyRefreshStage[] = [
    {
      name: 'prepare-data-directories',
      packageScript: 'data:setup',
      publicationBoundary: 'LOCAL_MAINTENANCE',
    },
    {
      name: 'purge-expired-news-artifacts',
      packageScript: 'data:purge:news:apply',
      publicationBoundary: 'LOCAL_MAINTENANCE',
    },
    {
      name: 'ingest-msp-infotitulos',
      packageScript: 'data:ingest:msp',
      publicationBoundary: 'INTERNAL_INGESTION',
    },
    ...mutualistas.map((name): DailyRefreshStage => ({
      name: `ingest-${name}`,
      packageScript: `data:ingest:${name}`,
      publicationBoundary: 'INTERNAL_INGESTION',
    })),
  ];

  if (options.newsEnabled ?? true) {
    stages.push({
      name: 'ingest-authorized-news-indexes',
      packageScript: 'data:ingest:news-indexes',
      publicationBoundary: 'INTERNAL_INGESTION',
    });
  }

  stages.push(
    {
      name: 'build-linkage-candidates',
      packageScript: 'data:link:candidates',
      publicationBoundary: 'INTERNAL_LINKAGE',
    },
    {
      name: 'build-internal-directory-snapshot',
      packageScript: 'data:build:directory',
      publicationBoundary: 'INTERNAL_DIRECTORY',
    },
  );

  if (options.publicExportEnabled ?? false) {
    stages.push({
      name: 'build-signed-public-directory-export',
      packageScript: 'data:build:public-directory',
      publicationBoundary: 'SIGNED_PUBLIC_EXPORT',
    });
  }

  return stages;
}

function loadOptionalDataEnvironment(): void {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function statusFilePath(environment: NodeJS.ProcessEnv): string {
  const dataDirectory =
    environment['DATA_INGESTION_DIR'] ??
    environment['MSP_INGESTION_DATA_DIR'] ??
    environment['INGESTION_DATA_DIR'] ??
    'data';

  return resolve(dataDirectory, 'logs', 'daily-refresh', 'latest.json');
}

async function persistStatus(path: string, status: DailyRefreshStatus): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, `${JSON.stringify(status, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function runPackageScript(
  packageScript: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

  return new Promise<number>((fulfill, reject) => {
    const child = spawn(executable, ['run', packageScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...environment,
      },
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${packageScript} was terminated by signal ${signal}`));
        return;
      }

      fulfill(code ?? 1);
    });
  });
}

export async function runDailyRefresh(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options: DailyRefreshPlanOptions = {
    mutualistas: parseMutualistaSelection(environment['DAILY_REFRESH_MUTUALISTAS']),
    newsEnabled: parseBoolean(
      environment['DAILY_REFRESH_NEWS_ENABLED'],
      true,
      'DAILY_REFRESH_NEWS_ENABLED',
    ),
    publicExportEnabled: parseBoolean(
      environment['DAILY_REFRESH_PUBLIC_EXPORT_ENABLED'],
      false,
      'DAILY_REFRESH_PUBLIC_EXPORT_ENABLED',
    ),
  };
  const plan = buildDailyRefreshPlan(options);

  if (process.argv.includes('--dry-run')) {
    process.stdout.write(
      `${JSON.stringify({ event: 'daily_refresh_plan', stages: plan }, null, 2)}\n`,
    );
    return;
  }

  const startedAt = new Date().toISOString();
  const executions: StageExecution[] = plan.map((stage) => ({
    ...stage,
    state: 'PENDING',
  }));
  const path = statusFilePath(environment);
  const statusBase = {
    schemaVersion: 1 as const,
    runId: randomUUID(),
    startedAt,
    safeguards: {
      automaticIdentityConfirmation: false as const,
      automaticAdversePublication: false as const,
      databaseMutationPerformed: false as const,
      publicExportRequested: options.publicExportEnabled ?? false,
      publicExportRequiresSignedPolicy: true as const,
    },
  };

  await persistStatus(path, {
    ...statusBase,
    state: 'RUNNING',
    stages: executions,
  });

  for (const [index, stage] of plan.entries()) {
    const stageStartedAt = new Date().toISOString();
    executions[index] = {
      ...stage,
      state: 'RUNNING',
      startedAt: stageStartedAt,
    };
    await persistStatus(path, {
      ...statusBase,
      state: 'RUNNING',
      stages: executions,
    });
    process.stdout.write(
      `${JSON.stringify({ event: 'daily_refresh_stage_started', stage: stage.name, packageScript: stage.packageScript })}\n`,
    );

    let exitCode: number;
    try {
      exitCode = await runPackageScript(stage.packageScript, environment);
    } catch (error) {
      executions[index] = {
        ...stage,
        state: 'FAILED',
        startedAt: stageStartedAt,
        completedAt: new Date().toISOString(),
      };
      await persistStatus(path, {
        ...statusBase,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        failedStage: stage.name,
        stages: executions,
      });
      throw error;
    }

    const completedAt = new Date().toISOString();
    executions[index] = {
      ...stage,
      state: exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
      startedAt: stageStartedAt,
      completedAt,
      exitCode,
    };

    if (exitCode !== 0) {
      await persistStatus(path, {
        ...statusBase,
        state: 'FAILED',
        completedAt,
        failedStage: stage.name,
        stages: executions,
      });
      throw new Error(`${stage.packageScript} failed with exit code ${exitCode}`);
    }

    await persistStatus(path, {
      ...statusBase,
      state: 'RUNNING',
      stages: executions,
    });
    process.stdout.write(
      `${JSON.stringify({ event: 'daily_refresh_stage_completed', stage: stage.name })}\n`,
    );
  }

  const completedAt = new Date().toISOString();
  await persistStatus(path, {
    ...statusBase,
    state: 'SUCCEEDED',
    completedAt,
    stages: executions,
  });
  process.stdout.write(
    `${JSON.stringify({ event: 'daily_refresh_completed', completedAt, statusPath: path })}\n`,
  );
}

if (require.main === module) {
  loadOptionalDataEnvironment();
  void runDailyRefresh().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ event: 'daily_refresh_failed', message })}\n`);
    process.exitCode = 1;
  });
}
