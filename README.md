# Gantt

Application web pour gérer des plannings Gantt et exporter une capture PNG
pour PowerPoint.

## Stack

- **Front** : Vite + React 19 + TypeScript + Tailwind v4 + date-fns
- **Back** : Express 5 + better-sqlite3 (mode WAL)
- **Validation** : Zod (schémas centralisés dans `server/schemas.js`)
- **Tests** : Vitest + supertest (DAL, HTTP, fonctions pures front)
- **Qualité** : ESLint + Prettier + Husky (pre-commit) + GitHub Actions (CI)
- **Capture** : `html-to-image` (export PNG du Gantt)

## Lancement local

```bash
npm install
npm run dev
```

- Frontend Vite : **http://localhost:5174/gantt/** (host `0.0.0.0` → accessible LAN)
- API Express : http://localhost:3002 (proxy Vite `/api/*`)

> Ports différents de `plan-de-charge` (5173 / 3001) pour pouvoir lancer
> les deux applications en parallèle sur la même machine.

Pour arrêter : `Ctrl+C` dans le terminal.

## Scripts

| Script                  | Rôle                                                  |
| ----------------------- | ----------------------------------------------------- |
| `npm run dev`           | Lance front + back en parallèle                       |
| `npm run dev:client`    | Front Vite seul                                       |
| `npm run dev:server`    | API Express seule                                     |
| `npm run build`         | Vérifie TS + build prod du front                      |
| `npm test`              | Lance la suite Vitest (one-shot)                      |
| `npm run test:watch`    | Vitest en mode watch                                  |
| `npm run test:coverage` | Couverture v8 (rapport texte + html dans `coverage/`) |
| `npm run lint`          | ESLint                                                |
| `npm run format`        | Prettier --write                                      |

## Fonctionnalités v1

- Affichage Gantt avec **4 mois par défaut** (configurable)
- **Zoom avant / arrière** (largeur d'un jour de 6 à 60 px)
- **Tâches et jalons** (jalons en losange ◆)
- **Affectation à un collaborateur** (couleur héritée)
- **Phases / regroupements** (parent_id)
- **Capture PNG** du Gantt pour PowerPoint
- **Synchronisation multi-utilisateurs** par polling 5 s
- Données démo pré-chargées au premier lancement

## Modèle de données

Voir `db/schema.sql`. 3 tables :

- `meta(key, value)` — version monotone incrémentée à chaque mutation
- `collaborators(id, name, color, position)`
- `tasks(id, name, kind, start_date, end_date, progress, collaborator_id, color, parent_id, position)`

Cascade : la suppression d'une tâche parent supprime ses enfants.
La suppression d'un collaborateur détache ses tâches (`SET NULL`).

## API HTTP

| Méthode | Endpoint                 | Rôle                        |
| ------- | ------------------------ | --------------------------- |
| GET     | `/api/state`             | État complet                |
| POST    | `/api/reset`             | Restaure les données démo   |
| POST    | `/api/collaborators`     | Créer un collaborateur      |
| PATCH   | `/api/collaborators/:id` | Modifier (name / color)     |
| DELETE  | `/api/collaborators/:id` | Supprimer                   |
| POST    | `/api/tasks`             | Créer une tâche / un jalon  |
| PATCH   | `/api/tasks/:id`         | Modifier                    |
| DELETE  | `/api/tasks/:id`         | Supprimer (cascade enfants) |

Toutes les mutations renvoient `{ version, ... }` ; les erreurs de validation
renvoient `{ error: 'Validation échouée', details: [{ where, path, message }] }`.

## Conventions

- Les fonctions sont commentées (JSDoc `@param` / `@returns`).
- Les **fonctions pures** sont dans `src/lib/utils.ts` (testées séparément).
- Le DAL (`db/index.js`) est synchrone (better-sqlite3) et testable avec
  `:memory:`.
- La factory `createApp(db)` n'a pas d'effet de bord → testable avec supertest.

## Pre-commit

Installé via Husky (`npm install` lance `prepare` qui appelle `husky`).
Lance `lint-staged` (eslint --fix + prettier) puis `npm test`.
Bypass d'urgence : `git commit --no-verify`.

## CI

GitHub Actions (`.github/workflows/ci.yml`) : lint + format:check + tests +
build à chaque push sur `main` et chaque PR.
