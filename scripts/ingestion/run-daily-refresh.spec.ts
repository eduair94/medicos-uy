import { describe, expect, it } from 'vitest';

import {
  buildDailyRefreshPlan,
  MUTUALISTA_STAGE_NAMES,
  parseMutualistaSelection,
} from './run-daily-refresh';

describe('daily refresh plan', () => {
  it('updates all configured internal sources without publishing by default', () => {
    const plan = buildDailyRefreshPlan();

    expect(plan.map((stage) => stage.packageScript)).toEqual([
      'data:setup',
      'data:purge:news:apply',
      'data:ingest:msp',
      ...MUTUALISTA_STAGE_NAMES.map((name) => `data:ingest:${name}`),
      'data:ingest:news-indexes',
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

  it('normalizes a bounded mutualista allowlist and rejects unknown stages', () => {
    expect(parseMutualistaSelection('smi, casmu, smi')).toEqual(['casmu', 'smi']);
    expect(() => parseMutualistaSelection('casmu,unknown-provider')).toThrow('unsupported values');
  });
});
