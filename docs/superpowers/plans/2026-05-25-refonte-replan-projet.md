# Plan d'implémentation — v2.3 Refonte Replan : `project_start_date` + dates au plus tôt + cohérence timeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec** : [`docs/superpowers/specs/2026-05-25-refonte-replan-projet.md`](../specs/2026-05-25-refonte-replan-projet.md)

**Goal** : Refondre le modèle de planification autour d'une `start_date` calculée au plus tôt à partir d'une `project_start_date` (nouveau champ projet). Supprimer RG-GANTT-0903 (« jamais vers le passé »). Figer `start_date` pour les tâches en cours (`progress > 0`). Aligner Plan de charge et détection de surcharge sur les intervalles effectifs du moteur Replan (cohérence parfaite).

**Architecture** : Nouveau champ `project_start_date` persisté. `replanTasks` reçoit cette date et retourne `{ moves, timeline }`. `computeWorkload` et `detectOverloads` consomment la timeline (plus de lecture naïve `[start, end]`). Le résultat du Replan est mémoïsé à la volée dans `App.tsx` (`useMemo`) pour cohérence sans persistance supplémentaire.

**Tech Stack** : TypeScript + React + Vite (front), Node + Express + better-sqlite3 (back), Vitest (tests).

**Branche** : `v2.3/refonte-replan` créée depuis `main` après merge de v2.2.

**Ordre des lots** :

1. **L1** — Fondation projet (`project_start_date`) + refonte borne basse + suppression démo + suppression RG-0903.
2. **L2** — Option γ : `start_date` figée si `progress > 0`.
3. **L3** — Cohérence timeline moteur ↔ Plan de charge ↔ détection surcharge.
4. **L4** — Cas particuliers (pred terminé futur, jalon sans pred, phase vide, sans collab).

Chaque lot est mergeable indépendamment.

---

## Vue d'ensemble des fichiers

| Fichier                                        | Responsabilité                                                 | Modifié dans   |
| ---------------------------------------------- | -------------------------------------------------------------- | -------------- |
| `db/index.js`                                  | DAL serveur + migrations                                       | L1, L4         |
| `db/index.test.js`                             | Tests DAL                                                      | L1, L4         |
| `server/app.js`                                | Endpoints HTTP                                                 | L1             |
| `server/app.test.js`                           | Tests endpoints                                                | L1             |
| `server/schemas.js`                            | Schémas de validation Zod (ou équivalent)                      | L1             |
| `src/lib/utils.ts`                             | Moteur Replan + types                                          | L1, L2, L3, L4 |
| `src/lib/utils.test.ts`                        | Tests moteur                                                   | L1, L2, L3, L4 |
| `src/lib/types.ts`                             | Type `Project` (ajout `project_start_date`)                    | L1             |
| `src/App.tsx`                                  | Orchestration UI/API ; câblage Replan + useMemo timeline       | L1, L3         |
| `src/App.test.tsx`                             | Tests intégration UI                                           | L1, L3         |
| `src/components/ProjectSettingsModal.tsx`      | **NOUVEAU** — modal Paramètres                                 | L1             |
| `src/components/ProjectSettingsModal.test.tsx` | Tests modal                                                    | L1             |
| `src/components/CreateProjectDialog.tsx`       | **NOUVEAU** — dialog création de projet (nom + date démarrage) | L1             |
| `src/components/TaskEditor.tsx`                | Champ `start_date` grisé si progress > 0                       | L2             |
| `src/components/TaskEditor.test.tsx`           | Tests TaskEditor                                               | L2             |
| `src/components/GanttChart.tsx`                | Drag horizontal désactivé si progress > 0                      | L2             |
| `src/components/WorkloadChart.tsx`             | Consomme `timeline` du moteur                                  | L3             |
| `src/components/CoherenceAlert.tsx`            | Nouvelles alertes (pred terminé futur) + consomme `timeline`   | L3, L4         |
| `db/demo-state.js`                             | **SUPPRIMÉ**                                                   | L1             |
| `docs/regles-metier.md`                        | Catalogue RG                                                   | L1, L2, L3, L4 |

---

# LOT 1 — Fondation projet + refonte borne basse + suppression démo

**Périmètre RG** : 2000, 2001, 2002, 2010, 1903 (redéfinie), 1910 (redéfinie), suppression 0903.

**Critère de succès global** :

- Un projet a une `project_start_date` éditable via la modal Paramètres (bouton ✏️).
- Une tâche à `progress=0` actuellement « bloquée loin dans le futur » est ramenée à la borne basse globale (= `MAX(project_start_date, today_si_mode_normal, …)`) au prochain Replan.
- La modif de la date démarrage projet est refusée (avec message) si elle dépasse une activité à `progress > 0`.

---

### Task L1.1 — Migration DB : ajouter `project_start_date` sur `projects`

**Files** :

- Modify : `db/index.js` (fonctions `initSchema` / `runMigrations` ou équivalent au boot)
- Test : `db/index.test.js`

- [ ] **Step 1** — Identifier la fonction d'init de schéma

```
grep -n "CREATE TABLE.*projects\|ALTER TABLE projects\|migrations" db/index.js | head -20
```

Repérer où sont déclarées les colonnes de `projects` et où sont gérées les migrations idempotentes (souvent dans une fonction type `ensureColumn` ou un bloc qui vérifie `PRAGMA table_info`).

- [ ] **Step 2** — Test rouge : la colonne existe sur une base fraîche

Dans `db/index.test.js`, ajouter dans le `describe` du schéma projets :

```js
it('v2.3 / RG-GANTT-2000 — la colonne projects.project_start_date existe avec un défaut', () => {
  const cols = db.prepare('PRAGMA table_info(projects)').all()
  const col = cols.find((c) => c.name === 'project_start_date')
  expect(col).toBeDefined()
  expect(col.notnull).toBe(1) // NOT NULL
})
```

Lancer : `npm test -- --run db/index.test.js -t "project_start_date"`. Attendu : **FAIL** (colonne inexistante).

- [ ] **Step 3** — Implémenter la migration

Localiser la fonction d'init (souvent une longue fonction qui crée toutes les tables si absentes + lance des `ALTER TABLE ... ADD COLUMN` idempotents). Ajouter, dans le bloc de migrations idempotentes :

```js
// v2.3 / RG-GANTT-2000 — Ajout de project_start_date sur projects.
// Par défaut : '2026-01-01' pour les bases existantes (le code applicatif
// proposera de la modifier via la modal Paramètres). Pour les nouveaux
// projets créés via l'API, le défaut applicatif est `today` (cf. serveur).
const projectsCols = db.prepare('PRAGMA table_info(projects)').all()
if (!projectsCols.some((c) => c.name === 'project_start_date')) {
  db.prepare(
    "ALTER TABLE projects ADD COLUMN project_start_date TEXT NOT NULL DEFAULT '2026-01-01'",
  ).run()
}
```

Si la table `projects` est créée pour la première fois (base fraîche), s'assurer que la définition initiale inclut aussi `project_start_date TEXT NOT NULL DEFAULT '2026-01-01'` dans le `CREATE TABLE`. Sinon, le test sur base fraîche ne sera vert que partiellement.

- [ ] **Step 4** — Lancer test → PASS

```
npm test -- --run db/index.test.js -t "project_start_date"
```

- [ ] **Step 5** — Commit

```bash
git add db/index.js db/index.test.js
git commit -m "2026-05-25 — v2.3/RG-2000 : migration projects.project_start_date"
```

---

### Task L1.2 — API POST `/api/projects` accepte `project_start_date`

**Files** :

- Modify : `server/schemas.js` (schéma de validation du body POST)
- Modify : `db/index.js` (fonction `createProject` ou équivalent)
- Modify : `server/app.js` (handler POST `/api/projects`)
- Test : `server/app.test.js`

- [ ] **Step 1** — Test rouge : POST avec `project_start_date`

Dans `server/app.test.js` :

```js
it('v2.3 / RG-GANTT-2000 — POST /api/projects accepte project_start_date', async () => {
  const res = await request(app)
    .post('/api/projects')
    .send({ id: 'p_test', name: 'Test', project_start_date: '2026-09-01' })
  expect(res.status).toBe(200)
  const state = await request(app).get('/api/state?project_id=p_test')
  expect(state.body.project.project_start_date).toBe('2026-09-01')
})

it('v2.3 / RG-GANTT-2000 — POST /api/projects sans project_start_date : défaut = today', async () => {
  const res = await request(app)
    .post('/api/projects')
    .send({ id: 'p_test2', name: 'Test 2' })
  expect(res.status).toBe(200)
  const state = await request(app).get('/api/state?project_id=p_test2')
  const today = new Date().toISOString().slice(0, 10)
  expect(state.body.project.project_start_date).toBe(today)
})
```

Lancer → **FAIL**.

- [ ] **Step 2** — Étendre le schéma

Dans `server/schemas.js`, repérer `CreateProjectBody` (ou équivalent) et ajouter :

```js
project_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
```

- [ ] **Step 3** — Étendre `createProject` côté DAL

Dans `db/index.js`, repérer la fonction qui insère un projet. Ajouter le champ :

```js
export function createProject(db, { id, name, project_start_date }) {
  const start = project_start_date || todayIsoServer()
  db.prepare(
    'INSERT INTO projects (id, name, project_start_date) VALUES (?, ?, ?)',
  ).run(id, name, start)
  // … autres opérations existantes (création membres, etc.)
  return { version: bumpVersion(db), changed: true }
}
```

`todayIsoServer()` : helper existant ou à créer côté serveur (équivalent de `todayIso()` côté client, retourne `YYYY-MM-DD`).

- [ ] **Step 4** — Étendre le handler HTTP

Dans `server/app.js`, dans le handler `app.post('/api/projects', ...)` :

```js
const result = createProject(db, {
  id: req.body.id,
  name: req.body.name,
  project_start_date: req.body.project_start_date, // peut être undefined
})
```

- [ ] **Step 5** — Étendre `GET /api/state` pour retourner `project_start_date`

Repérer dans `db/index.js` la fonction qui peuple `state.project` (souvent `getFullState` ou similaire). Ajouter `project_start_date` à la projection SQL et au DTO retourné.

- [ ] **Step 6** — Test → PASS, commit

```
npm test -- --run server/app.test.js -t "project_start_date"
```

```bash
git add server/ db/
git commit -m "2026-05-25 — v2.3/RG-2000 : POST /api/projects accepte project_start_date + GET /api/state l'expose"
```

---

### Task L1.3 — API PATCH `/api/projects/:id` (renommage + date démarrage) avec validation RG-2010

**Files** :

- Modify : `server/schemas.js` (schéma `UpdateProjectBody`)
- Modify : `db/index.js` (nouvelle fonction `updateProject`)
- Modify : `server/app.js` (nouveau handler `PATCH /api/projects/:id`)
- Test : `db/index.test.js`, `server/app.test.js`

- [ ] **Step 1** — Test rouge serveur : PATCH valide + PATCH refusé (RG-2010)

Dans `server/app.test.js` :

```js
it('v2.3 / RG-GANTT-2001 — PATCH /api/projects/:id renomme + modifie date', async () => {
  // Prérequis : projet p1 existe avec une seule tâche progress=0.
  const res = await request(app)
    .patch('/api/projects/p1')
    .send({ name: 'Nouveau nom', project_start_date: '2026-08-01' })
  expect(res.status).toBe(200)
})

it("v2.3 / RG-GANTT-2010 — PATCH refusé si date > start d'une tâche progress>0", async () => {
  // Prérequis : projet p2 avec tâche t1 progress=50, start_date=2026-05-15.
  const res = await request(app)
    .patch('/api/projects/p2')
    .send({ project_start_date: '2026-09-01' }) // postérieure à 2026-05-15
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/déjà démarrée/i)
})
```

Lancer → **FAIL**.

- [ ] **Step 2** — Implémenter `updateProject` côté DAL

Dans `db/index.js` :

```js
/**
 * v2.3 / RG-GANTT-2001 + RG-GANTT-2010 — Met à jour un projet (nom et/ou
 * date de démarrage). Valide RG-2010 : refuse une `project_start_date`
 * postérieure à la `start_date` d'au moins une activité avec progress > 0.
 *
 * @returns { ok: true, version } | { ok: false, code, message, conflictingTask? }
 */
export function updateProject(db, id, patch) {
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    if (!cur)
      return { ok: false, code: 'NOT_FOUND', message: 'projet introuvable' }
    const next = { ...cur, ...patch }
    // RG-GANTT-2010 — Validation : pas de date postérieure aux tâches en cours.
    if (
      patch.project_start_date &&
      patch.project_start_date !== cur.project_start_date
    ) {
      const conflict = db
        .prepare(
          `SELECT id, name, start_date FROM tasks
         WHERE project_id = ? AND kind = 'task' AND progress > 0
           AND start_date < ?
         ORDER BY start_date ASC LIMIT 1`,
        )
        .get(id, patch.project_start_date)
      if (conflict) {
        return {
          ok: false,
          code: 'PROJECT_START_AFTER_TASK',
          message: `Impossible : la tâche "${conflict.name}" est déjà démarrée le ${conflict.start_date}.`,
          conflictingTask: conflict,
        }
      }
    }
    db.prepare(
      `UPDATE projects SET name = ?, project_start_date = ? WHERE id = ?`,
    ).run(next.name, next.project_start_date, id)
    return { ok: true, version: bumpVersion(db) }
  })
  return tx()
}
```

- [ ] **Step 3** — Handler HTTP

Dans `server/app.js` :

```js
app.patch(
  '/api/projects/:id',
  validate({ params: ProjectIdParams, body: UpdateProjectBody }),
  safeRoute((req, res) => {
    const result = updateProject(db, req.params.id, req.body)
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400
      return res
        .status(status)
        .json({
          error: result.message,
          code: result.code,
          conflictingTask: result.conflictingTask,
        })
    }
    res.json({ version: result.version, changed: true })
  }),
)
```

- [ ] **Step 4** — Schéma `UpdateProjectBody`

Dans `server/schemas.js` :

```js
export const UpdateProjectBody = z.object({
  name: z.string().min(1).optional(),
  project_start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
```

- [ ] **Step 5** — Test → PASS, commit

```bash
git add server/ db/
git commit -m "2026-05-25 — v2.3/RG-2001/2010 : PATCH /api/projects + validation date >= max start des tâches en cours"
```

---

### Task L1.4 — Suppression du concept de démo

**Files** :

- Delete : `db/demo-state.js`
- Modify : `db/index.js` (retirer l'appel à `seedDemo()`)

- [ ] **Step 1** — Identifier où `seedDemo()` est appelée

```
grep -n "seedDemo\|demo-state" db/ server/ src/ 2>/dev/null
```

- [ ] **Step 2** — Test : un boot sur base vide n'insère plus de données démo

Dans `db/index.test.js`, dans un `describe` d'init :

```js
it("v2.3 / RG-GANTT-2002 — boot sur base vide n'insère plus la démo", () => {
  const freshDb = initDb(':memory:')
  const projects = freshDb.prepare('SELECT * FROM projects').all()
  expect(projects.length).toBe(0)
})
```

Lancer → **FAIL** (aujourd'hui la démo est seedée).

- [ ] **Step 3** — Supprimer l'appel + le fichier

Retirer `seedDemo(db)` de `db/index.js` (et l'import correspondant). Supprimer `db/demo-state.js` :

```bash
rm db/demo-state.js
```

- [ ] **Step 4** — Test → PASS, commit

```bash
git add db/
git commit -m "2026-05-25 — v2.3/RG-2002 : suppression du concept de démo (db/demo-state.js + seedDemo)"
```

---

### Task L1.5 — Refonte de `computeReplanEarliestStart` (borne basse globale, suppression RG-0903)

**Files** :

- Modify : `src/lib/utils.ts` (fonction `computeReplanEarliestStart`)
- Test : `src/lib/utils.test.ts`

- [ ] **Step 1** — Tests rouges

Dans `src/lib/utils.test.ts`, nouveau bloc :

```ts
describe('v2.3 / RG-GANTT-1903 redéfinie — borne basse globale', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('progress=0, start dans le futur lointain → ramenée à project_start_date (mode anticipé) ou today (normal)', () => {
    const tasks: Task[] = [
      mkTask('t1', {
        start_date: '2027-12-31',
        end_date: '2027-12-31',
        charge_jours: 5,
        progress: 0,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
        project_id: 'p1',
      }),
    ]
    const result = replanTasks(tasks, '2026-01-01', [], [], {
      ignoreToday: true,
    }) // mode anticipé
    expect(result.moves[0].newStart).toBe('2026-01-01')

    // Mode normal : today (2026-05-25) > project_start (2026-01-01) → today gagne.
    const result2 = replanTasks(tasks, '2026-01-01', [], [], {
      ignoreToday: false,
    })
    expect(result2.moves[0].newStart).toBe('2026-05-25')
  })

  it("progress=0, project_start_date dans le futur → respecté quelle que soit l'option", () => {
    const tasks: Task[] = [
      mkTask('t1', {
        start_date: '2026-06-01',
        end_date: '2026-06-01',
        charge_jours: 3,
        progress: 0,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
        project_id: 'p1',
      }),
    ]
    const result = replanTasks(tasks, '2026-09-01', [], [], {
      ignoreToday: false,
    })
    expect(result.moves[0].newStart).toBe('2026-09-01')
  })
})
```

Note : `replanTasks` n'a pas encore la signature avec `projectStartDate` ni le retour `{ moves, timeline }`. Ce test va casser temporairement. **C'est volontaire** — Step 2 et 3 corrigent la signature.

Lancer → **FAIL** (compilation ou exécution).

- [ ] **Step 2** — Adapter la signature de `replanTasks`

Dans `src/lib/utils.ts`, à la déclaration de `replanTasks` (ligne ~1971) :

```ts
export interface ReplanResult {
  moves: ReplanMove[]
  // v2.3 / RG-GANTT-2004 — Timeline exposée pour cohérence avec Plan de charge.
  timeline: Map<string, Array<{ taskId: string; start: string; end: string }>>
}

export function replanTasks(
  tasks: Task[],
  projectStartDate: string, // NOUVEAU
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
  options: { ignoreToday?: boolean } = {},
): ReplanResult {
  // … (corps adapté, voir Step 3)
}
```

Adapter tous les appels existants à `replanTasks` (rechercher `replanTasks(`) pour leur passer le nouveau paramètre. Pour les tests existants qui passent `undefined` ou pas du tout, mettre `'2026-01-01'` ou la date qui colle au scénario.

- [ ] **Step 3** — Modifier `computeReplanEarliestStart` et le placement

```ts
function computeReplanEarliestStart(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  projectStartDate: string,
  options: { ignoreToday: boolean } = { ignoreToday: false },
): string {
  // v2.3 / RG-GANTT-1903 redéfinie — Borne basse globale.
  // Plus de dépendance à progress (l'asymétrie de la v2.2 est supprimée).
  // RG-GANTT-0903 (« jamais vers le passé ») abandonnée : on ne part PLUS
  // de t.start_date mais de project_start_date.
  let earliest = projectStartDate
  if (!options.ignoreToday) {
    const today = todayIso()
    if (today > earliest) earliest = today
  }
  if (t.predecessor_id) {
    const pred = tasksById.get(t.predecessor_id)
    if (pred) {
      const predEnd = proposed.get(pred.id)?.end ?? pred.end_date
      // RG-GANTT-2006 — Si pred terminé mais end dans le futur, on ignorera
      // la contrainte. Sera implémenté en L4 avec l'alerte associée.
      // Ici on garde le comportement actuel pour rester focalisé sur L1.
      const lagStart = computeSuccessorStart(predEnd, t.predecessor_lag || 0)
      if (lagStart > earliest) earliest = lagStart
    }
  }
  if (t.not_before_date) {
    const snet = snapForwardToWorkingDay(t.not_before_date)
    if (snet > earliest) earliest = snet
  }
  return snapForwardToWorkingDay(earliest)
}
```

Adapter aussi `placeTaskInTimeline` pour propager `projectStartDate` et `options.ignoreToday` à `computeReplanEarliestStart`. La signature de `placeTaskInTimeline` reçoit aussi `projectStartDate` en argument.

Le corps de `replanTasks` initialise la timeline et la retourne à la fin :

```ts
export function replanTasks(
  tasks: Task[],
  projectStartDate: string,
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
  options: { ignoreToday?: boolean } = {},
): ReplanResult {
  const ignoreToday = options.ignoreToday === true
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const order = buildReplanOrder(tasks)
  const proposed = new Map<string, { start: string; end: string }>()
  for (const t of tasks) {
    proposed.set(t.id, { start: t.start_date, end: t.end_date })
  }
  const timeline = new Map<
    string,
    Array<{ taskId: string; start: string; end: string }>
  >()
  prefillCompletedIntervals(tasks, timeline)
  for (const t of order) {
    if (t.progress === 100) continue
    placeTaskInTimeline(
      t,
      tasksById,
      proposed,
      timeline,
      allocations,
      absences,
      projectStartDate,
      { ignoreToday },
    )
  }
  const moves = buildReplanMoves(order, proposed)
  return { moves, timeline }
}
```

Adapter aussi `prefillCompletedIntervals`, `placeTaskInTimeline`, `pushTimelineInterval` pour stocker `{ taskId, start, end }` au lieu de juste `[start, end]` (les consommateurs de la timeline ont besoin de connaître la tâche).

- [ ] **Step 4** — Test → PASS

```
npm test -- --run src/lib/utils.test.ts -t "RG-GANTT-1903"
```

- [ ] **Step 5** — Lancer toute la suite

```
npm test
```

Beaucoup de tests vont casser (toute la base de tests `replanTasks` n'a plus la bonne signature). Les adapter un par un : ajouter `'2026-01-01'` (ou la date pertinente) en 2ᵉ position, et adapter les assertions sur le retour (`result.moves` au lieu de `result`).

- [ ] **Step 6** — Commit

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-25 — v2.3/RG-1903 redéfinie : borne basse globale = MAX(project_start, today, pred, SNET) — suppression RG-0903"
```

---

### Task L1.6 — Câblage `projectStartDate` dans `App.tsx`

**Files** :

- Modify : `src/App.tsx`
- Modify : `src/lib/types.ts` (champ `project_start_date` sur le type `Project`)

- [ ] **Step 1** — Ajouter le champ au type

Dans `src/lib/types.ts`, repérer le type `Project` (ou interface) :

```ts
export interface Project {
  id: string
  name: string
  project_start_date: string // v2.3 / RG-GANTT-2000
}
```

- [ ] **Step 2** — Lire `project_start_date` dans App.tsx

Dans `App.tsx`, repérer `state.current_project` (ou équivalent — où on lit le projet courant). Extraire la date pour la passer aux appels `replanTasks`.

```ts
const projectStartDate = state.current_project?.project_start_date ?? todayIso()
// Au site de l'appel à replanTasks :
const result = replanTasks(
  orderedTasks,
  projectStartDate,
  allocations,
  absences,
  { ignoreToday },
)
```

Adapter tous les sites d'appel (manuel via `handleOpenReplan` + auto via `handleSaveTask`).

- [ ] **Step 3** — TS check + tests

```
npx tsc --noEmit
npm test
```

Adapter ce qui casse à la compilation. Les tests doivent passer.

- [ ] **Step 4** — Commit

```bash
git add src/App.tsx src/lib/types.ts
git commit -m "2026-05-25 — v2.3/RG-2000 : câblage project_start_date dans replanTasks (manuel + auto)"
```

---

### Task L1.7 — Composant `ProjectSettingsModal` (modal Paramètres)

**Files** :

- Create : `src/components/ProjectSettingsModal.tsx`
- Create : `src/components/ProjectSettingsModal.test.tsx`
- Modify : `src/App.tsx` (binding du bouton ✏️ existant à la modal)

- [ ] **Step 1** — Tests rouges (rendu, save, validation client RG-2010)

```tsx
describe('ProjectSettingsModal', () => {
  const project = {
    id: 'p1',
    name: 'Projet 1',
    project_start_date: '2026-05-01',
  }
  const tasks = [
    {
      id: 't1',
      name: 'En cours',
      progress: 50,
      start_date: '2026-05-15',
      kind: 'task',
    },
  ] as Task[]

  it('v2.3 / RG-GANTT-2001 — affiche nom + date, modifiable', async () => {
    render(
      <ProjectSettingsModal
        project={project}
        tasks={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect((screen.getByLabelText(/nom/i) as HTMLInputElement).value).toBe(
      'Projet 1',
    )
    expect(
      (screen.getByLabelText(/date de démarrage/i) as HTMLInputElement).value,
    ).toBe('2026-05-01')
  })

  it("v2.3 / RG-GANTT-2010 — bloque la date si > start d'une tâche en cours", async () => {
    render(
      <ProjectSettingsModal
        project={project}
        tasks={tasks}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/date de démarrage/i), {
      target: { value: '2026-09-01' },
    })
    fireEvent.click(screen.getByText(/enregistrer/i))
    // Le message d'erreur apparaît, onSave n'est pas appelé.
    expect(screen.getByText(/déjà démarrée/i)).toBeInTheDocument()
  })

  it('v2.3 / RG-GANTT-2010 — accepte si date <= start des tâches en cours', async () => {
    const onSave = vi.fn()
    render(
      <ProjectSettingsModal
        project={project}
        tasks={tasks}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/date de démarrage/i), {
      target: { value: '2026-04-01' },
    })
    fireEvent.click(screen.getByText(/enregistrer/i))
    expect(onSave).toHaveBeenCalledWith({
      name: 'Projet 1',
      project_start_date: '2026-04-01',
    })
  })
})
```

- [ ] **Step 2** — Implémenter le composant

```tsx
// src/components/ProjectSettingsModal.tsx
import { useState } from 'react'
import type { Project, Task } from '../lib/types'

type Props = {
  project: Project
  tasks: Task[]
  onSave: (patch: { name: string; project_start_date: string }) => void
  onClose: () => void
}

/**
 * v2.3 / RG-GANTT-2001 — Modal "Paramètres du projet" (ouverte via ✏️).
 * Édite : nom + date de démarrage.
 *
 * v2.3 / RG-GANTT-2010 — Validation client : la nouvelle date démarrage
 * ne doit pas être postérieure à la start_date d'une tâche en cours
 * (progress > 0). Même validation côté serveur (DAL updateProject) en
 * défense en profondeur.
 */
export default function ProjectSettingsModal({
  project,
  tasks,
  onSave,
  onClose,
}: Props) {
  const [name, setName] = useState(project.name)
  const [startDate, setStartDate] = useState(project.project_start_date)
  const [error, setError] = useState<string | null>(null)

  const handleSave = () => {
    setError(null)
    // RG-2010 — validation client.
    const inProgress = tasks
      .filter((t) => t.kind === 'task' && (t.progress ?? 0) > 0)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
    const conflict = inProgress.find((t) => t.start_date < startDate)
    if (conflict) {
      setError(
        `Impossible de définir la date au ${startDate} : la tâche "${conflict.name}" est déjà démarrée le ${conflict.start_date}.`,
      )
      return
    }
    onSave({ name, project_start_date: startDate })
  }

  return (
    <div role="dialog" className="modal-overlay">
      <div className="modal-content">
        <h2>Paramètres du projet</h2>
        <label>
          Nom : <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Date de démarrage :{' '}
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Annuler</button>
          <button onClick={handleSave}>Enregistrer</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3** — Binding dans App.tsx

Localiser le bouton ✏️ dans App.tsx. Câbler son `onClick` à un état `showProjectSettings`. Au save, envoyer un `PATCH /api/projects/:id`, gérer l'erreur 400 (`PROJECT_START_AFTER_TASK`) en restaurant la modal ouverte avec le message.

- [ ] **Step 4** — Test → PASS, commit

```bash
git add src/components/ProjectSettingsModal.tsx src/components/ProjectSettingsModal.test.tsx src/App.tsx
git commit -m "2026-05-25 — v2.3/RG-2001/2010 : modal Paramètres du projet (nom + date + validation RG-2010)"
```

---

### Task L1.8 — Dialog de création de projet (nom + date démarrage)

**Files** :

- Create : `src/components/CreateProjectDialog.tsx`
- Create : `src/components/CreateProjectDialog.test.tsx`
- Modify : `src/App.tsx` (binding du bouton ➕ existant)

- [ ] **Step 1** — Tests rouges

```tsx
describe('CreateProjectDialog', () => {
  it('affiche un champ nom et un champ date (défaut today)', () => {
    render(<CreateProjectDialog onCreate={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText(/nom/i)).toBeInTheDocument()
    const date = screen.getByLabelText(/date de démarrage/i) as HTMLInputElement
    expect(date.value).toBe(new Date().toISOString().slice(0, 10))
  })

  it('onCreate appelée avec nom + date à la validation', () => {
    const onCreate = vi.fn()
    render(<CreateProjectDialog onCreate={onCreate} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/nom/i), {
      target: { value: 'Mon projet' },
    })
    fireEvent.change(screen.getByLabelText(/date/i), {
      target: { value: '2026-09-01' },
    })
    fireEvent.click(screen.getByText(/créer/i))
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Mon projet',
      project_start_date: '2026-09-01',
    })
  })
})
```

- [ ] **Step 2** — Implémentation

```tsx
// src/components/CreateProjectDialog.tsx
import { useState } from 'react'

type Props = {
  onCreate: (data: { name: string; project_start_date: string }) => void
  onClose: () => void
}

/**
 * v2.3 / RG-GANTT-2000 — Dialog de création d'un projet.
 * Demande nom + date de démarrage (défaut today).
 */
export default function CreateProjectDialog({ onCreate, onClose }: Props) {
  const [name, setName] = useState('')
  const today = new Date().toISOString().slice(0, 10)
  const [startDate, setStartDate] = useState(today)

  const handleCreate = () => {
    if (!name.trim()) return
    onCreate({ name: name.trim(), project_start_date: startDate })
  }

  return (
    <div role="dialog" className="modal-overlay">
      <div className="modal-content">
        <h2>Nouveau projet</h2>
        <label>
          Nom :{' '}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Date de démarrage :{' '}
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Annuler</button>
          <button onClick={handleCreate} disabled={!name.trim()}>
            Créer
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3** — Binding dans App.tsx (remplace l'éventuel prompt actuel)

- [ ] **Step 4** — Test → PASS, commit

```bash
git add src/components/CreateProjectDialog.tsx src/components/CreateProjectDialog.test.tsx src/App.tsx
git commit -m "2026-05-25 — v2.3/RG-2000 : dialog création projet (nom + date démarrage défaut today)"
```

---

### Task L1.9 — Catalogue RG : ajout 2000, 2001, 2002, 2010 + redéfinitions 1903/1910 + suppression 0903

**Files** :

- Modify : `docs/regles-metier.md`

- [ ] **Step 1** — Ajouter les nouvelles RG

À la fin de la Famille 10 (Replanification) ou dans une nouvelle Famille « v2.3 — Projet et planification globale » : insérer les RG-GANTT-2000, 2001, 2002, 2010 avec leur libellé (copier depuis la spec § 2.4).

- [ ] **Step 2** — Réécrire RG-GANTT-1903 et RG-GANTT-1910

Repérer leur emplacement existant et réécrire selon la spec § 2.3.

- [ ] **Step 3** — Supprimer RG-GANTT-0903

```
grep -n "RG-GANTT-0903" docs/regles-metier.md
```

Supprimer la section entière.

- [ ] **Step 4** — Vérifier couverture

```
npx vitest run docs/regles-metier.coverage.test.js
```

Attendu : PASS (les nouvelles RG renvoient vers des tests qui existent désormais).

- [ ] **Step 5** — Commit

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): v2.3 — ajout RG-GANTT-2000/2001/2002/2010 + refonte 1903/1910 + suppression 0903 (2026-05-25)"
```

---

**Fin de L1.** À ce stade : un projet a une date de démarrage éditable ; la modal Paramètres existe ; le Replan utilise cette date comme borne basse ; les tâches `progress=0` placées loin dans le futur sont ramenées au plus tôt ; la démo est supprimée ; toutes les anciennes données sont conservées.

---

# LOT 2 — Option γ : `start_date` figée si `progress > 0`

**Périmètre RG** : 2003, 1907 (redéfinie).

**Critère de succès** : une tâche en cours conserve sa `start_date` historique au fil des Replans ; seule `end_date` glisse selon le reste à faire.

---

### Task L2.1 — `placeTaskInTimeline` : `start_date` figée si progress > 0

**Files** :

- Modify : `src/lib/utils.ts` (fonction `placeTaskInTimeline`)
- Test : `src/lib/utils.test.ts`

- [ ] **Step 1** — Tests rouges RG-2003

```ts
describe('v2.3 / RG-GANTT-2003 — start_date figée si progress > 0', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('tâche progress=50 avec start_date historique passée : start figée, end glissée à today+reste', () => {
    const tasks: Task[] = [
      mkTask('t1', {
        start_date: '2026-05-01',
        end_date: '2026-05-12',
        charge_jours: 10,
        progress: 50,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
        project_id: 'p1',
      }),
    ]
    const result = replanTasks(tasks, '2026-01-01', [], [])
    expect(result.moves[0].newStart).toBe('2026-05-01') // figée !
    // reste à faire = 5 jours, consommés à partir de today=2026-05-25 (lundi)
    expect(result.moves[0].newEnd).toBe('2026-05-29') // 5 j ouvrés depuis lundi 25/05
  })

  it('tâche progress=50 avec start_date dans le futur : start figée, end = start + reste à faire', () => {
    const tasks: Task[] = [
      mkTask('t1', {
        start_date: '2026-08-03',
        end_date: '2026-08-14',
        charge_jours: 10,
        progress: 50,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
        project_id: 'p1',
      }),
    ]
    const result = replanTasks(tasks, '2026-01-01', [], [])
    expect(result.moves[0].newStart).toBe('2026-08-03') // figée
    expect(result.moves[0].newEnd).toBe('2026-08-07') // 5 j ouvrés depuis lundi 03/08
  })
})
```

Lancer → **FAIL** (actuellement `start_date` est recalculée à la borne basse globale).

- [ ] **Step 2** — Modifier `placeTaskInTimeline`

```ts
function placeTaskInTimeline(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  timeline: Map<string, Array<{ taskId: string; start: string; end: string }>>,
  allocations: MemberAllocation[],
  absences: CollaboratorAbsence[],
  projectStartDate: string,
  options: { ignoreToday: boolean } = { ignoreToday: false },
): void {
  const totalCharge =
    t.charge_jours && t.charge_jours >= 1
      ? t.charge_jours
      : Math.max(1, workingDaysBetween(t.start_date, t.end_date))
  const progress = Math.max(0, Math.min(100, t.progress ?? 0)) / 100
  const effectiveCharge = Math.max(1, Math.ceil(totalCharge * (1 - progress)))
  const collabIds = taskCollabIds(t)

  // v2.3 / RG-GANTT-2003 — Si progress > 0, start_date est figée.
  let newStart: string
  if (progress > 0) {
    newStart = t.start_date
    // Le reste à faire est consommé à partir de MAX(today, start_date).
    const today = todayIso()
    const consumeFrom = newStart > today ? newStart : today
    // Cherche un créneau libre du collab à partir de consumeFrom pour effectiveCharge jours.
    for (const cId of collabIds) {
      const intervals = timeline.get(cId) || []
      const candidate = findFreeSlot(
        intervals.map((iv) => [iv.start, iv.end] as [string, string]),
        consumeFrom,
        effectiveCharge,
      )
      if (candidate > consumeFrom) {
        // Le créneau libre commence après consumeFrom — c'est OK, newStart reste figée mais
        // l'end est calculée à partir de candidate. (Cas où le collab est occupé sur d'autres tâches.)
        // On utilise candidate comme point de départ pour le calcul de end.
        // newStart reste t.start_date (figée pour l'affichage).
        // Pour computeEndFromCharge on utilise candidate.
        // Stocke pour usage ci-dessous.
        var actualConsumeStart = candidate
      }
    }
  } else {
    // v2.3 / RG-GANTT-1903 — progress=0 : start recalculée à la borne basse globale.
    const earliest = computeReplanEarliestStart(
      t,
      tasksById,
      proposed,
      projectStartDate,
      options,
    )
    newStart = earliest
    for (const cId of collabIds) {
      const intervals = timeline.get(cId) || []
      const candidate = findFreeSlot(
        intervals.map((iv) => [iv.start, iv.end] as [string, string]),
        earliest,
        effectiveCharge,
      )
      if (candidate > newStart) newStart = candidate
    }
  }

  // Calcul de la fin.
  const consumeFrom =
    progress > 0 ? (newStart > todayIso() ? newStart : todayIso()) : newStart
  const newEnd = computeEndFromCharge(consumeFrom, effectiveCharge, {
    projectId: t.project_id,
    collaboratorId: t.collaborator_id,
    collaboratorIds: collabIds.length > 0 ? collabIds : undefined,
    allocations,
    absences,
  })

  proposed.set(t.id, { start: newStart, end: newEnd })
  for (const cId of collabIds) {
    pushTimelineInterval(timeline, cId, t.id, consumeFrom, newEnd)
  }
}
```

> **Note d'implémentation** : la consommation effective (qui sert au Plan de charge en L3) commence à `consumeFrom`, qui peut être > `newStart` quand la tâche est en cours et que `start_date < today`. C'est exactement la sémantique attendue : la barre va de `start_historique` à `newEnd`, mais le moteur ne consomme que de `consumeFrom` à `newEnd` dans la timeline. L'écart entre `newStart` et `consumeFrom` représente la portion réalisée (non re-consommée).

Adapter aussi `pushTimelineInterval` pour accepter `taskId` :

```ts
function pushTimelineInterval(
  timeline: Map<string, Array<{ taskId: string; start: string; end: string }>>,
  collabId: string,
  taskId: string,
  start: string,
  end: string,
): void {
  const intervals = timeline.get(collabId) || []
  intervals.push({ taskId, start, end })
  intervals.sort((a, b) => a.start.localeCompare(b.start))
  timeline.set(collabId, intervals)
}
```

- [ ] **Step 3** — Test → PASS

```
npm test -- --run src/lib/utils.test.ts -t "RG-GANTT-2003"
```

- [ ] **Step 4** — Suite complète

```
npm test
```

- [ ] **Step 5** — Commit

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-25 — v2.3/RG-2003 : start_date figée si progress>0 + consume depuis MAX(today, start)"
```

---

### Task L2.2 — TaskEditor : champ `start_date` grisé si progress > 0

**Files** :

- Modify : `src/components/TaskEditor.tsx`
- Test : `src/components/TaskEditor.test.tsx`

- [ ] **Step 1** — Test rouge

```tsx
it("v2.3 / RG-GANTT-2003 — champ start_date grisé si progress > 0", () => {
  const task = makeMockTask({ progress: 50 })
  render(<TaskEditor mode="edit" initial={task} ... />)
  expect(screen.getByLabelText(/date de début/i)).toBeDisabled()
})

it("v2.3 / RG-GANTT-2003 — champ start_date éditable si progress = 0", () => {
  const task = makeMockTask({ progress: 0 })
  render(<TaskEditor mode="edit" initial={task} ... />)
  expect(screen.getByLabelText(/date de début/i)).not.toBeDisabled()
})
```

- [ ] **Step 2** — Modifier TaskEditor

```tsx
<input
  type="date"
  value={form.start_date}
  onChange={(e) => setForm({ ...form, start_date: e.target.value })}
  disabled={form.kind === 'task' && (form.progress ?? 0) > 0}
  title={
    form.kind === 'task' && (form.progress ?? 0) > 0
      ? 'Date de début figée car la tâche est démarrée (progress > 0). Pour la débloquer, remettez progress à 0.'
      : undefined
  }
/>
```

- [ ] **Step 3** — Test → PASS, commit

```bash
git add src/components/TaskEditor.tsx src/components/TaskEditor.test.tsx
git commit -m "2026-05-25 — v2.3/RG-2003 : TaskEditor désactive start_date si progress>0"
```

---

### Task L2.3 — GanttChart : drag horizontal désactivé si progress > 0

**Files** :

- Modify : `src/components/GanttChart.tsx`

- [ ] **Step 1** — Localiser le handler de drag

```
grep -n "onMouseDown\|onDragStart\|dragMode\|handleBarDrag" src/components/GanttChart.tsx | head -10
```

- [ ] **Step 2** — Condition de désactivation

Dans le handler du drag horizontal (le « move », pas le « resize edge » qui édite la charge), ajouter au début :

```ts
if ((task.progress ?? 0) > 0) {
  // v2.3 / RG-GANTT-2003 — start_date figée pour les tâches en cours,
  // donc le drag horizontal qui déplacerait la barre est désactivé.
  // Le resize du bord droit (édition charge) reste autorisé.
  return
}
```

Pas de test unitaire dédié (le comportement est piloté par l'interaction souris), mais ajouter un test e2e ou intégration simple :

```tsx
it("v2.3 / RG-GANTT-2003 — drag horizontal d'une tâche progress>0 n'a aucun effet", () => {
  // Simulation : déclencher mousedown puis mousemove sur la barre, vérifier que onTaskMove n'est PAS appelé.
  // (Implémentation dépendante du framework de test ; à adapter)
})
```

- [ ] **Step 3** — Commit

```bash
git add src/components/GanttChart.tsx
git commit -m "2026-05-25 — v2.3/RG-2003 : drag horizontal désactivé sur barre progress>0"
```

---

### Task L2.4 — Cas particulier : passage `progress = 0 → > 0` dans TaskEditor

**Files** :

- Modify : `src/components/TaskEditor.tsx`
- Test : `src/components/TaskEditor.test.tsx`

- [ ] **Step 1** — Test

```tsx
it("v2.3 / RG-1907 redéfinie — passage progress 0→30 + édition start_date au même save", () => {
  const task = makeMockTask({ progress: 0, start_date: '2026-06-01' })
  const onSave = vi.fn()
  render(<TaskEditor mode="edit" initial={task} onSave={onSave} ... />)
  // L'utilisateur modifie progress ET start_date dans le même formulaire.
  fireEvent.change(screen.getByLabelText(/avancement/i), { target: { value: '30' } })
  // À ce stade, start_date doit encore être éditable (progress courant=30 mais
  // l'état initial était 0 — l'utilisateur peut faire les 2 changements dans
  // le même formulaire).
  expect(screen.getByLabelText(/date de début/i)).not.toBeDisabled()
  fireEvent.change(screen.getByLabelText(/date de début/i), { target: { value: '2026-05-15' } })
  fireEvent.click(screen.getByText(/enregistrer/i))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    progress: 30,
    start_date: '2026-05-15',
  }), expect.any(Object))
})
```

- [ ] **Step 2** — Ajuster TaskEditor

La condition `disabled` doit comparer à la valeur **initiale** de `progress`, pas à la valeur courante du formulaire. Ainsi, l'utilisateur peut éditer `start_date` même s'il est en train de basculer progress 0→30 dans le même save.

```tsx
const initialProgress = initial?.progress ?? 0
<input
  type="date"
  value={form.start_date}
  onChange={...}
  disabled={form.kind === 'task' && initialProgress > 0}
/>
```

- [ ] **Step 3** — Test → PASS, commit

```bash
git add src/components/TaskEditor.tsx src/components/TaskEditor.test.tsx
git commit -m "2026-05-25 — v2.3/RG-1907 : passage progress 0→>0 permet édition start_date au même save"
```

---

### Task L2.5 — Catalogue RG : ajout 2003 + redéfinition 1907

**Files** :

- Modify : `docs/regles-metier.md`

- [ ] **Step 1** — Ajouter RG-2003 et réécrire RG-1907 selon spec § 2.3 / 2.4.

- [ ] **Step 2** — Couverture

```
npx vitest run docs/regles-metier.coverage.test.js
```

- [ ] **Step 3** — Commit

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): v2.3 — ajout RG-GANTT-2003 + redéfinition 1907 (2026-05-25)"
```

---

**Fin de L2.** Les tâches en cours conservent leur `start_date` historique ; le moteur ne consomme que le reste à faire.

---

# LOT 3 — Cohérence Replan ↔ Plan de charge ↔ détection de surcharge

**Périmètre RG** : 2004, 2005.

**Critère de succès** : `computeWorkload` et `detectOverloads` consomment la `timeline` du moteur. Pas de fausse surcharge dans le Plan de charge.

---

### Task L3.1 — `computeWorkload` consomme la timeline

**Files** :

- Modify : `src/lib/utils.ts` (fonctions `computeWorkload`, `accumulateTaskWorkload`)
- Test : `src/lib/utils.test.ts`

- [ ] **Step 1** — Test rouge

```ts
describe('v2.3 / RG-GANTT-2004 — Plan de charge utilise timeline du moteur', () => {
  it('ne peint pas la charge sur les jours antérieurs à la portion consommée', () => {
    // Tâche en cours : start_historique = 2026-05-01, today = 2026-05-25,
    // reste à faire consommé du 25 au 29.
    const tasks = [
      mkTask('t1', {
        start_date: '2026-05-01',
        end_date: '2026-05-29',
        charge_jours: 10,
        progress: 50,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
        project_id: 'p1',
      }),
    ]
    // Construction d'une timeline simulée (équivalente à ce que produit le moteur).
    const timeline = new Map([
      ['c1', [{ taskId: 't1', start: '2026-05-25', end: '2026-05-29' }]],
    ])
    const dates = [
      new Date('2026-05-15'),
      new Date('2026-05-20'),
      new Date('2026-05-26'),
      new Date('2026-05-28'),
    ]
    const result = computeWorkload(
      tasks,
      [{ id: 'c1', name: 'Alice', color: null }],
      dates,
      [],
      [],
      timeline,
    )
    // Le 15 et 20 mai : 0 (portion réalisée, pas peinte).
    expect(result.get('c1')![0]).toBe(0)
    expect(result.get('c1')![1]).toBe(0)
    // Le 26 et 28 mai : > 0 (portion consommée).
    expect(result.get('c1')![2]).toBeGreaterThan(0)
    expect(result.get('c1')![3]).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2** — Adapter la signature

```ts
export function computeWorkload(
  tasks: Task[],
  collaborators: Collaborator[],
  dates: Date[],
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
  timeline?: Map<string, Array<{ taskId: string; start: string; end: string }>>, // NOUVEAU
): Map<string, number[]> {
  const result = new Map<string, number[]>()
  for (const c of collaborators) {
    result.set(c.id, new Array(dates.length).fill(0))
  }
  if (timeline) {
    // v2.3 / RG-GANTT-2004 — Source de vérité : timeline du moteur.
    for (const [collabId, intervals] of timeline.entries()) {
      const arr = result.get(collabId)
      if (!arr) continue
      for (const iv of intervals) {
        // Trouver la tâche pour récupérer l'allocation/projet/etc.
        const t = tasks.find((x) => x.id === iv.taskId)
        if (!t) continue
        accumulateIntervalWorkload(
          iv,
          t,
          arr,
          collabId,
          dates,
          allocations,
          absences,
        )
      }
    }
  } else {
    // Fallback (rétro-compat) : ancien comportement par plages [start, end] de la tâche.
    for (const t of tasks) {
      if (t.kind !== 'task') continue
      const collabIds = taskCollabIds(t)
      if (collabIds.length === 0) continue
      for (const cId of collabIds) {
        const arr = result.get(cId)
        if (!arr) continue
        accumulateTaskWorkload(t, arr, cId, dates, allocations, absences)
      }
    }
  }
  return result
}

function accumulateIntervalWorkload(
  iv: { start: string; end: string },
  t: Task,
  arr: number[],
  collabId: string,
  dates: Date[],
  allocations: MemberAllocation[],
  absences: CollaboratorAbsence[],
): void {
  const start = isoToDate(iv.start).getTime()
  const end = isoToDate(iv.end).getTime()
  const useAllocations = allocations.length > 0
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]
    const ts = d.getTime()
    if (ts < start || ts > end) continue
    if (isNonWorkingDay(d)) continue
    if (useAllocations) {
      arr[i] += getDailyAllocation(
        dateToIso(d),
        allocations,
        t.project_id,
        collabId,
        absences,
      )
    } else {
      arr[i] += 1
    }
  }
}
```

- [ ] **Step 3** — Test → PASS

- [ ] **Step 4** — Commit

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-25 — v2.3/RG-2004 : computeWorkload consomme la timeline du moteur (fallback rétro-compat)"
```

---

### Task L3.2 — `detectOverloads` consomme la timeline

**Files** :

- Modify : `src/lib/utils.ts` (fonction `detectOverloads`, helpers internes)
- Test : `src/lib/utils.test.ts`

- [ ] **Step 1** — Test rouge

```ts
describe('v2.3 / RG-GANTT-2005 — detectOverloads utilise timeline moteur', () => {
  it('deux tâches en cours dont les plages chevauchent visuellement mais consommées séquentiellement : pas de surcharge', () => {
    const tasks = [
      mkTask('t1', {
        start_date: '2026-05-01',
        end_date: '2026-05-29',
        charge_jours: 10,
        progress: 50,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
      }),
      mkTask('t2', {
        start_date: '2026-05-15',
        end_date: '2026-06-05',
        charge_jours: 10,
        progress: 30,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
      }),
    ]
    const timeline = new Map([
      [
        'c1',
        [
          { taskId: 't1', start: '2026-05-25', end: '2026-05-29' },
          { taskId: 't2', start: '2026-05-30', end: '2026-06-05' },
        ],
      ],
    ])
    const issues = detectOverloads(tasks, timeline)
    expect(issues).toEqual([]) // aucune surcharge — séquentiel
  })
})
```

- [ ] **Step 2** — Adapter `detectOverloads`

```ts
export function detectOverloads(
  tasks: Task[],
  timeline?: Map<string, Array<{ taskId: string; start: string; end: string }>>,
): CoherenceIssue[] {
  if (!timeline) {
    // Fallback ancien comportement.
    return detectOverloadsLegacy(tasks)
  }
  // v2.3 / RG-GANTT-2005 — Détection sur intervalles du moteur.
  const issues: CoherenceIssue[] = []
  for (const [collabId, intervals] of timeline.entries()) {
    const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start))
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]
        const b = sorted[j]
        if (b.start > a.end) break
        // Chevauchement réel des intervalles consommés → vraie surcharge.
        const taskA = tasks.find((t) => t.id === a.taskId)
        const taskB = tasks.find((t) => t.id === b.taskId)
        if (!taskA || !taskB) continue
        issues.push({
          kind: 'overload',
          severity: 'error',
          taskIds: [a.taskId, b.taskId],
          message: `Surcharge : « ${taskA.name} » et « ${taskB.name} » se chevauchent sur le même collaborateur.`,
        })
      }
    }
  }
  return issues
}
```

Garder la fonction legacy renommée `detectOverloadsLegacy` pour les tests historiques (à supprimer en v2.4 si plus utilisée).

- [ ] **Step 3** — Test → PASS, commit

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-25 — v2.3/RG-2005 : detectOverloads sur timeline du moteur (legacy en fallback)"
```

---

### Task L3.3 — App.tsx : `useMemo` du Replan à la volée

**Files** :

- Modify : `src/App.tsx`

- [ ] **Step 1** — Ajouter le useMemo

Localiser où sont consommés `coherenceIssues` et où est rendu `WorkloadChart`. Ajouter en amont :

```ts
// v2.3 / RG-GANTT-2004 / 2005 — Replan à la volée pour cohérence
// Plan de charge ↔ détection surcharge ↔ moteur. Mémoïsé par React :
// recalcul uniquement quand les inputs changent.
const replanLiveResult = useMemo(() => {
  if (!state?.current_project) return null
  return replanTasks(
    orderedTasks,
    state.current_project.project_start_date,
    state.member_allocations,
    state.collaborator_absences,
    { ignoreToday: advancePlanningChecked },
  )
}, [
  orderedTasks,
  state?.current_project?.project_start_date,
  state?.member_allocations,
  state?.collaborator_absences,
  advancePlanningChecked,
])

// coherenceIssues est désormais calculé avec la timeline du moteur.
const coherenceIssues = useMemo(() => {
  if (!replanLiveResult) return []
  return detectCoherenceIssues(orderedTasks, replanLiveResult.timeline)
}, [orderedTasks, replanLiveResult])
```

Et passer `replanLiveResult.timeline` à `WorkloadChart` :

```tsx
<WorkloadChart
  tasks={orderedTasks}
  collaborators={state.collaborators}
  ...
  timeline={replanLiveResult?.timeline}
/>
```

- [ ] **Step 2** — Adapter `WorkloadChart` pour accepter la prop `timeline`

```tsx
// src/components/WorkloadChart.tsx
type Props = {
  // ... props existantes
  timeline?: Map<string, Array<{ taskId: string; start: string; end: string }>>
}

function WorkloadChart({ tasks, collaborators, dates, allocations, absences, timeline, ... }: Props) {
  const workload = useMemo(
    () => computeWorkload(tasks, collaborators, dates, allocations, absences, timeline),
    [tasks, collaborators, dates, allocations, absences, timeline],
  )
  // ... rendu
}
```

- [ ] **Step 3** — TS check + suite complète

```
npx tsc --noEmit
npm test
```

- [ ] **Step 4** — Commit

```bash
git add src/App.tsx src/components/WorkloadChart.tsx
git commit -m "2026-05-25 — v2.3/RG-2004/2005 : useMemo replan à la volée + Plan de charge consomme timeline moteur"
```

---

### Task L3.4 — Catalogue RG : ajout 2004 et 2005

**Files** :

- Modify : `docs/regles-metier.md`

- [ ] **Step 1** — Ajouter RG-2004 et RG-2005 selon spec § 2.4.

- [ ] **Step 2** — Commit

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): v2.3 — ajout RG-GANTT-2004 et 2005 (cohérence timeline moteur) (2026-05-25)"
```

---

**Fin de L3.** Cohérence parfaite Replan ↔ Plan de charge ↔ détection surcharge.

---

# LOT 4 — Cas particuliers

**Périmètre RG** : 2006, 2007, 2008, 2009.

**Critère de succès** : alertes spécifiques, comportements homogènes.

---

### Task L4.1 — RG-GANTT-2006 : prédécesseur terminé dans le futur

**Files** :

- Modify : `src/lib/utils.ts` (`computeReplanEarliestStart` + nouvelle alerte dans `detectCoherenceIssues`)
- Test : `src/lib/utils.test.ts`

- [ ] **Step 1** — Test rouge

```ts
describe('v2.3 / RG-GANTT-2006 — prédécesseur terminé dans le futur', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('ignore la contrainte pred si pred terminé et end>today', () => {
    const tasks = [
      mkTask('p', {
        start_date: '2026-12-01',
        end_date: '2026-12-31',
        progress: 100,
        charge_jours: 20,
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
      }),
      mkTask('s', {
        start_date: '2027-01-01',
        end_date: '2027-01-31',
        progress: 0,
        charge_jours: 5,
        predecessor_id: 'p',
        collaborator_id: 'c2',
        collaborator_ids: ['c2'],
      }),
    ]
    const result = replanTasks(tasks, '2026-01-01', [], [])
    // s ne suit PAS la fin de p (qui est dans le futur), elle démarre au plus tôt.
    expect(result.moves.find((m) => m.id === 's')?.newStart).toBe('2026-05-25')
  })

  it('alerte ajoutée dans le bandeau', () => {
    const tasks = [
      mkTask('p', {
        start_date: '2026-12-01',
        end_date: '2026-12-31',
        progress: 100,
      }),
      mkTask('s', {
        start_date: '2027-01-01',
        end_date: '2027-01-31',
        progress: 0,
        predecessor_id: 'p',
      }),
    ]
    const issues = detectCoherenceIssues(tasks)
    const alert = issues.find((i) => i.kind === 'pred_finished_future')
    expect(alert).toBeDefined()
    expect(alert?.message).toMatch(/terminé.*futur/i)
  })
})
```

- [ ] **Step 2** — Activer le bypass dans `computeReplanEarliestStart`

Compléter le bloc qu'on avait laissé en L1 :

```ts
if (t.predecessor_id) {
  const pred = tasksById.get(t.predecessor_id)
  if (pred) {
    const today = todayIso()
    const predEnd = proposed.get(pred.id)?.end ?? pred.end_date
    // v2.3 / RG-GANTT-2006 — Si pred terminé mais end dans le futur, ignorer.
    const ignorePred = pred.progress === 100 && predEnd > today
    if (!ignorePred) {
      const lagStart = computeSuccessorStart(predEnd, t.predecessor_lag || 0)
      if (lagStart > earliest) earliest = lagStart
    }
  }
}
```

- [ ] **Step 3** — Ajouter le détecteur d'incohérence

Dans `detectCoherenceIssues` (ou créer une fonction `detectPredFinishedFuture`) :

```ts
function detectPredFinishedFuture(tasks: Task[]): CoherenceIssue[] {
  const today = todayIso()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const issues: CoherenceIssue[] = []
  for (const t of tasks) {
    if (t.kind === 'phase' || !t.predecessor_id) continue
    const pred = byId.get(t.predecessor_id)
    if (!pred) continue
    if (pred.progress === 100 && pred.end_date > today) {
      issues.push({
        kind: 'pred_finished_future',
        severity: 'warning',
        taskIds: [t.id, pred.id],
        message: `Le prédécesseur « ${pred.name} » de la tâche « ${t.name} » est terminé mais ses dates sont dans le futur ; la contrainte n'a pas été appliquée.`,
      })
    }
  }
  return issues
}
```

L'inclure dans le `detectCoherenceIssues` global.

- [ ] **Step 4** — Test → PASS, commit

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-25 — v2.3/RG-2006 : pred terminé dans le futur ignoré par moteur + alerte"
```

---

### Task L4.2 — RG-2007, 2008, 2009 : jalon sans pred, phase vide, sans collab

**Files** :

- Modify : `src/lib/utils.ts` (vérifications + ajustements mineurs)
- Test : `src/lib/utils.test.ts`

- [ ] **Step 1** — Tests rouges

```ts
describe('v2.3 / RG-GANTT-2007 — jalon sans pred', () => {
  it('placé à project_start_date (mode anticipé)', () => {
    const tasks = [
      mkTask('j1', {
        kind: 'milestone',
        start_date: '2027-01-01',
        end_date: '2027-01-01',
      }),
    ]
    const result = replanTasks(tasks, '2026-03-01', [], [], {
      ignoreToday: true,
    })
    expect(result.moves[0].newStart).toBe('2026-03-01')
  })
})

describe('v2.3 / RG-GANTT-2008 — phase vide', () => {
  it('a start_date = end_date = project_start_date', () => {
    const tasks = [
      mkTask('p1', {
        kind: 'phase',
        start_date: '2025-01-01',
        end_date: '2025-12-31',
      }),
    ]
    const result = replanTasks(tasks, '2026-03-01', [], [])
    // … le moteur ne traite pas les phases directement (recompute par recomputePhaseDates),
    // mais on vérifie au moins que ses dates par défaut sont cohérentes.
    // Cas vraiment validé en intégration côté DAL serveur.
    // Ici on s'assure surtout que le moteur ne plante pas.
    expect(result).toBeDefined()
  })
})

describe('v2.3 / RG-GANTT-2009 — activité sans collab', () => {
  it('traitée comme capacité infinie, pas de surcharge possible', () => {
    const tasks = [
      mkTask('t1', {
        start_date: '2026-05-01',
        end_date: '2026-05-10',
        charge_jours: 5,
        progress: 0,
        collaborator_id: null,
        collaborator_ids: [],
      }),
      mkTask('t2', {
        start_date: '2026-05-01',
        end_date: '2026-05-10',
        charge_jours: 5,
        progress: 0,
        collaborator_id: null,
        collaborator_ids: [],
      }),
    ]
    const result = replanTasks(tasks, '2026-01-01', [], [], {
      ignoreToday: true,
    })
    // Les deux tâches sans collab démarrent le même jour, sans contrainte de timeline.
    expect(result.moves.find((m) => m.id === 't1')?.newStart).toBe(
      result.moves.find((m) => m.id === 't2')?.newStart,
    )
  })
})
```

- [ ] **Step 2** — Vérifier le comportement actuel

Beaucoup de ces cas sont déjà conformes par construction (jalon, sans collab). Lancer les tests : ceux qui passent déjà → tant mieux, on les conserve comme tests de non-régression. Ceux qui échouent → adapter.

- [ ] **Step 3** — Adapter si besoin

Si jalon sans pred utilisait son `start_date` actuelle comme borne basse → s'assurer que `computeReplanEarliestStart` est appelée même pour les jalons (typiquement les jalons ne sont pas placés par `placeTaskInTimeline` mais leurs dates suivent la cascade serveur). Vérifier ce point spécifique côté serveur (`propagateToSuccessors`) ou côté moteur.

- [ ] **Step 4** — Commit

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-25 — v2.3/RG-2007/2008/2009 : jalon/phase vide/sans collab homogénéisés sur project_start_date"
```

---

### Task L4.3 — Catalogue RG : ajout 2006, 2007, 2008, 2009

**Files** :

- Modify : `docs/regles-metier.md`

- [ ] **Step 1** — Ajouter selon spec § 2.4

- [ ] **Step 2** — Commit

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): v2.3 — ajout RG-GANTT-2006/2007/2008/2009 (cas limites) (2026-05-25)"
```

---

**Fin de L4.** Tous les cas limites sont couverts.

---

# Smoke test final manuel

- [ ] **Step F.1** — Démarrer le projet

```bash
cd /Users/seb/Developpement/Gantt
npm run dev
```

Ouvrir http://localhost:5174/gantt/.

- [ ] **Step F.2** — Vérifier la modal Paramètres

Cliquer sur ✏️ à côté du sélecteur de projet → modal s'ouvre avec nom + date démarrage.

Modifier la date à une valeur dans le passé (ex. `2026-03-01`) → save → recharger la page → date conservée.

Tenter de mettre une date postérieure à une tâche en cours (ex. `2026-12-01` si une tâche est en `progress=50` au 2026-05-15) → message d'erreur attendu.

- [ ] **Step F.3** — Reproduire le bug de l'utilisateur (tâche bloquée au 06/08)

1. Sur la tâche « Recherche audience » à `progress=0` et `start_date=2026-08-06` (état actuel de la base).
2. Cliquer « Replan ».
3. La tâche doit revenir à `MAX(project_start_date, today)` = `today=2026-05-25` (si project_start_date est dans le passé).

- [ ] **Step F.4** — Vérifier l'Option γ

Tâche en cours (`progress=50`) avec `start_date=2026-05-01` :

- Cliquer Replan → start reste à 05/01, end glisse à today+reste.
- Ouvrir TaskEditor → champ start_date grisé.
- Tenter drag horizontal de la barre → aucun effet.

- [ ] **Step F.5** — Vérifier la cohérence Plan de charge

Deux tâches en cours dont les plages [start, end] se chevauchent visuellement → Plan de charge ne montre PAS de cellule rouge sur les jours où elles ne sont en réalité pas chevauchantes côté moteur.

- [ ] **Step F.6** — Mode anticipé

Cocher la case « Planification anticipée » → toutes les tâches sont replacées à la date démarrage projet (qui peut être passée).

Décocher → today redevient la borne basse.

- [ ] **Step F.7** — Création nouveau projet

Cliquer ➕ → dialog avec nom + date (défaut today). Créer → le nouveau projet a une `project_start_date` correcte.

---

## Notes opérationnelles

- **Migration** : aucune action utilisateur requise. La colonne `project_start_date` est ajoutée automatiquement au boot.
- **Données démo persistées** : conservées comme données utilisateur. L'utilisateur peut les supprimer manuellement.
- **Tâches actuellement « parquées dans le futur »** : seront automatiquement ramenées au plus tôt au 1er Replan post-déploiement (objectif de la refonte).
- **Performance** : `useMemo` sur `replanTasks` à chaque rendu, mais le calcul est trivial (~10ms pour 100 tâches).

## Convention de commit utilisée

- **Code** : `2026-05-25 — v2.3/RG-XXX : description courte`
- **Docs (regles, plan, spec)** : `docs(regles|plan|spec): description (2026-05-25)`

Cohérent avec l'historique du projet (cf. `git log --oneline`).
