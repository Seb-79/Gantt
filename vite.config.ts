// =============================================================================
// CONFIGURATION Vite — projet Gantt
// =============================================================================
// • Front Vite servi sur 0.0.0.0:5173 (accessible LAN)
// • Toutes les requêtes /api/* sont proxifiées vers Express (port 3001)
// • Vitest est configuré ici (section `test`) pour les tests unitaires
//   des fonctions pures (`src/lib/**`) + DAL (`db/**`) + factory app
//   (`server/**`).
// =============================================================================

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 0.0.0.0 — joignable depuis le LAN
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
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
