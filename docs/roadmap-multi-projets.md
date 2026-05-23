# Roadmap — Refonte sélecteur de projet + tooltips custom

Démarré le 2026-05-23. Décision utilisateur : implémenter F1 → F5 (chantier complet).

## Objectifs

1. Remplacer les tooltips natifs HTML (`title=`) capricieux par un composant custom.
2. Fusionner le `<select>` de projet et le toggle `🌐 Global / 📁 Courant` en un seul composant `<ProjectFilter>` avec 3 modes : projet unique / multi-sélection (cases à cocher type "filtre Excel") / "Tous les projets".
3. Étendre le multi-projets à TOUS les onglets : Gantt, Plan de charge, Affectations. (Congés inchangés — déjà cross-projet par nature.)

## Découpage

| Feature | Description                                                             | Coût   | État    |
| ------- | ----------------------------------------------------------------------- | ------ | ------- |
| F1      | Composant `<Tooltip>` custom + migration toolbar                        | ~1 j   | À faire |
| F2      | `<ProjectFilter>` mode simple : un projet OU "Tous"                     | ~1-2 j | À faire |
| F3      | Multi-sélection dans `<ProjectFilter>` (subset) + impact Plan de charge | ~2-3 j | À faire |
| F4      | Multi-projets sur l'onglet Gantt (lecture seule)                        | ~5-8 j | À faire |
| F5      | Multi-projets sur l'onglet Affectations (lecture seule)                 | ~2-3 j | À faire |

## Principes d'édition en mode multi

- Le state applicatif maintient un **`activeProjectId`** = "projet d'édition actif", utilisé pour : création de tâches, renommage, suppression, ouverture de TaskEditor, gestion d'allocations.
- Sélection en mode `single` → `activeProjectId` = ce projet.
- Sélection en mode `all` ou `subset` → `activeProjectId` reste le dernier projet "single" choisi explicitement, et l'édition est **désactivée** (boutons grisés, lecture seule sur Gantt/Affectations). Le multi est une vue d'agrégation, pas un mode d'édition.

## État applicatif

```ts
type ProjectFilterState =
  | { mode: 'single'; projectId: string }
  | { mode: 'all' }
  | { mode: 'subset'; projectIds: string[] }
```

Persistance localStorage (clé `gantt.projectFilter`).

## Endpoints backend

- `/api/state?project_id=X` → conservé pour le mode `single`.
- `/api/workload/global` → conservé pour le mode `all` (renvoie les tâches activités, pas d'autres détails).
- **Nouveau besoin pour F4/F5** : endpoint qui renvoie l'état complet (tasks, members, allocations) de plusieurs projets. Soit on étend `/api/state` à `?project_ids=A,B,C`, soit on crée `/api/state/multi`. Choix à arrêter au moment d'attaquer F4.
