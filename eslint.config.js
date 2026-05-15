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
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// `sonarjs` ajoute ~60 règles ciblant code smells, complexité cyclomatique,
// duplications et patterns à risque — équivalent local d'un sous-ensemble
// de SonarQube. Aligné avec la config de `plan-de-charge`.
export default defineConfig([
  globalIgnores(['dist', 'coverage', 'node_modules']),

  // Backend Node (Express + SQLite + tests)
  {
    files: ['server/**/*.js', 'db/**/*.js', 'server.js'],
    extends: [sonarjs.configs.recommended],
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
      sonarjs.configs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Surcharges pour les fichiers de TESTS :
  //   • `sonarjs/assertions-in-tests` est désactivée parce que supertest
  //     utilise `.expect(200)` comme assertion (que sonar ne reconnaît pas).
  //   • Les tests sont autorisés à laisser un seul callback (no-callback-on-test).
  {
    files: ['**/*.test.{js,ts,tsx}'],
    rules: {
      'sonarjs/assertions-in-tests': 'off',
    },
  },
])
