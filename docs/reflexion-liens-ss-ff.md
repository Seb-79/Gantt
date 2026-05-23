# Réflexion — Ajout des liens SS (Début-Début) et FF (Fin-Fin)

**Statut : en réflexion. Aucune décision finale. Aucune ligne de code à écrire tant que l'utilisateur n'a pas tranché entre « approche light » et « approche pleine ».**

Démarré le 2026-05-23.

---

## Contexte actuel

Le projet ne supporte qu'un seul type de lien entre tâches : **FS (Finish-Start)**.

- Table SQL `task_predecessors(task_id, predecessor_id, lag)` — pas de colonne `type` (`db/index.js`).
- Modèle TS `predecessors: { id: string; lag: number }[]` (`src/lib/types.ts:76`).
- Sémantique : `successor.start = MAX(pred.end + lag)` sur l'ensemble des prédécesseurs.
- Sémantique « minimum » (pas strict) : si la tâche démarre plus tard que la borne, c'est valide. On ne ramène jamais en arrière (`db/index.js:1418`).
- Propagation : `propagateToSuccessors` cascade les changements de dates vers l'aval (`db/index.js:1472`).
- Détection : `detectPredecessorViolations` ne valide que la sémantique FS (`src/lib/utils.ts:2157`).
- UI : `PredecessorPicker` affiche `[arbre tâches] + [lag en jours ouvrés]`. Pas de notion de type.
- Replan auto : son solveur de surcharges suppose un graphe acyclique passé→futur.

---

## Besoin exprimé par l'utilisateur

> Permettre d'ajouter, en plus du FS actuel :
>
> - **SS (Start-Start)** : deux tâches démarrent ensemble.
> - **FF (Finish-Finish)** : deux tâches finissent ensemble.
>
> Utilité confirmée : **rétro-planning**.

**Exemple concret donné** (industrie agro / pâtisserie) :

- Activité A : mise sous emballage décorée de la tarte au citron meringuée.
- Activité B : inspection de la tarte au citron meringuée.

L'inspection (B) doit démarrer en même temps que l'emballage (A) — lien **SS** — et finir en même temps que A — lien **FF**. Sémantique : « B accompagne A du début à la fin, sans démarrer trop tôt ni traîner après ».

---

## Position de l'utilisateur sur les challenges

| Challenge                                                    | Réponse                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| **C1 — Cas d'usage concret**                                 | ✅ Donné (cf. exemple ci-dessus). Argument fort : rétro-planning. |
| **C2 — Sémantique minimum (a) ou stricte (b) ?**             | ⏳ **À trancher**.                                                |
| **C3 — Propagation arrière sur FF ?**                        | ✅ **Approche pleine** (propagation bidirectionnelle assumée).    |
| **C4 — Jalons + phases : autorisés ou interdits en SS/FF ?** | ⏳ **À trancher**.                                                |
| **C5 — Exposition UI complète ou mode avancé ?**             | ⏳ **À trancher**.                                                |

---

## Impacts techniques (synthèse à froid)

### Schéma de données

- Ajouter colonne `type TEXT NOT NULL DEFAULT 'FS'` (check `'FS' | 'SS' | 'FF'`) sur `task_predecessors`.
- Migration : toutes les lignes existantes prennent `type = 'FS'` automatiquement.
- Modèle TS : `predecessors: { id: string; type: 'FS' | 'SS' | 'FF'; lag: number }[]`.

### Moteur de calcul (le gros morceau)

`computeMinStartFromPredecessors` doit être généralisé. Avec `B` ayant les liens :

- FS depuis A : `B.start ≥ A.end + lag_FS`
- SS depuis A : `B.start ≥ A.start + lag_SS`
- FF depuis A : `B.end ≥ A.end + lag_FF` → équivaut à `B.start ≥ A.end + lag_FF − charge(B)`

Donc la borne basse de `B.start` est :

```
maxStart = MAX(
  pour chaque pred A:
    type=FS → A.end + lag
    type=SS → A.start + lag
    type=FF → A.end + lag − charge(B)
)
```

### Propagation bidirectionnelle (approche pleine choisie)

Le graphe n'est plus orientable « passé → futur » :

- Bouger `B` (successeur) peut forcer `A` (prédécesseur) à reculer si FF strict.
- Bouger `B` peut forcer `A` à démarrer plus tôt si SS strict.

→ L'algo de propagation doit devenir un **solveur de point fixe** (boucle jusqu'à stabilité). Risque de :

- Cycles infinis si contraintes contradictoires.
- Performance : O(n²) au lieu de O(n) pour un graphe acyclique.
- Détection de contradictions : `A SS B` + `B SS A` avec lags incompatibles.

### Cas dégénérés à régler

- **Jalon** (durée 0) : SS et FF se réduisent mathématiquement à FS. Choix : interdire en UI, ou autoriser en traitant comme FS automatiquement.
- **Phase** (regroupement) : ses dates sont MIN/MAX des enfants. Lier une phase par SS/FF n'a pas de sens opérationnel. Probable : **interdire**.

### UI

- `PredecessorPicker` : ajouter sélecteur de type (3 options FS/SS/FF) à côté du lag pour chaque lien.
- Gantt : flèches doivent partir de points différents (start ou end) selon le type. Doubler la logique de rendu (`GanttChart.tsx`).
- Visualisation distincte recommandée : couleur ou style de flèche par type (convention MS Project = lignes plus fines, têtes différentes).

### Tests + règles métier

- `detectPredecessorViolations` : étendre les 3 sémantiques.
- Nouvelles règles RG-GANTT-XXXX à ajouter dans `docs/regles-metier.md`.
- Tests : multiplier les cas pour chaque type × chaque cas (création / modif / cascade / replan / violation).

### Replan auto

- L'algo actuel pousse les successeurs en aval pour résoudre les surcharges.
- Avec SS : pousser B (lien SS depuis A) doit-il pousser A aussi pour préserver la simultanéité ?
- Avec FF : pousser B (lien FF depuis A) doit-il **allonger A** pour qu'elle finisse en même temps ?
- L'approche pleine demande de faire évoluer Replan, sinon les liens SS/FF seront cassés à chaque Replan.

---

## Options globales

### Option Light (rejetée par l'utilisateur)

- Sémantique « minimum » sur les 3 types.
- Pas de propagation arrière (FF ne force pas A à bouger).
- Coût ~3-5 jours de dev, surface de tests modérée.
- Limitation : ne résout PAS proprement le rétro-planning (l'objectif annoncé).

### Option Pleine (choix actuel)

- Sémantique stricte ou minimum à trancher (C2).
- Propagation bidirectionnelle avec solveur de point fixe.
- Replan auto étendu pour respecter les 3 types.
- Détection de cycles + contradictions.
- Coût estimé **15-25 jours** de dev (modèle, moteur, UI, tests, replan).
- Surface de tests : ~30-50 nouveaux cas.

---

## Questions encore ouvertes (à trancher avant tout dev)

1. **C2 — Sémantique minimum ou stricte ?**
   - Minimum : « B ne peut pas démarrer/finir avant X, mais peut décaler ». Compatible avec saisie manuelle libre.
   - Stricte : « B démarre/finit EXACTEMENT à X ». Plus rigide, mais c'est le seul moyen de vraiment forcer le rétro-planning sans intervention manuelle.
   - À noter : on peut mixer (FS = minimum comme aujourd'hui, SS et FF strictes). Mais ça crée une asymétrie cognitive.

2. **C4a — Liens SS/FF sur jalon : interdits, ou auto-équivalents FS ?**

3. **C4b — Liens SS/FF sur phase : interdits ?**

4. **C5 — Exposition UI : visible par défaut, ou activé via préférence « mode avancé » ?**

5. **Replan auto étendu : périmètre v1 ou v2 ?**
   - v1 = SS/FF respectés à la création/édition manuelle mais Replan peut les casser (signalés en violation).
   - v2 = Replan intègre SS/FF dans son solveur.

---

## Décision à prendre

L'utilisateur évalue actuellement s'il **lance ou non l'« approche pleine »**. Coût/valeur :

- Coût : 15-25 jours de dev + complexité durable du moteur.
- Valeur : rétro-planning natif, pas de contournement manuel pour les chaînes SS/FF, alignement avec MS Project (référence du marché).

Si Go : produire un plan détaillé par feature (modèle DB → moteur calcul → UI picker → rendu Gantt → tests → Replan).
Si NoGo : archiver ce document et continuer avec le FS seul.
