import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const testFiles = [
  '**/*.spec.ts',
  '**/*.test.ts',
  '**/*.integration.spec.ts',
  '**/*.e2e-spec.ts',
  '**/test/**/*.ts',
];

export default defineConfig(
  {
    name: 'global-ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.cache/**',
      '**/.serena/**',
      '**/*.d.ts',
      'drizzle/**/migrations/**',
    ],
  },
  {
    name: 'linter-options',
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  {
    name: 'javascript-config',
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    name: 'typed-typescript',
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: {
      'import-x': importX,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'object',
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@medicos/*/src/**'],
              message: 'Import only from the public package entrypoint.',
            },
          ],
        },
      ],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    name: 'hexagonal-domain',
    files: ['packages/modules/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/**',
                'drizzle-orm',
                'firebase-admin/**',
                '@medicos/platform-*',
                '**/application/**',
                '**/infrastructure/**',
                '**/presentation/**',
              ],
              message: 'Domain code must remain framework and outer-layer independent.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'hexagonal-application',
    files: ['packages/modules/*/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/**',
                'drizzle-orm',
                'firebase-admin/**',
                '@medicos/platform-*',
                '**/infrastructure/**',
                '**/presentation/**',
              ],
              message: 'Application code may depend only on domain and application ports.',
            },
          ],
        },
      ],
    },
  },
  {
    ...vitest.configs.recommended,
    name: 'vitest',
    files: testFiles,
    rules: {
      ...vitest.configs.recommended.rules,
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    name: 'scripts',
    files: ['drizzle/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
);
