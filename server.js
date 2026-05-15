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
const PORT = 3001

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
