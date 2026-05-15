// =============================================================================
// CONFIGURATION Vite — projet Gantt
// =============================================================================
// • Front Vite servi sur 0.0.0.0:5174 (5173 est pris par plan-de-charge)
// • base = '/gantt/' → l'app est accessible sur http://localhost:5174/gantt/
// • Toutes les requêtes /api/* sont proxifiées vers Express (port 3002,
//   3001 étant pris par plan-de-charge)
// • Vitest est configuré ici (section `test`) pour les tests unitaires
//   des fonctions pures (`src/lib/**`) + DAL (`db/**`) + factory app
//   (`server/**`).
// =============================================================================

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Préfixe de toutes les URLs servies par Vite (dev ET build prod).
  // Conséquence : l'app vit à http://localhost:5174/gantt/ — la racine
  // (`/`) renvoie un 404. Les imports JS/CSS/images sont automatiquement
  // préfixés par Vite.
  base: '/gantt/',
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 0.0.0.0 — joignable depuis le LAN
    port: 5174,
    // strictPort : échoue si 5174 est déjà pris (plutôt que d'aller
    // silencieusement sur 5175 et nous embrouiller).
    strictPort: true,
    proxy: {
      // Le proxy s'applique aux requêtes vers /api/* OU /gantt/api/*
      // (selon que le code client utilise un chemin absolu ou relatif).
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: [
      'src/**/*.test.{ts,tsx}',
      'db/**/*.test.{js,ts}',
      'server/**/*.test.{js,ts}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts', 'db/**/*.js', 'server/**/*.js'],
      exclude: ['**/*.test.*'],
    },
  },
})
