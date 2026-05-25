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
