# Spec — Replan : invariance de la charge, prise en compte du progress, abandon du Replan partiel, mode planification anticipée

**Date** : 2026-05-24
**Version cible** : v2.2 (cycle suivant la v2.1.5+)
**Statut** : brouillon en attente de revue utilisateur

---

## 1. Contexte et problème

Deux bugs et un vide normatif ont été identifiés en production sur la v2.1.5+ :

### Bug B1 — Boucle divergente du Replan sur `charge_jours`

Le PATCH généré par le Replan envoie `{ start_date, end_date, predecessor_lag }` sans `charge_jours`. Côté serveur, `resolveChargeAndEnd` ([db/index.js:1668-1746](../../db/index.js#L1668)) emprunte alors la branche « cas 3b » et **back-dérive `charge_jours = workingDaysBetweenServer(start, end)`** — un comptage de jours ouvrés bruts, sans tenir compte de l'allocation %.

Conséquence : pour les collaborateurs en allocation partielle (< 100 %), chaque Replan **inflate** la charge stockée, et le Replan suivant trouve un nouvel écart à appliquer. Le système boucle. RG-GANTT-0100 a été conçue pour le drag manuel du bord droit, pas pour un PATCH automatique du Replan ; le code ne distingue pas les deux sources.

### Bug B2 — Replan ignore `progress`

Le champ `progress` n'est utilisé nulle part dans le moteur de Replan ni dans le calcul des dates côté serveur. Vérifié par recherche exhaustive : seules apparitions dans le code de production sont la persistance brute en base et la largeur de barre dans le diagramme. Conséquences :

- une activité à 70 % faite est replanifiée comme si elle n'avait pas commencé (consomme `charge` complète au lieu de `charge × 0,30`) ;
- une activité à 100 % (terminée) reste éligible au déplacement, ce qui n'a pas de sens métier ;
- une activité en cours peut être replanifiée dans le passé (la borne basse `t.start_date` peut être antérieure à `today`).

### Vide normatif

Aucune RG de la Famille 10 (Replanification) du catalogue ne contraint l'invariance de la charge sous Replan, ni n'encadre le traitement de `progress`. RG-GANTT-0905 (« Replan partiel ») introduit en outre une complexité (paramètre `concernedIds`, `prefillLockedIntervals`, bouton dédié) que le besoin métier ne justifie plus.

---

## 2. RG validées

### Invariance fondamentale

**RG-INV** _(nouvelle)_ — Un Replan ne modifie JAMAIS `charge_jours`. La charge est un invariant ; seules `start_date` et `end_date` peuvent évoluer sous l'action du Replan.

### État d'exécution (`progress`)

**RG-A** _(nouvelle)_ — Une activité à `progress = 100` est lockée par le Replan : ses dates ne sont pas modifiées. Elle est ajoutée à la timeline des collaborateurs affectés comme obstacle (intervalle bloqué `[start_date, end_date]`).

**RG-B** _(nouvelle)_ — Pour une activité à `progress > 0`, **la date de début proposée par le Replan ne peut être antérieure à `today`**. La portion déjà réalisée reste figée à sa date historique ; seul le reste à faire est candidat au placement par le Replan. Concrètement, la borne basse devient `max(t.start_date, pred.end + lag, SNET, today)` au lieu de `max(t.start_date, pred.end + lag, SNET)`.

**RG-C** _(nouvelle)_ — Le Replan consomme `charge_jours × (1 − progress/100)` jours-allocation (= reste à faire), arrondi au jour ouvré supérieur (minimum 1). Pour `progress = 0`, le comportement reste identique à v2.1.

### Cohérences et alertes

**RG-K** _(absorbée par RG-B + RG-C)_ — Tâche en retard (`today > end_date` ET `progress < 100`) : pas d'alerte distincte dans le bandeau. Un Replan pousse automatiquement la fin à `today + reste à faire` (effet naturel).

**RG-L** _(politique sans alerte)_ — Tâche à `progress > 0` ET `today < start_date` (commencée avant la date prévue) : aucune alerte. Le Replan respecte la `start_date` saisie ; la borne basse est `start_date` (puisque `start_date > today`, le `max` de RG-B retombe sur `start_date`).

**RG-M** _(info silencieuse)_ — Tâche à `progress = 100` avec `today < end_date` (« finie en avance ») : aucune alerte.

### Édition manuelle d'une activité

**RG-N** _(nouvelle)_ — Un PATCH d'édition d'une activité, lorsqu'il modifie uniquement `progress` (sans `charge_jours` ni `end_date`), **ne recalcule pas `end_date`** côté serveur. Si l'utilisateur n'a pas décoché « Replanifier après enregistrement », c'est le Replan automatique (RG-GANTT-0909) qui produit la nouvelle date de fin. Si la case est décochée, `end_date` reste figée à sa valeur précédente — c'est le geste assumé de « figer ».

**RG-O** _(nouvelle)_ — Lorsque l'utilisateur édite manuellement `charge_jours` sur une activité à `progress > 0`, la valeur saisie est interprétée comme la **charge totale révisée**. Le reste à faire dérivé est `nouvelle_charge × (1 − progress/100)`. À aucun moment l'utilisateur ne saisit directement un « reste à faire ».

### Mode « Planification anticipée »

**RG-V** _(nouvelle)_ :

- Un toggle UI **« Planification anticipée »** est ajouté à côté du bouton Replan dans le bandeau d'incohérences et dans la barre d'action principale du Gantt.
- Sémantique : case cochée = mode anticipé activé pour le projet courant.
- **Persistance** : localStorage avec clé `gantt:advance-planning:{project_id}`, valeur booléenne. Par défaut décochée. La persistance est « par navigateur × projet » (en l'absence d'identité utilisateur dans la stack actuelle).
- **Portée** : la valeur du toggle pilote **toutes les sources de Replan** d'un projet : Replan manuel (bouton dédié, bouton du bandeau) ET auto-replan post-édition d'activité (RG-GANTT-0909).
- **Effet** : suspend **RG-B uniquement**. La borne basse redevient `max(t.start_date, pred.end + lag, SNET)` sans `today`. **RG-A et RG-C restent appliquées** : les tâches à `progress = 100` restent lockées, et le Replan consomme toujours le reste à faire pour les tâches à `progress > 0`.

### Synthèse progress des phases

**RG-U** _(nouvelle)_ — Le `progress` d'une phase est dérivé automatiquement de ses fils :

```
chargeEffective(c) = charge_jours(c)              si c est une activité (kind='task')
                   | 0                            si c est un jalon (kind='milestone')
                   | Σ chargeEffective(fils de c) si c est une sous-phase

progressEffectif(c) = progress(c)                  si c est une activité
                    | progress(c) calculé via cette formule appliquée récursivement
                                                  si c est une sous-phase
                    | (non éligible)              si c est un jalon

progress(phase) = Σ(chargeEffective(cᵢ) × progressEffectif(cᵢ)) / Σ chargeEffective(cᵢ)

Cas limite :
  • Σ chargeEffective(cᵢ) = 0 → moyenne arithmétique non pondérée des progress des fils éligibles
  • aucun fils éligible (phase vide ou ne contenant que des jalons) → progress(phase) = null (affiché vide)
```

Le `progress` d'une phase n'est plus saisi : il devient une lecture dérivée. La colonne `progress` reste persistée en base mais n'est plus écrite par l'utilisateur pour les phases.

### Cascade

**RG-R** _(rappel/clarification)_ — La cascade aux successeurs (`propagateToSuccessors`, [db/index.js:2155](../../db/index.js#L2155)) respecte aussi l'invariance de charge : aucun successeur ne voit sa `charge_jours` modifiée par la propagation.

**RG-S** _(rappel)_ — Un successeur d'une tâche en cours est traité normalement par le Replan : sa borne basse intègre `pred.end + lag`, où `pred.end` est la fin proposée par le Replan de la tâche en cours (pas son ancienne `end_date` figée).

### Contrat PATCH (technique)

**RG-W** _(nouvelle)_ — Le PATCH issu du Replan (manuel ou automatique via RG-GANTT-0909) inclut systématiquement les quatre champs `start_date`, `end_date`, `charge_jours` et `predecessor_lag`. Le serveur honore les quatre valeurs telles quelles **sans back-dérivation**.

RG-GANTT-0100 (back-dérivation de `charge_jours` depuis `end_date - start_date`) **ne s'applique plus qu'au drag manuel du bord droit** dans le diagramme, où le PATCH client envoie `end_date` SANS `charge_jours`.

### Abandons

- **RG-GANTT-0905** (« Replan partiel ») est supprimée du catalogue.
- Toute la mécanique associée est démantelée :
  - paramètre `concernedIds?: Set<string>` de `replanTasks` ([utils.ts:1964](../../src/lib/utils.ts#L1964)) ;
  - fonctions `concernedTaskIds`, `prefillLockedIntervals`, `descendantTaskIds` côté utils ;
  - état `scope: 'full' | 'partial'` et tout son usage dans `App.tsx` ;
  - bouton « Replan partiel » dans `CoherenceAlert` ;
  - tests « Replan partiel » dans `App.test.tsx` et `utils.test.ts`.
- Le bandeau d'incohérences (`CoherenceAlert`) **reste** : il continue de surfacer surcharges, conflits de prédécesseur, conflits de priorité et tâches en retard (signalement de nouvelle RG si jugé utile à part). Il ne propose qu'un seul bouton « Replan ».

### Choix de modèle (`end_date` d'une tâche en cours)

Pour une activité en cours (0 < `progress` < 100), `end_date` est calculée par le moteur Replan selon :

```
end = max(start_date, today) + computeEndFromCharge(reste_à_faire, allocations, absences)
```

où `reste_à_faire = charge_jours × (1 − progress/100)`.

Conséquence à accepter : entre deux Replans, la `end_date` stockée peut « vieillir » par rapport à cette formule, puisque `today` avance. C'est le Replan qui rafraîchit la valeur, jamais une lecture continue.

---

## 3. Architecture et impact code

### Côté moteur Replan ([src/lib/utils.ts](../../src/lib/utils.ts))

- `computeReplanEarliestStart` ([utils.ts:1802](../../src/lib/utils.ts#L1802)) : ajouter `today` au `max(...)` quand `t.progress > 0` (RG-B). Argument `ignoreToday: boolean` pour RG-V.
- `placeTaskInTimeline` ([utils.ts:1859](../../src/lib/utils.ts#L1859)) : remplacer `charge` par `effectiveCharge = Math.max(1, Math.ceil(t.charge_jours × (1 − t.progress/100)))` (RG-C).
- `replanTasks` ([utils.ts:1964](../../src/lib/utils.ts#L1964)) :
  - retirer le paramètre `concernedIds` ;
  - exclure les tâches à `progress = 100` de la boucle de placement ;
  - **les ajouter à la timeline comme obstacles** via un nouvel utilitaire `prefillCompletedIntervals` (récupère le rôle structurel de l'ancien `prefillLockedIntervals`, mais filtré sur `progress = 100` au lieu de `!concernedIds.has(id)`) ;
  - ajouter un paramètre `ignoreToday: boolean` propagé à `computeReplanEarliestStart`.
- Supprimer `concernedTaskIds` ([utils.ts:2327+](../../src/lib/utils.ts#L2327)) et toute fonction d'expansion transitive aux successeurs qui n'aurait plus d'usage hors du mode partial.
- `buildReplanMoves` ([utils.ts:1938](../../src/lib/utils.ts#L1938)) : inclure `charge_jours` dans chaque `ReplanMove` (= valeur originale préservée, transmise au PATCH).

### Côté `App.tsx`

- `handleOpenReplan` ([App.tsx:1294](../../src/App.tsx#L1294)) : retirer le paramètre `scope`, lire `ignoreToday` depuis localStorage du projet courant, passer aux deux appels à `replanTasks`.
- `submitReplanMoves` ([App.tsx:900](../../src/App.tsx#L900)) : ajouter `charge_jours: m.charge_jours` dans le body du PATCH (RG-W).
- `handleSaveTask` ([App.tsx:949](../../src/App.tsx#L949)) : l'auto-replan post-édition lit aussi `ignoreToday` depuis localStorage.
- Supprimer toute la branche `scope === 'partial'`, l'état `pendingReplanScope`, et le `useEffect` associé.
- Ajouter un toggle UI « Planification anticipée » qui lit/écrit localStorage. Placement à confirmer (à côté du bouton Replan principal, et possiblement dans le bandeau d'incohérences).

### Côté serveur ([db/index.js](../../db/index.js))

- `resolveChargeAndEnd` ([db/index.js:1668](../../db/index.js#L1668)) : ajouter un nouveau cas en tête, avant 3a, 3b, 3c :
  - **Cas 3a' (nouveau)** : si `patch.charge_jours` ET `patch.end_date` sont tous deux explicites (= signal du Replan), honorer les deux telles quelles. `charge_jours = patch.charge_jours`, `end_date = patch.end_date`. **Pas de back-dérivation, pas de recalcul.**
  - Les cas existants 3a, 3b, 3c restent pour les autres sources de PATCH (TaskEditor, drag du bord droit).
- `updateTask` ([db/index.js:2029](../../db/index.js#L2029)) : pas d'autre modification structurelle ; la nouvelle branche dans `resolveChargeAndEnd` suffit. Garantie RG-N par construction : un PATCH ne contenant que `progress` traverse aujourd'hui le cas 3c (`charge` préservée, `end` recalculée depuis le start courant). Tant que les allocations n'ont pas changé entre deux PATCH, le résultat est identique à l'ancienne `end_date`. Aucun ajout de garde n'est nécessaire pour ce cas — à vérifier sur un test dédié (cf. § 4 test 9).

### Côté `CoherenceAlert` ([src/components/CoherenceAlert.tsx](../../src/components/CoherenceAlert.tsx))

- Supprimer le bouton « Replan partiel » et toute sa logique de scope.
- Conserver le bouton « Replan » unique.

### Côté `TaskEditor`

- Une phase ne saisit plus `progress` : champ désactivé/masqué pour `kind='phase'`. La valeur affichée est la lecture dérivée (RG-U).
- Conservation du champ `progress` pour les activités (saisie 0..100).

### Catalogue RG ([docs/regles-metier.md](../regles-metier.md))

- Ajouter les sections : RG-GANTT-1900 à 1908 (ou plage libre suivante) pour les nouvelles RG ci-dessus.
- Réviser RG-GANTT-0100 pour préciser : la back-dérivation s'applique au drag manuel uniquement. Le Replan a son propre contrat (RG-W).
- Réviser RG-GANTT-0903 pour préciser le cas `progress > 0` (RG-B).
- Réviser RG-GANTT-0909 pour signaler que le mode anticipé pilote aussi l'auto-replan.
- Supprimer RG-GANTT-0905 (Replan partiel).

---

## 4. Plan de tests

### Tests unitaires (`src/lib/utils.test.ts`)

1. **Invariance de charge** : 2 Replans consécutifs sans modification produisent le même état (le 2ᵉ retourne `[]`).
2. **RG-A** : une tâche à `progress = 100` n'est jamais dans la sortie de `replanTasks` ; elle bloque la timeline d'un autre collaborateur si elle chevauche.
3. **RG-B** : une tâche à `progress > 0` avec `start_date < today` est replanifiée à `today`.
4. **RG-B + RG-L** : une tâche à `progress > 0` avec `start_date > today` reste à `start_date`.
5. **RG-C** : une tâche à `progress = 50` ne consomme que la moitié de `charge_jours`.
6. **RG-V** : `replanTasks(tasks, { ignoreToday: true })` ne replace pas une tâche à `progress > 0` à `today` si elle pouvait rester avant ; RG-A et RG-C continuent de s'appliquer.

### Tests serveur (`db/index.test.js`)

7. **RG-W (cas 3a')** : PATCH avec `start_date` + `end_date` + `charge_jours` explicites : tous trois honorés sans recalcul.
8. **RG-GANTT-0100 préservée** : PATCH avec `end_date` seul (drag bord droit) : `charge_jours` back-dérivée comme avant.
9. **RG-N** : PATCH avec `progress` seul : `end_date` et `charge_jours` inchangés.

### Tests intégration (`src/App.test.tsx`)

10. Le PATCH généré par un Replan inclut `charge_jours`.
11. Toggle « Planification anticipée » : lecture/écriture localStorage, prise en compte par le Replan manuel et par l'auto-replan post-édition.
12. Suppression du bouton « Replan partiel » du bandeau d'incohérences (test de non-régression de l'UI).

### Test de répro du bug (`src/lib/utils.test.ts` ou intégration)

13. **Bug B1 (boucle)** : avec une allocation < 100 %, exécuter Replan → appliquer les moves → relancer Replan → `moves.length === 0`. (Ce test échoue aujourd'hui ; il valide la correction.)

### Tests de la synthèse phase (`src/lib/utils.test.ts`)

14. **RG-U cas nominal** : phase avec 2 activités (charge 10 à 20 %, charge 30 à 80 %) → `progress = (10×20 + 30×80) / 40 = 65 %`.
15. **RG-U sous-phase imbriquée** : récursion correcte.
16. **RG-U que des jalons** : `progress = null`.

---

## 5. Considérations et risques

### Migration des données existantes

Les `charge_jours` actuellement en base peuvent être déjà gonflées par la boucle (bug B1). Deux options :

- **Option migration A** : laisser la base en l'état. Le bug ne s'aggrave plus après le correctif. Les charges « gonflées » des tâches existantes sont conservées, ce qui peut surprendre. Avantage : zéro risque de migration.
- **Option migration B** : script de migration optionnel qui, pour chaque tâche, propose un nouveau `charge_jours = workingDaysBetween(start, end) × min(allocation)` ou similaire. Risque de mauvaise estimation.

💡 Recommandation : option A. La correction stoppe la divergence sans toucher à l'historique. L'utilisateur peut corriger manuellement les charges aberrantes via le TaskEditor.

### Compatibilité descendante

Le contrat PATCH côté server (cas 3a' nouveau) ne casse pas les cas existants : les anciens clients qui n'envoient pas `charge_jours` continuent à fonctionner via les cas 3a/3b/3c existants.

### Performance

Aucun impact significatif. Le calcul `effectiveCharge = charge × (1-progress/100)` est trivial. La suppression de `prefillLockedIntervals` réduit même légèrement le travail du moteur.

### Sécurité / cohérence

L'utilisation de `today` comme borne basse introduit une dépendance temporelle. Deux Replans à des dates différentes peuvent produire des résultats différents pour la même base. C'est attendu et documenté (RG-B + choix de modèle).

---

## 6. Hors-scope explicite

- Identité utilisateur / authentification : le « par navigateur × projet » est un compromis pragmatique de la v2.2. Si une auth est ajoutée plus tard, on déplacera le toggle vers une préférence serveur.
- Suivi historique de `actual_start_date` / `actual_end_date` distincts des dates planifiées : pas dans cette spec. La `start_date` actuelle joue le rôle de date historique pour les tâches en cours.
- Affichage visuel d'une tâche en cours « coupée en deux » (portion passée vs reste à faire) : pas dans cette spec. La barre reste continue, étendue de `start_date` à la nouvelle `end_date`.

---

## 7. Découpage proposé (préliminaire — sera détaillé dans le plan d'implémentation)

L'implémentation se fait en quatre lots, chacun mergeable et testé indépendamment :

- **L1** — Invariance de charge + correction du contrat PATCH (RG-INV + RG-W) : corrige le bug B1, ne change pas le comportement métier.
- **L2** — Abandon du Replan partiel (suppression de RG-GANTT-0905 et du code associé) : refactor sans changement de comportement utilisateur en dehors de la disparition d'un bouton.
- **L3** — Prise en compte de `progress` dans le Replan (RG-A, RG-B, RG-C, RG-L, RG-M, RG-N, RG-O) + synthèse progress des phases (RG-U).
- **L4** — Mode planification anticipée (RG-V) avec toggle UI et localStorage.

L'ordre L1 → L2 → L3 → L4 est intentionnel : on corrige d'abord la boucle (urgent), puis on simplifie (avant d'ajouter), puis on enrichit, puis on ajoute l'option.
