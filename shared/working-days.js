// =============================================================================
// HELPERS « JOURS OUVRÉS » — module PARTAGÉ front ↔ serveur
// =============================================================================
// Plain JavaScript (pas de TS) pour pouvoir être importé identiquement par :
//   • le serveur Node ES (db/, server/)
//   • le front Vite + TypeScript (src/lib/utils.ts)
//
// Toutes les fonctions ici raisonnent en strings ISO `YYYY-MM-DD` — donc
// indépendantes du fuseau et du type Date natif. La conversion Date ↔ ISO
// est faite à la frontière du module appelant.
//
// Une seule source de vérité pour :
//   • Jours fériés français (algorithme grégorien anonyme de Pâques + 8 fixes).
//   • Arithmétique de date en ISO (add/snap/working-days-between).
//   • Calcul de la date de début d'un successeur (computeSuccessorStart).
// =============================================================================

/** Cache (year → Set<ISO>) des fériés FR, calculé à la demande. */
const FRENCH_HOLIDAYS_CACHE = new Map()

/**
 * Indique si une date ISO tombe un week-end (samedi/dimanche),
 * en se basant sur le fuseau LOCAL.
 *
 * @param {string} iso   YYYY-MM-DD
 * @returns {boolean}
 */
export function isWeekendIso(iso) {
  // 'T00:00:00' force une interprétation en heure locale (sans 'Z'),
  // évitant les décalages de fuseau qui pourraient déplacer le jour.
  const dow = new Date(iso + 'T00:00:00').getDay()
  return dow === 0 || dow === 6
}

/**
 * Calcule la date du dimanche de Pâques pour une année donnée
 * (algorithme grégorien anonyme / Meeus-Jones-Butcher).
 *
 * @param {number} year   Année grégorienne.
 * @returns {{month:number, day:number}}  Mois 1-based, jour 1-based.
 */
export function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  return { month: Math.floor(n / 31), day: (n % 31) + 1 }
}

/**
 * Renvoie un `Set` des dates ISO fériées en France pour une année donnée
 * (8 fixes + 3 mobiles dérivés de Pâques).
 *
 * @param {number} year
 * @returns {Set<string>}
 */
export function frenchHolidaysOf(year) {
  const cached = FRENCH_HOLIDAYS_CACHE.get(year)
  if (cached) return cached
  const pad = (n) => String(n).padStart(2, '0')
  const set = new Set([
    `${year}-01-01`, // Jour de l'An
    `${year}-05-01`, // Fête du Travail
    `${year}-05-08`, // Victoire 1945
    `${year}-07-14`, // Fête nationale
    `${year}-08-15`, // Assomption
    `${year}-11-01`, // Toussaint
    `${year}-11-11`, // Armistice 1918
    `${year}-12-25`, // Noël
  ])
  const e = easterSunday(year)
  const easterIso = `${year}-${pad(e.month)}-${pad(e.day)}`
  set.add(addDaysIso(easterIso, 1)) // Lundi de Pâques
  set.add(addDaysIso(easterIso, 39)) // Ascension
  set.add(addDaysIso(easterIso, 50)) // Lundi de Pentecôte
  FRENCH_HOLIDAYS_CACHE.set(year, set)
  return set
}

/**
 * Indique si une date ISO tombe un jour férié français.
 *
 * @param {string} iso   YYYY-MM-DD
 * @returns {boolean}
 */
export function isFrenchHolidayIso(iso) {
  const year = Number(iso.slice(0, 4))
  return frenchHolidaysOf(year).has(iso)
}

/**
 * Prédicat unifié « jour non ouvré » = week-end OU jour férié français.
 *
 * @param {string} iso   YYYY-MM-DD
 * @returns {boolean}
 */
export function isNonWorkingDayIso(iso) {
  return isWeekendIso(iso) || isFrenchHolidayIso(iso)
}

/**
 * Avance ou recule une date ISO de N jours calendaires.
 *
 * @param {string} iso    YYYY-MM-DD
 * @param {number} days   Entier (négatif autorisé).
 * @returns {string}      YYYY-MM-DD
 */
export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/**
 * Si iso est non-ouvré (week-end ou férié français), le pousse au jour ouvré
 * suivant (sinon inchangé).
 *
 * @param {string} iso  YYYY-MM-DD
 * @returns {string}
 */
export function snapForwardToWorkingDayIso(iso) {
  let cur = iso
  while (isNonWorkingDayIso(cur)) cur = addDaysIso(cur, 1)
  return cur
}

/**
 * Si iso est non-ouvré, le recule au jour ouvré précédent (sinon inchangé).
 *
 * @param {string} iso  YYYY-MM-DD
 * @returns {string}
 */
export function snapBackwardToWorkingDayIso(iso) {
  let cur = iso
  while (isNonWorkingDayIso(cur)) cur = addDaysIso(cur, -1)
  return cur
}

/**
 * Compte les jours OUVRÉS inclus dans [start, end] (hors week-ends et fériés FR).
 *
 * @param {string} start  YYYY-MM-DD
 * @param {string} end    YYYY-MM-DD
 * @returns {number}
 */
export function workingDaysBetweenIso(start, end) {
  if (!start || !end || end < start) return 0
  let count = 0
  let cur = start
  while (cur <= end) {
    if (!isNonWorkingDayIso(cur)) count++
    cur = addDaysIso(cur, 1)
  }
  return count
}

/**
 * Ajoute `charge` jours OUVRÉS à partir de start et renvoie la date de fin
 * (incluse). Saute week-ends ET jours fériés français.
 *
 * @param {string} start   YYYY-MM-DD
 * @param {number} charge  Nombre de jours ouvrés (≥ 1).
 * @returns {string}       YYYY-MM-DD (fin incluse).
 */
export function addWorkingDaysIso(start, charge) {
  if (charge <= 1) return start
  let cur = start
  let count = isNonWorkingDayIso(cur) ? 0 : 1
  while (count < charge) {
    cur = addDaysIso(cur, 1)
    if (!isNonWorkingDayIso(cur)) count++
  }
  return cur
}

/**
 * Calcule la date de début d'un successeur Y à partir de la fin de son
 * prédécesseur X et d'un délai (jours ouvrés).
 *
 * Sémantique : `lag = N` impose N jours ouvrés STRICTEMENT entre `predEnd`
 * et `start` (= minimum d'attente).
 *   • lag = 0 → Y.start = base (= jour ouvré snappé de X.end).
 *   • lag = N ≥ 1 → Y.start = (N+1)-ième jour ouvré STRICTEMENT après X.end.
 *
 * @param {string} predEnd  Date de fin du prédécesseur (YYYY-MM-DD).
 * @param {number} lag      Délai en jours ouvrés (≥ 0).
 * @returns {string}        Date de début du successeur (YYYY-MM-DD).
 */
export function computeSuccessorStartIso(predEnd, lag) {
  const base = snapForwardToWorkingDayIso(predEnd)
  if (lag <= 0) return base
  // lag + 2 (au lieu de lag + 1) : on veut N jours ouvrés STRICTEMENT entre
  // base et start, sans compter base ni start dans le décompte.
  return addWorkingDaysIso(base, lag + 2)
}
