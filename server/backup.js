// =============================================================================
// SAUVEGARDE AUTOMATIQUE QUOTIDIENNE DE data.db (v1.8)
// =============================================================================
// Principe : "une sauvegarde par jour, dès que possible".
//
// Plutôt que de viser une heure fixe (3h00) — non fiable si la machine est
// éteinte la nuit — on garantit qu'il y aura **un fichier daté du jour** dans
// le dossier `backups/`. Deux déclencheurs complémentaires :
//
//   1. Au démarrage du serveur (catch-up) : si aucun fichier
//      `data-YYYY-MM-DD.db` pour la date du jour n'existe, on en crée un.
//
//   2. Pendant que le serveur tourne (intervalle horaire) : toutes les 60 min,
//      même test. Si la date a changé depuis la dernière sauvegarde,
//      on en crée une.
//
// Conséquences :
//   • Mac éteint la nuit, allumé à 9h → 1 sauvegarde créée à 9h.
//   • Mac allumé toute la journée → 1 seule sauvegarde, pas de doublon (la
//     présence du fichier daté fait office de verrou).
//   • Mac éteint toute une journée → cette journée-là est sautée
//     (inévitable sans service externe).
//
// Cohérence des snapshots :
//   La base tourne en mode WAL et l'API peut écrire pendant qu'on sauvegarde.
//   On utilise donc l'API native `db.backup(path)` de better-sqlite3, qui
//   prend un snapshot cohérent (pas de simple `fs.copyFile`).
//
// Rotation :
//   Après chaque création réussie, on purge les fichiers `data-*.db` plus
//   vieux que `retentionDays` jours (7 par défaut) → fenêtre glissante.
//
// Module porté depuis `plan-de-charge` (v14.2) pour aligner la qualité des
// deux projets — mêmes garanties, mêmes tests.
// =============================================================================

import fs from 'fs'
import path from 'path'

const BACKUP_FILE_REGEX = /^data-(\d{4}-\d{2}-\d{2})\.db$/

/**
 * Renvoie la date du jour au format `YYYY-MM-DD` (fuseau local).
 * On utilise le fuseau local et non l'UTC pour que la "date du jour"
 * corresponde à la perception de l'utilisateur (Europe/Paris).
 *
 * @param {Date} [now=new Date()]  Instant de référence (paramétrable pour les tests).
 * @returns {string}  Date au format ISO `YYYY-MM-DD`.
 */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Construit le chemin complet du fichier de sauvegarde pour une date donnée.
 *
 * @param {string} dir    Répertoire des sauvegardes (créé si absent).
 * @param {string} stamp  Date au format `YYYY-MM-DD`.
 * @returns {string}      Chemin absolu du fichier `data-YYYY-MM-DD.db`.
 */
export function backupPathFor(dir, stamp) {
  return path.join(dir, `data-${stamp}.db`)
}

/**
 * Liste les sauvegardes existantes dans le dossier, triées par date croissante.
 * Ignore tout fichier ne respectant pas le motif `data-YYYY-MM-DD.db`.
 *
 * @param {string} dir  Répertoire à scanner. S'il n'existe pas, retourne [].
 * @returns {Array<{ stamp: string, file: string, fullPath: string }>}
 *          Sauvegardes valides triées chronologiquement.
 */
export function listBackups(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((file) => {
      const match = BACKUP_FILE_REGEX.exec(file)
      if (!match) return null
      return { stamp: match[1], file, fullPath: path.join(dir, file) }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.stamp.localeCompare(b.stamp))
}

/**
 * Crée le dossier `dir` s'il n'existe pas (mkdir récursif, idempotent).
 *
 * @param {string} dir  Chemin du répertoire à garantir.
 * @returns {void}
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Supprime les sauvegardes plus vieilles que `retentionDays` jours, en se
 * basant sur le `stamp` (YYYY-MM-DD) extrait du nom de fichier — pas sur la
 * date système du fichier, qui peut être modifiée par un `touch` accidentel.
 *
 * @param {string} dir            Répertoire des sauvegardes.
 * @param {number} retentionDays  Nombre de jours à conserver (inclusif).
 * @param {Date}   [now=new Date()]  Instant de référence (paramétrable pour les tests).
 * @returns {string[]}            Liste des chemins supprimés.
 */
export function purgeOldBackups(dir, retentionDays, now = new Date()) {
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  const deleted = []
  for (const entry of listBackups(dir)) {
    const entryMs = new Date(`${entry.stamp}T00:00:00`).getTime()
    if (entryMs < cutoffMs) {
      fs.unlinkSync(entry.fullPath)
      deleted.push(entry.fullPath)
    }
  }
  return deleted
}

/**
 * Effectue une sauvegarde pour la date du jour si aucune n'existe encore.
 * Pas de doublon : si le fichier `data-YYYY-MM-DD.db` est déjà là, on ne
 * fait rien. Sinon, on appelle `db.backup()` (snapshot cohérent WAL-safe)
 * puis on purge les sauvegardes au-delà de la rétention.
 *
 * @param {import('better-sqlite3').Database} db  Connexion ouverte.
 * @param {object} options
 * @param {string} options.dir              Dossier des sauvegardes.
 * @param {number} options.retentionDays    Rétention en jours (>= 1).
 * @param {Date}   [options.now=new Date()] Instant de référence (tests).
 * @returns {Promise<{ created: boolean, path: string, stamp: string, deleted: string[] }>}
 *          `created: true` si un nouveau fichier a été produit.
 */
export async function runDailyBackup(
  db,
  { dir, retentionDays, now = new Date() },
) {
  ensureDir(dir)
  const stamp = todayStamp(now)
  const target = backupPathFor(dir, stamp)

  if (fs.existsSync(target)) {
    return { created: false, path: target, stamp, deleted: [] }
  }

  // db.backup() (better-sqlite3) renvoie une Promise et produit un snapshot
  // cohérent même si l'API écrit pendant ce temps (verrou interne SQLite).
  await db.backup(target)

  const deleted = purgeOldBackups(dir, retentionDays, now)
  return { created: true, path: target, stamp, deleted }
}

/**
 * Branche la sauvegarde automatique sur la connexion serveur :
 *   • un catch-up immédiat (si pas de sauvegarde pour aujourd'hui) ;
 *   • un setInterval toutes les `checkIntervalMs` (1h par défaut) pour
 *     reprendre dès que la date du jour change.
 *
 * Les erreurs sont attrapées et loguées via `logger` : la sauvegarde ne doit
 * jamais faire planter le serveur.
 *
 * @param {import('better-sqlite3').Database} db  Connexion ouverte.
 * @param {object} options
 * @param {string} options.dir                      Dossier des sauvegardes.
 * @param {number} [options.retentionDays=7]        Rétention en jours.
 * @param {number} [options.checkIntervalMs=3600000]  Période de vérification.
 * @param {{ log: Function, error: Function }} [options.logger=console]
 *          Logger injectable (utile pour les tests).
 * @returns {{ stop: Function }}  Handle exposant `stop()` pour arrêter le timer
 *          (utile aux tests et à un shutdown propre).
 */
export function scheduleDailyBackup(
  db,
  {
    dir,
    retentionDays = 7,
    checkIntervalMs = 60 * 60 * 1000,
    logger = console,
  },
) {
  // Wrapper qui exécute une passe et logue le résultat sans jamais throw.
  const tick = async () => {
    try {
      const result = await runDailyBackup(db, { dir, retentionDays })
      if (result.created) {
        logger.log(
          `[BACKUP] Snapshot créé : ${path.basename(result.path)}` +
            (result.deleted.length > 0
              ? ` — ${result.deleted.length} ancien(s) fichier(s) purgé(s)`
              : ''),
        )
      }
    } catch (err) {
      logger.error('[BACKUP] Échec de la sauvegarde quotidienne :', err)
    }
  }

  // Catch-up immédiat (non bloquant : on n'attend pas la promesse au boot).
  tick()

  // Vérification périodique pendant que le serveur tourne.
  const handle = setInterval(tick, checkIntervalMs)
  // unref() : ce timer ne doit pas empêcher Node de s'arrêter (ex. CTRL-C).
  if (typeof handle.unref === 'function') handle.unref()

  return {
    stop: () => clearInterval(handle),
  }
}
