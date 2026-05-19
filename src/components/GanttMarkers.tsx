// =============================================================================
// COMPOSANT GanttMarkers — éléments visuels superposés aux barres
// =============================================================================
// Extrait de GanttChart.tsx (refacto (c) audit v2.0). Regroupe les fonctions
// de rendu PURES superposées aux barres : libellés de dates aux extrémités,
// marqueurs SNET (« Ne doit pas démarrer avant le ») et FNLT (« Fin au plus
// tard »).
//
// Toutes ces fonctions sont sans state ni hook : elles prennent une `Task`,
// retournent du JSX pré-positionné absolument dans la ligne courante. Faciles
// à tester individuellement si besoin futur.
// =============================================================================

import { dateToX, snapForwardToWorkingDay } from '../lib/utils'
import type { Task } from '../lib/types'

/** Hauteur fixe d'une ligne (px) — synchronisée avec GanttChart. */
const ROW_HEIGHT = 26

/**
 * v1.11 — Formate une date ISO en libellé court "dd/MM" pour l'affichage
 * sur les barres du Gantt. Conserve l'année implicite (les dates affichées
 * sont dans la fenêtre temporelle courante).
 */
export function formatShortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

/**
 * v1.11 / v1.19 / v1.19.1 — Rend les étiquettes de dates de début et de fin
 * d'une barre du Gantt, positionnées juste en-dehors de la barre. Le rendu
 * est purement visuel : aucune interaction.
 *
 * Options :
 *   • `single = true`  → affiche uniquement la fin (utilisé pour les jalons :
 *                        une seule date à montrer, sur la droite du losange).
 *   • `hideStart = true` → masque la date de début quand on sait qu'elle est
 *                        immédiatement après la fin d'un prédécesseur (la
 *                        flèche fait l'indicateur de début).
 */
export function renderDateLabels(
  leftPx: number,
  widthPx: number,
  startIso: string,
  endIso: string,
  single = false,
  hideStart = false,
) {
  // v1.19 — Style noir gras sur fond blanc semi-opaque : reste lisible
  // au-dessus des cellules week-end grisées ET au-dessus des flèches
  // prédécesseur qui passent désormais SOUS les barres (cf. PredecessorArrows
  // déplacé avant la map des tâches). Le fond mini-pill masque le segment
  // de flèche qui croise l'étiquette, supprimant le chevauchement illisible
  // signalé en v1.18.
  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    top: ROW_HEIGHT / 2 - 7,
    fontSize: 10,
    lineHeight: '14px',
    fontWeight: 600,
    color: '#0f172a', // slate-900
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    background: 'rgba(255,255,255,0.92)',
    padding: '0 3px',
    borderRadius: 2,
    // v1.19.2 — z-index 3 : au-dessus des barres (2) et des flèches (1).
    zIndex: 3,
  }
  return (
    <>
      {!single && !hideStart && (
        <span
          style={{
            ...baseStyle,
            // Aligné à droite contre le bord gauche de la barre.
            left: leftPx - 4,
            transform: 'translateX(-100%)',
          }}
        >
          {formatShortDate(startIso)}
        </span>
      )}
      <span
        style={{
          ...baseStyle,
          left: leftPx + widthPx + 4,
        }}
      >
        {formatShortDate(endIso)}
      </span>
    </>
  )
}

/**
 * v1.24 — Rend un petit triangle gris discret pour matérialiser la contrainte
 * SNET « Ne doit pas démarrer avant le » d'une activité ou d'un jalon. Le
 * triangle est positionné au centre de la cellule du jour de démarrage au plus
 * tôt (ou du prochain jour ouvré quand la date de démarrage au plus tôt tombe
 * un week-end / férié), juste sous la baseline de la barre. Aucune
 * interaction : c'est un repère pur.
 *
 * @param task         Tâche à examiner (rien rendu si pas de SNET ou phase).
 * @param windowStart  Borne gauche du calendrier.
 * @param dayWidth     Largeur d'un jour en pixels.
 */
export function renderNotBeforeMarker(
  task: Task,
  windowStart: string,
  dayWidth: number,
) {
  if (task.kind === 'phase' || !task.not_before_date) return null
  // Snap au prochain jour ouvré pour matérialiser ce que le serveur applique.
  const snapped = snapForwardToWorkingDay(task.not_before_date)
  const left = dateToX(snapped, windowStart, dayWidth) + dayWidth / 2 - 4
  return (
    <div
      aria-hidden
      title={`Ne doit pas démarrer avant le ${task.not_before_date}${
        snapped !== task.not_before_date ? ` (appliqué au ${snapped})` : ''
      }`}
      style={{
        position: 'absolute',
        left,
        bottom: 2,
        width: 0,
        height: 0,
        borderLeft: '4px solid transparent',
        borderRight: '4px solid transparent',
        // Triangle pointant vers le HAUT : la pointe « accroche » la base de
        // la barre pour signaler la borne basse temporelle.
        borderBottom: '6px solid #94a3b8', // slate-400
        opacity: 0.85,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    />
  )
}

/**
 * v2.0 / F4 — Rend un petit triangle gris discret pour matérialiser la
 * contrainte FNLT « Fin au plus tard » d'une activité ou d'un jalon.
 * Positionné au centre de la cellule de la deadline, sous la baseline de la
 * barre. Sœur jumelle de `renderNotBeforeMarker` mais pour la borne haute.
 *
 * Si la date de fin calculée DÉPASSE la FNLT, on bascule la couleur du
 * triangle en rouge pour matérialiser le signal d'alerte (cohérent avec le
 * bandeau de cohérence). Aucune interaction : c'est un repère pur.
 *
 * @param task         Tâche à examiner (rien rendu si pas de FNLT ou phase).
 * @param windowStart  Borne gauche du calendrier.
 * @param dayWidth     Largeur d'un jour en pixels.
 */
export function renderFnltMarker(
  task: Task,
  windowStart: string,
  dayWidth: number,
) {
  if (task.kind === 'phase' || !task.not_later_than_date) return null
  const left =
    dateToX(task.not_later_than_date, windowStart, dayWidth) + dayWidth / 2 - 4
  const isOverrun = task.end_date > task.not_later_than_date
  return (
    <div
      aria-hidden
      title={
        isOverrun
          ? `⚠ Deadline dépassée — fin au plus tard : ${task.not_later_than_date}, fin calculée : ${task.end_date}`
          : `Fin au plus tard : ${task.not_later_than_date}`
      }
      style={{
        position: 'absolute',
        left,
        bottom: 2,
        width: 0,
        height: 0,
        borderLeft: '4px solid transparent',
        borderRight: '4px solid transparent',
        // Triangle pointant vers le HAUT : la pointe « accroche » la base de
        // la barre pour signaler la borne HAUTE temporelle (deadline).
        // Rouge en cas de dépassement, gris sinon (= deadline encore tenue).
        borderBottom: isOverrun
          ? '6px solid #dc2626' // red-600 : alerte
          : '6px solid #94a3b8', // slate-400 : info neutre
        opacity: 0.85,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    />
  )
}
