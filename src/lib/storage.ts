// =============================================================================
// storage.ts — v2.2
// =============================================================================
// Helpers de persistance localStorage pour les préférences utilisateur scopées
// par projet. En l'absence d'authentification dans la stack actuelle (LAN
// partagé sans identité utilisateur), la persistance est « par navigateur ×
// projet ».
//
// En cas d'indisponibilité de localStorage (SSR, mode privé bloqué), les
// getters retournent la valeur par défaut sans erreur.
// =============================================================================

/**
 * Construit la clé localStorage pour le toggle « Planification anticipée »
 * d'un projet donné (RG-GANTT-1910).
 */
const KEY_ADVANCE_PLANNING = (projectId: string): string =>
  `gantt:advance-planning:${projectId}`

/**
 * v2.2 / RG-V (RG-GANTT-1910) — Lit le toggle « Planification anticipée »
 * pour un projet. Par défaut : `false`.
 *
 * @param projectId Id du projet courant.
 * @returns         `true` si le mode anticipé est activé, `false` sinon.
 */
export function getAdvancePlanning(projectId: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(KEY_ADVANCE_PLANNING(projectId)) === 'true'
  } catch {
    return false
  }
}

/**
 * v2.2 / RG-V (RG-GANTT-1910) — Écrit le toggle « Planification anticipée »
 * pour un projet. Silencieux si localStorage est indisponible ou plein.
 *
 * @param projectId Id du projet courant.
 * @param value     Nouvelle valeur du toggle.
 */
export function setAdvancePlanning(projectId: string, value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY_ADVANCE_PLANNING(projectId), String(value))
  } catch {
    // Silencieux : si le stockage est plein ou inaccessible, on continue
    // sans planter le composant appelant.
  }
}

/**
 * État d'affichage du bandeau d'alerte de cohérence (cf. `CoherenceAlert`) :
 *   • 'expanded'     → bandeau complet (défaut).
 *   • 'collapsed'    → replié en pastille ⚠️.
 *   • 'acknowledged' → acquitté, masqué.
 */
export type AlertDisplay = 'expanded' | 'collapsed' | 'acknowledged'

/**
 * Construit la clé localStorage pour l'état d'affichage de l'alerte de
 * cohérence d'un projet donné.
 */
const KEY_ALERT_DISPLAY = (projectId: string): string =>
  `gantt:alert-display:${projectId}`

/** Valeurs valides — garde-fou contre une valeur stockée corrompue. */
const ALERT_DISPLAY_VALUES: readonly AlertDisplay[] = [
  'expanded',
  'collapsed',
  'acknowledged',
]

/**
 * Lit l'état d'affichage de l'alerte de cohérence pour un projet. Par défaut
 * (ou si la valeur stockée est invalide / localStorage indisponible) :
 * `'expanded'`.
 *
 * @param projectId Id du projet courant.
 * @returns         L'état mémorisé, ou `'expanded'`.
 */
export function getAlertDisplay(projectId: string): AlertDisplay {
  try {
    if (typeof localStorage === 'undefined') return 'expanded'
    const v = localStorage.getItem(KEY_ALERT_DISPLAY(projectId))
    return ALERT_DISPLAY_VALUES.includes(v as AlertDisplay)
      ? (v as AlertDisplay)
      : 'expanded'
  } catch {
    return 'expanded'
  }
}

/**
 * Écrit l'état d'affichage de l'alerte de cohérence pour un projet.
 * Silencieux si localStorage est indisponible ou plein.
 *
 * @param projectId Id du projet courant.
 * @param value     Nouvel état d'affichage.
 */
export function setAlertDisplay(projectId: string, value: AlertDisplay): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY_ALERT_DISPLAY(projectId), value)
  } catch {
    // Silencieux : si le stockage est plein ou inaccessible, on continue
    // sans planter le composant appelant.
  }
}
