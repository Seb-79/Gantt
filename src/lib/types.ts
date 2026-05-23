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

/**
 * v2.2 / F3 (refondu) — État de filtre projet :
 *
 *   • 'single'  : un seul projet visible. Le projet visé est porté par
 *                 `projectId`. Disponible sur toutes les vues.
 *   • 'all'     : tous les projets agrégés (vue globale). Disponible
 *                 uniquement sur Charge et Affectation. Indisponible sur
 *                 Gantt (mono-projet par design) et Congés (cross-projet
 *                 par nature, donc le sélecteur est masqué).
 *
 * Le mode 'subset' (multi-sélection partielle) a été supprimé après
 * clarification du besoin : la dichotomie « un projet OU tous » couvre
 * tous les cas d'usage métier identifiés.
 *
 * Persisté en localStorage sous la clé `gantt.projectSelection`.
 */
export type ProjectSelection =
  | { mode: 'single'; projectId: string }
  | { mode: 'all' }

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
  /** Collaborateur responsable (null si non affectée).
   *  v2.0 / F6 — Reste alimenté comme alias rétro-compat (= 1er affecté par
   *  ordre alpha sur `collaborators[]`). Pour le multi-collab, lire
   *  `collaborators[]` directement. */
  collaborator_id: string | null
  /** v2.0 / F6 — Liste des collaborateurs affectés (multi-collab).
   *  Tableau toujours présent (vide pour les jalons et les phases).
   *  Source de vérité pour le moteur de calcul de fin et le plan de charge. */
  collaborators?: { id: string }[]
  /** v2.0 / F6 — Tableau d'ids envoyé au serveur lors d'un save (POST/PATCH
   *  Task). Côté lecture (GET /api/state), `collaborators[]` est la source.
   *  Conservé optionnel pour les fixtures de tests qui ne le posent pas. */
  collaborator_ids?: string[]
  /** Couleur custom de la barre (sinon : couleur du collab, sinon défaut). */
  color: string | null
  /** Tâche parent (regroupement en phases). */
  parent_id: string | null
  /** v1.21 — Liste des prédécesseurs (N:M). Une tâche peut avoir 0..N
   *  prédécesseurs, chacun avec son propre lag (jours ouvrés). Sa start_date
   *  effective est MAX(pred.end + lag) sur tous les liens.
   *  Tableau toujours présent (jamais null/undefined) côté serveur ; optionnel
   *  dans le type pour permettre aux tests legacy de forger des tâches sans
   *  ce champ. À durcir en `Task` (non-optionnel) une fois tous les tests migrés. */
  predecessors?: { id: string; lag: number }[]
  /** v1.2 / v1.21 — Alias rétro-compat : 1er prédécesseur de la liste
   *  (tri par id ASC) ou null. Retiré à la v1.22 — utiliser `predecessors`. */
  predecessor_id: string | null
  /** v1.10 / v1.21 — Alias rétro-compat : lag du 1er prédécesseur ou 0.
   *  Retiré à la v1.22 — utiliser `predecessors`. */
  predecessor_lag: number
  /** v1.18 / v1.24 — Priorité 1..5. Obligatoire sur les activités (3 par défaut) ;
   *  `null` pour les jalons et les phases. Sans effet sur l'affichage :
   *  utilisée uniquement par « Replan ». */
  priority: number | null
  /** v1.24 — Contrainte SNET « Ne doit pas démarrer avant le » : date de démarrage au plus tôt
   *  ISO YYYY-MM-DD facultative en dessous de laquelle la tâche ne peut pas
   *  commencer. `null` = pas de contrainte. Toujours `null` pour les phases. */
  not_before_date: string | null
  /** v2.0 / F4 — Contrainte FNLT « Fin au plus tard » : date de fin AU PLUS
   *  TARD souhaitée (deadline). NON BLOQUANTE : si la date de fin calculée
   *  dépasse cette valeur, c'est seulement signalé visuellement. `null` =
   *  pas de deadline. Toujours `null` pour les phases. */
  not_later_than_date: string | null
  /** v2.0 — Charge en jours ouvrés (≥ 1) d'une activité. Source de vérité :
   *  `end_date` est dérivée de `addWorkingDays(start_date, charge_jours)`.
   *  `null` pour les jalons et les phases (pas de notion de charge propre). */
  charge_jours: number | null
  /** Position d'affichage (ordre des lignes). */
  position: number
  /** Projet de rattachement (v1.8). */
  project_id: string
}

/** v2.0 / F2 — Une période d'allocation d'un membre sur un projet. */
export interface MemberAllocation {
  /** Identifiant unique (surrogate, généré côté serveur). */
  id: string
  /** Projet concerné. */
  project_id: string
  /** Collaborateur concerné (doit être membre du projet). */
  collaborator_id: string
  /** Date de début de la période (incluse), YYYY-MM-DD. */
  start_date: string
  /** Date de fin de la période (incluse), YYYY-MM-DD. */
  end_date: string
  /** Pourcentage ∈ {25, 50, 75, 100}. */
  allocation_pct: number
}

/** v2.0 / F3 — Un congé (cross-projet) posé par un collaborateur sur une
 *  date donnée. La fraction représente la part de journée NON travaillée
 *  (Q8b multiplicatif : capacité = pct × (1 − fraction)). */
export interface CollaboratorAbsence {
  collaborator_id: string
  /** Date ISO YYYY-MM-DD. */
  date: string
  /** Fraction non-travaillée ∈ {0.25, 0.5, 0.75, 1}. */
  fraction: number
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
  /** v2.0 / F1 — Ids des collaborateurs membres du projet courant. Sert à
   *  filtrer la dropdown du TaskEditor et à alimenter l'onglet « Affectation
   *  projet ». Vide si aucun projet courant. */
  current_project_members: string[]
  /** v2.0 / F2 — Toutes les périodes d'allocation du projet courant (toutes
   *  paires collab/période confondues). Consommée par le moteur de calcul de
   *  fin (computeEndFromCharge), le plan de charge pondéré et l'UI. */
  member_allocations: MemberAllocation[]
  /** v2.0 / F5 — Allocations cross-projet : nécessaires pour calculer la
   *  capacité totale d'un collab (Σ pct sur tous projets). Utilisée par le
   *  plan de charge pour positionner les seuils de coloration (« surcharge
   *  ssi charge > capacité totale »). */
  all_member_allocations: MemberAllocation[]
  /** v2.2 / F5 — Memberships cross-projet : tous les couples (project_id,
   *  collaborator_id) existants. Consommé par la vue « Affectation × Tous
   *  les projets » qui rend la matrice croisée. */
  all_project_members: { project_id: string; collaborator_id: string }[]
  /** v2.0 / F3 — Toutes les absences (cross-projet) de tous les collabs.
   *  Diminue multiplicativement la capacité quotidienne (Q8b). Saisie et
   *  affichée dans l'onglet « Congés ». */
  collaborator_absences: CollaboratorAbsence[]
}
