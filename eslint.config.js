const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// Extract @typescript-eslint plugin that expo already imports
const tsConfig = expoConfig.find((c) => c.plugins && c.plugins['@typescript-eslint']);
const tsPlugin = tsConfig ? { '@typescript-eslint': tsConfig.plugins['@typescript-eslint'] } : {};

module.exports = defineConfig([
  ...expoConfig,
  {
    ignores: ['node_modules/', 'dist/', '.expo/', 'supabase/functions/', 'workers/api-proxy/', '.claude/', 'foliolens-clear-lens/', '.worktrees/', 'scripts/build-icons.mjs'],
  },
  {
    plugins: tsPlugin,
    rules: {
      // Enforce exhaustive deps — prevents stale closure bugs
      'react-hooks/exhaustive-deps': 'error',
      // Flag unused vars (prefix _ to explicitly ignore)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
]);
