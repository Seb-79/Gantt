// =============================================================================
// DEMO_STATE — Données de démonstration chargées au 1er démarrage
// =============================================================================
// Inspirées de l'exemple "Video Production Template" fourni à la création du
// projet. Utilisé par `resetToDemo` et le bouton « ↺ Restaurer démo » de l'UI.
// =============================================================================

import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from './migrations.js'

/**
 * État de démo : 1 projet, 3 collaborateurs, 3 phases (pré-prod / tournage /
 * post-prod) avec leurs activités enfants et 2 jalons de validation.
 */
export const DEMO_STATE = {
  // v1.8 — Le jeu de démo s'inscrit dans un projet "Projet 1" unique.
  projects: [{ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME }],
  collaborators: [
    { id: 'c1', name: 'Alice', color: '#3b82f6' },
    { id: 'c2', name: 'Benoît', color: '#10b981' },
    { id: 'c3', name: 'Camille', color: '#f59e0b' },
  ],
  tasks: [
    // Phase 1
    {
      // v1.6 — kind 'phase' : dates auto-calculées depuis les enfants
      id: 't1',
      name: 'Pré-production',
      kind: 'phase',
      start_date: '2026-05-15',
      end_date: '2026-06-30',
      progress: 0,
    },
    {
      id: 't1a',
      name: 'Recherche audience',
      kind: 'task',
      start_date: '2026-05-15',
      end_date: '2026-05-29',
      progress: 100,
      collaborator_id: 'c1',
      parent_id: 't1',
    },
    {
      id: 't1b',
      name: 'Définir le message',
      kind: 'task',
      start_date: '2026-05-25',
      end_date: '2026-06-05',
      progress: 100,
      collaborator_id: 'c1',
      parent_id: 't1',
    },
    {
      id: 't1c',
      name: 'Écrire le script',
      kind: 'task',
      start_date: '2026-06-01',
      end_date: '2026-06-15',
      progress: 80,
      collaborator_id: 'c2',
      parent_id: 't1',
    },
    {
      id: 't1d',
      name: 'Storyboard',
      kind: 'task',
      start_date: '2026-06-10',
      end_date: '2026-06-25',
      progress: 30,
      collaborator_id: 'c2',
      parent_id: 't1',
    },
    {
      id: 'm1',
      name: 'Validation pré-production',
      kind: 'milestone',
      start_date: '2026-06-30',
      parent_id: 't1',
    },

    // Phase 2
    {
      id: 't2',
      name: 'Tournage',
      kind: 'phase',
      start_date: '2026-07-01',
      end_date: '2026-07-20',
      progress: 0,
    },
    {
      id: 't2a',
      name: 'Tournage extérieur',
      kind: 'task',
      start_date: '2026-07-01',
      end_date: '2026-07-10',
      progress: 0,
      collaborator_id: 'c3',
      parent_id: 't2',
    },
    {
      id: 't2b',
      name: 'Tournage intérieur',
      kind: 'task',
      start_date: '2026-07-08',
      end_date: '2026-07-20',
      progress: 0,
      collaborator_id: 'c3',
      parent_id: 't2',
    },

    // Phase 3
    {
      id: 't3',
      name: 'Post-production',
      kind: 'phase',
      start_date: '2026-07-21',
      end_date: '2026-08-31',
      progress: 0,
    },
    {
      id: 't3a',
      name: 'Montage',
      kind: 'task',
      start_date: '2026-07-21',
      end_date: '2026-08-10',
      progress: 0,
      collaborator_id: 'c2',
      parent_id: 't3',
    },
    {
      id: 't3b',
      name: 'Voix off',
      kind: 'task',
      // v1.18.1 — fin alignée sur un jour ouvré (vendredi 14/08), au lieu
      // du samedi 15/08 qui faisait apparaître la tâche dans l'aperçu Replan
      // alors qu'aucune surcharge ne la concernait (Replan ramène toujours
      // la fin sur un jour ouvré via addWorkingDays).
      start_date: '2026-08-05',
      end_date: '2026-08-14',
      progress: 0,
      collaborator_id: 'c1',
      parent_id: 't3',
    },
    {
      id: 'm2',
      name: 'Livraison finale',
      kind: 'milestone',
      start_date: '2026-08-31',
      parent_id: 't3',
    },
  ],
}
