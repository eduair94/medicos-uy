import { describe, expect, it } from 'vitest';

import {
  buildDailyRefreshPlan,
  MUTUALISTA_STAGE_NAMES,
  parseMutualistaSelection,
  resolvePackageScriptCommand,
} from './run-daily-refresh';

describe('daily refresh plan', () => {
  it('updates all configured internal sources without publishing by default', () => {
    const plan = buildDailyRefreshPlan();

    expect(plan.map((stage) => stage.packageScript)).toEqual([
      'data:prepare',
      'data:purge:news:apply',
      'data:ingest:msp',
      ...MUTUALISTA_STAGE_NAMES.map((name) => `data:ingest:${name}`),
      'data:ingest:news-indexes',
      'data:link:news-candidates',
      'data:link:candidates',
      'data:build:directory',
    ]);
    expect(plan).not.toContainEqual(
      expect.objectContaining({
        publicationBoundary: 'SIGNED_PUBLIC_EXPORT',
      }),
    );
  });

  it('adds the fail-closed public exporter only when explicitly requested', () => {
    const plan = buildDailyRefreshPlan({
      mutualistas: ['asociacion-espanola'],
      newsEnabled: false,
      publicExportEnabled: true,
    });

    expect(plan.at(-1)).toEqual({
      name: 'build-signed-public-directory-export',
      packageScript: 'data:build:public-directory',
      publicationBoundary: 'SIGNED_PUBLIC_EXPORT',
    });
  });

  it('adds quarantined web enrichment only when explicitly requested', () => {
    const plan = buildDailyRefreshPlan({
      mutualistas: [],
      newsEnabled: false,
      webEnrichmentEnabled: true,
    });

    expect(plan.map((stage) => stage.packageScript)).toEqual([
      'data:prepare',
      'data:purge:news:apply',
      'data:ingest:msp',
      'data:link:candidates',
      'data:enrich:web:tick',
      'data:build:directory',
    ]);
    expect(plan.find(({ packageScript }) => packageScript === 'data:enrich:web:tick')).toEqual(
      expect.objectContaining({
        publicationBoundary: 'INTERNAL_LINKAGE',
      }),
    );
  });

  it('normalizes a bounded mutualista allowlist and rejects unknown stages', () => {
    expect(parseMutualistaSelection('smi, casmu, smi')).toEqual(['casmu', 'smi']);
    expect(() => parseMutualistaSelection('casmu,unknown-provider')).toThrow('unsupported values');
  });

  it('launches package scripts portably without spawning a cmd shim directly', () => {
    expect(
      resolvePackageScriptCommand(
        'data:setup',
        {
          npm_execpath: 'C:\\tools\\pnpm.cjs',
        },
        'win32',
      ),
    ).toEqual({
      executable: process.execPath,
      arguments: ['C:\\tools\\pnpm.cjs', 'run', 'data:setup'],
    });

    expect(
      resolvePackageScriptCommand(
        'data:setup',
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
        'win32',
      ),
    ).toEqual({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/s', '/c', 'pnpm.cmd run data:setup'],
    });

    expect(resolvePackageScriptCommand('data:setup', {}, 'linux')).toEqual({
      executable: 'pnpm',
      arguments: ['run', 'data:setup'],
    });
  });
});
