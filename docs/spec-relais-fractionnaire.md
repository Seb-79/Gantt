# Spécification — Relais à la capacité (fractionnaire) entre activités

> Statut : **G1+G2+G3 implémentés (v2.7)** — timeline fractionnaire (RG-2305),
> surcharge fractionnaire (RG-2306), relais prédécesseur capacité-aware client
> ET serveur (RG-2307). **Reste G4** (charges fractionnaires < 1 jour : colonne
> `charge_jours` REAL + UI au quart de jour) — non commencé.

## 1. Problème

Deux symptômes liés :

1. **Bug visible** : une activité dont le prédécesseur finit le 25/06 (lag 0)
   démarre **le 25/06** au lieu du **26/06**. Très visible sur les activités
   **sans collaborateur** (« Activité Tests », « Activités Tests 2 »).
2. **Besoin métier** : si le prédécesseur n'a consommé qu'une **fraction** de sa
   dernière journée (0,25 / 0,5 / 0,75), le successeur devrait pouvoir démarrer
   **le même jour** (en utilisant le reste), sinon le **jour ouvré suivant**.

Cause racine du bug : `computeSuccessorStart(finPréd, lag=0)` renvoie
`finPréd` (= **même jour**), et la borne basse serveur (`reconcilePredecessors`)
est une **arithmétique de dates pure**, sans notion de capacité. Les activités
sans collaborateur ne marquent aucun jour « occupé » → rien ne repousse le
successeur → il colle à la fin du prédécesseur.

## 2. Modèle de capacité (existant)

- Une journée d'un collaborateur = **budget de capacité** `C(collab, jour)`.
- `C = (allocation_pct / 100) × (1 − absence_fraction)`, à 0 les week-ends/fériés.
  Valeurs typiques : 1,0 (100 %), 0,75, 0,5, 0,25, 0.
- Une activité **consomme** `charge_jours` unités (jours-équivalents) en
  répartissant sur les jours ouvrés selon la capacité disponible.
- `charge_jours` est **ENTIER ≥ 1** aujourd'hui (schéma SQLite `INTEGER`).
- `end_date` = dernier jour où l'activité a consommé > 0 (inclusif).

Aujourd'hui, le moteur marque un jour **entièrement occupé** dès qu'une activité
le touche (`timeline = Map<collab, Set<jour>>`, binaire). Deux activités **ne
partagent jamais** un jour, et la **surcharge** se déclenche dès que deux
activités partagent un jour travaillé (RG-GANTT-2303).

## 3. Règle cible

**Le lag est un délai en jours ouvrés ENTIERS.** Le relais se fait « à la
capacité » :

- **lag 0** : le successeur démarre au **premier instant de capacité
  disponible** à partir de la fin du prédécesseur. Concrètement, au grain jour :
  - si la **dernière journée du prédécesseur** garde un **reste de capacité**
    (> 0) pour le collaborateur du successeur → le successeur démarre **le même
    jour** (il consomme le reste) ;
  - sinon → **jour ouvré suivant** disposant de capacité.
- **lag N ≥ 1** : on impose un **délai de N jours ouvrés pleins** après la fin du
  prédécesseur. Pas de partage le même jour (le délai est explicite).

La capacité « disponible » d'un jour = `C(collab, jour) − déjà_consommé(collab,
jour)` (toutes activités confondues). Le relais same-day n'est donc possible que
si `reste > 0`.

## 4. D'où vient un « reste » de capacité ?

Le reste sur la dernière journée du prédécesseur apparaît quand la **charge
restante ce jour-là < capacité du jour**. Exemples :

| Capacité/jour | charge                            | Répartition        | Dernier jour consomme | **Reste**               |
| ------------- | --------------------------------- | ------------------ | --------------------- | ----------------------- |
| 1,0 (100 %)   | 1                                 | `1,0`              | 1,0                   | **0** → jour suivant    |
| 1,0           | 2                                 | `1,0 + 1,0`        | 1,0                   | **0** → jour suivant    |
| 0,5 (50 %)    | 1                                 | `0,5 + 0,5`        | 0,5                   | **0** → jour suivant    |
| 0,75 (75 %)   | 1                                 | `0,75 + 0,25`      | 0,25                  | **0,5** → **même jour** |
| 1,0           | 0,5 _(si charge frac. autorisée)_ | `0,5`              | 0,5                   | **0,5** → **même jour** |
| sans collab   | 1                                 | `1,0` (jour plein) | 1,0                   | **0** → jour suivant ✅ |

⚠️ **Observation clé** : avec une **charge entière** et une capacité de 1,0, la
dernière journée consomme toujours 1,0 → **jamais de reste** → toujours jour
suivant. Le relais same-day n'apparaît donc que si :

- (a) la capacité du jour n'est pas un diviseur de la charge (ex. 75 %), **ou**
- (b) on autorise des **charges fractionnaires** (< 1 jour).

→ C'est la **question ouverte n°1** ci-dessous.

## 5. Exemples chiffrés détaillés

Hypothèses : semaine ouvrée, pas de férié. « → » = consommation du jour.

### Exemple A — 100 %, charge entière, lag 0 (cas courant)

- Alice 100 %. **P** (Alice, charge 2) : Lun→1,0, Mar→1,0 → fin **Mar**.
- **S** (Alice, lag 0, charge 1) : Mar plein (reste 0) → démarre **Mer** (jour
  suivant). ✅ corrige le bug.

### Exemple B — sans collaborateur, lag 0 (le bug signalé)

- **Test délai** (sans collab, charge 1) : 25/06 → 1,0 → fin **25/06**.
- **Activité Tests** (sans collab, lag 0) : 25/06 plein → démarre **26/06**. ✅

### Exemple C — 75 %, charge 1, lag 0 (relais same-day)

- Bob 75 %. **P** (Bob, charge 1) : Lun→0,75, Mar→0,25 → fin **Mar** (reste 0,5).
- **S** (Bob, lag 0, charge 1) : Mar a 0,5 libre → **démarre Mar** (consomme 0,5),
  puis Mer→0,25 → fin **Mer**. Bars P et S **se chevauchent le Mar** mais somme
  = 0,25 + 0,5 = 0,75 ≤ capacité → **pas de surcharge**.

### Exemple D — lag 1 (délai plein, pas de same-day)

- Reprise de l'exemple C mais **lag 1**. Même s'il reste 0,5 le Mar, le délai
  d'1 jour ouvré s'applique → S démarre au plus tôt **Jeu** (1 jour plein de gap
  après Mar : Mer = gap, Jeu = début).

### Exemple E — chaîne P → Q → R, fractions mélangées, lag 0

- Carla 50 %. **P** (charge 1) : Lun 0,5 + Mar 0,5 → fin **Mar** (reste 0).
- **Q** (Carla, lag 0, charge 1) : Mar plein → démarre **Mer** : Mer 0,5 + Jeu 0,5
  → fin **Jeu** (reste 0).
- **R** (Carla, lag 0, charge 1) : Jeu plein → démarre **Ven**…
- Conclusion : à 50 %, jamais de reste → chaîne décalée d'un jour à chaque maillon
  (comportement attendu : 50 % = on avance d'une demi-charge par jour, le jour est
  « plein » côté capacité).

### Exemple F — collaborateurs différents, lag 0

- **P** (Alice 100 %, charge 1) fin **Lun**. **S** (Bob, lag 0) : Lun, côté Bob,
  est libre (capacité Bob non touchée par P) → **S démarre Lun** ?
  - ⚠️ **Question ouverte n°2** : un successeur sur un AUTRE collaborateur
    peut-il démarrer le jour de fin du prédécesseur (chevauchement « légitime »
    car ressources différentes), ou impose-t-on toujours « après la fin » ?

### Exemple G — surcharge fractionnaire

- Alice 100 %. **T1** (charge 1) et **T2** (charge 1) toutes deux le **Lun**
  (0,75 + 0,5 par ex.) → somme 1,25 **> 1,0** → **surcharge** le Lun.
- Mais 0,5 + 0,5 = 1,0 ≤ 1,0 → **pas** de surcharge (deux demi-journées tiennent).

## 6. Impact technique

### 6.1 Moteur (client, `src/lib/utils.ts`)

- **`timeline` fractionnaire** : `Map<collab, Map<jour, consommé>>` au lieu de
  `Map<collab, Set<jour>>`. `markDayTaken` → `addDayConsumption(collab, jour, frac)`.
- **`placeChargeWeaving`** : à chaque jour, `dispo = C(jour) − consommé(jour)` ;
  consommer `min(reste_charge, dispo)` ; un jour partiellement pris reste
  éligible tant que `dispo > 0`.
- **Borne basse (`computeReplanEarliestStart` / `predecessorLowerBound`)** :
  pour lag 0, garder `finPréd` comme borne (le « jour suivant » émerge
  naturellement du tissage si le jour est plein). Pour lag ≥ 1, gap plein.
- **`buildEnrichedTimeline`** : une entrée par jour travaillé **avec sa
  fraction** (pour le plan de charge et la surcharge).

### 6.2 Surcharge / cohérence (`detectOverloads`, RG-2303)

- Surcharge ssi `Σ fractions(collab, jour) > C(collab, jour)` (au lieu de « ≥ 2
  activités le même jour »). Tolérance numérique 1e-9.

### 6.3 Serveur (`db/index.js`) — **le point dur**

- `reconcilePredecessors` et `propagateToSuccessors` calculent la `start_date`
  **stockée** via `computeSuccessorStart` (arithmétique pure, sans capacité).
  Pour que la date stockée colle au relais fractionnaire, la borne basse serveur
  doit devenir **capacité-aware** (réutiliser la logique « 1er jour avec reste »).
  → c'est la partie la plus sensible (cohérence client/serveur, idempotence du
  Replan, RG-INV).
- `computeSuccessorStart(predEnd, 0)` : conserver `predEnd` comme borne, et
  laisser le calcul de fin capacité-aware (`addWorkingDaysWithAllocationServer`)
  gérer le reste. Pour lag ≥ 1 : inchangé.

### 6.4 Données / charge fractionnaire (si Q1 = oui)

- `charge_jours` deviendrait **REAL** (≥ 0,25, pas de 0,25). Migration + UI
  (saisie en quarts de jour) + tous les `Math.max(1, …)` / `ceil` à revoir.

## 7. Fichiers & tests impactés (estimation)

- `src/lib/utils.ts` : timeline fractionnaire, weaving, surcharge, borne basse.
- `db/index.js` : borne basse capacité-aware (reconcile + cascade).
- `shared/working-days.js` : `computeSuccessorStart` (lag 0).
- Tests : `utils.test.ts` (tissage, surcharge, morcellement), `db/index.test.js`
  (cascade lag 0/N), `App.test.tsx`. ~30–40 assertions à revoir.
- RG : famille 0400 (lag), famille 23 (morcellement 2300..2304), surcharge 2303.
  Nouvelles RG « relais fractionnaire ».
- Si charge fractionnaire (Q1) : `schema.sql`, `migrations.js`, `server/schemas.js`,
  `TaskEditor`, fixtures.

## 8. Décisions (validées le 2026-05-31)

1. **Charges fractionnaires : OUI.** `charge_jours` ∈ {0,25 ; 0,5 ; 0,75 ; 1 ;
   1,25 ; …}, **par pas de 0,25, minimum 0,25, sans borne haute**. Colonne REAL +
   saisie UI au quart de jour.
2. **Règle « même jour / lendemain » = remplissage de la DERNIÈRE JOURNÉE du
   prédécesseur**, de façon **uniforme** (y compris si le successeur est sur un
   autre collaborateur, et y compris sans collaborateur) :
   - `reste = capacité(dernier jour) − consommé_par_le_préd(dernier jour)` ;
   - `reste > 0` → successeur **le même jour** (consomme le reste) ;
   - `reste = 0` → successeur **le jour ouvré suivant**.
     Le successeur « attend que le prédécesseur soit fini » — on ne se base PAS sur
     la disponibilité propre du collaborateur du successeur pour le démarrage.
3. **Lag (rappel, monotone)** : `lag 0` → même jour si reste, sinon `X+1` ;
   `lag N≥1` → `X + (N+1)` jours ouvrés (le reste éventuel est ignoré, le délai
   prime). Seul le cas « lag 0 + journée pleine » change vs l'existant.
4. **Surcharge : OUI** → `Σ fractions(collab, jour) > capacité(collab, jour)`
   (deux demi-journées tenant dans 1,0 ne sont PAS une surcharge).
5. **Cohérence client/serveur : OBLIGATOIRE.** La borne basse **serveur**
   (`reconcilePredecessors` + cascade) devient capacité-aware pour que la date
   **stockée** corresponde exactement au relais (sinon divergence comme le bug
   du jalon).

Voir le tableau de 14 exemples chiffrés (échange du 2026-05-31) faisant foi.

## 9. Découpage envisagé (après validation des Q)

- **G1** — Timeline fractionnaire + tissage (moteur) + surcharge fractionnaire.
- **G2** — Borne basse capacité-aware (lag 0 same-day si reste) côté moteur.
- **G3** — Alignement serveur (reconcile + cascade) capacité-aware.
- **G4** — (si Q1=oui) charge fractionnaire (schéma + UI).
- **G5** — RG, doc, porte de garde.
