// =============================================================================
// TYPES partagés frontend — Gantt v1
// =============================================================================
// Reproduisent à l'identique le format renvoyé par l'API (`GET /api/state`).
// =============================================================================

/**
 * Type d'une entrée de planning :
 *   • 'task'      = tâche normale (barre)
 *   • 'milestone' = jalon ponctuel (losange)
 *   • 'phase'     = regroupement (v1.6) : dates auto-calculées
 *                   depuis les enfants (MIN début / MAX fin), pas de
 *                   collaborateur ni de prédécesseur.
 */
export type TaskKind = 'task' | 'milestone' | 'phase'

/** Un collaborateur affectable à des tâches. */
export interface Collaborator {
  /** Identifiant unique (string libre, généré côté client lors de la création). */
  id: string
  /** Nom affiché. */
  name: string
  /** Couleur hex de la pastille (et des tâches affectées par défaut). */
  color: string
  /** Position d'affichage (ordre dans les listes). */
  position: number
}

/** Un projet (v1.8) — regroupe phases, jalons et activités. */
export interface Project {
  /** Identifiant unique. */
  id: string
  /** Nom affiché. */
  name: string
  /** Position d'affichage dans le sélecteur. */
  position: number
}

/** Une tâche ou un jalon dans le Gantt. */
export interface Task {
  /** Identifiant unique. */
  id: string
  /** Libellé affiché. */
  name: string
  /** 'task' = barre, 'milestone' = losange. */
  kind: TaskKind
  /** Date de début YYYY-MM-DD. */
  start_date: string
  /** Date de fin YYYY-MM-DD (== start_date si jalon). */
  end_date: string
  /** Avancement 0..100 (en %). */
  progress: number
  /** Collaborateur responsable (null si non affectée). */
  collaborator_id: string | null
  /** Couleur custom de la barre (sinon : couleur du collab, sinon défaut). */
  color: string | null
  /** Tâche parent (regroupement en phases). */
  parent_id: string | null
  /** Tâche prédécesseur (v1.2) : si défini, start_date == end_date du prédécesseur. */
  predecessor_id: string | null
  /** Position d'affichage (ordre des lignes). */
  position: number
  /** Projet de rattachement (v1.8). */
  project_id: string
}

/** État complet renvoyé par GET /api/state?project_id=…. */
export interface GanttState {
  version: number
  /** Projet actuellement chargé (null si la base est vide). */
  current_project_id: string | null
  /** Tous les projets disponibles (pour le sélecteur). */
  projects: Project[]
  collaborators: Collaborator[]
  /** Tâches du projet courant uniquement. */
  tasks: Task[]
}
