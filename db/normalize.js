// =============================================================================
// NORMALISATION SERVEUR — filets de sécurité sur les champs entrants
// =============================================================================
// Ces helpers ramènent toujours une valeur cohérente même quand le payload est
// invalide (mauvais type, format hors-spec, etc.). Ils s'appliquent EN PLUS de
// la validation Zod côté API : la validation Zod rejette en amont, ces helpers
// servent de DERNIÈRE LIGNE de défense côté DAL (pour les chemins qui
// court-circuiteraient Zod : seeds, replaceFullState, scripts d'admin).
// =============================================================================

/**
 * v1.24 — Priorité (1..5) avec règle Pr2.
 *
 * Règle métier Pr2 (v1.24) : la priorité est **obligatoire** sur les activités
 * (kind='task'), avec **3 comme valeur par défaut**. Sur les jalons et les
 * phases, la priorité **n'a pas de sens** et vaut toujours `null`.
 *
 * Toute valeur invalide (NaN, hors-bornes, type incompatible) est remplacée :
 *   • pour une activité → 3 (défaut métier),
 *   • pour un jalon / une phase → null.
 *
 * @param {unknown} raw   Valeur reçue dans le payload.
 * @param {string}  kind  Type de la tâche ('task' | 'milestone' | 'phase').
 * @returns {number|null}
 */
export function normalizePriority(raw, kind) {
  if (kind !== 'task') return null
  if (raw === undefined || raw === null) return 3
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1 || n > 5) return 3
  return n
}

/**
 * Helper commun pour SNET et FNLT (factorisé pour sonarjs/no-identical-functions).
 * Normalise une date contrainte facultative :
 *   • Phase → toujours null.
 *   • Valeur absente / vide / type incorrect → null.
 *   • Format hors ISO `YYYY-MM-DD` → null.
 *   • Sinon → valeur conservée telle quelle (le snap éventuel se fait ailleurs).
 *
 * @param {unknown} raw
 * @param {string}  kind
 * @returns {string|null}
 */
export function normalizeOptionalIsoDate(raw, kind) {
  if (kind === 'phase') return null
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  return raw
}

/**
 * v1.24 — Normalise la date de démarrage au plus tôt SNET (« Ne doit pas démarrer avant le »).
 *
 * Règle métier SNET :
 *   • Activités et jalons : valeur facultative au format `YYYY-MM-DD`, ou
 *     `null` quand aucune contrainte.
 *   • Phases : toujours `null` (la phase est une synthèse de ses enfants).
 *   • Toute valeur de format invalide est ignorée (ramenée à `null`).
 *
 * @param {unknown} raw   Valeur reçue dans le payload.
 * @param {string}  kind  Type de la tâche.
 * @returns {string|null} Date ISO normalisée ou null.
 */
export function normalizeNotBeforeDate(raw, kind) {
  return normalizeOptionalIsoDate(raw, kind)
}

/**
 * v2.0 / F4 — Normalise la date FNLT (« Fin au plus tard »).
 *
 * Règle métier symétrique au SNET :
 *   • Activités et jalons : valeur facultative au format `YYYY-MM-DD`, ou
 *     `null` quand aucune deadline imposée.
 *   • Phases : toujours `null` (dates dérivées des enfants).
 *   • Toute valeur de format invalide est ignorée (ramenée à `null`).
 *
 * Note : aucun enforcement sur les dates ici. Le FNLT est **non bloquant** —
 * il sert uniquement à la détection de dépassement côté UI (bandeau de
 * cohérence + icône sur la barre).
 *
 * @param {unknown} raw   Valeur reçue dans le payload.
 * @param {string}  kind  Type de la tâche.
 * @returns {string|null} Date ISO normalisée ou null.
 */
export function normalizeNotLaterThanDate(raw, kind) {
  return normalizeOptionalIsoDate(raw, kind)
}
