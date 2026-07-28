import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

const workspaceAliases = {
  '@medicos/config': resolve(__dirname, 'packages/platform/config/src/index.ts'),
  '@medicos/credentials/nest': resolve(__dirname, 'packages/modules/credentials/src/nest.ts'),
  '@medicos/credentials': resolve(__dirname, 'packages/modules/credentials/src/index.ts'),
  '@medicos/database': resolve(__dirname, 'packages/platform/database/src/index.ts'),
  '@medicos/discovery': resolve(__dirname, 'packages/modules/discovery/src/index.ts'),
  '@medicos/health': resolve(__dirname, 'packages/platform/health/src/index.ts'),
  '@medicos/http': resolve(__dirname, 'packages/platform/http/src/index.ts'),
  '@medicos/observability': resolve(__dirname, 'packages/platform/observability/src/index.ts'),
  '@medicos/professionals/nest': resolve(__dirname, 'packages/modules/professionals/src/nest.ts'),
  '@medicos/professionals': resolve(__dirname, 'packages/modules/professionals/src/index.ts'),
  '@medicos/provenance/nest': resolve(__dirname, 'packages/modules/provenance/src/nest.ts'),
  '@medicos/provenance': resolve(__dirname, 'packages/modules/provenance/src/index.ts'),
  '@medicos/worker': resolve(__dirname, 'packages/platform/worker/src/index.ts'),
};

export default defineConfig({
  plugins: [swc.vite()],
  oxc: false,
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: 'node',
    setupFiles: ['test/setup/environment.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    allowOnly: !process.env['CI'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'packages/modules/**/src/application/**/*.ts',
        'packages/modules/**/src/domain/**/*.ts',
        'packages/modules/**/src/presentation/**/*.ts',
        'packages/platform/config/src/**/*.ts',
        'packages/platform/health/src/**/*.ts',
        'packages/platform/http/src/**/*.ts',
        'packages/platform/observability/src/**/*.ts',
      ],
      exclude: ['**/*.d.ts', '**/index.ts', '**/main.ts'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
        'packages/modules/**/src/{application,domain}/**/*.ts': {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages,scripts}/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, '**/*.integration.spec.ts', '**/*.e2e-spec.ts'],
          pool: 'threads',
          testTimeout: 5_000,
          hookTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,packages}/**/*.integration.spec.ts'],
          exclude: [...configDefaults.exclude],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['apps/**/test/**/*.e2e-spec.ts'],
          exclude: [...configDefaults.exclude],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
