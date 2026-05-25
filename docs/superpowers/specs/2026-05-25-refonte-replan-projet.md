# Spec — Refonte du Replan : date de démarrage projet, dates calculées au plus tôt, cohérence Replan ↔ Plan de charge

**Date** : 2026-05-25
**Version cible** : v2.3 (refonte du modèle de planification, succédant à v2.2 livrée le 2026-05-24)
**Statut** : brouillon en attente de revue utilisateur
**Spec précédente** : [2026-05-24-replan-progress-design.md](./2026-05-24-replan-progress-design.md) (livrée et mergée)

---

## 1. Contexte et motivation

La v2.2 a corrigé le bug B1 (boucle divergente sur `charge_jours`) et introduit la prise en compte de `progress`. Mais elle a conservé **RG-GANTT-0903** (« la replanification ne déplace jamais une activité vers une date plus ancienne »), héritée des versions précédentes, qui s'avère incompatible avec la philosophie « _planning optimisé au plus tôt_ » que l'utilisateur souhaite.

Symptômes observés en v2.2 :

- Une tâche déplacée dans le futur (par bug, par drag&drop accidentel, ou par un Replan d'une ancienne version) y reste figée à jamais. Le Replan ne peut plus la ramener vers le présent même quand toutes les conditions le permettraient.
- L'utilisateur doit éditer manuellement la `start_date` pour « libérer » une tâche bloquée loin dans le futur. Cette opération manuelle contredit l'idée même d'un Replan automatique.
- La distinction entre « activité à `progress > 0` » (today comme borne basse, RG-B initiale) et « activité à `progress = 0` » (start_date courante comme borne basse, RG-0903) crée une asymétrie sans justification métier.

Cette spec **refond le modèle de planification** autour d'une idée centrale :

> **La `start_date` d'une activité est une information _calculée_ par le Replan, pas une donnée _saisie_ par l'utilisateur. Sa valeur, à chaque Replan, est la date _au plus tôt_ à laquelle l'activité peut démarrer compte tenu de toutes les contraintes (date de démarrage du projet, today, prédécesseurs, SNET, capacité du collab, progression).**

Conséquence : un nouveau concept central, la **date de démarrage du projet** (`project_start_date`), qui sert de **borne basse globale** par défaut.

### Analogie

Le nouveau Replan est un **GPS qui recalcule en permanence l'itinéraire le plus rapide**. Tu lui indiques un point de départ (la date de démarrage du projet, choisie par toi, dans le passé ou le futur). Le GPS recalcule à chaque Replan le chemin le plus court vers la fin du projet. La « position actuelle » des tâches n'est jamais figée : elle est en permanence recalculée. Pour forcer un détour, tu poses un waypoint = le champ `not_before_date` (SNET) ou tu modifies manuellement une date (qui sera écrasée au prochain Replan, sauf si la tâche est déjà commencée).

---

## 2. Catalogue des règles de gestion (RG)

### 2.1 Règles **conservées** depuis v2.2

| RG                                   | Nom                                                        | Statut       |
| ------------------------------------ | ---------------------------------------------------------- | ------------ |
| RG-GANTT-1900                        | Invariance de la charge sous Replan (RG-INV)               | ✅ Inchangée |
| RG-GANTT-1901                        | Contrat PATCH du Replan (RG-W)                             | ✅ Inchangée |
| RG-GANTT-1902                        | `progress = 100` lockée par le Replan (RG-A)               | ✅ Inchangée |
| RG-GANTT-1904                        | Reste à faire = `charge × (1 − progress/100)` (RG-C)       | ✅ Inchangée |
| RG-GANTT-1906                        | Tâche `progress = 100` en avance silencieuse (RG-M)        | ✅ Inchangée |
| RG-GANTT-1908                        | Édit manuel de `charge_jours` = charge totale (RG-O)       | ✅ Inchangée |
| RG-GANTT-1909                        | `progress(phase)` dérivé pondéré (RG-U)                    | ✅ Inchangée |
| RG-GANTT-0909                        | Auto-replan post-édition d'activité (opt-out par checkbox) | ✅ Inchangée |
| Ordre du Replan (`buildReplanOrder`) | Topologique + priorité + position                          | ✅ Inchangée |

### 2.2 Règles **supprimées**

| RG                                              | Nom                                                                                                             | Raison                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| RG-GANTT-0903                                   | « La replanification ne déplace jamais une activité vers une date plus ancienne que sa date de début actuelle » | Incompatible avec la philosophie « au plus tôt ». Remplacée par la borne basse globale (RG-B redéfinie). |
| RG-GANTT-1905                                   | RG-L : politique sans alerte si `today < start_date` avec `progress > 0`                                        | Obsolète : `start_date` est calculée donc cohérente par construction.                                    |
| Concept de démo (`demo-state.js`, `seedDemo()`) | Initialisation de la base avec des tâches d'exemple                                                             | L'utilisateur n'en a plus besoin ; les données seedées deviennent des données utilisateur normales.      |

### 2.3 Règles **redéfinies**

#### RG-GANTT-1903 (RG-B) — **Borne basse globale du Replan**

**Ancien libellé** (v2.2) : « Pour une activité à `progress > 0`, la borne basse intègre `today` ».

**Nouveau libellé** :

> La borne basse de placement d'une activité par le Replan est :
>
> ```
> borne_basse = MAX(
>   project_start_date,             // date de démarrage du projet
>   today,                           // si mode normal (RG-V décochée)
>   predecessor.end_date + lag,      // contrainte de prédécesseur (sauf cas exception)
>   not_before_date                  // SNET, si saisi
> )
> ```
>
> S'applique **uniformément à toutes les activités**, indépendamment de `progress`. La distinction « progress > 0 » de la v2.2 est abandonnée.
>
> **Exception RG-A** : les activités à `progress = 100` ne sont jamais placées par le moteur ; leurs dates restent figées.
>
> **Exception Option γ** : les activités à `0 < progress < 100` (en cours) ont leur `start_date` **figée à la valeur historique** ; seule `end_date` est recalculée par le Replan (cf. RG-GANTT-2003 ci-dessous).

#### RG-GANTT-1910 (RG-V) — **Mode « Planification anticipée »**

**Ancien libellé** : « Le toggle suspend RG-B (today comme borne basse) ».

**Nouveau libellé** :

> Le toggle « Planification anticipée » (case à cocher persistée en `localStorage` par projet, clé `gantt:advance-planning:{project_id}`, défaut décoché) bascule la borne basse globale :
>
> - **Décoché (mode normal)** : `borne_basse = MAX(project_start_date, today, pred.end+lag, SNET)`.
> - **Coché (mode anticipé)** : `borne_basse = MAX(project_start_date, pred.end+lag, SNET)`. `today` est exclu → le Replan accepte de planifier dans le passé (utile pour les simulations rétrospectives).
>
> Le toggle pilote **toutes les sources de Replan** d'un projet : manuel ET auto-replan post-édition (RG-GANTT-0909).
>
> RG-A (`progress = 100`) et RG-C (reste à faire) restent appliquées dans les deux modes.

#### RG-GANTT-1907 (RG-N) — **Édition manuelle d'une activité**

**Nouveau libellé** :

> Une activité peut être modifiée manuellement par l'utilisateur via deux canaux : le TaskEditor (formulaire) et le drag&drop dans le diagramme Gantt.
>
> **Champs persistés tels quels** (jamais recalculés par le Replan) :
>
> - `name`, `progress`, `charge_jours`, `priority`, `predecessor_id`, `predecessor_lag`, `collaborator_id(s)`, `not_before_date`, `not_later_than_date`, `parent_id`, `color`.
>
> **Champs `start_date` et `end_date`** : comportement dépendant du `progress` de l'activité :
>
> - **`progress = 0`** : modifications **éphémères**. Le prochain Replan recalcule `start_date` à la borne basse globale et `end_date = start + charge_alloc`. Pour figer une date, l'utilisateur pose un SNET (`not_before_date`).
> - **`0 < progress < 100`** : modifications **persistantes**. `start_date` est figée (cf. RG-GANTT-2003). Le Replan ne recalcule que `end_date`. Dans le TaskEditor, le champ `start_date` est **grisé en lecture seule** ; le drag&drop horizontal de la barre dans le Gantt qui modifierait `start_date` est **désactivé**.
> - **`progress = 100`** : modifications **persistantes** (RG-A : la tâche est lockée par le Replan ; seule l'édition manuelle peut changer ses dates).
>
> **Drag&drop dans le diagramme Gantt** : ne déclenche **jamais** d'auto-replan. Seul l'enregistrement du TaskEditor déclenche l'auto-replan (RG-GANTT-0909, opt-out par checkbox).
>
> **Cas particulier — passage de `progress = 0` à `progress > 0` dans le TaskEditor** : l'utilisateur peut éditer la `start_date` dans le même formulaire avant de cliquer « Enregistrer ». Au save :
>
> 1. Le PATCH écrit la nouvelle valeur de `progress` et la nouvelle valeur de `start_date` (telle que saisie ou inchangée si l'utilisateur ne l'a pas modifiée).
> 2. Cette `start_date` devient **figée** dès lors que `progress > 0`.
> 3. Si la case « Replanifier après enregistrement » (RG-GANTT-0909) est cochée, un auto-replan suit. Il ne touchera pas à `start_date` (figée) mais recalculera `end_date`.

### 2.4 Règles **nouvelles**

#### RG-GANTT-2000 — **Date de démarrage du projet (`project_start_date`)**

> Chaque projet a une **date de démarrage** persistée en base (colonne `project_start_date` sur la table `projects`, format `YYYY-MM-DD`, NOT NULL).
>
> - **Création de projet** : un dialog demande la date à l'utilisateur. La valeur par défaut proposée est `today`. La date peut être dans le passé ou dans le futur, sans restriction.
> - **Modification** : possible à tout moment via la modal « Paramètres du projet ». À la modification, un dialog propose un Replan immédiat (option par défaut cochée, opt-out, même pattern que l'auto-replan post-édition d'activité).
>
> Cette date sert de **borne basse globale par défaut** dans le Replan (cf. RG-GANTT-1903 redéfinie).

#### RG-GANTT-2001 — **Modal « Paramètres du projet »**

> Une modal « ⚙️ Paramètres du projet » accessible depuis le sélecteur de projet regroupe les réglages projet :
>
> - Nom du projet (renommage)
> - Date de démarrage (`project_start_date`)
> - Toggle « Planification anticipée » (RG-GANTT-1910)
>
> L'ancien emplacement du toggle (à côté du bouton Replan dans la barre d'action) est retiré au profit de cet emplacement unique.

#### RG-GANTT-2002 — **Suppression du concept de démo**

> Le code initialisant la base avec des données d'exemple (`db/demo-state.js`, fonction `seedDemo()` appelée au boot) est supprimé.
>
> Les données actuellement présentes dans `data.db` **ne sont pas wipées** : elles deviennent des données utilisateur normales et restent accessibles via l'UI.
>
> À la création d'un nouveau projet via l'API/UI, aucune tâche n'est créée par défaut.

#### RG-GANTT-2003 — **`start_date` figée pour les activités en cours (Option γ)**

> Une activité dont `0 < progress < 100` a sa `start_date` **figée** : le Replan ne la recalcule jamais, il ne touche qu'à `end_date`.
>
> Calcul de `end_date` pour une activité en cours :
>
> ```
> end_date = consomme(reste_à_faire) sur la timeline du collab,
>            à partir de MAX(today, start_date)
> ```
>
> où `reste_à_faire = charge_jours × (1 − progress/100)` (cf. RG-GANTT-1904 / RG-C).
>
> Lorsqu'une activité passe de `progress = 0` à `progress > 0` (édition utilisateur), la `start_date` est figée à la valeur en base au moment du PATCH (qui peut avoir été éditée dans le même formulaire — cf. RG-GANTT-1907 redéfinie / RG-N).

#### RG-GANTT-2004 — **Cohérence Replan ↔ Plan de charge : intervalles effectifs**

> Le Plan de charge (`computeWorkload`) **n'utilise plus la plage `[start_date, end_date]`** d'une tâche pour calculer la charge journalière du collaborateur. À la place, il consomme les **intervalles effectifs produits par le moteur Replan** lors du dernier `replanTasks(...)`.
>
> Concrètement :
>
> - `replanTasks` retourne désormais, en plus des `ReplanMove[]`, la `timeline: Map<collabId, Array<{taskId, start, end}>>` des intervalles consommés.
> - `computeWorkload` accepte cette timeline en entrée et l'utilise comme source de vérité.
> - Le Plan de charge devient ainsi en cohérence parfaite avec le placement effectif du moteur : pas de fausse surcharge par chevauchement visuel des plages `[start, end]`.
>
> **Si aucun Replan n'a tourné depuis la dernière modification** (état périmé), le Plan de charge déclenche un calcul `replanTasks` en lecture seule (sans persistance) pour obtenir une timeline à jour, ou affiche un état « périmé, lancer Replan » selon la stratégie retenue (cf. § 4 ci-dessous).

#### RG-GANTT-2005 — **Cohérence Replan ↔ détection de surcharge**

> `detectOverloads` (bandeau d'incohérence, [utils.ts:2148](src/lib/utils.ts#L2148)) **utilise également les intervalles effectifs** du moteur (RG-GANTT-2004), pas les plages `[start_date, end_date]` brutes.
>
> Deux intervalles consommés du même collaborateur qui se chevauchent constituent une vraie surcharge — mais par construction le moteur ne produit jamais ce cas (il place séquentiellement les tâches sur des créneaux libres). Le bandeau ne devrait donc jamais lever d'alerte « surcharge » sur un état issu d'un Replan récent.
>
> Il continue d'alerter sur les autres incohérences (prédécesseurs violés, priorité violée, prédécesseur terminé dans le futur — cf. RG-GANTT-2006).

#### RG-GANTT-2006 — **Prédécesseur terminé dans le futur**

> Cas limite : si une activité A a un prédécesseur P tel que `P.progress = 100` ET `P.end_date > today` (P est marquée terminée mais ses dates affichées sont dans le futur — incohérence métier), le moteur **ignore la contrainte de prédécesseur** lors du placement de A. A peut démarrer dès la borne basse globale (`project_start_date` ou today selon le mode).
>
> Le bandeau d'incohérence affiche une alerte :
>
> > _« Le prédécesseur "P" de la tâche "A" est terminé mais ses dates sont dans le futur ; la contrainte n'a pas été appliquée. »_

#### RG-GANTT-2007 — **Jalon sans prédécesseur : traité comme une activité**

> Un jalon (`kind = 'milestone'`) sans prédécesseur a sa `start_date` recalculée par le Replan à la borne basse globale (`MAX(project_start_date, today_si_mode_normal)`). Comme une activité, sa date peut être modifiée par drag&drop (éphémère) ; pour la figer, l'utilisateur pose un SNET.

#### RG-GANTT-2008 — **Phase vide**

> Une phase sans enfants directs (cas dégénéré) a `start_date = end_date = project_start_date`. La phase reste affichable mais sans contenu.

#### RG-GANTT-2009 — **Activité sans collaborateur**

> Une activité sans collaborateur affecté est traitée comme si elle disposait d'un collaborateur fictif à **capacité infinie** :
>
> - Pas de contrainte de timeline (aucun chevauchement à éviter).
> - Aucune surcharge à signaler.
> - Durée = `charge_jours` × jours ouvrés bruts (allocation ignorée).
> - Les autres contraintes restent appliquées (prédécesseur, SNET, `project_start_date`, today si mode normal).
>
> Comportement déjà conforme dans le code actuel (`placeTaskInTimeline` ne consulte aucune timeline si `collabIds.length === 0`).

### 2.5 Tableau récapitulatif final des RG (après refonte)

| Numéro            | Nom court                                   | Statut                       |
| ----------------- | ------------------------------------------- | ---------------------------- |
| RG-GANTT-0100     | Charge et back-dérivation                   | Conservée                    |
| RG-GANTT-0909     | Auto-replan post-édition (opt-out)          | Conservée                    |
| RG-GANTT-1900     | RG-INV : invariance charge                  | Conservée                    |
| RG-GANTT-1901     | RG-W : contrat PATCH                        | Conservée                    |
| RG-GANTT-1902     | RG-A : progress=100 lockée                  | Conservée                    |
| RG-GANTT-1903     | RG-B : borne basse globale                  | **Redéfinie**                |
| RG-GANTT-1904     | RG-C : reste à faire                        | Conservée                    |
| RG-GANTT-1906     | RG-M : en avance silencieuse                | Conservée                    |
| RG-GANTT-1907     | RG-N : édition manuelle                     | **Redéfinie**                |
| RG-GANTT-1908     | RG-O : charge édit = totale                 | Conservée                    |
| RG-GANTT-1909     | RG-U : progress phase dérivé                | Conservée                    |
| RG-GANTT-1910     | RG-V : mode anticipé                        | **Redéfinie**                |
| **RG-GANTT-2000** | **Date démarrage projet**                   | **Nouvelle**                 |
| **RG-GANTT-2001** | **Modal Paramètres projet**                 | **Nouvelle**                 |
| **RG-GANTT-2002** | **Suppression démo**                        | **Nouvelle**                 |
| **RG-GANTT-2003** | **start_date figée si progress>0**          | **Nouvelle**                 |
| **RG-GANTT-2004** | **Plan de charge utilise timeline moteur**  | **Nouvelle**                 |
| **RG-GANTT-2005** | **detectOverloads utilise timeline moteur** | **Nouvelle**                 |
| **RG-GANTT-2006** | **Prédécesseur terminé dans le futur**      | **Nouvelle**                 |
| **RG-GANTT-2007** | **Jalon sans pred = project_start**         | **Nouvelle**                 |
| **RG-GANTT-2008** | **Phase vide = project_start**              | **Nouvelle**                 |
| **RG-GANTT-2009** | **Activité sans collab = capacité infinie** | **Nouvelle (formalisation)** |
| RG-GANTT-0903     | ~~Jamais vers le passé~~                    | **Supprimée**                |
| RG-GANTT-1905     | ~~RG-L : sans alerte~~                      | **Supprimée**                |

---

## 3. Architecture et impact code

### 3.1 Schéma de base de données

#### Nouvelle colonne sur `projects`

```sql
ALTER TABLE projects ADD COLUMN project_start_date TEXT NOT NULL DEFAULT '2026-01-01';
```

Migration au démarrage : si la colonne n'existe pas, l'ajouter avec `DEFAULT today_iso()` pour les projets existants. Stratégie de migration dans `db/index.js` (fonction `runMigrations` ou équivalent).

### 3.2 API serveur

#### Modifications de `POST /api/projects`

Le body accepte désormais `project_start_date` (optionnel, défaut = `today`).

#### Modifications de `PATCH /api/projects/:id`

Permet de modifier `project_start_date`. Réponse : `{ version, changed: true }`.

#### Modifications de `GET /api/state` / `GET /api/projects`

Le projet retourné inclut `project_start_date`.

### 3.3 Moteur de Replan ([src/lib/utils.ts](src/lib/utils.ts))

#### `replanTasks` — signature étendue

```ts
export interface ReplanResult {
  moves: ReplanMove[]
  timeline: Map<string, Array<TimelineEntry>> // par collab
}

export interface TimelineEntry {
  taskId: string
  start: string // YYYY-MM-DD inclus
  end: string // YYYY-MM-DD inclus
}

export function replanTasks(
  tasks: Task[],
  projectStartDate: string, // NOUVEAU paramètre
  allocations: MemberAllocation[] = [],
  absences: CollaboratorAbsence[] = [],
  options: { ignoreToday?: boolean } = {},
): ReplanResult
```

#### `computeReplanEarliestStart` — réécrite

```ts
function computeReplanEarliestStart(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  projectStartDate: string,
  options: { ignoreToday: boolean } = { ignoreToday: false },
): string {
  // v2.3 — RG-GANTT-1903 redéfinie : borne basse globale.
  // - project_start_date : borne basse projet
  // - today : si mode normal (RG-V décochée)
  // - pred.end + lag : sauf cas RG-GANTT-2006 (pred terminé dans futur)
  // - not_before_date (SNET) : si saisi
  let earliest = projectStartDate
  if (!options.ignoreToday) {
    const today = todayIso()
    if (today > earliest) earliest = today
  }
  if (t.predecessor_id) {
    const pred = tasksById.get(t.predecessor_id)
    if (pred) {
      // v2.3 — RG-GANTT-2006 : si pred terminé mais end dans le futur, ignorer.
      const today = todayIso()
      const predEnd = proposed.get(pred.id)?.end ?? pred.end_date
      const ignorePred = pred.progress === 100 && predEnd > today
      if (!ignorePred) {
        const lagStart = computeSuccessorStart(predEnd, t.predecessor_lag || 0)
        if (lagStart > earliest) earliest = lagStart
      }
    }
  }
  if (t.not_before_date) {
    const snet = snapForwardToWorkingDay(t.not_before_date)
    if (snet > earliest) earliest = snet
  }
  return snapForwardToWorkingDay(earliest)
}
```

#### `placeTaskInTimeline` — adaptation pour Option γ

Pour une activité en cours (`0 < progress < 100`), la `start_date` reste figée à `t.start_date`. Le moteur consomme `reste_à_faire` sur la timeline du collab à partir de `MAX(today, t.start_date)`.

```ts
function placeTaskInTimeline(
  t: Task,
  tasksById: Map<string, Task>,
  proposed: Map<string, { start: string; end: string }>,
  timeline: Map<string, Array<TimelineEntry>>,
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

  // v2.3 — RG-GANTT-2003 : start_date figée si progress > 0.
  let newStart: string
  if (progress > 0) {
    // Activité en cours : start_date reste la valeur historique.
    newStart = t.start_date
    // Le moteur consomme reste_à_faire à partir de MAX(today, start_date)
    // sur les créneaux libres du collab.
    const today = todayIso()
    const consumeFrom = newStart > today ? newStart : today
    // … recherche de créneau libre ≥ consumeFrom …
  } else {
    // Activité jamais démarrée : start recalculée à la borne basse globale.
    const earliest = computeReplanEarliestStart(
      t,
      tasksById,
      proposed,
      projectStartDate,
      options,
    )
    newStart = earliest
    // … recherche de créneau libre ≥ earliest …
  }
  // … computeEndFromCharge + push dans timeline …
}
```

### 3.4 Côté `App.tsx`

- Lecture de `state.current_project.project_start_date` et transmission aux appels `replanTasks`.
- Persistance du résultat `ReplanResult` (timeline incluse) dans un state React pour alimenter `WorkloadChart` et `CoherenceAlert`.

### 3.5 Côté `db/index.js`

- Modification de `resolveChargeAndEnd` pour respecter RG-GANTT-2003 : un PATCH provenant d'un Replan sur une tâche en cours ne modifie pas `start_date`. Le contrat technique reste « cas 3a' » mais avec une garde supplémentaire côté client (le client n'envoie pas `start_date` si la tâche est en cours, ou il envoie la valeur figée — à choisir lors de l'implémentation).
- Suppression de `seedDemo()` et du fichier `db/demo-state.js`.

### 3.6 Côté UI

#### Nouvelle modal `ProjectSettingsModal`

- Champ « Nom du projet » (édition)
- Champ « Date de démarrage » (date picker, modifiable)
- Toggle « Planification anticipée »
- Bouton « Enregistrer » (PATCH le projet)
- Si `project_start_date` a changé : dialog de confirmation « Voulez-vous relancer un Replan immédiatement ? » avec checkbox cochée par défaut.

#### Dialog de création de projet

À la création d'un nouveau projet, un dialog demande le nom + la date de démarrage (défaut `today`).

#### TaskEditor

- Champ `start_date` grisé en lecture seule si `progress > 0` (cf. RG-GANTT-1907 / RG-GANTT-2003).
- Champ `start_date` éditable si `progress = 0` (mais valeur éphémère sauf si passage à `progress > 0` au même save).

#### GanttChart

- Drag&drop horizontal d'une barre désactivé si la tâche a `progress > 0` (la `start_date` est figée — on ne peut pas la décaler).
- Drag&drop du bord droit (étirement = édition charge) reste autorisé.

#### CoherenceAlert

- Nouvelle alerte « prédécesseur terminé dans le futur » (RG-GANTT-2006).
- Adaptation de `detectOverloads` pour utiliser les intervalles du moteur (RG-GANTT-2005).

#### WorkloadChart

- Adaptation de `computeWorkload` pour utiliser la timeline du moteur (RG-GANTT-2004).

### 3.7 Catalogue RG ([docs/regles-metier.md](docs/regles-metier.md))

- Ajout des RG-GANTT-2000 à 2009.
- Suppression de RG-GANTT-0903 et RG-GANTT-1905.
- Réécriture de RG-GANTT-1903, 1907, 1910.

---

## 4. Stratégie pour le « timeline frais »

Le Plan de charge et la détection de surcharge utilisent la timeline du dernier Replan (RG-GANTT-2004 / 2005). Cette timeline peut être périmée si l'utilisateur a modifié des données sans relancer un Replan.

**Stratégie retenue** : la timeline est **recalculée à la volée** à chaque rendu du Plan de charge et de la détection d'incohérences, via un appel `replanTasks(...)` en lecture seule (sans PATCH, sans persistance). Le résultat est mémoïsé dans React (`useMemo` sur `tasks`, `allocations`, `absences`, `project_start_date`, `ignoreToday`).

**Coût** : un `replanTasks` est appelé à chaque rendu. Pour un projet de 100 tâches, c'est ~10ms — négligeable. Si la performance devient un problème, on basculera sur une persistance de la timeline avec invalidation explicite.

**Avantage** : aucun état périmé possible ; le Plan de charge et le bandeau reflètent toujours la situation actuelle.

---

## 5. Plan de tests

### Tests unitaires (`src/lib/utils.test.ts`)

1. **RG-GANTT-1903 redéfinie** : une tâche à `progress = 0` avec `start_date` dans le futur lointain est ramenée à `project_start_date` au prochain Replan.
2. **RG-GANTT-1903 redéfinie + mode normal** : même tâche mais `project_start_date` dans le passé → ramenée à `today`.
3. **RG-GANTT-1903 redéfinie + mode anticipé** : même tâche, mode anticipé → ramenée à `project_start_date` (passé accepté).
4. **RG-GANTT-2003** : une tâche à `progress = 50` avec `start_date = 2026-05-15` → `start_date` reste à `2026-05-15` après Replan ; `end_date` est recalculée.
5. **RG-GANTT-2003** : passage de `progress = 0` à `progress = 30` via PATCH → `start_date` n'est pas modifiée par le PATCH.
6. **RG-GANTT-2006** : prédécesseur P à `progress=100` et `end_date=2027-01-01` (futur), today=2026-05-25 → tâche successeur A peut démarrer à `MAX(project_start_date, today)` (la contrainte pred est ignorée).
7. **RG-GANTT-2004** : `computeWorkload` retourne 0 sur la cellule d'un collab pour un jour antérieur à la portion consommée par le moteur.
8. **RG-GANTT-2007** : un jalon sans prédécesseur est placé à `project_start_date` (ou `today`).
9. **RG-GANTT-2008** : phase sans enfants a `start_date = end_date = project_start_date`.
10. **RG-GANTT-2009** : activité sans collab → durée brute, pas de timeline consultée.

### Tests serveur (`db/index.test.js`)

11. **Migration `project_start_date`** : sur une base existante sans la colonne, la migration ajoute la colonne avec valeur par défaut `today`.
12. **POST /api/projects avec `project_start_date`** : valeur honorée.
13. **PATCH /api/projects** : modification de `project_start_date` persistée.
14. **Suppression `seedDemo`** : un boot sur base vide ne crée plus de tâches de démo.

### Tests intégration (`src/App.test.tsx`)

15. **Modal Paramètres projet** : ouverture, édition, save, dialog de Replan optionnel.
16. **Création de projet** : dialog avec champ date de démarrage.
17. **Drag&drop désactivé pour tâche en cours** : tentative de drag horizontal d'une barre `progress=50` → pas de changement de `start_date`.

### Tests UI ciblés

18. **TaskEditor** : champ `start_date` grisé si `progress > 0`.
19. **TaskEditor** : passage `progress=0` → `progress=30` avec édition de `start_date` au même save → les deux changements persistent.
20. **WorkloadChart** : pas de cellule rouge fausse sur deux tâches en cours dont les plages se chevauchent visuellement mais sont séquentielles dans le moteur.

---

## 6. Stratégie de migration des données

### 6.1 Données existantes en base

Les données présentes dans `data.db` au moment du déploiement v2.3 :

- Conservées intégralement.
- Ajout automatique de `project_start_date` aux projets existants : valeur par défaut = `today` (au moment de la migration).

### 6.2 Tâches actuellement placées « loin dans le futur » suite à RG-0903

Au premier Replan post-déploiement, ces tâches seront automatiquement ramenées au plus tôt (à la borne basse globale). C'est l'objectif principal de la refonte.

### 6.3 Tâches avec `progress > 0`

Au premier Replan post-déploiement, leur `start_date` est figée à la valeur actuellement en base. Si cette valeur est cohérente (date à laquelle la tâche a effectivement démarré), c'est OK. Sinon, l'utilisateur peut la corriger manuellement via le TaskEditor (en passant temporairement `progress` à 0, en modifiant `start_date`, en remettant `progress`).

### 6.4 Wipe du démo

Aucun wipe automatique. Les données seedées de la démo (projet 1 avec ses tâches t1a-t1d, etc.) sont conservées comme données utilisateur. L'utilisateur peut les supprimer manuellement s'il le souhaite.

---

## 7. Découpage en lots

### Lot R1 — Date de démarrage du projet (fondation)

**Périmètre** : RG-GANTT-2000, RG-GANTT-2001, RG-GANTT-2002.

- Migration DB : nouvelle colonne `project_start_date`.
- API : POST/PATCH/GET projets enrichis.
- UI : dialog de création de projet, modal Paramètres du projet.
- Suppression de la démo.

**Critère de succès** : un projet a une `project_start_date` éditable. La démo n'existe plus en code.

### Lot R2 — Refonte de la borne basse globale du Replan

**Périmètre** : RG-GANTT-1903 redéfinie, RG-GANTT-1910 redéfinie, suppression de RG-GANTT-0903.

- Modification de `computeReplanEarliestStart` pour utiliser `project_start_date` comme borne basse.
- Adaptation de `replanTasks` pour recevoir `project_start_date` en paramètre.
- Câblage du paramètre dans `App.tsx` (Replan manuel + auto-replan).
- Suppression de la garde `let earliest = t.start_date` (clef de RG-0903).
- Mise à jour du catalogue RG.

**Critère de succès** : une tâche à `progress=0` placée loin dans le futur est ramenée à la borne basse globale au prochain Replan.

### Lot R3 — Option γ raffinée : `start_date` figée si `progress > 0`

**Périmètre** : RG-GANTT-2003, RG-GANTT-1907 redéfinie.

- Modification de `placeTaskInTimeline` : si `progress > 0`, `newStart = t.start_date` (figée), consommation de `reste_à_faire` à partir de `MAX(today, start_date)`.
- TaskEditor : champ `start_date` grisé si `progress > 0`.
- GanttChart : drag&drop horizontal désactivé si `progress > 0`.
- Cas de passage `progress = 0 → > 0` : édition de `start_date` autorisée dans le même save.

**Critère de succès** : tests unitaires RG-GANTT-2003 verts.

### Lot R4 — Cohérence Replan ↔ Plan de charge ↔ détection de surcharge

**Périmètre** : RG-GANTT-2004, RG-GANTT-2005.

- `replanTasks` retourne désormais `ReplanResult = { moves, timeline }`.
- `computeWorkload` accepte la timeline en entrée et l'utilise comme source de vérité.
- `detectOverloads` utilise aussi la timeline (les anciennes plages `[start, end]` ne sont plus consultées pour le calcul de surcharge).
- App.tsx mémoïse le résultat du Replan pour alimenter `WorkloadChart` et `CoherenceAlert`.

**Critère de succès** : pas de fausse surcharge dans le Plan de charge en présence de tâches en cours avec chevauchement visuel.

### Lot R5 — Cas particuliers

**Périmètre** : RG-GANTT-2006, RG-GANTT-2007, RG-GANTT-2008, RG-GANTT-2009.

- Prédécesseur terminé dans le futur : ignoré + alerte.
- Jalon sans prédécesseur : `project_start_date`.
- Phase vide : `project_start_date`.
- Activité sans collab : capacité infinie (formalisation, code déjà conforme).

**Critère de succès** : alertes spécifiques affichées dans les cas limites ; comportement homogène.

---

## 8. Considérations et risques

### Risques

- **Régression sur l'existant** : la suppression de RG-0903 change le comportement nominal du Replan. Toutes les tâches actuellement « parquées dans le futur » vont bouger au premier Replan post-déploiement. C'est l'objectif, mais ça peut surprendre l'utilisateur. → Mitigation : alerter dans le release note + tester sur une base de production en miroir avant déploiement.
- **Performance du `replanTasks` à la volée** : appelé à chaque rendu du Plan de charge. → Mitigation : `useMemo` strict + benchmark avec 200 tâches.
- **Migration de la colonne `project_start_date`** : valeur par défaut `today` pourrait ne pas refléter la réalité pour des projets anciens. → Mitigation : alerter l'utilisateur dans la modal Paramètres qu'il devrait revoir la date.

### Compatibilité descendante

Le contrat technique côté serveur (cas 3a' dans `resolveChargeAndEnd`) reste inchangé. Les clients anciens (s'il y en avait) continueraient à fonctionner sans planification mais ne profiteraient pas des nouvelles règles.

---

## 9. Hors-scope explicite

- **Authentification utilisateur** : le toggle « Planification anticipée » reste en `localStorage` (« par navigateur × projet »). L'introduction d'une identité utilisateur n'est pas dans cette spec.
- **Historique des `start_date`** : on garde `start_date` historique pour les tâches en cours (Option γ), mais sans champ séparé `actual_start_date`. Si une historisation plus fine est nécessaire un jour, ce sera une autre spec.
- **Notifications de planning périmé** : pas dans cette version. L'utilisateur clique « Replan » quand il le souhaite ; pas d'alerte « le planning n'est plus à jour » entre deux Replans (sauf via les incohérences déjà détectées dans le bandeau).
- **Multi-projet dans le toggle anticipé** : chaque projet a son propre toggle. Le toggle ne se propage pas d'un projet à l'autre.
- **Renommage d'un projet** : possible via la modal Paramètres (existait déjà, on l'expose juste au même endroit).

---

## 10. Validation avant implémentation

Avant de produire le plan d'implémentation détaillé :

1. **Valides-tu le catalogue RG complet de la section 2.5 ?**
2. **Valides-tu la stratégie « replan à la volée pour la timeline » (section 4) ?** Alternative possible : persister la timeline en BDD et l'invalider explicitement.
3. **Valides-tu le découpage en 5 lots (R1 → R5) ?** Alternative possible : R1 + R2 en un seul lot, R4 séparé en deux (Plan de charge / detectOverloads).
4. **Y a-t-il un cas limite ou un scénario que tu veux ajouter avant le plan ?**

Une fois validé, je rédige le **plan d'implémentation détaillé** dans `docs/superpowers/plans/2026-05-25-refonte-replan-projet.md`, avec :

- Tâches atomiques (granularité 2-5 min)
- Code complet par tâche
- Commits datés
- Tests TDD au format Red → Green → Refactor
