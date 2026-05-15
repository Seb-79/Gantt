// =============================================================================
// CONFIGURATION ESLint — projet Gantt
// =============================================================================
// On utilise la "flat config" introduite par ESLint v9.
// Les fichiers JS du backend (server/, db/) sont vérifiés en mode "node",
// et les fichiers TSX du frontend en mode "browser" + plugins React.
// =============================================================================

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'node_modules']),

  // Backend Node (Express + SQLite + tests)
  {
    files: ['server/**/*.js', 'db/**/*.js', 'server.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Frontend React + TypeScript
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
