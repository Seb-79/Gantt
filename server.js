// =============================================================================
// BOOT — Gantt v1
// =============================================================================
// Petit fichier d'entrée :
//   1. Ouvre / crée la base SQLite (data.db)
//   2. Charge les données démo si la base est vide
//   3. Démarre la sauvegarde automatique quotidienne (catch-up + tick horaire)
//   4. Construit l'app Express via createApp(db)
//   5. Écoute sur 0.0.0.0:3002 (HTTP local + LAN)
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
import { scheduleDailyBackup } from './server/backup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE = path.join(__dirname, 'data.db')
const BACKUP_DIR = path.join(__dirname, 'backups')
// 3001 est pris par l'API plan-de-charge → on utilise 3002 pour Gantt.
const PORT = 3002

const db = initDb(DB_FILE)

if (isDatabaseEmpty(db)) {
  console.log('[INIT] base vide — chargement des données de démonstration')
  replaceFullState(db, DEMO_STATE)
}

// v1.8 — Sauvegarde quotidienne SQLite snapshot dans ./backups/ avec
// rétention glissante de 7 jours. Catch-up immédiat au boot + vérification
// horaire pour reprendre dès que la date change.
scheduleDailyBackup(db, {
  dir: BACKUP_DIR,
  retentionDays: 7,
})

const app = createApp(db)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Gantt — http://localhost:${PORT}`)
  console.log(`[API] Base SQLite : ${DB_FILE}`)
  console.log(`[API] Sauvegardes : ${BACKUP_DIR} (rétention 7 jours)`)
})
