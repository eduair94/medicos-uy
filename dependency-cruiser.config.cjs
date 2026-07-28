/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
      },
      to: {
        circular: true,
      },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: 'packages-must-not-import-apps',
      severity: 'error',
      from: {
        path: '^packages/',
      },
      to: {
        path: '^apps/',
      },
    },
    {
      name: 'domain-must-not-import-outer-layers',
      severity: 'error',
      from: {
        path: '^packages/modules/[^/]+/src/domain/',
      },
      to: {
        path: '^(apps/|packages/platform/|packages/modules/[^/]+/src/(application|infrastructure|presentation|composition)/)',
      },
    },
    {
      name: 'domain-must-not-import-third-party-packages',
      severity: 'error',
      from: {
        path: '^packages/modules/[^/]+/src/domain/',
      },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled'],
      },
    },
    {
      name: 'application-must-not-import-outer-layers',
      severity: 'error',
      from: {
        path: '^packages/modules/[^/]+/src/application/',
      },
      to: {
        path: '^(apps/|packages/platform/|packages/modules/[^/]+/src/(infrastructure|presentation|composition)/)',
      },
    },
    {
      name: 'presentation-must-enter-through-application',
      severity: 'error',
      from: {
        path: '^packages/modules/[^/]+/src/presentation/',
      },
      to: {
        path: '^packages/modules/[^/]+/src/(domain|infrastructure|composition)/',
      },
    },
    {
      name: 'infrastructure-must-not-import-presentation',
      severity: 'error',
      from: {
        path: '^packages/modules/[^/]+/src/infrastructure/',
      },
      to: {
        path: '^packages/modules/[^/]+/src/(presentation|composition)/',
      },
    },
    {
      name: 'no-private-cross-module-imports',
      severity: 'error',
      from: {
        path: '^packages/modules/([^/]+)/src/',
      },
      to: {
        path: '^packages/modules/[^/]+/src/(?!index\\.ts$)',
        pathNot: '^packages/modules/$1/src/',
      },
    },
    {
      name: 'platform-must-not-import-business-modules',
      severity: 'error',
      from: {
        path: '^packages/platform/',
      },
      to: {
        path: '^packages/modules/',
      },
    },
    {
      name: 'production-must-not-import-tests',
      severity: 'error',
      from: {
        path: '^(apps|packages)/.+/src/',
        pathNot: '\\.(spec|test)\\.ts$',
      },
      to: {
        path: '(^|/)(test|__tests__)/|\\.(spec|test)\\.ts$',
      },
    },
    {
      name: 'runtime-source-must-not-import-dev-dependencies',
      severity: 'error',
      from: {
        path: '^(apps|packages)/.+/src/',
        pathNot: '\\.(spec|test)\\.ts$',
      },
      to: {
        dependencyTypes: ['npm-dev'],
      },
    },
  ],
  options: {
    includeOnly: '^(apps|packages)/',
    exclude: '(^|/)(dist|coverage|node_modules)/',
    doNotFollow: {
      dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled'],
    },
    moduleSystems: ['cjs', 'es6'],
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
    tsPreCompilationDeps: true,
  },
};
