import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * R15 lint: correctness rules plus the architecture's dependency direction.
 *
 *   core        -> nothing app-specific (contracts, mapping, types)
 *   engine      -> core contracts, never connector or database implementations
 *   connectors  -> core, never engine / http / db
 *   http routes -> engine/services and contracts, never connectors or db directly
 *
 * Type-only imports are allowed across boundaries (they vanish at runtime).
 */
const layer = (patterns, message) => ({
  '@typescript-eslint/no-restricted-imports': [
    'error',
    { patterns: [{ group: patterns, message, allowTypeImports: true }] },
  ],
});

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'hubspot-app/**', '.sf/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Command-line tools print to the terminal by design; tests and scripts may log.
    files: ['src/cli/**', 'test/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  { files: ['src/core/**'], rules: layer(['../engine/*', '../db/*', '../connectors/*', '../http/*', '../dashboard/*'], 'core must not depend on engines, stores, connectors or the HTTP layer') },
  { files: ['src/engine/**'], rules: layer(['../connectors/*', '../db/*', '../http/*', '../dashboard/*'], 'engines use connector/store contracts, not implementations') },
  { files: ['src/connectors/**'], rules: layer(['../../engine/*', '../../http/*', '../../db/*', '../../dashboard/*'], 'connectors implement core contracts only') },
  {
    // Routes reach live CRM behavior only through App/engine contracts, never a connector
    // implementation, and never a database store directly. Two things are NOT part of that
    // boundary and stay allowed: the OAuth helper modules under connectors/*/auth.js (they
    // are not part of the CRMConnector data-sync contract; the HTTP layer owns the OAuth
    // flow itself) and the mock connector (demo-only scaffolding, never live business logic).
    files: ['src/http/**'],
    rules: layer(
      [
        '../connectors/*/salesforceConnector.js',
        '../connectors/*/hubspotConnector.js',
        '../../connectors/*/salesforceConnector.js',
        '../../connectors/*/hubspotConnector.js',
        '../db/*',
        '../../db/*',
      ],
      'routes go through services and contracts',
    ),
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
