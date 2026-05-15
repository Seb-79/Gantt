// =============================================================================
// BOOT — Gantt v1
// =============================================================================
// Petit fichier d'entrée :
//   1. Ouvre / crée la base SQLite (data.db)
//   2. Charge les données démo si la base est vide
//   3. Construit l'app Express via createApp(db)
//   4. Écoute sur 0.0.0.0:3001 (HTTP local + LAN)
// =============================================================================

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  initDb,
  isDatabaseEmpty,
  replaceFullState,
  DEMO_STATE,
} from './db/index.js'
import { createApp } from './server/app.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE = path.join(__dirname, 'data.db')
// 3001 est pris par l'API plan-de-charge → on utilise 3002 pour Gantt.
const PORT = 3002

const db = initDb(DB_FILE)

if (isDatabaseEmpty(db)) {
  console.log('[INIT] base vide — chargement des données de démonstration')
  replaceFullState(db, DEMO_STATE)
}

const app = createApp(db)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Gantt — http://localhost:${PORT}`)
  console.log(`[API] Base SQLite : ${DB_FILE}`)
})
