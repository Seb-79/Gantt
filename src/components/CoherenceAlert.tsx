// =============================================================================
// COMPOSANT CoherenceAlert — Gantt v1.21 (v2.2 : Replan partiel abandonné)
// =============================================================================
// Bandeau (et non popup) affiché AU-DESSUS du planning quand `checkCoherence`
// remonte au moins une incohérence (surcharge, prédécesseur, priorité).
//
// v2.2 — RG-GANTT-0905 (Replan partiel) abandonnée : un seul bouton « Replan
// complet » qui replanifie l'intégralité du projet.
//
// v2.3 (2026-05-27) — Le bouton « Replan complet » est masqué quand TOUTES les
// issues affichées ont `fixableByReplan === false` (typiquement : conflit de
// priorité impliquant une tâche terminée à 100 % donc figée par le moteur).
// Évite de proposer un Replan qui n'aurait aucun effet.
//
// Le bandeau disparaît automatiquement quand `issues.length === 0`.
// =============================================================================

import type { CoherenceIssue } from '../lib/utils'

interface Props {
  /** Incohérences à afficher (cf. `checkCoherence`). Vide → bandeau caché. */
  issues: CoherenceIssue[]
  /** Lance un Replan (toutes les tâches sont candidates au déplacement). */
  onReplan: () => void
}

/**
 * v1.21 / v2.2 — Affiche un bandeau d'alerte récapitulant les incohérences du
 * projet. Couleur :
 *   • rouge (erreur)   si au moins une issue `severity === 'error'`
 *   • orange (warning) sinon (priorité seule).
 *
 * v2.3 (2026-05-27) — Masque le bouton Replan quand AUCUNE issue affichée
 * n'est corrigeable par Replan (toutes ont `fixableByReplan === false`).
 *
 * @param issues    Issues à afficher (Vide → rend `null`).
 * @param onReplan  Handler du bouton « Replan complet ».
 */
export default function CoherenceAlert({ issues, onReplan }: Props) {
  if (issues.length === 0) return null
  const hasError = issues.some((i) => i.severity === 'error')
  // v2.3 (2026-05-27) — Le bouton n'a de sens que s'il existe au moins une
  // issue que le Replan peut potentiellement corriger. Une issue sans flag
  // explicite est considérée corrigeable (rétrocompat).
  const showReplanButton = issues.some((i) => i.fixableByReplan !== false)
  // Palette : rouge si au moins une erreur, orange sinon.
  const palette = hasError
    ? {
        wrapper: 'border-red-300 bg-red-50',
        header: 'text-red-800',
        bullet: 'text-red-600',
      }
    : {
        wrapper: 'border-amber-300 bg-amber-50',
        header: 'text-amber-800',
        bullet: 'text-amber-600',
      }
  return (
    <div
      role="alert"
      aria-label="Incohérences détectées"
      className={[
        'mb-3 rounded-lg border px-3 py-2 text-sm shadow-sm',
        palette.wrapper,
      ].join(' ')}
      data-testid="coherence-alert"
    >
      <div className="flex items-start gap-2">
        <span className="text-base leading-none" aria-hidden="true">
          ⚠️
        </span>
        <div className="flex-1 min-w-0">
          <div className={['font-semibold mb-1', palette.header].join(' ')}>
            {issues.length} incohérence{issues.length > 1 ? 's' : ''} détectée
            {issues.length > 1 ? 's' : ''} dans le planning
          </div>
          {/* Liste des messages. Limitée visuellement à 5 lignes via
              max-h + overflow pour ne pas bouffer la place du Gantt sur les
              gros projets ; le reste se révèle au scroll. */}
          <ul className="space-y-0.5 max-h-24 overflow-y-auto pr-1">
            {issues.map((issue, idx) => (
              <li
                key={`${issue.kind}-${issue.taskIds.join('-')}-${idx}`}
                className="text-slate-700 text-xs flex gap-1.5"
              >
                <span
                  className={['shrink-0 font-bold', palette.bullet].join(' ')}
                  aria-hidden="true"
                >
                  •
                </span>
                <span className="min-w-0">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
        {showReplanButton && (
          <div className="flex flex-col gap-1 shrink-0">
            <button
              type="button"
              className="h-7 px-2 text-xs rounded border border-slate-300 bg-white hover:bg-slate-100 whitespace-nowrap"
              onClick={onReplan}
              title="Replanifier l'intégralité du projet"
            >
              🔄 Replan complet
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
