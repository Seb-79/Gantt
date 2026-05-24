# Plan d'implémentation — Replan invariance / progress / abandon partial / mode anticipé

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec** : [`docs/superpowers/specs/2026-05-24-replan-progress-design.md`](../specs/2026-05-24-replan-progress-design.md)

**Goal:** Corriger la boucle divergente du Replan sur `charge_jours`, faire que le Replan prenne en compte `progress`, simplifier en abandonnant le « Replan partiel », et ajouter un mode optionnel « Planification anticipée ».

**Architecture:** Le Replan client devient progress-aware et envoie systématiquement `charge_jours` dans son PATCH. Le serveur honore les trois champs `(start_date, end_date, charge_jours)` lorsqu'ils sont fournis ensemble (cas 3a' nouveau), supprimant ainsi la back-dérivation parasite. Le code du Replan partiel est intégralement supprimé. Un toggle UI persisté en `localStorage` par projet pilote la borne basse `today` du moteur.

**Tech Stack:** TypeScript (React + Vite, dossier `src/`), JavaScript Node (Express + better-sqlite3, dossier `server/` + `db/`), Vitest (unit + intégration), Testing Library (composants React).

**Ordre des lots (intentionnel)** :

1. **L1 — Invariance + Contrat PATCH** corrige d'abord la boucle (urgent, sans changement de comportement utilisateur visible).
2. **L2 — Abandon du Replan partiel** simplifie le moteur avant d'y greffer les nouvelles règles `progress`.
3. **L3 — Prise en compte de `progress`** enrichit le moteur sur la base nettoyée.
4. **L4 — Mode anticipé** ajoute le toggle optionnel.

Chaque lot se termine par un commit mergeable indépendamment.

---

## Vue d'ensemble des fichiers

| Fichier                                    | Responsabilité                                                                   | Modifié dans                  |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------- |
| `src/lib/utils.ts`                         | Moteur Replan (fonctions pures)                                                  | L1, L2, L3, L4                |
| `src/lib/types.ts`                         | Type `ReplanMove` (ajout `charge_jours`)                                         | L1                            |
| `src/App.tsx`                              | Orchestration UI/API ; `submitReplanMoves`, `handleOpenReplan`, `handleSaveTask` | L1, L2, L4                    |
| `src/components/CoherenceAlert.tsx`        | Bandeau d'incohérences                                                           | L2                            |
| `src/components/TaskEditor.tsx`            | Formulaire de tâche                                                              | L3                            |
| `src/components/GanttChart.tsx`            | Diagramme                                                                        | L3 (affichage progress phase) |
| `src/lib/storage.ts`                       | **NOUVEAU** — helper localStorage typé pour préférences projet                   | L4                            |
| `src/components/AdvancePlanningToggle.tsx` | **NOUVEAU** — toggle « Planification anticipée »                                 | L4                            |
| `db/index.js`                              | DAL serveur ; `resolveChargeAndEnd`, `updateTask`                                | L1, L3                        |
| `src/lib/utils.test.ts`                    | Tests unitaires moteur                                                           | L1, L2, L3, L4                |
| `db/index.test.js`                         | Tests DAL                                                                        | L1, L3                        |
| `src/App.test.tsx`                         | Tests intégration UI                                                             | L1, L2, L4                    |
| `src/components/TaskEditor.test.tsx`       | Tests formulaire                                                                 | L3                            |
| `src/components/CoherenceAlert.test.tsx`   | Tests bandeau                                                                    | L2                            |
| `docs/regles-metier.md`                    | Catalogue RG                                                                     | L1, L2, L3, L4                |

---

# LOT 1 — Invariance de la charge + Contrat PATCH

**Périmètre** : RG-INV, RG-W. Corrige Bug B1 (boucle divergente). Aucun changement de comportement utilisateur visible : le PATCH du Replan inclut désormais `charge_jours`, ce qui empêche la back-dérivation côté serveur.

**Critère de succès** : le test de répro de la boucle B1 passe (test n° 13 de la spec).

---

### Task 1: Test de répro du Bug B1 (TDD, doit échouer avant L1)

**Files:**

- Modify: `src/lib/utils.test.ts`

- [ ] **Step 1.1: Ajouter le test de répro de la boucle**

Localiser le bloc `describe('replanTasks', ...)` ou créer un nouveau bloc en fin de fichier. Ajouter :

```ts
describe('v2.2 / RG-INV — invariance de la charge sous Replan', () => {
  it('RG-INV — 2 Replans consécutifs sans modification produisent le même état (le 2e retourne [])', () => {
    // Allocation 50 % pour le collab → l'engine étire l'end_date pour absorber la charge.
    const tasks: Task[] = [
      {
        id: 't1',
        name: 'T1',
        kind: 'task',
        start_date: '2026-06-01',
        end_date: '2026-06-12', // 10 jours ouvrés à 50 % = 5 jours-allocation
        progress: 0,
        priority: 3,
        charge_jours: 5,
        project_id: 'p1',
        collaborator_id: 'c1',
        collaborator_ids: ['c1'],
        predecessor_id: null,
        predecessor_lag: 0,
        not_before_date: null,
        not_later_than_date: null,
        parent_id: null,
        color: null,
      },
    ]
    const allocations: MemberAllocation[] = [
      {
        id: 'a1',
        project_id: 'p1',
        collaborator_id: 'c1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        allocation_pct: 50,
      },
    ]
    // 1er Replan : peut produire des moves (réajustement initial allocation-aware).
    const moves1 = replanTasks(tasks, undefined, allocations, [])
    // Appliquer les moves au modèle in-memory en respectant le contrat RG-W :
    // start, end ET charge_jours sont préservés. La charge NE DOIT PAS bouger.
    for (const m of moves1) {
      const t = tasks.find((x) => x.id === m.id)!
      t.start_date = m.newStart
      t.end_date = m.newEnd
      // charge_jours conservée (invariance).
    }
    // 2e Replan : doit être un no-op.
    const moves2 = replanTasks(tasks, undefined, allocations, [])
    expect(moves2).toEqual([])
  })
})
```

- [ ] **Step 1.2: Lancer le test pour vérifier qu'il échoue**

```
npx vitest run src/lib/utils.test.ts -t "RG-INV"
```

Attendu : **FAIL**. La première itération produit des moves, et la 2e itération produit elle aussi des moves (la `end_date` glisse à chaque tour parce que le moteur ne sait pas que la `charge_jours` doit rester stable — ce qui est exactement le bug B1 reproduit côté pur).

Note : ce test échoue **côté pur**, sans serveur. Pour reproduire la boucle complète serveur, il faudrait passer par `updateTask` qui back-dérive. Ce test pur capture la moitié haute du bug. Le test serveur dédié arrive en Task 4.

- [ ] **Step 1.3: Commit du test rouge**

```bash
git add src/lib/utils.test.ts
git commit -m "2026-05-24 — test(repro) RG-INV : 2 Replans consécutifs doivent être idempotents (échoue avant fix)"
```

---

### Task 2: Cas 3a' dans `resolveChargeAndEnd` côté serveur

**Files:**

- Modify: `db/index.js:1668-1746` (fonction `resolveChargeAndEnd`)
- Test: `db/index.test.js`

- [ ] **Step 2.1: Ajouter le test serveur du cas 3a'**

Dans `db/index.test.js`, repérer le `describe` qui contient les tests RG-GANTT-0100 (vers ligne 540-555) et ajouter à la suite :

```js
it('v2.2 / RG-W — PATCH avec start+end+charge tous explicites : tous honorés sans recalcul', () => {
  // Crée une tâche initiale avec charge 5, end calculé depuis start.
  updateTask(db, 't1', { start_date: '2026-06-01', charge_jours: 5 })
  // PATCH simulant un Replan : envoie start, end ET charge ensemble.
  // Aucun des trois ne doit être recalculé / back-dérivé par le serveur.
  updateTask(db, 't1', {
    start_date: '2026-06-08',
    end_date: '2026-06-19', // valeur "imposée" par le client (10 j calendaires)
    charge_jours: 5, // charge inchangée par le replan
  })
  const t = getFullState(db).tasks.find((x) => x.id === 't1')
  expect(t.start_date).toBe('2026-06-08')
  expect(t.end_date).toBe('2026-06-19') // honorée telle quelle, pas recalculée
  expect(t.charge_jours).toBe(5) // honorée telle quelle, pas back-dérivée
})
```

- [ ] **Step 2.2: Lancer le test pour vérifier qu'il échoue**

```
npm test -- --run db/index.test.js -t "RG-W"
```

Attendu : **FAIL**. Le cas 3a actuel (charge_explicit) recalcule end à partir de charge → `end_date` devient autre chose que `2026-06-19`.

- [ ] **Step 2.3: Implémenter le cas 3a' dans `resolveChargeAndEnd`**

Dans `db/index.js`, ouvrir `resolveChargeAndEnd` (ligne 1668). Juste après le bloc des constantes `hasExplicitCharge` / `hasExplicitEnd` (vers ligne 1701-1709), AVANT le `if (hasExplicitCharge)` de la ligne 1711, insérer :

```js
// v2.2 / RG-W — Cas 3a' : si charge ET end_date sont TOUS DEUX fournis par
// le client (signal du Replan ou d'un éditeur qui contrôle les trois),
// les deux valeurs sont honorées telles quelles. Pas de back-dérivation,
// pas de recalcul. Ce cas court-circuite 3a (qui écraserait end) et 3b
// (qui back-dériverait charge — bug B1 historique du Replan).
if (hasExplicitCharge && hasExplicitEnd) {
  const c = Math.max(1, Math.floor(Number(patch.charge_jours)))
  return { charge_jours: c, end_date: patch.end_date }
}
```

- [ ] **Step 2.4: Vérifier que le nouveau test passe ET que les anciens tests RG-GANTT-0100 passent toujours**

```
npm test -- --run db/index.test.js -t "RG-GANTT-0100|RG-W"
```

Attendu : **PASS** sur tous (drag bord droit RG-0100 : continue d'utiliser cas 3b ; charge_jours seul : continue d'utiliser cas 3a ; nouveau cas 3a' : passe).

- [ ] **Step 2.5: Commit**

```bash
git add db/index.js db/index.test.js
git commit -m "2026-05-24 — v2.2/RG-W : cas 3a' dans resolveChargeAndEnd (start+end+charge tous honorés)"
```

---

### Task 3: Inclure `charge_jours` dans `ReplanMove` et le PATCH

**Files:**

- Modify: `src/lib/utils.ts:1596-1620` (type `ReplanMove`)
- Modify: `src/lib/utils.ts:1938-1962` (fonction `buildReplanMoves`)
- Modify: `src/App.tsx:900-933` (fonction `submitReplanMoves`)

- [ ] **Step 3.1: Ajouter `charge_jours` au type `ReplanMove`**

Dans `src/lib/utils.ts`, ouvrir l'interface `ReplanMove` (ligne 1596). Ajouter le champ :

```ts
export interface ReplanMove {
  id: string
  name: string
  collaborator_id: string | null
  oldStart: string
  oldEnd: string
  /** Date de début proposée par la replanification. */
  newStart: string
  /** Date de fin proposée par la replanification. */
  newEnd: string
  /** v1.23 — lag courant à renvoyer tel quel dans le PATCH. */
  predecessor_lag: number
  /** v2.2 / RG-W — charge_jours de la tâche, transmise telle quelle au PATCH
   *  pour empêcher la back-dérivation côté serveur (RG-INV). */
  charge_jours: number
}
```

- [ ] **Step 3.2: Populer `charge_jours` dans `buildReplanMoves`**

Dans `src/lib/utils.ts`, ouvrir `buildReplanMoves` (ligne 1938). Modifier la construction de l'objet `moves.push({...})` :

```ts
moves.push({
  id: t.id,
  name: t.name,
  collaborator_id: t.collaborator_id,
  oldStart: t.start_date,
  oldEnd: t.end_date,
  newStart: p.start,
  newEnd: p.end,
  predecessor_lag: t.predecessor_lag || 0,
  // v2.2 / RG-W — Charge transmise telle quelle dans le PATCH : le serveur
  // honore les 3 champs sans back-dérivation (cf. resolveChargeAndEnd cas 3a').
  charge_jours: t.charge_jours ?? 1,
})
```

- [ ] **Step 3.3: Inclure `charge_jours` dans le body du PATCH**

Dans `src/App.tsx`, ouvrir `submitReplanMoves` (ligne 900). Modifier le body :

```ts
            body: JSON.stringify({
              start_date: m.newStart,
              end_date: m.newEnd,
              predecessor_lag: m.predecessor_lag,
              // v2.2 / RG-W — Charge incluse pour empêcher la back-dérivation
              // côté serveur (RG-INV). Le moteur de Replan ne modifie JAMAIS
              // charge_jours, ce champ est ici uniquement pour neutraliser le
              // cas 3b côté serveur.
              charge_jours: m.charge_jours,
            }),
```

- [ ] **Step 3.4: Lancer le test de répro de Task 1 — il doit maintenant passer**

```
npx vitest run src/lib/utils.test.ts -t "RG-INV"
```

Attendu : **PASS**. Le 2e Replan retourne `[]` parce que `charge_jours` reste stable dans le modèle in-memory mis à jour par les moves.

- [ ] **Step 3.5: Lancer toute la suite pour vérifier qu'aucun test existant ne casse**

```
npm test
```

Attendu : **PASS** intégral (les tests existants du Replan ne dépendent pas du nouveau champ ; les `expect` sur `ReplanMove` portent sur les champs déjà présents).

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/utils.ts src/App.tsx
git commit -m "2026-05-24 — v2.2/RG-W/RG-INV : ReplanMove.charge_jours + PATCH inclut charge_jours (corrige boucle B1)"
```

---

### Task 4: Test intégration — le PATCH généré par Replan inclut `charge_jours`

**Files:**

- Modify: `src/App.test.tsx`

- [ ] **Step 4.1: Ajouter le test**

Repérer dans `src/App.test.tsx` un test existant qui mocke `fetch` pour intercepter les PATCH de replan (chercher `"chaque PATCH de replan inclut le lag"`). Ajouter à la suite, dans le même `describe` :

```tsx
it('v2.2 / RG-W — chaque PATCH de replan inclut charge_jours', async () => {
  // Réutilise le setup du test précédent : on déclenche un Replan via le bouton
  // et on intercepte le PATCH. Voir le test "chaque PATCH de replan inclut le lag"
  // pour la mise en place complète du mock fetch ; on copie ici le minimum.
  const patchBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH' && url.startsWith('/api/tasks/')) {
      patchBodies.push(JSON.parse(init.body as string))
      return new Response(JSON.stringify({ version: 1, changed: true }), {
        status: 200,
      })
    }
    // Réutiliser le mock /api/state du test précédent.
    return defaultFetchMock(url, init)
  }) as typeof fetch

  // … déclencher le Replan via clic sur le bouton (copier la mécanique du test "lag").
  // Une fois les PATCH envoyés :
  for (const body of patchBodies) {
    expect(body).toHaveProperty('charge_jours')
    expect(typeof body.charge_jours).toBe('number')
    expect(body.charge_jours).toBeGreaterThanOrEqual(1)
  }
})
```

Note d'implémentation : si le test existant `"chaque PATCH de replan inclut le lag"` partage déjà un helper (fixture) pour le setup du mock fetch et le déclenchement du Replan, le réutiliser. Sinon, dupliquer la mécanique en restant minimal — l'objectif est de vérifier la forme du PATCH, pas le comportement du Replan.

- [ ] **Step 4.2: Lancer le test, vérifier qu'il passe (le code est déjà en place depuis Task 3)**

```
npx vitest run src/App.test.tsx -t "RG-W — chaque PATCH"
```

Attendu : **PASS**.

- [ ] **Step 4.3: Commit**

```bash
git add src/App.test.tsx
git commit -m "2026-05-24 — test(integ) v2.2/RG-W : PATCH de replan contient charge_jours"
```

---

### Task 5: Catalogue RG — ajouter RG-INV (1900), RG-W (1901), réviser RG-GANTT-0100

**Files:**

- Modify: `docs/regles-metier.md`

- [ ] **Step 5.1: Ajouter RG-GANTT-1900 (RG-INV) et RG-GANTT-1901 (RG-W) dans la Famille 10**

Repérer la fin de la Famille 10 (« Replanification », vers ligne 689). Insérer juste avant la séparation `---` :

```markdown
### RG-GANTT-1900

**(v2.2 — invariance de la charge)** Un Replan ne modifie JAMAIS la
`charge_jours` d'une activité. La charge est un invariant ; seules
`start_date` et `end_date` peuvent évoluer sous l'action du Replan.
Cette règle garantit qu'un Replan suivi d'aucune modification utilisateur
est un point fixe : un second Replan immédiat retourne `[]`.

**Tests :** `utils.test.ts` → « v2.2 / RG-INV — 2 Replans consécutifs… » ; `db/index.test.js` → « v2.2 / RG-W — PATCH avec start+end+charge… ».

### RG-GANTT-1901

**(v2.2 — contrat PATCH du Replan)** Le PATCH issu du Replan (manuel ou
automatique via RG-GANTT-0909) inclut systématiquement les quatre
champs `start_date`, `end_date`, `charge_jours` et `predecessor_lag`.
Le serveur honore les quatre valeurs telles quelles, sans
back-dérivation. RG-GANTT-0100 (back-dérivation de `charge_jours`
depuis `end_date - start_date`) ne s'applique plus qu'au drag manuel
du bord droit dans le diagramme, où `charge_jours` n'est pas envoyé.

**Tests :** `db/index.test.js` → « v2.2 / RG-W — PATCH avec start+end+charge… » ; `App.test.tsx` → « v2.2 / RG-W — chaque PATCH de replan inclut charge_jours ».
```

- [ ] **Step 5.2: Réviser RG-GANTT-0100 pour préciser la portée**

Localiser RG-GANTT-0100 (vers ligne 81). À la fin du paragraphe principal, AVANT la ligne `**Tests :** …`, ajouter un nouveau paragraphe :

```markdown
**(v2.2)** La back-dérivation depuis `end_date` (cas où seule `end_date`
est fournie) ne s'applique qu'au **drag manuel du bord droit** dans le
diagramme Gantt. Le Replan utilise un contrat distinct (RG-GANTT-1901)
qui fournit `charge_jours` explicitement pour empêcher la back-dérivation.
```

- [ ] **Step 5.3: Vérifier la non-régression des tests de couverture du catalogue**

```
npx vitest run docs/regles-metier.coverage.test.js
```

Attendu : **PASS** (le test de couverture vérifie que les RG citées renvoient à des tests existants).

- [ ] **Step 5.4: Commit**

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): ajout RG-GANTT-1900 (invariance charge) + 1901 (contrat PATCH Replan) + révision 0100 (2026-05-24)"
```

---

**Fin de L1.** À ce stade, la boucle B1 est corrigée. Aucun changement de comportement utilisateur visible.

---

# LOT 2 — Abandon du Replan partiel

**Périmètre** : Suppression intégrale de RG-GANTT-0905 et de tous les artefacts associés. Aucun changement de logique de placement.

**Critère de succès** : `replanTasks` n'accepte plus de paramètre `concernedIds` ; le bouton « Replan partiel » a disparu du bandeau ; aucun test ne porte plus sur le scope `'partial'`.

---

### Task 6: Retirer `concernedIds` de la signature de `replanTasks`

**Files:**

- Modify: `src/lib/utils.ts:1964-2008` (fonction `replanTasks`)

- [ ] **Step 6.1: Modifier la signature et le corps**

Remplacer l'intégralité de `replanTasks` (ligne 1964 à 2008) par :

```ts
export function replanTasks(
  tasks: Task[],
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
): ReplanMove[] {
  // v2.2 — Le Replan partiel (RG-GANTT-0905) est abandonné. Toutes les tâches
  // `kind='task'` sont candidates au déplacement. Les obstacles éventuels
  // (tâches lockées par RG-A à venir en L3) sont gérés par un pré-remplissage
  // dédié (cf. prefillCompletedIntervals en L3).
  // v2.0 / F2/F3 — `allocations` et `absences` sont consommées par
  // `computeEndFromCharge` pour calculer la fin de chaque tâche.
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const order = buildReplanOrder(tasks)

  const proposed = new Map<string, { start: string; end: string }>()
  for (const t of tasks) {
    proposed.set(t.id, { start: t.start_date, end: t.end_date })
  }

  const timeline = new Map<string, Array<[string, string]>>()

  for (const t of order) {
    placeTaskInTimeline(t, tasksById, proposed, timeline, allocations, absences)
  }

  return buildReplanMoves(order, proposed)
}
```

- [ ] **Step 6.2: Adapter les appels dans `src/App.tsx`**

Dans `handleOpenReplan` (ligne 1294), remplacer le bloc :

```ts
const moves =
  scope === 'partial'
    ? replanTasks(
        orderedTasks,
        concernedTaskIds(coherenceIssues, orderedTasks),
        allocs,
        absences,
      )
    : replanTasks(orderedTasks, undefined, allocs, absences)
```

par :

```ts
const moves = replanTasks(orderedTasks, allocs, absences)
```

Dans `handleSaveTask` (ligne 981), remplacer :

```ts
const moves = replanTasks(
  freshTasks,
  undefined,
  freshState.member_allocations,
  freshState.collaborator_absences,
)
```

par :

```ts
const moves = replanTasks(
  freshTasks,
  freshState.member_allocations,
  freshState.collaborator_absences,
)
```

- [ ] **Step 6.3: Lancer la TS-check + tests pour identifier les casses**

```
npx tsc --noEmit
npm test
```

Attendu : `tsc` doit passer. Les tests vont CASSER sur les tests « Replan partiel » (qui appellent `replanTasks(tasks, concernedIds)`). C'est OK pour cette étape — on les nettoiera en Task 10.

- [ ] **Step 6.4: Commit**

```bash
git add src/lib/utils.ts src/App.tsx
git commit -m "2026-05-24 — v2.2 : retirer concernedIds de replanTasks (abandon Replan partiel, étape 1/5)"
```

---

### Task 7: Supprimer `prefillLockedIntervals`, `concernedTaskIds` et fonctions associées

**Files:**

- Modify: `src/lib/utils.ts:1911-1932` (`prefillLockedIntervals`)
- Modify: `src/lib/utils.ts:2300-2360` environs (chercher `concernedTaskIds`, `descendantIds`)

- [ ] **Step 7.1: Identifier et supprimer les fonctions**

```
grep -n "function prefillLockedIntervals\|function concernedTaskIds\|function descendantIds\|export function concernedTaskIds" src/lib/utils.ts
```

Supprimer chacune de ces fonctions (avec leur docblock en tête).

Note : `descendantIds` est utilisée uniquement par `concernedTaskIds`. Si `descendantIds` est utilisée ailleurs (par exemple par la détection d'arbre de phases), la conserver. Vérifier :

```
grep -n "descendantIds" src/lib/utils.ts src/App.tsx src/components/
```

Si elle n'apparaît plus que dans sa propre définition après suppression de `concernedTaskIds`, la supprimer aussi.

- [ ] **Step 7.2: Supprimer les imports/exports devenus orphelins**

Dans `src/App.tsx`, retirer `concernedTaskIds` de la liste d'imports en haut de fichier (chercher l'import depuis `./lib/utils`).

- [ ] **Step 7.3: Lancer TS-check et tests**

```
npx tsc --noEmit
```

Attendu : PASS (toutes les références aux fonctions supprimées doivent l'être aussi).

- [ ] **Step 7.4: Commit**

```bash
git add src/lib/utils.ts src/App.tsx
git commit -m "2026-05-24 — v2.2 : supprime prefillLockedIntervals + concernedTaskIds (abandon Replan partiel, étape 2/5)"
```

---

### Task 8: Retirer le scope `'full' | 'partial'` et l'état associé de `App.tsx`

**Files:**

- Modify: `src/App.tsx` (états `pendingReplanScope`, `replanShortfall`, `handleOpenReplan` signature)

- [ ] **Step 8.1: Retirer le paramètre `scope` de `handleOpenReplan`**

Modifier la signature ligne 1294 :

```ts
const handleOpenReplan = async () => {
  if (!state) return
  const allocs = state.member_allocations
  const absences = state.collaborator_absences
  if (state.current_project_id) {
    const shortfallItems = scanReplanShortfalls(
      orderedTasks,
      state.current_project_id,
      allocs,
      absences,
    )
    if (shortfallItems.length > 0) {
      setReplanShortfall({ items: shortfallItems })
      return
    }
  }
  const moves = replanTasks(orderedTasks, allocs, absences)
  if (moves.length === 0) {
    await askAlert('Aucune surcharge détectée — rien à replanifier.')
    return
  }
  setReplanPreview(moves)
}
```

- [ ] **Step 8.2: Adapter l'état `replanShortfall`**

Repérer la déclaration de l'état `replanShortfall` (vers ligne 294). Modifier :

```ts
const [replanShortfall, setReplanShortfall] = useState<{
  items: ReplanShortfallItem[]
} | null>(null)
```

(Suppression de `scope: 'full' | 'partial'`.)

- [ ] **Step 8.3: Supprimer `pendingReplanScope` et le `useEffect` associé**

Retirer la déclaration (vers ligne 303) :

```ts
const [pendingReplanScope, setPendingReplanScope] = useState<…>(null)
```

Retirer le `useEffect` qui en dépend (vers ligne 1370-1381).

- [ ] **Step 8.4: Adapter `handleApplyReplanExtensions`**

Repérer la fonction (vers ligne 1349). Remplacer le corps par :

```ts
const handleApplyReplanExtensions = async (plans: ExtensionPlan[]) => {
  if (!replanShortfall) return
  try {
    for (const plan of plans) {
      await handleExtendAllocations(plan)
    }
    setReplanShortfall(null)
    // v2.2 — Re-déclenchement direct (plus de mémorisation de scope).
    // Le state sera frais après fetchState() interne à handleExtendAllocations.
    void handleOpenReplan()
  } catch {
    // L'erreur est déjà affichée par handleExtendAllocations.
  }
}
```

Note : si `handleExtendAllocations` ne garantit pas un state à jour, il faudra peut-être restaurer un mécanisme de wait sur `state.version`. Vérifier le comportement existant ; en cas de doute, garder un petit `useEffect` similaire à l'ancien, mais sans le scope.

- [ ] **Step 8.5: Localiser les appels `handleOpenReplan(scope)` et retirer l'argument**

```
grep -n "handleOpenReplan(" src/App.tsx
```

Tous les appels doivent devenir `handleOpenReplan()`.

- [ ] **Step 8.6: TS-check**

```
npx tsc --noEmit
```

Attendu : PASS.

- [ ] **Step 8.7: Commit**

```bash
git add src/App.tsx
git commit -m "2026-05-24 — v2.2 : retire scope full|partial de handleOpenReplan + état pendingReplanScope (abandon Replan partiel, étape 3/5)"
```

---

### Task 9: Retirer le bouton « Replan partiel » du `CoherenceAlert`

**Files:**

- Modify: `src/components/CoherenceAlert.tsx`
- Modify: `src/components/CoherenceAlert.test.tsx`

- [ ] **Step 9.1: Identifier le bouton et son handler**

```
grep -n "Replan partiel\|partial\|scope" src/components/CoherenceAlert.tsx
```

- [ ] **Step 9.2: Supprimer le bouton « Replan partiel »**

Retirer le `<button>` correspondant et son handler (`onClick`). Conserver le bouton « Replan » qui appelle désormais `onReplan()` sans argument.

Adapter la prop du composant : la prop `onReplan: (scope: 'full' | 'partial') => void` devient `onReplan: () => void`.

- [ ] **Step 9.3: Adapter l'appel dans `App.tsx`**

```
grep -n "<CoherenceAlert" src/App.tsx
```

Modifier le binding : `onReplan={() => void handleOpenReplan()}`.

- [ ] **Step 9.4: Adapter le test du bandeau**

Dans `CoherenceAlert.test.tsx`, supprimer les tests « affiche le bouton Replan partiel » et « clic Replan partiel appelle onReplan('partial') ». Conserver les tests sur le bouton « Replan ».

- [ ] **Step 9.5: Lancer tests**

```
npx vitest run src/components/CoherenceAlert.test.tsx
```

Attendu : PASS.

- [ ] **Step 9.6: Commit**

```bash
git add src/components/CoherenceAlert.tsx src/components/CoherenceAlert.test.tsx src/App.tsx
git commit -m "2026-05-24 — v2.2 : retire bouton Replan partiel du bandeau (abandon Replan partiel, étape 4/5)"
```

---

### Task 10: Nettoyer les tests « Replan partiel » restants

**Files:**

- Modify: `src/lib/utils.test.ts`
- Modify: `src/App.test.tsx`

- [ ] **Step 10.1: Lister les tests à supprimer**

```
grep -n "Replan partiel\|concernedIds\|scope.*partial" src/lib/utils.test.ts src/App.test.tsx
```

- [ ] **Step 10.2: Supprimer le bloc `describe('replanTasks — variante PARTIELLE …')` dans `utils.test.ts`**

Retirer le bloc entier de tests partiels. S'assurer qu'aucun helper local n'était utilisé ailleurs.

- [ ] **Step 10.3: Supprimer les tests `"Replan partiel"` dans `App.test.tsx`**

Retirer les tests :

- `"Replan partiel" ne déplace que les tâches concernées`
- `"Replan complet" depuis le bandeau ouvre la modal habituelle` (renommer en `"Replan" depuis le bandeau …`)

- [ ] **Step 10.4: Lancer toute la suite**

```
npm test
```

Attendu : PASS intégral.

- [ ] **Step 10.5: Commit**

```bash
git add src/lib/utils.test.ts src/App.test.tsx
git commit -m "2026-05-24 — v2.2 : nettoie les tests Replan partiel (abandon Replan partiel, étape 5/5)"
```

---

### Task 11: Catalogue RG — supprimer RG-GANTT-0905 et adapter 0900-0908

**Files:**

- Modify: `docs/regles-metier.md`

- [ ] **Step 11.1: Supprimer la section RG-GANTT-0905**

Localiser la section (vers ligne 659-664) et la supprimer intégralement (titre `### RG-GANTT-0905`, corps, ligne `**Tests :** …`).

- [ ] **Step 11.2: Adapter RG-GANTT-0900**

Localiser RG-GANTT-0900 (vers ligne 601). Modifier la phrase qui mentionne les deux actions :

```
actions : **Replan complet** (toutes les activités du projet) et
**Replan partiel** (seules les activités concernées par les …
```

remplacer par :

```
action : **Replan** (toutes les activités du projet).
```

Adapter aussi la ligne `**Tests :** …` pour retirer la mention du test Replan partiel.

- [ ] **Step 11.3: Vérifier qu'aucune autre RG ne référence 0905**

```
grep -n "0905\|partiel\|Replan partiel" docs/regles-metier.md
```

Si occurrences restantes hors numéros de famille (ex : « la replanification… partielle »), reformuler en « la replanification ».

- [ ] **Step 11.4: Lancer le test de couverture du catalogue**

```
npx vitest run docs/regles-metier.coverage.test.js
```

Attendu : PASS.

- [ ] **Step 11.5: Commit**

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): supprime RG-GANTT-0905 (Replan partiel) + adapte 0900 (2026-05-24)"
```

---

**Fin de L2.** Le moteur de Replan est simplifié. Aucun changement de comportement utilisateur en dehors de la disparition du bouton « Replan partiel ».

---

# LOT 3 — Prise en compte de `progress`

**Périmètre** : RG-A, RG-B, RG-C, RG-L (effet implicite), RG-M, RG-N, RG-O, RG-U.

**Critère de succès** : une activité en cours (`progress > 0`) est replanifiée à partir de `today` en consommant uniquement le reste à faire ; une activité terminée (`progress = 100`) est lockée ; la phase affiche un `progress` dérivé de ses fils.

---

### Task 12: RG-A — Exclure `progress = 100` du placement + obstacle dans la timeline

**Files:**

- Modify: `src/lib/utils.ts` (fonction `replanTasks`, ajout d'un helper `prefillCompletedIntervals`)
- Test: `src/lib/utils.test.ts`

- [ ] **Step 12.1: Test RG-A — tâche progress=100 non déplacée**

Dans `src/lib/utils.test.ts`, ajouter :

```ts
describe('v2.2 / RG-A — progress=100 lockée par le Replan', () => {
  it('ne propose aucun move pour une tâche à progress=100', () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 100,
        start_date: '2026-06-01',
        end_date: '2026-06-05',
        charge_jours: 5,
      }),
      makeTask({
        id: 't2',
        progress: 0,
        start_date: '2026-06-03',
        end_date: '2026-06-07',
        charge_jours: 5,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [])
    // t1 ne doit jamais apparaître dans les moves
    expect(moves.find((m) => m.id === 't1')).toBeUndefined()
  })

  it("bloque l'intervalle de t1 comme obstacle pour les autres tâches du même collab", () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 100,
        start_date: '2026-06-01',
        end_date: '2026-06-05',
        charge_jours: 5,
        collaborator_id: 'c1',
      }),
      makeTask({
        id: 't2',
        progress: 0,
        start_date: '2026-06-01',
        end_date: '2026-06-05',
        charge_jours: 5,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [])
    // t2 doit être poussée APRÈS la fin de t1.
    const m2 = moves.find((m) => m.id === 't2')
    expect(m2).toBeDefined()
    expect(m2!.newStart >= '2026-06-08').toBe(true) // après t1 (5 j ouvrés depuis lundi 01/06)
  })
})
```

Hypothèse : `makeTask` est un helper de test existant ou à ajouter en tête du fichier. Si absent, ajouter :

```ts
function makeTask(partial: Partial<Task>): Task {
  return {
    id: 'x',
    name: 'X',
    kind: 'task',
    start_date: '2026-06-01',
    end_date: '2026-06-01',
    progress: 0,
    priority: 3,
    charge_jours: 1,
    project_id: 'p1',
    collaborator_id: null,
    collaborator_ids: [],
    predecessor_id: null,
    predecessor_lag: 0,
    not_before_date: null,
    not_later_than_date: null,
    parent_id: null,
    color: null,
    ...partial,
  }
}
```

- [ ] **Step 12.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/lib/utils.test.ts -t "RG-A"
```

Attendu : FAIL (la tâche progress=100 est traitée comme une autre, t1 apparaîtra dans moves ou t2 ne sera pas poussée).

- [ ] **Step 12.3: Implémenter `prefillCompletedIntervals`**

Dans `src/lib/utils.ts`, juste après `buildReplanOrder` (vers ligne 1764), ajouter :

```ts
/**
 * v2.2 / RG-A — Pré-remplit la timeline des collaborateurs avec les tâches
 * TERMINÉES (`progress = 100`). Ces tâches sont des obstacles que le Replan
 * doit contourner mais ne déplace JAMAIS.
 *
 * Reprend le rôle structurel de l'ancienne `prefillLockedIntervals` du
 * mode partial, avec un filtre différent (progress=100 au lieu de
 * !concernedIds.has(id)).
 */
function prefillCompletedIntervals(
  tasks: Task[],
  timeline: Map<string, Array<[string, string]>>,
): void {
  for (const t of tasks) {
    if (t.kind !== 'task') continue
    if (t.progress !== 100) continue
    const collabIds = taskCollabIds(t)
    for (const cId of collabIds) {
      pushTimelineInterval(timeline, cId, t.start_date, t.end_date)
    }
  }
}
```

- [ ] **Step 12.4: Modifier `replanTasks` pour utiliser le helper et exclure progress=100**

Dans la version courante de `replanTasks` (issue de Task 6), modifier la boucle :

```ts
const timeline = new Map<string, Array<[string, string]>>()
// v2.2 / RG-A — Pré-remplissage des tâches terminées comme obstacles.
prefillCompletedIntervals(tasks, timeline)

for (const t of order) {
  // v2.2 / RG-A — Une tâche à progress=100 est lockée : pas de placement,
  // pas de move. Elle est déjà dans la timeline via prefillCompletedIntervals.
  if (t.progress === 100) continue
  placeTaskInTimeline(t, tasksById, proposed, timeline, allocations, absences)
}
```

- [ ] **Step 12.5: Lancer test, vérifier qu'il passe**

```
npx vitest run src/lib/utils.test.ts -t "RG-A"
```

Attendu : PASS.

- [ ] **Step 12.6: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-24 — v2.2/RG-A : tâches progress=100 lockées par le Replan + obstacle dans timeline"
```

---

### Task 13: RG-B — Borne basse `today` pour activités en cours

**Files:**

- Modify: `src/lib/utils.ts` (fonction `computeReplanEarliestStart`)
- Test: `src/lib/utils.test.ts`

- [ ] **Step 13.1: Test RG-B**

Dans `utils.test.ts` :

```ts
describe('v2.2 / RG-B — borne basse today pour progress > 0', () => {
  // Helper pour injecter today dans les tests sans dépendre du calendrier réel.
  // Si todayIso() est utilisée directement, la mocker via vi.setSystemTime.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tâche progress=30 avec start_date dans le passé : Replan propose start >= today', () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 30,
        start_date: '2026-06-01', // dans le passé par rapport à today (10/06)
        end_date: '2026-06-05',
        charge_jours: 5,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [])
    expect(moves.length).toBe(1)
    expect(moves[0].newStart >= '2026-06-10').toBe(true)
  })

  it('tâche progress=30 avec start_date dans le futur : start respectée (RG-L)', () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 30,
        start_date: '2026-06-20', // dans le futur
        end_date: '2026-06-25',
        charge_jours: 5,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [])
    // start_date reste à 2026-06-20 puisque > today
    const m = moves[0]
    if (m) expect(m.newStart).toBe('2026-06-20')
    // Si pas de move (déjà sur la bonne start), tasks[0].start_date reste 2026-06-20
  })
})
```

- [ ] **Step 13.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/lib/utils.test.ts -t "RG-B"
```

Attendu : FAIL (le moteur ne prend pas encore today en compte).

- [ ] **Step 13.3: Modifier `computeReplanEarliestStart`**

Dans `src/lib/utils.ts` (ligne 1802), modifier la signature et le corps :

```ts
function computeReplanEarliestStart(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  options: { ignoreToday: boolean } = { ignoreToday: false },
): string {
  let earliest = t.start_date
  if (t.predecessor_id) {
    const pred = tasksById.get(t.predecessor_id)
    if (pred) {
      const predEnd = proposed.get(pred.id)?.end ?? pred.end_date
      const lagStart = computeSuccessorStart(predEnd, t.predecessor_lag || 0)
      if (lagStart > earliest) earliest = lagStart
    }
  }
  if (t.not_before_date) {
    const snet = snapForwardToWorkingDay(t.not_before_date)
    if (snet > earliest) earliest = snet
  }
  // v2.2 / RG-B — Pour une activité en cours (progress > 0), la date de
  // début proposée ne peut être antérieure à today. La portion déjà réalisée
  // reste figée dans le passé ; seul le reste à faire est replacé à partir
  // de today (ou plus tard si une autre contrainte le repousse).
  // v2.2 / RG-V — En mode "Planification anticipée", cette règle est suspendue
  // (option.ignoreToday). Sera câblée en L4.
  if (!options.ignoreToday && (t.progress ?? 0) > 0) {
    const today = todayIso()
    if (today > earliest) earliest = today
  }
  return snapForwardToWorkingDay(earliest)
}
```

Vérifier que `todayIso` est déjà exportée par `src/lib/utils.ts` (chercher `export function todayIso`).

- [ ] **Step 13.4: Adapter `placeTaskInTimeline` pour passer options**

`placeTaskInTimeline` n'a pas besoin de l'option `ignoreToday` à ce stade (sera ajoutée en L4 Task 20). Pour l'instant, l'appel reste sans option, ce qui équivaut à `ignoreToday = false`. Vérifier que le code compile.

- [ ] **Step 13.5: Lancer test**

```
npx vitest run src/lib/utils.test.ts -t "RG-B"
```

Attendu : PASS.

- [ ] **Step 13.6: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-24 — v2.2/RG-B : borne basse today pour activités progress > 0"
```

---

### Task 14: RG-C — Consommer le reste à faire `charge × (1 - progress)`

**Files:**

- Modify: `src/lib/utils.ts:1859-1909` (fonction `placeTaskInTimeline`)
- Test: `src/lib/utils.test.ts`

- [ ] **Step 14.1: Test RG-C**

Dans `utils.test.ts` :

```ts
describe('v2.2 / RG-C — consommation du reste à faire', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('tâche progress=50 charge=10 : Replan place 5 jours de travail', () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 50,
        start_date: '2026-06-01',
        end_date: '2026-06-12', // ancien end basé sur charge 10
        charge_jours: 10,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [])
    expect(moves.length).toBe(1)
    const m = moves[0]
    // newStart = 2026-06-01 (today), newEnd = start + 5 j ouvrés (Mo-Fr)
    expect(m.newStart).toBe('2026-06-01')
    expect(m.newEnd).toBe('2026-06-05') // 5 jours ouvrés (Lu→Ve)
    expect(m.charge_jours).toBe(10) // charge totale préservée (RG-INV)
  })

  it('tâche progress=0 : comportement identique à v2.1 (charge complète)', () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 0,
        start_date: '2026-06-01',
        end_date: '2026-06-12',
        charge_jours: 10,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [])
    // Pour progress=0 et pas de surcharge, le moteur ne propose un move que si
    // l'end calculé diffère. Sans allocation %, end = start + 10 j ouvrés.
    // 2026-06-01 (Lu) + 10 j ouvrés = 2026-06-12 (Ve) → pas de move.
    expect(moves.length).toBe(0)
  })
})
```

- [ ] **Step 14.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/lib/utils.test.ts -t "RG-C"
```

Attendu : FAIL (le moteur consomme `charge_jours` complet quel que soit progress).

- [ ] **Step 14.3: Modifier `placeTaskInTimeline`**

Dans `src/lib/utils.ts` (ligne 1859), remplacer le bloc de calcul de `charge` (lignes 1872-1875) et de `newEnd` par :

```ts
// v2.0 — La charge totale est lue depuis `task.charge_jours` (source de vérité).
// v2.2 / RG-C — Le Replan ne consomme que le reste à faire :
//   effectiveCharge = charge_totale × (1 − progress/100), arrondi au sup, min 1.
// RG-INV — La charge totale persistée reste inchangée ; effectiveCharge est
// uniquement utilisée pour le placement.
const totalCharge =
  t.charge_jours && t.charge_jours >= 1
    ? t.charge_jours
    : Math.max(1, workingDaysBetween(t.start_date, t.end_date))
const progressFrac = Math.max(0, Math.min(100, t.progress ?? 0)) / 100
const effectiveCharge = Math.max(1, Math.ceil(totalCharge * (1 - progressFrac)))
const earliest = computeReplanEarliestStart(t, tasksById, proposed)
const collabIds = taskCollabIds(t)
let newStart = earliest
for (const cId of collabIds) {
  const intervals = timeline.get(cId) || []
  const candidate = findFreeSlot(intervals, earliest, effectiveCharge)
  if (candidate > newStart) newStart = candidate
}
const newEnd = computeEndFromCharge(newStart, effectiveCharge, {
  projectId: t.project_id,
  collaboratorId: t.collaborator_id,
  collaboratorIds: collabIds.length > 0 ? collabIds : undefined,
  allocations,
  absences,
})
```

(Le reste de la fonction — `proposed.set` et la boucle `pushTimelineInterval` — reste identique.)

- [ ] **Step 14.4: Lancer test**

```
npx vitest run src/lib/utils.test.ts -t "RG-C"
```

Attendu : PASS.

- [ ] **Step 14.5: Lancer toute la suite Replan**

```
npx vitest run src/lib/utils.test.ts -t "replan|RG-A|RG-B|RG-C|RG-INV"
```

Attendu : PASS intégral.

- [ ] **Step 14.6: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-24 — v2.2/RG-C : Replan consomme uniquement le reste à faire (charge × (1-progress))"
```

---

### Task 15: RG-U — Calcul dérivé du progress d'une phase

**Files:**

- Modify: `src/lib/utils.ts` (ajout `derivePhaseProgress`)
- Test: `src/lib/utils.test.ts`

- [ ] **Step 15.1: Test RG-U**

```ts
describe('v2.2 / RG-U — progress phase dérivé', () => {
  it('phase avec 2 activités (charge 10 à 20 %, charge 30 à 80 %) → 65 %', () => {
    const tasks: Task[] = [
      makeTask({ id: 'p1', kind: 'phase', parent_id: null }),
      makeTask({ id: 't1', parent_id: 'p1', charge_jours: 10, progress: 20 }),
      makeTask({ id: 't2', parent_id: 'p1', charge_jours: 30, progress: 80 }),
    ]
    expect(derivePhaseProgress('p1', tasks)).toBe(65)
  })

  it('phase imbriquée : récursion correcte', () => {
    const tasks: Task[] = [
      makeTask({ id: 'p1', kind: 'phase', parent_id: null }),
      makeTask({ id: 'p2', kind: 'phase', parent_id: 'p1' }),
      makeTask({ id: 't1', parent_id: 'p2', charge_jours: 10, progress: 50 }),
      makeTask({ id: 't2', parent_id: 'p1', charge_jours: 10, progress: 100 }),
    ]
    // p2 = 50, p1 = (10×50 + 10×100) / 20 = 75
    expect(derivePhaseProgress('p2', tasks)).toBe(50)
    expect(derivePhaseProgress('p1', tasks)).toBe(75)
  })

  it('phase ne contenant que des jalons → null', () => {
    const tasks: Task[] = [
      makeTask({ id: 'p1', kind: 'phase' }),
      makeTask({ id: 'j1', kind: 'milestone', parent_id: 'p1' }),
      makeTask({ id: 'j2', kind: 'milestone', parent_id: 'p1' }),
    ]
    expect(derivePhaseProgress('p1', tasks)).toBeNull()
  })

  it('phase vide → null', () => {
    const tasks: Task[] = [makeTask({ id: 'p1', kind: 'phase' })]
    expect(derivePhaseProgress('p1', tasks)).toBeNull()
  })
})
```

- [ ] **Step 15.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/lib/utils.test.ts -t "RG-U"
```

Attendu : FAIL (`derivePhaseProgress` n'existe pas).

- [ ] **Step 15.3: Implémenter `derivePhaseProgress`**

Dans `src/lib/utils.ts`, dans une section dédiée (par exemple en fin de fichier ou après le bloc des fonctions de synthèse phase), ajouter :

```ts
/**
 * v2.2 / RG-U — Calcule récursivement le progress dérivé d'une phase à partir
 * de ses fils (activités, sous-phases ; jalons exclus).
 *
 * Formule :
 *   chargeEffective(c) = charge_jours(c)                       si c est une activité
 *                      | 0                                     si c est un jalon
 *                      | Σ chargeEffective(fils de c)          si c est une sous-phase
 *
 *   progressEffectif(c) = progress(c)                          si c est une activité
 *                       | derivePhaseProgress(c)               si c est une sous-phase
 *                       | (non éligible)                       si c est un jalon
 *
 *   progress(P) = Σ(charge_i × progress_i) / Σ charge_i
 *
 * Cas limite : Σ charges = 0 → moyenne arithmétique non pondérée des progress
 *              des fils éligibles. Aucun fils éligible (vide ou que des jalons)
 *              → null (affiché vide).
 *
 * @param phaseId  Id de la phase racine.
 * @param tasks    Toutes les tâches du projet (pour reconstruire l'arbre).
 * @returns        Progress dérivé (0..100 entier) ou null si non applicable.
 */
export function derivePhaseProgress(
  phaseId: string,
  tasks: Task[],
): number | null {
  const phase = tasks.find((t) => t.id === phaseId)
  if (!phase || phase.kind !== 'phase') return null
  const children = tasks.filter((t) => t.parent_id === phaseId)

  // Calcule chargeEffective et progressEffectif pour chaque fils éligible.
  const contributions: Array<{ charge: number; progress: number }> = []
  for (const c of children) {
    if (c.kind === 'milestone') continue
    if (c.kind === 'task') {
      const chg = c.charge_jours && c.charge_jours >= 1 ? c.charge_jours : 0
      contributions.push({ charge: chg, progress: c.progress ?? 0 })
    } else if (c.kind === 'phase') {
      const subProgress = derivePhaseProgress(c.id, tasks)
      if (subProgress === null) continue
      // chargeEffective de la sous-phase = Σ charges de ses descendants tasks.
      const subCharge = sumDescendantTaskCharges(c.id, tasks)
      contributions.push({ charge: subCharge, progress: subProgress })
    }
  }

  if (contributions.length === 0) return null

  const totalCharge = contributions.reduce((s, c) => s + c.charge, 0)
  if (totalCharge === 0) {
    // Cas limite : moyenne arithmétique non pondérée.
    const sum = contributions.reduce((s, c) => s + c.progress, 0)
    return Math.round(sum / contributions.length)
  }

  const weighted = contributions.reduce((s, c) => s + c.charge * c.progress, 0)
  return Math.round(weighted / totalCharge)
}

/**
 * v2.2 / RG-U — Helper : somme des `charge_jours` des descendants activités
 * d'un nœud (récursif). Jalons exclus (charge = 0).
 */
function sumDescendantTaskCharges(nodeId: string, tasks: Task[]): number {
  let total = 0
  const children = tasks.filter((t) => t.parent_id === nodeId)
  for (const c of children) {
    if (c.kind === 'task' && c.charge_jours && c.charge_jours >= 1) {
      total += c.charge_jours
    } else if (c.kind === 'phase') {
      total += sumDescendantTaskCharges(c.id, tasks)
    }
  }
  return total
}
```

- [ ] **Step 15.4: Lancer test**

```
npx vitest run src/lib/utils.test.ts -t "RG-U"
```

Attendu : PASS.

- [ ] **Step 15.5: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-24 — v2.2/RG-U : derivePhaseProgress (synthèse pondérée du progress d'une phase)"
```

---

### Task 16: TaskEditor — désactiver le champ progress pour les phases

**Files:**

- Modify: `src/components/TaskEditor.tsx`
- Modify: `src/components/TaskEditor.test.tsx`

- [ ] **Step 16.1: Test du champ progress désactivé pour kind='phase'**

Dans `TaskEditor.test.tsx`, ajouter (s'inspirer d'un test existant pour les props requises ; le pattern ci-dessous donne les valeurs essentielles) :

```tsx
it("v2.2 / RG-U — kind='phase' : champ progress désactivé (lecture dérivée)", () => {
  const phase: Task = {
    id: 'p1',
    name: 'Phase 1',
    kind: 'phase',
    start_date: '2026-06-01',
    end_date: '2026-06-30',
    progress: 0,
    priority: null,
    charge_jours: null,
    project_id: 'proj1',
    collaborator_id: null,
    collaborator_ids: [],
    predecessor_id: null,
    predecessor_lag: 0,
    not_before_date: null,
    not_later_than_date: null,
    parent_id: null,
    color: null,
  }
  const child: Task = {
    ...phase,
    id: 't1',
    name: 'T1',
    kind: 'task',
    parent_id: 'p1',
    charge_jours: 10,
    progress: 40,
  }
  render(
    <TaskEditor
      mode="edit"
      initial={phase}
      tasks={[phase, child]}
      collaborators={[]}
      memberIds={[]}
      memberAllocations={[]}
      absences={[]}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  const progressInput = screen.getByLabelText(/avancement/i)
  expect(progressInput).toBeDisabled()
})
```

Note : la prop `tasks: Task[]` doit être ajoutée au composant TaskEditor (et passée depuis App.tsx) à l'étape 16.3. Les autres props peuvent différer selon la signature actuelle — adapter à ce qui est requis sans `tasks`/`allTasks`.

- [ ] **Step 16.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/components/TaskEditor.test.tsx -t "RG-U"
```

Attendu : FAIL.

- [ ] **Step 16.3: Modifier TaskEditor**

Dans `TaskEditor.tsx`, repérer l'input de progress. Ajouter la condition de désactivation :

```tsx
<input
  type="number"
  // … props existantes
  disabled={form.kind === 'phase' || form.kind === 'milestone'}
  // v2.2 / RG-U — pour kind='phase', la valeur affichée est dérivée (lecture seule).
  // Pour kind='milestone', RG-GANTT-0200 désactive déjà.
  value={
    form.kind === 'phase'
      ? (derivePhaseProgress(form.id, allTasks) ?? '')
      : form.progress
  }
/>
```

Note : `allTasks` doit être disponible dans le scope du TaskEditor. Si la prop n'est pas déjà transmise, ajouter la prop `tasks: Task[]` au composant et la passer depuis `App.tsx`.

- [ ] **Step 16.4: Lancer test**

```
npx vitest run src/components/TaskEditor.test.tsx -t "RG-U"
```

Attendu : PASS.

- [ ] **Step 16.5: Commit**

```bash
git add src/components/TaskEditor.tsx src/components/TaskEditor.test.tsx src/App.tsx
git commit -m "2026-05-24 — v2.2/RG-U : TaskEditor désactive le champ progress pour les phases (lecture dérivée)"
```

---

### Task 16b: Test serveur RG-N — PATCH `progress` seul ne touche pas `end_date`

**Files:**

- Modify: `db/index.test.js`

- [ ] **Step 16b.1: Ajouter le test**

Dans le même `describe` que les tests RG-GANTT-0100 :

```js
it('v2.2 / RG-N — PATCH avec progress seul : end_date et charge_jours inchangés', () => {
  updateTask(db, 't1', { start_date: '2026-06-01', charge_jours: 5 })
  const before = getFullState(db).tasks.find((x) => x.id === 't1')
  // PATCH ne contenant que progress.
  updateTask(db, 't1', { progress: 50 })
  const after = getFullState(db).tasks.find((x) => x.id === 't1')
  expect(after.progress).toBe(50)
  expect(after.charge_jours).toBe(before.charge_jours)
  expect(after.end_date).toBe(before.end_date)
  expect(after.start_date).toBe(before.start_date)
})
```

- [ ] **Step 16b.2: Lancer test**

```
npm test -- --run db/index.test.js -t "RG-N"
```

Attendu : **PASS**. Si **FAIL**, le serveur recalcule silencieusement `end_date` via le cas 3c — investiguer dans `resolveChargeAndEnd` pour ajouter une garde « pas de recalcul si aucun champ temporel touché » (cf. note d'implémentation du spec § 3 / RG-N).

- [ ] **Step 16b.3: Commit**

```bash
git add db/index.test.js
git commit -m "2026-05-24 — test(serveur) v2.2/RG-N : PATCH progress seul ne touche pas end_date"
```

---

### Task 16c: Affichage du progress dérivé d'une phase dans le GanttChart

**Files:**

- Modify: `src/components/GanttChart.tsx`

- [ ] **Step 16c.1: Identifier les sites de lecture de `task.progress`**

```
grep -n "task.progress\|\.progress" src/components/GanttChart.tsx
```

Repérer les deux occurrences (largeur de barre + tooltip) signalées dans le spec § 1.

- [ ] **Step 16c.2: Calculer le progress effectif par tâche**

En haut du composant `TaskBar` ou `GanttRow` (selon la structure du fichier), avant les références à `task.progress`, ajouter :

```tsx
// v2.2 / RG-U — Pour les phases, on affiche le progress dérivé de leurs fils.
// Pour les activités et jalons, on lit la valeur stockée.
const effectiveProgress: number =
  task.kind === 'phase'
    ? (derivePhaseProgress(task.id, allTasks) ?? 0)
    : task.progress
```

Remplacer toutes les références à `task.progress` dans le rendu par `effectiveProgress`. Adapter l'import :

```ts
import { derivePhaseProgress } from '../lib/utils'
```

`allTasks` doit déjà être disponible dans le scope (le diagramme reçoit l'ensemble des tâches du projet en prop). Si ce n'est pas le cas, le passer depuis le parent.

- [ ] **Step 16c.3: Mémoïser pour éviter les recalculs**

Si plusieurs phases sont affichées, `derivePhaseProgress` est O(n) en `allTasks`, et la rendre par phase donne O(n × p). Pour rester performant à l'échelle d'un projet, mémoïser en haut du composant `GanttChart` :

```ts
const phaseProgressById = useMemo(() => {
  const map = new Map<string, number | null>()
  for (const t of tasks) {
    if (t.kind === 'phase') {
      map.set(t.id, derivePhaseProgress(t.id, tasks))
    }
  }
  return map
}, [tasks])
```

Puis dans le rendu :

```tsx
const effectiveProgress =
  task.kind === 'phase' ? (phaseProgressById.get(task.id) ?? 0) : task.progress
```

- [ ] **Step 16c.4: Vérifier le rendu manuellement après les tests automatisés**

```
npm test -- --run src/lib/utils.test.ts -t "RG-U"
```

Confirme la formule. Le rendu visuel sera vérifié à l'étape F.6 du plan.

- [ ] **Step 16c.5: Commit**

```bash
git add src/components/GanttChart.tsx
git commit -m "2026-05-24 — v2.2/RG-U : GanttChart affiche le progress dérivé pour les phases"
```

---

### Task 17: Catalogue RG — RG-A, RG-B, RG-C, RG-L, RG-M, RG-N, RG-O, RG-U

**Files:**

- Modify: `docs/regles-metier.md`

- [ ] **Step 17.1: Ajouter le bloc complet en fin de Famille 10**

Insérer après RG-GANTT-1901 (créées en L1), avant la séparation `---` qui clôt la Famille 10 :

```markdown
### RG-GANTT-1902

**(v2.2 — RG-A)** Une activité à `progress = 100` est lockée par le
Replan : ses dates ne sont jamais modifiées. Elle est ajoutée à la
timeline des collaborateurs affectés comme obstacle (intervalle
bloqué `[start_date, end_date]`) pour empêcher d'autres tâches de
s'y superposer.

**Tests :** `utils.test.ts` → « v2.2 / RG-A — progress=100 lockée par le Replan ».

### RG-GANTT-1903

**(v2.2 — RG-B)** Pour une activité à `progress > 0`, la date de
début proposée par le Replan ne peut être antérieure à la date du
jour (`today`). La portion déjà réalisée reste figée à sa date
historique ; seul le reste à faire est candidat au placement par le
Replan. La borne basse de placement est donc
`max(t.start_date, pred.end + lag, SNET, today)`.

**Tests :** `utils.test.ts` → « v2.2 / RG-B — borne basse today pour progress > 0 ».

### RG-GANTT-1904

**(v2.2 — RG-C)** Le Replan consomme `charge_jours × (1 − progress/100)`
jours-allocation (= reste à faire), arrondi au jour ouvré supérieur
(minimum 1). La charge totale persistée n'est jamais modifiée (RG-1900).

**Tests :** `utils.test.ts` → « v2.2 / RG-C — consommation du reste à faire ».

### RG-GANTT-1905

**(v2.2 — RG-L)** Une activité à `progress > 0` ET `today < start_date`
(commencée avant la date prévue selon les données saisies) ne déclenche
pas d'alerte. Le Replan respecte la `start_date` saisie : la borne
basse retombe sur `start_date` puisque `start_date > today`. L'éventuelle
incohérence (saisie utilisateur erronée) reste à arbitrer par l'utilisateur
via le TaskEditor.

### RG-GANTT-1906

**(v2.2 — RG-M)** Une activité à `progress = 100` avec
`today < end_date` (finie en avance) ne déclenche aucune alerte
(information silencieuse).

### RG-GANTT-1907

**(v2.2 — RG-N)** Un PATCH d'édition d'activité qui ne modifie que
`progress` (sans `charge_jours` ni `end_date`) ne recalcule pas
`end_date` côté serveur. C'est le Replan automatique (RG-GANTT-0909,
case « Replanifier après enregistrement ») qui produit la nouvelle
date de fin si la case est cochée. Si elle est décochée, `end_date`
reste figée — c'est le geste assumé de « figer ».

### RG-GANTT-1908

**(v2.2 — RG-O)** Lorsque l'utilisateur édite manuellement
`charge_jours` sur une activité à `progress > 0`, la valeur saisie
est interprétée comme la **charge totale révisée** (et non comme le
reste à faire). Le reste à faire dérivé devient
`nouvelle_charge × (1 − progress/100)`.

### RG-GANTT-1909

**(v2.2 — RG-U)** Le `progress` d'une **phase** est dérivé
automatiquement de ses fils selon la moyenne pondérée :
`progress(P) = Σ(chargeEffective(cᵢ) × progressEffectif(cᵢ)) / Σ chargeEffective(cᵢ)`.

Les jalons (`kind='milestone'`) sont exclus du calcul (poids zéro).
Les sous-phases contribuent récursivement avec leur charge effective
(= somme des charges de leurs descendants activités) et leur progress
dérivé. Si `Σ chargeEffective = 0`, on retombe sur la moyenne
arithmétique non pondérée des progress des fils éligibles. Si aucun
fils éligible (phase vide ou ne contenant que des jalons),
`progress(P) = null` (affiché vide).

Le champ `progress` d'une phase n'est plus saisissable dans le
TaskEditor : c'est une lecture dérivée.

**Tests :** `utils.test.ts` → « v2.2 / RG-U — progress phase dérivé » ; `TaskEditor.test.tsx` → « v2.2 / RG-U — kind=phase : champ progress désactivé ».
```

- [ ] **Step 17.2: Adapter RG-GANTT-0903 pour préciser le cas `progress > 0`**

Localiser RG-GANTT-0903 (vers ligne 637-641). Modifier le texte :

```markdown
La replanification ne déplace **jamais** une activité vers une date
plus ancienne que sa date de début courante. **(v2.2)** Si l'activité
est en cours (`progress > 0`), la borne basse intègre en outre `today`
(RG-GANTT-1903) : on ne replanifie pas le passé.
```

- [ ] **Step 17.3: Test de couverture**

```
npx vitest run docs/regles-metier.coverage.test.js
```

Attendu : PASS.

- [ ] **Step 17.4: Commit**

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): ajout RG-GANTT-1902..1909 (progress + cohérences + phase) + révision 0903 (2026-05-24)"
```

---

**Fin de L3.** Le Replan est progress-aware. Aucun changement de comportement pour les tâches à `progress = 0`. Les tâches en cours sont replanifiées correctement, les tâches terminées sont lockées, les phases affichent un progress dérivé.

---

# LOT 4 — Mode « Planification anticipée »

**Périmètre** : RG-V. Toggle UI persisté en localStorage par projet, paramètre `ignoreToday` traversant le moteur.

**Critère de succès** : un Replan en mode anticipé n'utilise pas `today` comme borne basse même si `progress > 0` ; RG-A et RG-C restent appliquées ; le toggle est persisté par projet.

---

### Task 18: Helper localStorage typé

**Files:**

- Create: `src/lib/storage.ts`
- Test: `src/lib/storage.test.ts`

- [ ] **Step 18.1: Test du helper**

Créer `src/lib/storage.test.ts` :

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getAdvancePlanning, setAdvancePlanning } from './storage'

describe('storage — advance planning toggle', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('lit false par défaut', () => {
    expect(getAdvancePlanning('p1')).toBe(false)
  })

  it('écrit et relit la valeur', () => {
    setAdvancePlanning('p1', true)
    expect(getAdvancePlanning('p1')).toBe(true)
    setAdvancePlanning('p1', false)
    expect(getAdvancePlanning('p1')).toBe(false)
  })

  it('isole les projets entre eux', () => {
    setAdvancePlanning('p1', true)
    expect(getAdvancePlanning('p2')).toBe(false)
  })

  it('retourne false si localStorage indisponible (SSR / mode privé bloqué)', () => {
    const orig = globalThis.localStorage
    // @ts-expect-error simulation
    delete globalThis.localStorage
    expect(getAdvancePlanning('p1')).toBe(false)
    globalThis.localStorage = orig
  })
})
```

- [ ] **Step 18.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/lib/storage.test.ts
```

Attendu : FAIL (le module n'existe pas).

- [ ] **Step 18.3: Créer `src/lib/storage.ts`**

```ts
/**
 * v2.2 / RG-V — Helpers de persistance localStorage pour les préférences
 * utilisateur scopées par projet. En l'absence d'authentification dans la
 * stack actuelle (LAN partagé sans identité utilisateur), la persistance
 * est "par navigateur × projet".
 *
 * En cas d'indisponibilité de localStorage (SSR, mode privé bloqué), les
 * getters retournent la valeur par défaut sans erreur.
 */

const KEY_ADVANCE_PLANNING = (projectId: string): string =>
  `gantt:advance-planning:${projectId}`

/**
 * Lit le toggle "Planification anticipée" pour un projet. Défaut : false.
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
 * Écrit le toggle "Planification anticipée" pour un projet.
 */
export function setAdvancePlanning(projectId: string, value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY_ADVANCE_PLANNING(projectId), String(value))
  } catch {
    // Silencieux : si le stockage est plein ou inaccessible, on continue.
  }
}
```

- [ ] **Step 18.4: Lancer test**

```
npx vitest run src/lib/storage.test.ts
```

Attendu : PASS.

- [ ] **Step 18.5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "2026-05-24 — v2.2/RG-V : helper storage.ts (toggle Planification anticipée par projet)"
```

---

### Task 19: Paramètre `ignoreToday` dans `replanTasks` et `computeReplanEarliestStart`

**Files:**

- Modify: `src/lib/utils.ts`
- Test: `src/lib/utils.test.ts`

- [ ] **Step 19.1: Test RG-V**

```ts
describe('v2.2 / RG-V — mode Planification anticipée', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it("ignoreToday=true : tâche progress > 0 avec start dans le passé n'est pas tirée à today", () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 30,
        start_date: '2026-06-01',
        end_date: '2026-06-05',
        charge_jours: 5,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [], { ignoreToday: true })
    // En mode anticipé, RG-B suspendue : la borne basse retombe sur start_date (2026-06-01).
    if (moves.length > 0) {
      expect(moves[0].newStart).toBe('2026-06-01')
    } else {
      // Pas de move = start déjà OK = 2026-06-01.
      expect(tasks[0].start_date).toBe('2026-06-01')
    }
  })

  it('ignoreToday=true : RG-A reste appliquée (progress=100 lockée)', () => {
    const tasks: Task[] = [
      makeTask({ id: 't1', progress: 100, charge_jours: 5 }),
    ]
    const moves = replanTasks(tasks, [], [], { ignoreToday: true })
    expect(moves.find((m) => m.id === 't1')).toBeUndefined()
  })

  it('ignoreToday=true : RG-C reste appliquée (consomme reste à faire)', () => {
    const tasks: Task[] = [
      makeTask({
        id: 't1',
        progress: 50,
        start_date: '2026-06-01',
        end_date: '2026-06-12',
        charge_jours: 10,
        collaborator_id: 'c1',
      }),
    ]
    const moves = replanTasks(tasks, [], [], { ignoreToday: true })
    expect(moves.length).toBe(1)
    expect(moves[0].newStart).toBe('2026-06-01') // start respectée (mode anticipé)
    expect(moves[0].newEnd).toBe('2026-06-05') // 5 j ouvrés (reste à faire)
  })
})
```

- [ ] **Step 19.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/lib/utils.test.ts -t "RG-V"
```

Attendu : FAIL.

- [ ] **Step 19.3: Étendre la signature de `replanTasks`**

```ts
export function replanTasks(
  tasks: Task[],
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
  options: { ignoreToday?: boolean } = {},
): ReplanMove[] {
  const ignoreToday = options.ignoreToday === true
  // … (reste du corps inchangé jusqu'à la boucle de placement)
  for (const t of order) {
    if (t.progress === 100) continue
    placeTaskInTimeline(
      t,
      tasksById,
      proposed,
      timeline,
      allocations,
      absences,
      { ignoreToday },
    )
  }
  return buildReplanMoves(order, proposed)
}
```

- [ ] **Step 19.4: Étendre `placeTaskInTimeline` pour propager `ignoreToday`**

Ajouter le paramètre :

```ts
function placeTaskInTimeline(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  timeline: Map<string, Array<[string, string]>>,
  allocations: MemberAllocation[],
  absences: CollaboratorAbsence[],
  options: { ignoreToday: boolean } = { ignoreToday: false },
): void {
  // … (jusqu'à computeReplanEarliestStart)
  const earliest = computeReplanEarliestStart(t, tasksById, proposed, options)
  // …
}
```

(`computeReplanEarliestStart` accepte déjà `options.ignoreToday` depuis L3 Task 13.)

- [ ] **Step 19.5: Lancer test**

```
npx vitest run src/lib/utils.test.ts -t "RG-V"
```

Attendu : PASS.

- [ ] **Step 19.6: Lancer toute la suite**

```
npm test
```

Attendu : PASS intégral.

- [ ] **Step 19.7: Commit**

```bash
git add src/lib/utils.ts src/lib/utils.test.ts
git commit -m "2026-05-24 — v2.2/RG-V : paramètre ignoreToday dans replanTasks (RG-B suspendable)"
```

---

### Task 20: Câbler le toggle dans `handleOpenReplan` et `handleSaveTask`

**Files:**

- Modify: `src/App.tsx`

- [ ] **Step 20.1: Importer le helper**

En haut de `src/App.tsx`, ajouter :

```ts
import { getAdvancePlanning } from './lib/storage'
```

- [ ] **Step 20.2: Lire `ignoreToday` dans `handleOpenReplan`**

Modifier (issu de L2 Task 8) :

```ts
const handleOpenReplan = async () => {
  if (!state) return
  const allocs = state.member_allocations
  const absences = state.collaborator_absences
  // v2.2 / RG-V — Le mode anticipé est lu depuis localStorage par projet.
  // Il pilote indifféremment Replan manuel et auto-replan (cf. handleSaveTask).
  const ignoreToday = state.current_project_id
    ? getAdvancePlanning(state.current_project_id)
    : false

  if (state.current_project_id) {
    const shortfallItems = scanReplanShortfalls(
      orderedTasks,
      state.current_project_id,
      allocs,
      absences,
    )
    if (shortfallItems.length > 0) {
      setReplanShortfall({ items: shortfallItems })
      return
    }
  }
  const moves = replanTasks(orderedTasks, allocs, absences, { ignoreToday })
  if (moves.length === 0) {
    await askAlert('Aucune surcharge détectée — rien à replanifier.')
    return
  }
  setReplanPreview(moves)
}
```

- [ ] **Step 20.3: Lire `ignoreToday` dans `handleSaveTask` (auto-replan)**

Modifier le bloc auto-replan (ligne ~981, issu de L2 Task 6) :

```ts
if (wasEditing && options.replan) {
  try {
    const freshState = await fetchFreshState()
    const freshTasks = sortTasksHierarchically(freshState.tasks)
    const ignoreToday = freshState.current_project_id
      ? getAdvancePlanning(freshState.current_project_id)
      : false
    const moves = replanTasks(
      freshTasks,
      freshState.member_allocations,
      freshState.collaborator_absences,
      { ignoreToday },
    )
    await submitReplanMoves(moves)
  } catch (err) {
    console.error('[auto-replan]', err)
  }
}
```

- [ ] **Step 20.4: TS-check**

```
npx tsc --noEmit
```

Attendu : PASS.

- [ ] **Step 20.5: Commit**

```bash
git add src/App.tsx
git commit -m "2026-05-24 — v2.2/RG-V : câblage ignoreToday dans handleOpenReplan et auto-replan (RG-0909)"
```

---

### Task 21: Composant UI `AdvancePlanningToggle`

**Files:**

- Create: `src/components/AdvancePlanningToggle.tsx`
- Create: `src/components/AdvancePlanningToggle.test.tsx`
- Modify: `src/App.tsx` (insertion du toggle dans la barre d'action)

- [ ] **Step 21.1: Test du composant**

Créer `src/components/AdvancePlanningToggle.test.tsx` :

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import AdvancePlanningToggle from './AdvancePlanningToggle'
import { getAdvancePlanning } from '../lib/storage'

describe('AdvancePlanningToggle', () => {
  beforeEach(() => localStorage.clear())

  it('affiche décoché par défaut', () => {
    render(<AdvancePlanningToggle projectId="p1" />)
    const cb = screen.getByLabelText(
      /planification anticipée/i,
    ) as HTMLInputElement
    expect(cb.checked).toBe(false)
  })

  it('persiste la valeur dans localStorage à la coche', () => {
    render(<AdvancePlanningToggle projectId="p1" />)
    const cb = screen.getByLabelText(/planification anticipée/i)
    fireEvent.click(cb)
    expect(getAdvancePlanning('p1')).toBe(true)
  })

  it('relit la valeur persistée au montage', () => {
    localStorage.setItem('gantt:advance-planning:p1', 'true')
    render(<AdvancePlanningToggle projectId="p1" />)
    const cb = screen.getByLabelText(
      /planification anticipée/i,
    ) as HTMLInputElement
    expect(cb.checked).toBe(true)
  })
})
```

- [ ] **Step 21.2: Lancer test, vérifier qu'il échoue**

```
npx vitest run src/components/AdvancePlanningToggle.test.tsx
```

Attendu : FAIL.

- [ ] **Step 21.3: Créer le composant**

Créer `src/components/AdvancePlanningToggle.tsx` :

```tsx
import { useState } from 'react'
import { getAdvancePlanning, setAdvancePlanning } from '../lib/storage'

/**
 * v2.2 / RG-V — Toggle "Planification anticipée" persisté en localStorage
 * par projet. Quand activé, le Replan (manuel et automatique post-édition)
 * suspend RG-GANTT-1903 (today comme borne basse pour activités en cours).
 *
 * RG-A (progress=100 lockée) et RG-C (consommer le reste à faire) restent
 * appliquées. Le toggle ne modifie que la borne basse de placement.
 */
type Props = {
  projectId: string
}

export default function AdvancePlanningToggle({ projectId }: Props) {
  const [checked, setChecked] = useState<boolean>(() =>
    getAdvancePlanning(projectId),
  )
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked
    setChecked(next)
    setAdvancePlanning(projectId, next)
  }
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
      }}
      title="Quand activé, le Replan ne 'tire' pas vers aujourd'hui les tâches dont la date de début est dans le passé. Utile pour préparer un planning de phase future."
    >
      <input type="checkbox" checked={checked} onChange={handleChange} />
      Planification anticipée
    </label>
  )
}
```

- [ ] **Step 21.4: Lancer test du composant**

```
npx vitest run src/components/AdvancePlanningToggle.test.tsx
```

Attendu : PASS.

- [ ] **Step 21.5: Insérer le toggle dans `App.tsx`**

Repérer la barre d'action où se trouve le bouton « Replan » principal. Ajouter le toggle juste à côté :

```tsx
{
  state.current_project_id && (
    <AdvancePlanningToggle projectId={state.current_project_id} />
  )
}
;<button onClick={() => void handleOpenReplan()}>Replan</button>
```

Adapter l'import :

```ts
import AdvancePlanningToggle from './components/AdvancePlanningToggle'
```

- [ ] **Step 21.6: Lancer tests intégration**

```
npm test
```

Attendu : PASS intégral.

- [ ] **Step 21.7: Commit**

```bash
git add src/components/AdvancePlanningToggle.tsx src/components/AdvancePlanningToggle.test.tsx src/App.tsx
git commit -m "2026-05-24 — v2.2/RG-V : composant AdvancePlanningToggle + intégration dans barre d'action"
```

---

### Task 22: Test intégration — auto-replan respecte le mode anticipé

**Files:**

- Modify: `src/App.test.tsx`

- [ ] **Step 22.1: Ajouter le test**

```tsx
it('v2.2 / RG-V — mode anticipé activé : auto-replan post-édition utilise ignoreToday=true', async () => {
  // Préparer localStorage avant le mount
  localStorage.setItem('gantt:advance-planning:p1', 'true')

  // Mock fetch pour intercepter le PATCH du save + replan
  const patchBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'PATCH')
      patchBodies.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ version: 1, changed: true }), {
      status: 200,
    })
  }) as typeof fetch

  // … render + éditer une tâche progress=30 dont start est dans le passé
  // … cliquer Save (case "Replanifier après enregistrement" cochée par défaut)
  // … attendre que les PATCH partent

  // Vérifier : le start de la tâche n'a PAS été décalé à today
  // (en mode anticipé, RG-B est suspendue → start reste à l'historique)
  // L'assertion exacte dépend des fixtures ; principe : aucun PATCH ne
  // change start_date pour pousser la tâche à today.
  for (const body of patchBodies) {
    if (body.start_date) {
      expect(body.start_date).not.toBe(todayIso())
    }
  }
})
```

Note : ce test peut être délicat à écrire selon la structure de fixtures existante. Si trop lourd, fournir une version plus simple :

```tsx
it('v2.2 / RG-V — toggle coché dans localStorage : getAdvancePlanning retourne true', () => {
  localStorage.setItem('gantt:advance-planning:p1', 'true')
  expect(getAdvancePlanning('p1')).toBe(true)
})
```

(Ce test plus simple revient à dupliquer un test storage déjà fait — préférer la version intégration si possible.)

- [ ] **Step 22.2: Lancer test**

```
npx vitest run src/App.test.tsx -t "RG-V"
```

Attendu : PASS.

- [ ] **Step 22.3: Commit**

```bash
git add src/App.test.tsx
git commit -m "2026-05-24 — test(integ) v2.2/RG-V : auto-replan respecte mode anticipé"
```

---

### Task 23: Catalogue RG — RG-V (1910) et révision de RG-GANTT-0909

**Files:**

- Modify: `docs/regles-metier.md`

- [ ] **Step 23.1: Ajouter RG-GANTT-1910**

À la suite de RG-GANTT-1909 (ajoutée en L3 Task 17) :

```markdown
### RG-GANTT-1910

**(v2.2 — RG-V)** Le Replan dispose d'un mode optionnel « Planification
anticipée » activable par un toggle UI à côté du bouton Replan.
La valeur du toggle est persistée par projet en `localStorage`
(clé `gantt:advance-planning:{project_id}`, "par navigateur × projet"
en l'absence d'authentification utilisateur).

Quand le toggle est coché pour un projet :

- **RG-GANTT-1903 (RG-B) est suspendue** : `today` n'est plus
  pris en compte comme borne basse. La borne basse redevient
  `max(t.start_date, pred.end + lag, SNET)`.
- **RG-GANTT-1902 (RG-A) reste appliquée** : les tâches à
  `progress = 100` restent lockées.
- **RG-GANTT-1904 (RG-C) reste appliquée** : le moteur consomme
  toujours le reste à faire pour les tâches à `progress > 0`.

Le toggle pilote **toutes les sources de Replan** d'un projet :
Replan manuel ET auto-replan post-édition (RG-GANTT-0909).

**Tests :** `utils.test.ts` → « v2.2 / RG-V — mode Planification anticipée » ; `storage.test.ts` → « advance planning toggle » ; `AdvancePlanningToggle.test.tsx` → composant ; `App.test.tsx` → « v2.2 / RG-V — mode anticipé activé : auto-replan post-édition utilise ignoreToday=true ».
```

- [ ] **Step 23.2: Adapter RG-GANTT-0909**

Localiser RG-GANTT-0909 (vers ligne 681-687). Ajouter en fin de paragraphe :

```markdown
**(v2.2)** L'auto-replan respecte le toggle « Planification anticipée »
du projet courant (RG-GANTT-1910) : si le toggle est coché, l'auto-replan
s'exécute en mode anticipé (suspension de RG-GANTT-1903).
```

- [ ] **Step 23.3: Test de couverture**

```
npx vitest run docs/regles-metier.coverage.test.js
```

Attendu : PASS.

- [ ] **Step 23.4: Commit**

```bash
git add docs/regles-metier.md
git commit -m "docs(regles): ajout RG-GANTT-1910 (mode Planification anticipée) + révision 0909 (2026-05-24)"
```

---

**Fin de L4.** Le mode anticipé est disponible, toggleable, persisté, et respecté par toutes les sources de Replan.

---

# Récap final et fumée

### Vérification end-to-end manuelle (à faire après les 4 lots)

- [ ] **Step F.1: Lancer le dev server et l'API**

```bash
# Terminal 1 — API
cd /Users/seb/Developpement/Gantt
npm run server

# Terminal 2 — front
npm run dev
```

Ouvrir http://localhost:5174/gantt/.

- [ ] **Step F.2: Reproduire le scénario du bug B1**

1. Créer un projet avec un collab à allocation 50 %.
2. Créer une activité de charge 5 j ouvrés.
3. Cliquer « Replan » → appliquer (l'end doit être étiré).
4. Re-cliquer « Replan » → message « Aucune surcharge détectée — rien à replanifier ».

Si l'étape 4 propose à nouveau des moves, ouvrir DevTools, regarder le PATCH envoyé en étape 3 : il doit contenir `charge_jours`.

- [ ] **Step F.3: Tester le scénario progress > 0**

1. Marquer l'activité à `progress = 50`.
2. Cliquer « Replan ».
3. La barre doit s'étirer jusqu'à `today + 2-3 j` (selon le calendrier ouvré).

- [ ] **Step F.4: Tester le mode anticipé**

1. Cocher la case « Planification anticipée ».
2. Cliquer « Replan ».
3. La barre doit revenir à sa position « calendaire pure » (sans tirage vers today).
4. Recharger la page → la case reste cochée (persistance localStorage).

- [ ] **Step F.5: Tester l'auto-replan post-édition en mode anticipé**

1. Garder le toggle coché.
2. Éditer l'activité (changer le nom, garder la case « Replanifier après enregistrement »).
3. Save.
4. La barre doit rester en position calendaire pure (auto-replan respecte le mode).

- [ ] **Step F.6: Tester le calcul de progress phase**

1. Créer une phase avec 2 activités (charges et progress variés).
2. Ouvrir l'éditeur de la phase → le champ progress doit être désactivé.
3. La valeur affichée doit être la moyenne pondérée.

---

## Notes opérationnelles

- **Migration des données** : aucune. Les `charge_jours` actuellement gonflées par le bug B1 restent telles quelles. L'utilisateur peut les corriger via le TaskEditor au besoin.
- **Backups** : un backup est créé automatiquement avant chaque déploiement (cf. `server/backup.js`). Aucune action manuelle nécessaire.
- **Tests de la couverture du catalogue** : `npx vitest run docs/regles-metier.coverage.test.js` après chaque mise à jour de `docs/regles-metier.md`.

---

## Conventions de commit utilisées

- **Code** : `2026-05-24 — v2.2/RG-XXX : description courte`
- **Docs (regles)** : `docs(regles): description (2026-05-24)`
- **Docs (spec)** : `docs(spec): description (2026-05-24)`

Cohérent avec l'historique récent du projet (`git log --oneline -20`).
