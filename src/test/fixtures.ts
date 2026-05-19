// =============================================================================
// FIXTURES PARTAGÉES — Helpers de construction d'objets pour les tests
// =============================================================================
// v2.0 / Refacto (f) — Avant ce module, chaque fichier de test redéfinissait
// son propre `mkTask` (≈ 14 champs Task à recopier à chaque évolution du
// type). Le risque : ajouter un champ obligatoire à `Task` cassait 6 tests
// d'un coup parce qu'aucun fixture ne le portait. Cette mutualisation
// centralise la fabrication des objets de test : ajouter un champ ne touche
// qu'un seul endroit.
//
// Convention :
//   • `mkTask(overrides)` retourne une tâche MINIMALE conforme au type Task,
//     avec des dates volontairement « banales » (1ère semaine de mai 2026,
//     hors WE / fériés). Les tests qui ont besoin de dates spécifiques
//     passent `start_date` / `end_date` dans `overrides`.
//   • `mkCollab(overrides)` retourne un collaborateur minimal. Pas de
//     `position` automatique : à passer si plusieurs collabs sont créés
//     dans le même test.
//
// Pourquoi pas une factory plus « complète » ? On veut que chaque test
// reste lisible : si une tâche a besoin d'un prédécesseur ou d'une priorité,
// l'override le rend explicite. La fixture ne doit pas masquer ce qui est
// signifiant.
// =============================================================================

import type { Collaborator, Task } from '../lib/types'

/**
 * Fabrique une tâche minimale conforme au type `Task`.
 *
 * Valeurs par défaut :
 *   • `id='t'`, `name='T'`, `kind='task'`
 *   • Fenêtre [2026-05-01, 2026-05-05] (mai 2026, semaine sans WE/férié
 *     pour ne pas perturber les calculs jours-ouvrés involontairement).
 *   • Tous les champs nullables / optionnels = null / 0.
 *   • `project_id='p_test'` (jeton conventionnel pour les tests mono-projet).
 *
 * @param overrides — Champs à écraser. `name` n'est PAS dérivé de `id` :
 *   passe les deux explicitement si tu veux qu'ils diffèrent.
 */
export function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    name: 'T',
    kind: 'task',
    start_date: '2026-05-01',
    end_date: '2026-05-05',
    progress: 0,
    collaborator_id: null,
    color: null,
    parent_id: null,
    // v1.21+/v1.22 — `predecessors` (liste N:M) remplace l'ancien couple
    // `predecessor_id` / `predecessor_lag`. On porte [] par défaut pour
    // que les composants qui itèrent dessus ne pètent pas.
    predecessors: [],
    predecessor_id: null,
    predecessor_lag: 0,
    priority: null,
    not_before_date: null,
    not_later_than_date: null,
    charge_jours: null,
    position: 0,
    project_id: 'p_test',
    ...overrides,
  }
}

/**
 * Fabrique un collaborateur minimal conforme au type `Collaborator`.
 *
 * Valeurs par défaut :
 *   • `id='c1'`, `name='Alice'`, `color='#3b82f6'` (bleu Tailwind),
 *     `position=0`.
 *
 * Pour plusieurs collabs dans le même test, passe `id`, `name` et
 * `position` distincts à chaque appel.
 */
export function mkCollab(overrides: Partial<Collaborator> = {}): Collaborator {
  return {
    id: 'c1',
    name: 'Alice',
    color: '#3b82f6',
    position: 0,
    ...overrides,
  }
}
