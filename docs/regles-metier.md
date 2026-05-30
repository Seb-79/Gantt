# Règles de gestion — Application Gantt

**Version applicative couverte : v2.3 (v2.0 F0..F6 + v2.1 F2.9/F4/F5 + v2.2 invariance charge + v2.3 refonte Replan)**
**Date de dernière mise à jour : 2026-05-26**
**Couverture de test : voir la « Synthèse de couverture » en fin de document — objectif : 1 RG ↔ ≥ 1 test nommé.**

Ce document est le **référentiel vivant** des règles de gestion métier de
l'application. Chaque règle porte un identifiant stable de la forme
`RG-GANTT-XXXX` (XXXX entre 0001 et 9999) et est suivie d'une ligne
`**Tests :**` qui cite le ou les tests automatiques qui la garantissent.
Avant tout commit qui touche au comportement applicatif, vérifier que
chaque règle impactée reste couverte.

Les règles sont rédigées en **langage métier** (vocabulaire d'utilisateur,
pas de jargon technique). Elles sont organisées en **familles
thématiques** pour faciliter la lecture.

---

## Famille 1 — Règles communes à tous les types

### RG-GANTT-0001

Une tâche est de l'un des trois types suivants : **activité**, **jalon**
ou **phase**. Le type est défini à la création et peut être modifié
ensuite.

**Tests :** `db/index.test.js` → « insère une tâche normale » ; « jalon : end_date = start_date forcé » ; « createTask phase : ignore collaborator_id et predecessor_id ».

### RG-GANTT-0002

Toute tâche est obligatoirement rattachée à un projet unique. Il
n'existe pas de tâche orpheline.

**Tests :** `server/app.test.js` → « POST /api/tasks rattache la tâche au project_id fourni ».

### RG-GANTT-0003

L'avancement d'une tâche est un pourcentage entier compris entre 0 et
100 inclus.

**Tests :** `server/app.test.js` → « POST progress hors borne → 400 » ; `db/index.test.js` → « met à jour le progress ».

### RG-GANTT-0004

La date de fin d'une tâche est toujours supérieure ou égale à sa date
de début. Pour un jalon, ces deux dates sont identiques par
construction.

**Tests :** `TaskEditor.test.tsx` → « refuse une end_date < start_date » ; `server/app.test.js` → « POST end_date < start_date → 400 ».

### RG-GANTT-0005

Le nom d'une tâche est obligatoire et ne peut pas être vide.

**Tests :** `TaskEditor.test.tsx` → « refuse la sauvegarde si le nom est vide ».

### RG-GANTT-0006

À chaque modification de donnée (création, édition, suppression), le
système incrémente un numéro de version interne. Les **navigateurs
ouverts** consultent ce numéro toutes les 5 secondes pour se rafraîchir
automatiquement quand une autre personne a modifié le planning.

**Tests :** `App.test.tsx` → « le polling 5 s déclenche un re-fetch de /api/state » ; `db/index.test.js` → « insère et incrémente la version ».

### RG-GANTT-0007

Chaque tâche a une couleur effective :

1. couleur personnalisée si saisie, sinon
2. couleur du collaborateur (uniquement pour les activités), sinon
3. couleur grise par défaut.

**Tests :** `utils.test.ts` → « priorité couleur custom » ; « sinon couleur du collab » ; « sinon défaut ».

---

## Famille 2 — Activités

### RG-GANTT-0100

Une activité a une **charge** exprimée en jours ouvrés (≥ 1). Depuis la
v2.0, la charge est **stockée explicitement** (colonne `charge_jours`) et
constitue la **source de vérité** de la durée : la date de fin est
**dérivée** de `(date de début + charge en jours ouvrés)`. Les week-ends
et les jours fériés français sont sautés pendant la consommation.

À la création ou à la modification, si la charge n'est pas fournie mais
qu'une date de fin l'est, le système **back-dérive** la charge depuis
l'écart courant en jours ouvrés. Si les deux sont fournies, la charge
gagne. Cette politique permet au drag du bord droit d'une barre dans le
planning (qui envoie `end_date`) d'éditer implicitement la charge.

**(v2.2)** La back-dérivation depuis `end_date` (cas où seule `end_date`
est fournie) ne s'applique qu'au **drag manuel du bord droit** dans le
diagramme Gantt. Le Replan utilise un contrat distinct (RG-GANTT-1901)
qui fournit `charge_jours` explicitement pour empêcher la back-dérivation.

**Tests :** `utils.test.ts` → bloc `addWorkingDays (v1.9)` (8 cas) ;
bloc `computeEndFromCharge (v2.0)` (3 cas dont « saute les fériés FR ») ;
`db/index.test.js` → « v2.0 / RG-GANTT-0100 — activité créée sans charge_jours :
charge back-dérivée » ; « charge_jours explicite à la création : end recalculée » ;
« charge_jours saute les fériés français » ; « patch charge_jours : end_date
recalculée » ; « patch end_date seul : charge back-dérivée (drag bord droit) » ;
« patch start_date seul : charge préservée, end suit » ; « migration : charge_jours
initialisée depuis l'écart courant ».

### RG-GANTT-0101

Une activité peut être affectée à un seul collaborateur ou rester non
affectée.

**Tests :** `db/index.test.js` → « supprime + détache les tâches (SET NULL) » ; `TaskEditor.test.tsx` → « appelle onSave avec les champs saisis ».

### RG-GANTT-0102

Une activité peut avoir une couleur personnalisée ; à défaut, elle
hérite de la couleur de son collaborateur.

**Tests :** `utils.test.ts` → « priorité couleur custom » ; « sinon couleur du collab ».

### RG-GANTT-0103

Une activité peut être rattachée à une phase parente (qui la regroupe
dans la hiérarchie d'affichage).

**Tests :** `db/index.test.js` → « phase : créer une activité enfant recale ses dates » ; `App.test.tsx` → « clic sur le chevron d'une phase masque ses enfants dans la liste ».

### RG-GANTT-0104

Une activité peut avoir une tâche prédécesseur (activité ou jalon).

**Tests :** `server/app.test.js` → « POST avec predecessor_id : start_date forcée à la fin du prédécesseur ».

### RG-GANTT-0105

Une activité peut être déplacée librement à la souris dans le
diagramme, y compris dans le passé. Les éventuelles incohérences avec
les autres règles métier sont signalées a posteriori dans le bandeau
d'alertes.

**Tests :** `GanttChart.test.tsx` → « v1.21 — drag vers la GAUCHE (passé) déplace bien la tâche ».

---

## Famille 3 — Jalons

### RG-GANTT-0200

Un jalon est un point ponctuel. Sa date de fin est toujours identique
à sa date de début.

**Tests :** `db/index.test.js` → « jalon : end_date = start_date forcé » ; `server/app.test.js` → « POST jalon (end_date forcée) » ; `TaskEditor.test.tsx` → « jalon : fin et avancement désactivés ».

### RG-GANTT-0201

Un jalon n'a pas de charge : sa durée visuelle est de zéro jour. Depuis
la v2.0, sa colonne `charge_jours` est toujours NULL en base — même si
un client fournit une valeur, elle est ignorée.

**Tests :** `db/index.test.js` → « v1.24 / RG-GANTT-0201 — jalon : impossible de lui donner une charge » ; « v2.0 / RG-GANTT-0201 — jalon : charge_jours forcée à NULL même si fournie ».

### RG-GANTT-0202

**(v1.24, J3)** Un jalon n'a pas de collaborateur affecté. Toute
affectation ancienne est silencieusement effacée par le système.

**Tests :** `db/index.test.js` → « v1.24 / J3 — un jalon créé avec un collaborateur a collaborator_id = null » ; « v1.24 / J3 — passage en jalon → collaborator_id forcé à null ».

### RG-GANTT-0203

Un jalon peut avoir un prédécesseur ; les règles de prédécesseur
s'appliquent à lui comme à une activité.

**Tests :** `db/index.test.js` → « jalon successeur : end suit start (pas de charge à propager) ».

### RG-GANTT-0204

Un jalon peut servir de prédécesseur à d'autres tâches.

**Tests :** `TaskEditor.test.tsx` → « liste les jalons en plus des tâches dans le menu prédécesseur ».

### RG-GANTT-0205

Un jalon peut être rattaché à une phase parente (qui le contient dans
la hiérarchie d'affichage). Au maximum une seule phase parente.

**Tests :** `db/index.test.js` → « v1.24 / RG-GANTT-0205 — jalon enfant d`une phase : la phase intègre sa date ».

### RG-GANTT-0206

**(v1.24, J3)** La couleur d'un jalon ne dérive jamais d'un
collaborateur (puisqu'un jalon n'en a pas) : seules la couleur
personnalisée ou la couleur grise par défaut s'appliquent.

**Tests :** `utils.test.ts` → « un jalon avec un collaborator_id résiduel ne hérite PAS de la couleur du collab » ; « une activité avec le même collab continue d`hériter de sa couleur ».

### RG-GANTT-0207

**(v2.6 — Jalon imposé)** Un jalon peut être marqué **imposé**
(`milestone_imposed = true`) : sa date est alors **verrouillée**. Le moteur de
Replan ne le déplace jamais et la cascade de prédécesseur ne le bouge ni vers
l'avant ni vers l'arrière (ex. « date de Noël », échéance externe). Le flag est
exposé par une case « 📌 Date imposée » dans l'éditeur (jalons uniquement) et
signalé par un cadenas 🔒 sur le losange dans le Gantt. Forcé à `false` (0) pour
les activités et les phases. Défaut : `false` (non imposé).

**Tests :** `db/index.test.js` → « RG-GANTT-0207 — jalon imposé : milestone_imposed persisté à true », « RG-GANTT-0207 — jalon imposé : ne bouge pas quand X change », « RG-GANTT-0207 — updateTask bascule le flag imposé » ; `utils.test.ts` → « RG-GANTT-0207 — un jalon imposé reste une borne FIXE pour ses successeurs » ; `TaskEditor.test.tsx` → « RG-GANTT-0207 — jalon : cocher « Date imposée » envoie milestone_imposed=true », « RG-GANTT-0207 — la case « Date imposée » est absente pour une activité ».

### RG-GANTT-0208

**(v2.6 — Jalon non imposé)** Un jalon **non imposé** (défaut) n'a pas de
planning propre : il **suit son prédécesseur dans les deux sens** (= s'ancre
exactement sur `MAX(pred.end + lag)`, qu'il faille avancer OU reculer). C'est
l'exception à RG-GANTT-0406 (qui, pour les activités, ne ramène jamais un
successeur en arrière). Sans prédécesseur, un jalon non imposé conserve sa date
saisie. Le moteur de Replan le traite en outre comme **transparent** : il
recalcule sa date proposée pendant le passage pour que les tâches situées en
aval convergent en **un seul** Replan (pas de double-Replan).

**Tests :** `db/index.test.js` → « RG-GANTT-0208 — jalon non imposé : suit X quand X RECULE (cascade arrière) » ; `utils.test.ts` → « RG-GANTT-0208 — tâche après un jalon non imposé suit dès le 1er Replan » ; `db/index.test.js` → « RG-GANTT-0208 — jalon non imposé par défaut (flag absent → false) ».

### RG-GANTT-0209

**(v2.6 — Conflit jalon imposé : silencieux)** Si un jalon imposé tombe **avant
la fin** de son prédécesseur (situation impossible, ex. livraison le 20 mais
travaux finis le 25), l'outil **ne signale rien** et ne déplace rien : la date
imposée prime. Le détecteur de violation de prédécesseur ignore donc les jalons
imposés.

**Tests :** `utils.test.ts` → « RG-GANTT-0209 — jalon imposé avant la fin de son prédécesseur → aucune alerte », « RG-GANTT-0209 — un jalon NON imposé en conflit reste signalé ».

---

## Famille 4 — Phases

### RG-GANTT-0300

Une phase est un regroupement dont la date de début est la **plus
précoce** parmi celles de ses enfants directs, et la date de fin la
**plus tardive**.

**Tests :** `db/index.test.js` → « phase : MIN/MAX sur plusieurs enfants » ; « phase imbriquée : recompute remonte récursivement ».

### RG-GANTT-0301

Une phase sans enfant conserve ses dates inchangées (aucun
écrasement). Depuis la v2.0, sa colonne `charge_jours` est toujours
NULL (une phase est une synthèse, pas une activité avec une charge
propre).

**Tests :** `db/index.test.js` → « v1.24 / RG-GANTT-0301 — phase sans enfant : ses dates ne sont pas écrasées » ; « v2.0 / RG-GANTT-0301 — phase : charge_jours toujours NULL ».

### RG-GANTT-0302

Une phase n'a pas de collaborateur affecté.

**Tests :** `db/index.test.js` → « createTask phase : ignore collaborator_id et predecessor_id ».

### RG-GANTT-0303

Une phase n'a pas de prédécesseur ni de délai associés.

**Tests :** `db/index.test.js` → « createTask phase : ignore collaborator_id et predecessor_id » ; `TaskEditor.test.tsx` → « phase : collaborateur et prédécesseur masqués ».

### RG-GANTT-0304

Une phase n'a pas de priorité.

**Tests :** `db/index.test.js` → « v1.24 / Pr2 / RG-GANTT-0304 — phase créée avec priorité → priorité forcée à null ».

### RG-GANTT-0305

Une phase ne peut pas servir de prédécesseur à une autre tâche.

**Tests :** `TaskEditor.test.tsx` → « v1.24 / RG-GANTT-0305 — une phase existante n`apparaît PAS dans le menu déroulant Prédécesseur ».

### RG-GANTT-0306

Une phase peut contenir des activités, des jalons et d'autres phases
(imbrication libre).

**Tests :** `db/index.test.js` → « phase imbriquée : recompute remonte récursivement ».

### RG-GANTT-0307

Supprimer une phase supprime tout ce qu'elle contient (activités,
jalons et sous-phases). Aucun élément n'est laissé orphelin dans le
projet.

**Tests :** `db/index.test.js` → « cascade les enfants ».

### RG-GANTT-0308

Une phase peut être repliée ou dépliée visuellement pour masquer ou
afficher ses descendants. Cet état est purement visuel et ne modifie
pas les données.

**Tests :** `App.test.tsx` → « clic sur le chevron d'une phase masque ses enfants dans la liste » ; « l'état de repli est persisté en localStorage ».

### RG-GANTT-0309

**(v1.24, SNET)** Une phase ne porte jamais de date de démarrage au
plus tôt (cf. famille 8). Toute valeur ancienne est silencieusement
effacée par le système.

**Tests :** `db/index.test.js` → « v1.24 / SNET — phase : la date de démarrage au plus tôt est forcée à null » ; `GanttChart.test.tsx` → « n'affiche AUCUN triangle pour une phase ».

---

## Famille 5 — Prédécesseur et délai

### RG-GANTT-0400

Une tâche ne peut pas être son propre prédécesseur, ni avoir l'un de
ses descendants comme prédécesseur (anti-cycle).

**Tests :** `TaskEditor.test.tsx` → « v1.24 — RG-GANTT-0400 — un descendant de la tâche éditée n`apparaît PAS dans le menu Prédécesseur ».

### RG-GANTT-0401

Si une tâche a un prédécesseur, sa date de début ne peut pas être
antérieure à la fin du prédécesseur.

**Tests :** `TaskEditor.test.tsx` → « refuse une start_date < fin du prédécesseur » ; `server/app.test.js` → « POST avec predecessor_id : start_date forcée à la fin du prédécesseur ».

### RG-GANTT-0402

Le **délai** entre la fin du prédécesseur et le début du successeur
s'exprime en jours ouvrés (≥ 0). C'est un minimum : une date de début
plus tardive que le minimum imposé est respectée.

**Tests :** `db/index.test.js` → « v1.10 / v1.23 — le délai (predecessor_lag) est respecté lors d'un allongement » ; « v1.23 — le délai n'est PAS rétro-appliqué lors d'un raccourcissement ».

### RG-GANTT-0403

Quand l'utilisateur saisit explicitement un délai dans le formulaire,
ce délai est la consigne ferme. Le système recalcule alors la date de
début à partir de la fin du prédécesseur augmentée de ce délai.

**Tests :** `db/index.test.js` → « v1.10 / v1.23 — le délai (predecessor_lag) est respecté lors d'un allongement ».

### RG-GANTT-0404

Quand l'utilisateur déplace une activité à la souris dans le
diagramme (sans toucher au champ « Délai »), le système met à jour
automatiquement le délai pour refléter le nouvel écart entre la fin
du prédécesseur et le nouveau début. Le délai s'adapte donc à
l'intention exprimée par le geste.

**Tests :** `server/app.test.js` → « PATCH definir un predecesseur preserve start_date si elle est posterieure ».

### RG-GANTT-0405

Une tâche sans prédécesseur a un délai forcément égal à 0.

**Tests :** `db/index.test.js` → « v1.24 / RG-GANTT-0405 — retirer le prédécesseur remet predecessor_lag à 0 ».

### RG-GANTT-0406

Allonger la durée d'un prédécesseur **pousse** ses successeurs pour
préserver le délai. Raccourcir le prédécesseur **ne ramène pas** les
successeurs en arrière (le délai est un minimum, pas un écart figé).

**Exception (v2.6, RG-GANTT-0208) :** un **jalon non imposé** déroge à cette
règle — il se cale exactement sur son prédécesseur dans les deux sens (avance
ET recul). Les **activités** et les **jalons imposés** conservent le
comportement décrit ici.

**Tests :** `db/index.test.js` → « allonger X : Y est repoussé en conservant sa charge » ; « raccourcir X : Y reste sur place (lag = MINIMUM, v1.23) ».

### RG-GANTT-0407

Quand une tâche X est modifiée et que ses successeurs directs (Y)
doivent être poussés, les successeurs des successeurs (Z) sont eux
aussi poussés en chaîne. Le décalage se propage tant que c'est
nécessaire sur toute la chaîne de dépendances.

**Tests :** `db/index.test.js` → « chaîne X → Y → Z : la cascade se propage récursivement ».

### RG-GANTT-0408

Si la nouvelle date de fin d'un prédécesseur tombe un week-end ou un
jour férié, la date de début du successeur est **automatiquement
reportée au prochain jour ouvré**.

**Tests :** `db/index.test.js` → « la nouvelle fin de X qui tombe un week-end est snappée au lundi pour Y ».

### RG-GANTT-0409

Les jalons peuvent servir de prédécesseur. Comme un jalon est un
point ponctuel (un seul jour), c'est cette unique date qui sert de
référence à ses successeurs.

**Tests :** `db/index.test.js` → « jalon successeur : end suit start (pas de charge à propager) » ; `TaskEditor.test.tsx` → « liste les jalons en plus des tâches dans le menu prédécesseur ».

---

## Famille 6 — Priorité

### RG-GANTT-0500

**(v1.24, Pr2)** Toute activité a une priorité entière comprise entre
**1 et 5**, où 1 est la plus prioritaire et 5 la moins. Toute valeur
hors bornes (0, 6, 99, non numérique, NaN) est silencieusement
**normalisée à 3** par `normalizePriority` côté DAL.

**Tests :** `db/index.test.js` → « v1.24 / Pr2 / RG-GANTT-0500 — activité : priorité hors bornes [1..5] ramenée à 3 » (4 cas hors bornes).

### RG-GANTT-0501

**(v1.24, Pr2)** Quand l'utilisateur ne saisit rien, la priorité par
défaut d'une activité est **3**.

**Tests :** `db/index.test.js` → « v1.24 / Pr2 — activité créée sans priorité → priorité 3 par défaut ».

### RG-GANTT-0502

**(v1.24, Pr2)** Les jalons et les phases n'ont pas de priorité (le
champ n'existe pas pour eux).

**Tests :** `db/index.test.js` → « v1.24 / Pr2 — jalon créé avec priorité → priorité forcée à null ».

### RG-GANTT-0503

La priorité n'a aucun effet visuel direct dans le diagramme ni sur le
calcul de charge. Elle sert exclusivement d'arbitre lors de la
replanification et de la détection d'incohérences de priorité.

**Tests :** `utils.test.ts` → « v1.24 — RG-GANTT-0503 — changer la priorité d`une activité ne modifie PAS sa charge journalière » ; « couleur effective d`une activité indépendante de sa priorité ».

### RG-GANTT-0504

La priorité est utilisée pour départager les activités lors de la
replanification : la priorité 1 est traitée avant la 5. En cas
d'égalité, l'ordre d'affichage tranche.

**Tests :** `utils.test.ts` → « la priorité 1 gagne sur une tâche sans priorité » ; « tie-break sur la position dans la liste ».

---

## Famille 7 — Surcharge collaborateur

### RG-GANTT-0600

Chaque activité affectée à un collaborateur consomme **un
jour-personne par jour ouvré** sur son intervalle.

**Tests :** `utils.test.ts` → « cumule 1 par tâche-jour ouvré et saute les week-ends ».

### RG-GANTT-0601

Seules les activités comptent dans le calcul de charge. Les jalons et
les phases sont ignorés (un jalon est ponctuel, une phase est une
synthèse).

**Tests :** `utils.test.ts` → « ignore les jalons, phases et tâches sans collaborateur ».

### RG-GANTT-0602

Seuls les jours ouvrés sont comptabilisés. Les week-ends et jours
fériés français comptent comme zéro charge.

**Tests :** `utils.test.ts` → « cumule 1 par tâche-jour ouvré et saute les week-ends » ; `addWorkingDays / workingDaysBetween (v1.23) — sautent les fériés`.

### RG-GANTT-0603

Une activité sans collaborateur n'est imputée à personne dans le plan
de charge, mais reste affichée normalement dans le diagramme.

**Tests :** `utils.test.ts` → « ignore les jalons, phases et tâches sans collaborateur ».

### RG-GANTT-0604

La charge journalière d'un collaborateur est la **somme** des
activités qui se recouvrent ce jour-là. Deux activités le même jour =
charge de 2 (= surcharge).

**Tests :** `utils.test.ts` → « détecte la surcharge (2 tâches sur le même jour ouvré) ».

### RG-GANTT-0605

Le plan de charge affiche un code couleur par cellule selon la charge
du jour : rouge si > 1, vert si = 1, nuances de bleu si entre 0 et 1,
vide si = 0.

**Tests :** `utils.test.ts` → « mappe les charges sur les classes du code couleur » ; `WorkloadChart.test.tsx` → « met en évidence la surcharge en rouge » ; « affiche le vert sur une journée pleine ».

### RG-GANTT-0606

Un mode optionnel « mettre en évidence les sous-charges » bascule les
cellules dont la charge est strictement inférieure à 1 sur une
palette jaune, sans toucher aux états plein (vert) et surcharge
(rouge).

**Tests :** `utils.test.ts` → « highlightUnderload → sous-charges en jaune, sans toucher au plein/rouge » ; `WorkloadChart.test.tsx` → « highlightUnderload met les jours libres (sum < 1) en jaune ».

---

## Famille 8 — Contrainte « Ne doit pas démarrer avant le » (SNET)

### RG-GANTT-0700

**(v1.24, SNET)** Une activité ou un jalon peut porter une **date de
démarrage au plus tôt** facultative en dessous de laquelle la tâche
ne peut pas commencer.

**Tests :** `db/index.test.js` → « v1.24 / SNET — start_date relevée à la date de démarrage au plus tôt si en deçà ».

### RG-GANTT-0701

**(v1.24, SNET)** La date de démarrage au plus tôt est facultative
(vide par défaut). Une tâche sans cette contrainte se comporte comme
avant la v1.24.

**Tests :** `db/index.test.js` → « v1.24 / RG-GANTT-0701 — SNET facultatif : null par défaut à la création ».

### RG-GANTT-0702

**(v1.24, SNET)** Les phases ne portent jamais de date de démarrage
au plus tôt. Toute valeur ancienne est silencieusement effacée par
le système.

**Tests :** `db/index.test.js` → « v1.24 / SNET — phase : la date de démarrage au plus tôt est forcée à null ».

### RG-GANTT-0703

**(v1.24, SNET)** Si une tâche a à la fois un prédécesseur et une
date de démarrage au plus tôt, sa date de début effective doit
respecter **le plus tardif des deux** (règle « la plus tardive
gagne »).

**Tests :** `db/index.test.js` → « v1.24 / SNET RG-GANTT-0703 — SNET > pred.end : le SNET gagne » ; « pred.end > SNET : le prédécesseur gagne » ; `utils.test.ts` → « SNET > pred.end + lag → la borne basse de replan est le SNET » ; « SNET < pred.end + lag → le prédécesseur gagne ».

### RG-GANTT-0704

**(v1.24, SNET)** Si la date de démarrage au plus tôt saisie tombe un
week-end ou un jour férié, elle est **appliquée au prochain jour
ouvré**.

**Tests :** `db/index.test.js` → « v1.24 / SNET — date de démarrage au plus tôt un week-end → snap au prochain jour ouvré ».

### RG-GANTT-0705

**(v1.24, SNET)** L'utilisateur a le droit de saisir une date de
démarrage au plus tôt qui tombe un jour non ouvré. Dans ce cas, le
formulaire affiche un **avertissement non bloquant** signalant que
la date sera reportée au prochain jour ouvré.

**Tests :** `TaskEditor.test.tsx` → « affiche un avertissement quand la date saisie tombe un week-end » ; « n`affiche aucun avertissement quand la date tombe un jour ouvré ordinaire ».

### RG-GANTT-0706

**(v1.24, SNET)** Si l'utilisateur tente d'enregistrer une activité
ou un jalon dont la date de début est antérieure à sa date de
démarrage au plus tôt, l'enregistrement est **bloqué** avec un
message d'erreur clair dans le formulaire.

**Tests :** `TaskEditor.test.tsx` → « v1.24 — RG-GANTT-0706 — refuse l`enregistrement avec un message d`erreur explicite ».

### RG-GANTT-0707

**(v1.24, SNET)** Si l'utilisateur déplace une activité à la souris
en dessous de sa date de démarrage au plus tôt, le déplacement est
autorisé mais une **incohérence rouge** est immédiatement levée
dans le bandeau d'alertes. Le bouton Replan permet de corriger.

**Tests :** `utils.test.ts` → « une activité qui démarre avant son SNET déclenche une issue not_before » (couvre la détection métier, indépendamment du geste de drag déjà testé par ailleurs).

### RG-GANTT-0708

**(v1.24, SNET)** La date de démarrage au plus tôt est matérialisée
dans le diagramme par un **petit triangle gris discret** positionné
au jour ouvré effectif. Une info-bulle au survol affiche la date.

**Tests :** `GanttChart.test.tsx` → « rend un triangle (élément avec tooltip "Ne doit pas démarrer avant le ...") » ; « n'affiche AUCUN triangle pour une activité sans contrainte SNET » ; « n'affiche AUCUN triangle pour une phase ».

### RG-GANTT-0709

**(v1.24, SNET)** La replanification respecte la date de démarrage
au plus tôt comme borne basse : aucun déplacement proposé ne peut
amener une tâche en deçà de cette date.

**Tests :** `utils.test.ts` → « SNET > pred.end + lag → la borne basse de replan est le SNET » ; « SNET < pred.end + lag → le prédécesseur gagne ».

---

## Famille 9 — Cohérence (bandeau d'alertes)

### RG-GANTT-0800

Une **surcharge** est signalée (erreur rouge) dès qu'au moins une
journée ouvrée est commune entre deux activités d'un même
collaborateur.

**Tests :** `utils.test.ts` → « détecte une SURCHARGE entre 2 tâches du même collaborateur » ; « ne signale PAS deux tâches qui se touchent sans se chevaucher ».

### RG-GANTT-0801

Aucune surcharge n'est signalée entre activités de collaborateurs
différents.

**Tests :** `utils.test.ts` → « ne signale pas une surcharge entre collabs différents ».

### RG-GANTT-0802

Une **violation de prédécesseur** est signalée (erreur rouge) quand
une tâche démarre avant la fin de son prédécesseur.

**Tests :** `utils.test.ts` → « détecte une violation de PRÉDÉCESSEUR (Y avant fin X) ».

### RG-GANTT-0803

Une **violation de priorité** est signalée (avertissement jaune)
quand deux activités d'un même collaborateur ont des priorités
strictement différentes et que la moins prioritaire démarre avant la
plus prioritaire.

**Tests :** `utils.test.ts` → « détecte une violation de PRIORITÉ (faible avant haute, même collab) ».

### RG-GANTT-0804

Aucune alerte de priorité n'est levée si les deux activités ont la
même priorité, ou si une seule des deux est priorisée explicitement.

**Tests :** `utils.test.ts` → « n'inflige pas de faux positif quand une seule tâche a une priorité ».

### RG-GANTT-0805

**(v1.24, SNET)** Une **violation de date de démarrage au plus tôt**
est signalée (erreur rouge) quand une tâche démarre avant sa date de
démarrage au plus tôt (reportée au prochain jour ouvré le cas
échéant).

**Tests :** `utils.test.ts` → « une activité qui démarre avant son SNET déclenche une issue not_before » ; « une activité qui démarre PILE à son SNET ne déclenche aucune issue » ; « une phase ne déclenche jamais d`issue SNET ».

### RG-GANTT-0806

Quand un projet est cohérent (aucune incohérence détectée), aucun
bandeau d'alertes n'est affiché au-dessus du planning.

**Tests :** `App.test.tsx` → « n'affiche aucun bandeau quand le projet est cohérent ».

### RG-GANTT-0807

Quand des incohérences sont détectées, le bandeau propose une action :
**Replan complet** (toutes les activités du projet sont candidates au
déplacement).

**(v2.2)** Le bouton « Replan partiel » historique a été retiré
(RG-GANTT-0906 abandonnée).

**Tests :** `App.test.tsx` → « affiche le bandeau quand une surcharge existe + énumère les boutons » ; « "Replan complet" depuis le bandeau ouvre la modal habituelle ».

---

## Famille 10 — Replanification

### RG-GANTT-0900

La replanification ne déplace que les activités. Les jalons et les
phases suivent ensuite automatiquement par la cascade des
prédécesseurs.

**Tests :** `utils.test.ts` → « ignore les jalons et les phases ».

### RG-GANTT-0901

La replanification traite les activités par **priorité croissante**
(1 d'abord, 5 en dernier). En cas d'égalité de priorité, l'ordre
d'affichage tranche.

**Tests :** `utils.test.ts` → « la priorité 1 gagne sur une tâche sans priorité » ; « tie-break sur la position dans la liste ».

### RG-GANTT-0902

Une activité prédécesseur est traitée avant ses successeurs,
indépendamment de leur priorité respective (la dépendance prime sur
la priorité).

**Tests :** `utils.test.ts` → « le prédécesseur est prioritaire sur le successeur même si moins prioritaire en numérique ».

### RG-GANTT-0903

**~~SUPPRIMÉE EN v2.3~~** — La règle « la replanification ne déplace
jamais une activité vers une date antérieure à sa date de début
actuelle » est **abandonnée**. Elle est remplacée par RG-GANTT-1903
redéfinie (borne basse globale = `MAX(projectStartDate, today, pred.end+lag, SNET)`).

Motivation : la philosophie v2.3 est de toujours calculer la date de
démarrage la **plus précoce** compatible avec les contraintes. Le bug
historique « tâche bloquée loin dans le futur impossible à libérer »
est ainsi corrigé. Exception unique : les activités à `progress > 0`
ont leur `start_date` figée (RG-GANTT-2103, Option γ).

Cf. spec [docs/superpowers/specs/2026-05-25-refonte-replan-projet.md](./superpowers/specs/2026-05-25-refonte-replan-projet.md).

### RG-GANTT-0904

La replanification respecte la contrainte de prédécesseur : début ≥
fin du prédécesseur + délai.

**Tests :** `utils.test.ts` → « pousse la 2e tâche après la 1re quand elles se chevauchent pour le même collab ».

### RG-GANTT-0905

**(v1.24, SNET)** La replanification respecte aussi la date de
démarrage au plus tôt comme borne basse supplémentaire.

**Tests :** `utils.test.ts` → cf. RG-GANTT-0703 / 0709 (« SNET > pred.end + lag → la borne basse de replan est le SNET »).

### RG-GANTT-0906

**(v2.2 — abandonnée)** Le « Replan partiel » a été retiré.
Toutes les activités sont désormais candidates au déplacement par
le Replan complet (= seul mode de Replan). Le paramètre `concernedIds`
de `replanTasks`, la fonction `concernedTaskIds` et le bouton dédié
dans `CoherenceAlert` ont été supprimés.

### RG-GANTT-0907

Une replanification produit un **aperçu** modifiable. L'utilisateur
peut **annuler** sans rien envoyer au serveur, ou **appliquer** pour
enregistrer les déplacements.

**Tests :** `App.test.tsx` → « Annuler ferme la modal sans envoyer de PATCH » ; « Appliquer envoie 1 PATCH par tâche déplacée avec les nouvelles dates ».

### RG-GANTT-0908

Le délai saisi par l'utilisateur est **préservé** lors d'une
replanification : il n'est pas ré-inféré depuis le nouvel écart entre
prédécesseur et successeur.

**Tests :** `App.test.tsx` → « chaque PATCH de replan inclut le lag de la tâche déplacée ».

### RG-GANTT-0909

Par défaut, après chaque modification d'une tâche via le formulaire,
un Replan complet est relancé automatiquement. L'utilisateur peut
décocher cette option pour figer son geste sans replanification.

**(v2.2)** L'auto-replan respecte le toggle « Planification anticipée »
du projet courant (RG-GANTT-1910) : si le toggle est coché, l'auto-replan
s'exécute en mode anticipé (suspension de RG-GANTT-1903). Un seul mode
pilote toutes les sources de Replan.

**Tests :** `App.test.tsx` → « case cochée par défaut : un Replan suit le PATCH d'édition » ; « case décochée : aucun replan, seul le PATCH d'édition part ».

### RG-GANTT-1900

**(v2.2 — invariance de la charge)** Un Replan ne modifie JAMAIS la
`charge_jours` d'une activité. La charge est un invariant ; seules
`start_date` et `end_date` peuvent évoluer sous l'action du Replan.
Cette règle garantit qu'un Replan suivi d'aucune modification utilisateur
est un point fixe : un second Replan immédiat retourne `[]`.

**Tests :** `utils.test.ts` → « v2.2 / RG-INV — 2 Replans consécutifs sans modification produisent le même état » ; `db/index.test.js` → « v2.2 / RG-W — PATCH avec start+end+charge tous explicites : tous honorés sans recalcul ».

### RG-GANTT-1901

**(v2.2 — contrat PATCH du Replan)** Le PATCH issu du Replan (manuel ou
automatique via RG-GANTT-0909) inclut systématiquement les quatre
champs `start_date`, `end_date`, `charge_jours` et `predecessor_lag`.
Le serveur honore les quatre valeurs telles quelles, sans
back-dérivation. RG-GANTT-0100 (back-dérivation de `charge_jours`
depuis `end_date - start_date`) ne s'applique plus qu'au drag manuel
du bord droit dans le diagramme, où `charge_jours` n'est pas envoyé.

**Tests :** `db/index.test.js` → « v2.2 / RG-W — PATCH avec start+end+charge tous explicites » ; `App.test.tsx` → « v2.2 / RG-W — chaque PATCH de replan inclut charge_jours ».

### RG-GANTT-1902

**(v2.2 — RG-A)** Une activité à `progress = 100` est lockée par le
Replan : ses dates ne sont jamais modifiées. Elle est ajoutée à la
timeline des collaborateurs affectés comme obstacle (intervalle
bloqué `[start_date, end_date]`) pour empêcher d'autres tâches de
s'y superposer.

**Tests :** `utils.test.ts` → « v2.2 / RG-A — progress=100 lockée par le Replan ».

### RG-GANTT-1903

**(v2.3 — RG-B redéfinie — borne basse globale du Replan)** La borne
basse de placement d'une activité par le Replan est :

```
borne_basse = MAX(
  projectStartDate,              // RG-GANTT-2100, date démarrage projet
  today,                         // si mode normal (sinon mode anticipé RG-1910)
  predecessor.end_date + lag,    // contrainte de prédécesseur
  not_before_date (SNET),        // forçage utilisateur
)
```

S'applique **uniformément à toutes les activités**, indépendamment de
`progress`. La distinction « progress > 0 » de la v2.2 est abandonnée.
Exception RG-A (`progress=100`) : tâche lockée. Exception Option γ
(`0 < progress < 100`, RG-GANTT-2103) : `start_date` figée, seule
`end_date` est recalculée.

RG-GANTT-0903 (« jamais vers le passé ») est **supprimée** : le Replan
cherche désormais la date AU PLUS TÔT compatible avec les contraintes.

**Tests :** `utils.test.ts` → « v2.3 / RG-1903 — borne basse globale (today en mode normal) » (4 cas : progress=0 passé/futur, progress=30 passé/futur).

### RG-GANTT-1904

**(v2.2 — RG-C)** Le Replan consomme `charge_jours × (1 − progress/100)`
jours-allocation (= reste à faire), arrondi au jour ouvré supérieur
(minimum 1). La charge totale persistée n'est jamais modifiée (RG-1900).

**Tests :** `utils.test.ts` → « v2.2 / RG-C — consommation du reste à faire ».

### RG-GANTT-1905

**~~SUPPRIMÉE EN v2.3~~** — RG-L devenue obsolète : avec `start_date`
calculée par le Replan (RG-GANTT-1903 redéfinie) pour les activités à
`progress = 0` et figée pour `progress > 0` (RG-GANTT-2103), il n'y a
plus de cas « saisie utilisateur erronée commençant avant la date
prévue » — la date est cohérente par construction.

### RG-GANTT-1906

**(v2.2 — RG-M — info silencieuse)** Une activité à `progress = 100`
avec `today < end_date` (« finie en avance ») ne déclenche aucune
alerte. La tâche reste lockée par RG-GANTT-1902.

**Tests :** `utils.test.ts` → « v2.2 / RG-GANTT-1906 — progress=100 + today < end_date → checkCoherence ne lève rien ».

### RG-GANTT-1907

**(v2.3 — RG-N redéfinie — édition manuelle d'une activité)**

Une activité peut être modifiée manuellement par l'utilisateur via deux
canaux : le TaskEditor (formulaire) et le drag&drop dans le diagramme
Gantt.

**Champs persistés tels quels** (jamais recalculés par le Replan) :
`name`, `progress`, `charge_jours`, `priority`, `predecessor_id`,
`predecessor_lag`, `collaborator_id(s)`, `not_before_date`,
`not_later_than_date`, `parent_id`, `color`.

**Champs `start_date` et `end_date`** : comportement dépendant du
`progress` de l'activité :

- **`progress = 0`** : modifications **éphémères**. Le prochain Replan
  recalcule `start_date` à la borne basse globale (RG-GANTT-1903) et
  `end_date = start + charge_alloc`. Pour figer une date, l'utilisateur
  pose un SNET (`not_before_date`).
- **`0 < progress < 100`** : modifications **persistantes**. `start_date`
  est figée (RG-GANTT-2103). Le Replan ne recalcule que `end_date`. Dans
  le TaskEditor, le champ `start_date` est grisé en lecture seule ; le
  drag&drop horizontal qui modifierait `start_date` est désactivé.
- **`progress = 100`** : modifications **persistantes** (RG-GANTT-1902 :
  la tâche est lockée par le Replan ; seule l'édition manuelle peut
  changer ses dates).

**Drag&drop dans le diagramme Gantt** : ne déclenche **jamais**
d'auto-replan. Seul l'enregistrement du TaskEditor déclenche
éventuellement l'auto-replan (RG-GANTT-0909, opt-out par checkbox).

**Cas particulier — passage de `progress = 0` à `progress > 0`** :
l'utilisateur peut éditer la `start_date` dans le même formulaire avant
de cliquer « Enregistrer ». Au save, cette `start_date` devient figée
dès lors que `progress > 0`.

**Tests :** `db/index.test.js` → « v2.2 / RG-N — PATCH avec progress seul : end_date et charge_jours inchangés ».

### RG-GANTT-1908

**(v2.2 — RG-O)** Lorsque l'utilisateur édite manuellement
`charge_jours` sur une activité à `progress > 0`, la valeur saisie
est interprétée comme la **charge totale révisée** (et non comme le
reste à faire). Le reste à faire dérivé devient
`nouvelle_charge × (1 − progress/100)` lors du Replan suivant.
L'utilisateur ne saisit jamais directement un « reste à faire ».

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

**Tests :** `utils.test.ts` → « v2.2 / RG-U — progress phase dérivé ».

### RG-GANTT-1910

**(v2.3 — RG-V redéfinie — Mode « Planification anticipée »)** Le toggle
« Planification anticipée » (case à cocher persistée en `localStorage`
par projet, clé `gantt:advance-planning:{project_id}`, défaut décoché)
bascule la borne basse globale (RG-GANTT-1903) :

- **Décoché (mode normal)** :
  `borne_basse = MAX(projectStartDate, today, pred.end+lag, SNET)`.
- **Coché (mode anticipé)** :
  `borne_basse = MAX(projectStartDate, pred.end+lag, SNET)`. `today` est
  exclu → le Replan accepte de planifier dans le passé (utile pour les
  simulations rétrospectives quand `projectStartDate` est dans le passé).

Le toggle pilote **toutes les sources de Replan** d'un projet : Replan
manuel ET auto-replan post-édition (RG-GANTT-0909).

RG-GANTT-1902 (RG-A, `progress=100` lockée), RG-GANTT-1904 (RG-C, reste
à faire) et RG-GANTT-2103 (Option γ, `start_date` figée si
`progress > 0`) restent appliquées dans les deux modes.

**Tests :** `utils.test.ts` → « v2.2 / RG-V — mode Planification anticipée » ; `storage.test.ts` → « advance planning toggle » ; `AdvancePlanningToggle.test.tsx`.

---

## Famille 11 — Calendrier et jours ouvrés

### RG-GANTT-1000

Les samedis et dimanches sont des jours non ouvrés et ne sont jamais
décomptés dans une charge ni dans un calcul de délai.

**Tests :** `utils.test.ts` → « détecte samedi et dimanche » ; bloc `isWeekendDay`.

### RG-GANTT-1001

Les **11 jours fériés français** (8 fixes + 3 dérivés de Pâques)
sont des jours non ouvrés. Le calcul est **algorithmique et valable
pour toute année** (2027, 2030, 2050, …) — aucune intervention
manuelle n'est nécessaire dans le futur.

**Tests :** `utils.test.ts` → bloc `isFrenchHoliday (v1.23)` (« jours fixes connus », « jours mobiles 2026 », « calcul algorithmique au-delà de 2026 »).

### RG-GANTT-1003

Une date qui tombe un week-end ou un jour férié est **automatiquement
reportée au jour ouvré suivant** dès qu'elle est utilisée comme
borne de début.

**Tests :** `utils.test.ts` → bloc `snapForwardToWorkingDay (v1.9)` (« samedi → lundi suivant », « dimanche → lundi suivant »).

### RG-GANTT-1004

Une date qui tombe un week-end ou un jour férié est **automatiquement
avancée au jour ouvré précédent** dès qu'elle est utilisée comme
borne de fin.

**Tests :** `utils.test.ts` → bloc `snapBackwardToWorkingDay (v1.9)` (« samedi → vendredi précédent », « dimanche → vendredi précédent »).

### RG-GANTT-1005

Une charge de N jours ouvrés saute les week-ends et les jours
fériés : par exemple un lundi + 5 jours ouvrés tombe sur le vendredi
de la même semaine si aucun férié n'intervient, ou sur le lundi
suivant si un jour férié est traversé.

**Tests :** `utils.test.ts` → bloc `addWorkingDays (v1.9)` (« charge=5 lundi → fin vendredi de la même semaine » ; « charge=6 lundi → fin lundi suivant ») ; bloc `addWorkingDays / workingDaysBetween (v1.23) — sautent les fériés`.

---

## Famille 12 — Hiérarchie, collaborateurs et projets

### RG-GANTT-1100

Une tâche peut être déplacée dans la hiérarchie : changement de
phase parente, changement de position parmi les frères.

**Tests :** `db/index.test.js` → bloc `moveTask` (« réordonne au sein d'un même parent », « change le parent », « change le parent et insère avant un sibling », « détache »).

### RG-GANTT-1101

Quand l'utilisateur déplace une tâche dans la hiérarchie pour en
faire l'enfant d'une autre, il ne peut pas la déposer à l'intérieur
de l'une de ses propres sous-tâches — sinon le système refuse pour
empêcher la création d'une boucle (A contiendrait B qui contiendrait
A).

**Tests :** `db/index.test.js` → « refuse de devenir son propre parent » ; « refuse de se déplacer dans un de ses propres descendants (cycle) ».

### RG-GANTT-1102

Un collaborateur est caractérisé par un nom, une couleur de
pastille, et un **ordre d'affichage** dans la liste (1er, 2e, etc.).

**Tests :** `db/index.test.js` → « insère et incrémente la version » ; « positions auto-incrémentées ».

### RG-GANTT-1103

Supprimer un collaborateur **détache** ses activités (le
collaborateur de chacune passe à « aucun ») sans supprimer les
activités elles-mêmes.

**Tests :** `db/index.test.js` → « supprime + détache les tâches (SET NULL) ».

### RG-GANTT-1104

Un projet regroupe des phases, jalons et activités. Plusieurs
projets peuvent coexister dans la base, mais un seul est chargé à la
fois dans le diagramme.

**Tests :** `server/app.test.js` → « POST /api/projects crée un projet, GET /api/state?project_id=… le charge vide » ; `App.test.tsx` → « peuple le sélecteur de projet à partir de l'API » ; « changer de projet provoque un GET /api/state?project_id=… ».

### RG-GANTT-1105

Supprimer un projet supprime également toutes les tâches qu'il
contient (cascade).

**Tests :** `server/app.test.js` → « DELETE /api/projects/:id supprime le projet et ses tâches (cascade) ».

### RG-GANTT-1106

**(v1.24)** L'utilisateur peut supprimer **tous les projets** d'une
base, y compris le dernier. Dans ce cas, le diagramme apparaît vide
et l'utilisateur peut créer un nouveau projet à tout moment.

**Tests :** `server/app.test.js` → « v1.24 / RG-GANTT-1106 — DELETE /api/projects/:id autorise la suppression du dernier projet » ; `App.test.tsx` → « v1.24 / RG-GANTT-1106 — suppression : dernier projet → bouton actif (base vide après) ».

### RG-GANTT-1107

Les collaborateurs sont **partagés** entre tous les projets : ils
restent disponibles quel que soit le projet chargé.

**Tests :** `server/app.test.js` → « v1.24 / RG-GANTT-1107 — les collaborateurs sont partagés entre projets ».

---

## Évolutions futures notées (hors v1.24)

Ces évolutions ont été identifiées pendant la spécification de la v1.24
mais reportées à une version ultérieure :

- **Prédécesseurs multiples** : permettre qu'une tâche dépende de
  plusieurs prédécesseurs simultanément (aujourd'hui : un seul).
- **Taux d'affectation** : permettre de saisir un pourcentage de
  charge par activité (ex. 50 % sur la tâche X, 50 % sur Y) au lieu
  du 100 % implicite actuel.
- **Contrainte « Ne doit pas finir après le »** (FNLT — Finish No Later
  Than) : symétrique de la contrainte de démarrage au plus tôt, mais
  côté date de fin.

---

## Famille 12bis — Memberships projet ↔ collaborateur (v2.0 / F1)

### RG-GANTT-1200

L'affectation d'un collaborateur à une activité ne peut se faire que si
celui-ci est **membre** du projet de l'activité. Côté **UI**, la dropdown
de sélection du collaborateur dans le formulaire de tâche est filtrée
aux seuls membres du projet courant. Côté **DAL**, si une affectation
arrive via API directe avec un collab non-membre, la membership est
créée automatiquement (auto-heal) — la cohérence du modèle est ainsi
préservée même hors UI.

**Tests :** `db/index.test.js` → « v2.0 / RG-GANTT-1200 — createTask avec collab non-membre auto-ajoute la membership ».

### RG-GANTT-1201

Un collaborateur peut être ajouté à un projet via `addProjectMember`.
L'opération est **idempotente** : un second appel sur la même paire ne
crée pas de doublon et n'incrémente pas la version. Le projet et le
collaborateur doivent exister, sinon erreur typée
(`PROJECT_NOT_FOUND` / `COLLABORATOR_NOT_FOUND`).

**Tests :** `db/index.test.js` → « addProjectMember : idempotent + bump version » ; « addProjectMember rejette un projet inconnu » ; « addProjectMember rejette un collab inconnu ».

### RG-GANTT-1202

À la **migration v2.0**, pour chaque couple (projet, collaborateur)
distinct présent dans la table `tasks` d'une base v1.x, une membership
est automatiquement créée. Stratégie « option α » : aucune affectation
existante n'est cassée au premier boot v2.0.

**Tests :** `db/index.test.js` → « migration : auto-pop des memberships depuis les tâches ».

### RG-GANTT-1203

`GET /api/state` expose la liste `current_project_members` : ids des
collaborateurs membres du projet courant. Cette liste alimente la
dropdown filtrée du `TaskEditor` (cf. RG-GANTT-1200) et l'onglet
« Affectation projet ».

**Tests :** `db/index.test.js` → « getFullState expose current_project_members » ;
`server/app.test.js` → « v2.0 / F1 — GET /api/state.current_project_members ».

### RG-GANTT-1204

La suppression d'un projet retire en cascade toutes ses memberships
(FK `ON DELETE CASCADE` sur `project_members.project_id`).

**Tests :** `db/index.test.js` → « suppression projet : cascade sur les memberships ».

### RG-GANTT-1205

La suppression d'un collaborateur retire en cascade toutes ses
memberships, quel que soit le nombre de projets concernés.

**Tests :** `db/index.test.js` → « suppression collab : cascade sur les memberships ».

---

## Famille 13 — Allocations % (v2.0 / F2)

Périodes de capacité d'un membre sur un projet. Chaque période = un %
(parmi 25/50/75/100) sur un intervalle de dates. Le moteur consomme cette
capacité jour par jour pour calculer la date de fin d'une activité.

### RG-GANTT-1300

L'ajout d'une période d'allocation impose que le collaborateur soit
**déjà membre** du projet. Sinon, l'opération est refusée (`NOT_PROJECT_MEMBER`).
Pour les routes API `POST /api/projects/:id/members/.../allocations`, le
serveur renvoie 400.

**Tests :** `db/index.test.js` → « addMemberAllocation : ajoute une période propre » ; « non membre rejeté ».

### RG-GANTT-1301

Pour un même couple `(projet, collaborateur)`, deux périodes ne peuvent
**pas se chevaucher**, même partiellement. Le DAL rejette toute
insertion qui violerait cet invariant (`ALLOCATION_OVERLAP`). Des
périodes contiguës (par exemple `01-15` puis `16-30`) sont autorisées.

**Tests :** `db/index.test.js` → « chevauchement rejeté » ; « périodes contiguës sans chevauchement OK ».

### RG-GANTT-1302

Le pourcentage d'allocation est restreint à `{25, 50, 75, 100}`. Toute
autre valeur est rejetée par Zod côté API et par le DAL côté serveur
(`INVALID_ALLOCATION_PCT`).

**Tests :** `db/index.test.js` → « % invalide rejeté ».

### RG-GANTT-1303

Une période est supprimable par son `id` via le DAL et l'API
`DELETE /api/allocations/:id`. La suppression est traçable (changement
de version).

**Tests :** `db/index.test.js` → « deleteMemberAllocation : retire par id ».

### RG-GANTT-1304

La suppression d'un membership (collab ou projet) supprime toutes les
allocations correspondantes en cascade (`ON DELETE CASCADE`).

**Tests :** `db/index.test.js` → « suppression collab : cascade sur allocations ».

### RG-GANTT-1305

Au boot v2.0, pour chaque membership qui n'a aucune allocation existante,
une période 100 % est auto-créée :

- couvrant `[MIN(task.start_date), MAX(task.end_date)]` des tâches existantes
  du couple (projet, collab),
- à défaut, sur une plage par défaut très large.

De même, `addProjectMember` insère automatiquement une allocation 100 %
par défaut (`2020-01-01 → 2099-12-31`) pour éviter qu'un nouveau membre
n'ait 0 % de capacité.

**Tests :** `db/index.test.js` → « migration auto-pop : allocation 100 % par défaut ».

### RG-GANTT-1310

La date de fin d'une activité affectée à un collaborateur est calculée
en consommant l'**allocation quotidienne** du collab sur le projet :
chaque jour ouvré couvert par une période contribue `pct/100` à la
charge totale. La fin est le **dernier jour ayant contribué**.

Exemple : charge de 5 jours @ 50 % depuis lundi 08/06/2026 → fin
vendredi 19/06/2026 (10 jours ouvrés effectifs, 0,5 j-personne consommé
chacun, total 5,0).

**Tests :** `utils.test.ts` → « alloc 100 % sur toute la période : fin identique à F0 » ; « alloc 50 % : charge 5 j → 10 jours ouvrés » ; `db/index.test.js` → « charge 5j @ 50 % → 10 jours ouvrés ».

### RG-GANTT-1311

Une activité **sans collaborateur affecté** est calculée comme en F0 (1
j-personne par jour ouvré). L'allocation n'est consommée que lorsqu'un
collab est explicitement affecté.

**Tests :** `utils.test.ts` → « ctx sans collab : fallback F0 » ; `db/index.test.js` → « tâche sans collab : end = addWorkingDays (F0) ».

### RG-GANTT-1312

Auto-heal côté DAL : créer une tâche affectée à un collab non encore
membre du projet crée automatiquement (1) la membership et (2) une
allocation 100 % par défaut. La contrainte « doit être membre » reste
portée par l'UI (filtrage strict de la dropdown du TaskEditor).

**Tests :** `db/index.test.js` → « auto-heal : membership + allocation 100 % ».

### RG-GANTT-1313

`GET /api/state` expose la liste `member_allocations` (toutes les périodes
du projet courant, toutes paires confondues). Consommée côté client par :
le moteur de calcul de fin (`computeEndFromCharge`), le plan de charge
pondéré (`computeWorkload`), le replan (`replanTasks`), et l'UI
« Affectation projet ».

**Tests :** `db/index.test.js` → « getFullState : member_allocations exposé ».

## Famille 14 — Absences / Congés (v2.0 / F3)

Les absences sont saisies au niveau du collaborateur (cross-projet) :
une absence posée sur Léa s'applique à tous ses projets simultanément.
Elles réduisent **multiplicativement** la capacité quotidienne (Q8b) :
`capacité_réelle = allocation_pct × (1 − fraction_absence)`.

### RG-GANTT-1400

Une absence est portée par un collaborateur, à une date donnée, avec
une fraction non-travaillée appartenant à `{0.25, 0.5, 0.75, 1}`. Toute
autre valeur est rejetée (`INVALID_ABSENCE_FRACTION`). Le collaborateur
doit exister, sinon `COLLABORATOR_NOT_FOUND`.

**Tests :** `db/index.test.js` → « addAbsence : ajoute une absence » ;
« fraction invalide rejetée » ; « collab inconnu rejeté ».

### RG-GANTT-1401

Une absence est **cross-projet** : elle réduit la capacité du
collaborateur sur tous ses projets simultanément. C'est le même
mécanisme `getDailyAllocation` qui consomme l'absence pour tous les
projets impactés.

**Tests :** `db/index.test.js` → « absence cross-projet : impacte tous les projets ».

### RG-GANTT-1402

La lecture est **multiplicative** : la capacité effective du jour est
`(allocation_pct / 100) × (1 − fraction_absence)`. Exemples :

- Paul à 100 % + congé 1 j → capacité 0 (jour intégralement consommé
  par le congé, la tâche stagne).
- Paul à 50 % + congé 0,5 j → capacité 0,5 × 0,5 = **0,25**.
- Paul à 100 % + congé 0,25 j → capacité 0,75.

**Tests :** `utils.test.ts` → « congé 1 j décale d'un jour la fin (alloc 100 %) » ;
« alloc 50 % + congé 0,5 j = 25 % effectif » ; « absence d'un autre collab :
aucun effet » ; `db/index.test.js` → « absence 1 j décale la fin (alloc 100 %) » ;
« alloc 50 % + congé 0,5 j : capacité 25 % le jour concerné ».

### RG-GANTT-1403

Une seule absence par couple `(collaborateur, date)` : la table porte
une PRIMARY KEY composite. Un POST `/api/collaborators/:id/absences`
avec une date déjà occupée **remplace** la fraction (sémantique UPSERT,
plus pratique côté UI qu'un workflow delete + add).

**Tests :** `db/index.test.js` → « UPSERT : 2e saisie sur même date remplace la fraction ».

### RG-GANTT-1404

Une absence est supprimable par son couple `(collab, date)` via
`DELETE /api/collaborators/:id/absences/:date`. 404 si la ligne
n'existe pas.

**Tests :** `db/index.test.js` → « deleteAbsence : retire la ligne ».

### RG-GANTT-1405

La suppression d'un collaborateur efface en cascade toutes ses absences
(FK `ON DELETE CASCADE`).

**Tests :** `db/index.test.js` → « cascade suppression collab → absences effacées ».

### RG-GANTT-1406

`GET /api/state` expose `collaborator_absences` : la liste de toutes
les absences connues (toutes paires `(collab, date)` confondues, peu
importe le projet courant). Consommée côté client par le moteur de
calcul de fin, le plan de charge pondéré, le replan, et l'onglet
« Congés ».

**Tests :** `db/index.test.js` → « getFullState expose collaborator_absences ».

---

## Famille 15 — FNLT « Fin au plus tard » (v2.0 / F4)

Le FNLT est une **deadline non bloquante** posée par l'utilisateur sur
une activité ou un jalon. Sœur jumelle du SNET (qui contraint la borne
basse), mais sur la borne haute — avec une grande différence : aucun
enforcement sur les dates. Si la fin calculée dépasse le FNLT, c'est
seulement signalé visuellement (bandeau de cohérence + icône rouge en
bout de barre).

### RG-GANTT-1500

Une activité ou un jalon peut avoir un FNLT (« Fin au plus tard »)
facultatif au format ISO `YYYY-MM-DD`. La saisie est persistée telle
quelle (aucun snap automatique). `null` par défaut = pas de deadline.

**Tests :** `db/index.test.js` → « FNLT facultatif : null par défaut » ;
« FNLT saisi : persistance brute ».

### RG-GANTT-1501

Le FNLT est modifiable via PATCH (cohérent avec SNET et les autres
contraintes). Envoyer `null` retire la deadline.

**Tests :** `db/index.test.js` → « PATCH met à jour la FNLT ».

### RG-GANTT-1502

Le FNLT est **non bloquant** : la sauvegarde est acceptée même si la
date de fin calculée dépasse la deadline. C'est `checkCoherence` qui
remonte l'incohérence avec `severity: 'warning'`.

**Tests :** `db/index.test.js` → « FNLT non bloquante : sauvegarde acceptée
même si dépassée » ; `utils.test.ts` → « activité dépassant sa FNLT → warning ».

### RG-GANTT-1503

Une phase n'a jamais de FNLT (ses dates dérivent des enfants ; imposer
une deadline ne ferait qu'engendrer un faux signal). Toute valeur
saisie est ramenée à `null` par le DAL, et la migration au boot nettoie
les valeurs résiduelles éventuelles.

**Tests :** `db/index.test.js` → « phase : FNLT forcée à NULL même si fournie ».

### RG-GANTT-1504

Un format non-ISO ou invalide est silencieusement ignoré (ramené à
`null`) côté DAL, en plus de la validation Zod côté API. Filet de
sécurité pour les appels API hors UI.

**Tests :** `db/index.test.js` → « format invalide ignoré, ramené à NULL ».

### RG-GANTT-1505

`GET /api/state` expose `not_later_than_date` pour chaque tâche.
Consommé côté client par `TaskEditor` (champ saisie), `checkCoherence`
(détection `fnlt_overrun`), et `GanttChart` (marker triangle gris ou
rouge selon le dépassement).

**Tests :** `db/index.test.js` → « getFullState expose not_later_than_date ».

### RG-GANTT-1510

`checkCoherence` détecte les dépassements FNLT et remonte une issue de
type `fnlt_overrun` avec `severity: 'warning'`. La règle s'applique aux
activités et aux jalons (jamais aux phases). Fin **égale** à la FNLT =
pas d'alerte (la deadline est tenue pile-poil).

**Tests :** `utils.test.ts` → « activité dépassant sa FNLT → warning » ;
« fin = FNLT exacte → pas d'alerte » ; « sans FNLT, aucune alerte » ;
« jalon dépassant sa FNLT → warning » ; « phase : pas d'alerte FNLT ».

---

## Famille 16 — Plan de charge global (v2.0 / F5)

Le plan de charge agrège la **charge réelle** d'un collaborateur sur ses
tâches et la rapporte à sa **capacité totale** (Σ allocations tous projets
× présence). Deux périmètres possibles :

• **Projet courant** : workload affiché = tâches du projet courant
uniquement, mais seuils colorés contre la capacité totale.
• **Vue globale** : workload agrégé sur TOUTES les tâches de TOUS les
projets, seuils contre la même capacité totale.

### RG-GANTT-1600

La capacité quotidienne d'un collaborateur sur un projet vaut
`allocation_pct(p, c, d) / 100`. La capacité totale du jour est la somme
sur tous les projets. Hors jour ouvré (week-end / férié), la capacité
est 0. Hors période d'allocation, la contribution du projet est 0.

**Tests :** `utils.test.ts` → « sans allocation : capacité 0 » ;
« 50 % sur 1 projet → 0,5 » ; « week-end : capacité 0 ».

### RG-GANTT-1601

Σ allocations cross-projet : un collaborateur affecté à 50 % sur le
projet A et 50 % sur le projet B a une **capacité totale de 1,0** le
jour considéré. C'est cette somme qui sert de seuil de coloration au
plan de charge (et non un plafond fixe de 1).

**Tests :** `utils.test.ts` → « 50 % A + 50 % B → 1 ».

### RG-GANTT-1602

Les absences pondèrent la capacité totale **multiplicativement** :
`capacité = (Σ pct) × (1 − fraction_absence)`. Un collaborateur à 100 %
qui pose une demi-journée d'absence a une capacité de 0,5 ce jour-là ;
un congé complet annule la capacité à 0 quel que soit le total des
allocations.

**Tests :** `utils.test.ts` → « alloc 100 % + congé 0,5 j → 0,5 » ;
« congé 1 j → 0 même si 100 % alloué ».

### RG-GANTT-1610

Le plan de charge **colore** les cellules selon le ratio
`workload / capacité_totale` :

• `> 1` → rouge (SURCHARGE)
• `= 1` → vert (journée pleine)
• `[0,75 ; 1[` → bleu marqué
• `[0,5 ; 0,75[` → bleu moyen
• `]0 ; 0,5[` → bleu pâle (sous-charge)
• `0` → cellule neutre (ou jaune pâle si highlightUnderload)

Cas concret (Q3 validé avec utilisateur) : Léa à 50 % sur projet A
uniquement, charge 0,5 sur ce projet → ratio 1 → cellule verte (et non
bleue comme avant F5).

**Tests :** `utils.test.ts` → « workload = capacité 0,5 → vert » ;
« workload 0,25 sur capacité 0,5 → bleu moyen » ; « workload 0,75 sur
capacité 0,5 → rouge » ; « workload 0 + highlightUnderload → jaune pâle ».

### RG-GANTT-1611

Si la capacité totale est 0 mais qu'une charge a été planifiée
(anomalie : tâche assignée alors que le collab n'a aucune allocation),
la cellule passe en rouge même sans dépassement relatif — c'est le
signal que la donnée elle-même est incohérente.

**Tests :** `utils.test.ts` → « capacité 0 mais workload > 0 → rouge
(anomalie) ».

### RG-GANTT-1620

`GET /api/state` expose `all_member_allocations` : la liste complète
des allocations cross-projet. Consommée côté client par le plan de
charge pour calculer la capacité totale (même en vue « projet courant »).

**Tests :** `server/app.test.js` → « GET /api/state expose all_member_allocations ».

### RG-GANTT-1621

`GET /api/workload/global` renvoie `{ tasks }` cross-projet (kind=task,
collaborator non-null) pour alimenter la vue globale du plan de charge.
Route fetchée à la demande au passage en mode global.

**Tests :** `server/app.test.js` → « GET retourne les activités cross-projet ».

---

## Famille 17 — Multi-collaborateurs (v2.0 / F6)

L'étape 2 du plan v2.0 : une activité peut être affectée à N
collaborateurs simultanément. La **capacité quotidienne** est la
**somme** des contributions de chaque collab affecté (Q12a : additif
uniforme). Chacun voit sa propre part dans son plan de charge.

### RG-GANTT-1700

Une activité peut avoir 0..N collaborateurs affectés via le tableau
`collaborator_ids[]` (POST/PATCH). Le champ legacy `collaborator_id`
reste alimenté avec le 1er affecté (ordre alpha) en lecture pour ne
pas casser les clients qui le lisent encore.

**Tests :** `db/index.test.js` → « createTask avec collaborator_ids[] :
N collabs persistés ».

### RG-GANTT-1701

Rétro-compat : `collaborator_id` (legacy mono-collab) crée toujours
exactement une entrée dans `task_assignments`. Les bases / clients
d'avant F6 continuent de fonctionner sans modification.

**Tests :** `db/index.test.js` → « createTask avec collaborator_id legacy ».

### RG-GANTT-1702

**Additif uniforme** : la capacité du jour est la somme des
contributions individuelles (pct × (1−absence) par collab). Exemples :

- 2 collabs à 100 % chacun → capacité 2/jour → une charge de 4 j
  se fait en 2 j.
- 1 collab 100 % + 1 collab 50 % → capacité 1,5/jour → 3 j en 2 j.

**Tests :** `db/index.test.js` → « 2 collabs 100 % font une charge 4 j en 2 j » ;
« 100 % + 50 % → capacité 1,5/jour ».

### RG-GANTT-1703

`updateTask` remplace atomiquement la liste de collaborateurs depuis
`patch.collaborator_ids[]`. Un tableau vide = retire toutes les
affectations (cohérent avec `collaborator_id: null` legacy).

**Tests :** `db/index.test.js` → « updateTask : remplace atomiquement la liste ».

### RG-GANTT-1704

La suppression d'une tâche retire en cascade toutes ses affectations
(`task_assignments.task_id ON DELETE CASCADE`).

**Tests :** `db/index.test.js` → « cascade suppression tâche : assignments effacés ».

### RG-GANTT-1705

La suppression d'un collaborateur le retire automatiquement de toutes
les tâches auxquelles il était affecté (`task_assignments.collaborator_id
ON DELETE CASCADE`). Les tâches restantes conservent leurs autres
collaborateurs.

**Tests :** `db/index.test.js` → « cascade suppression collab : retiré des tâches ».

### RG-GANTT-1706

Migration auto-pop v2.0/F6 : pour chaque activité existante avec
`tasks.collaborator_id` non-null, une ligne `(task_id, collaborator_id)`
est créée dans `task_assignments` au premier boot v2.0/F6. Les
affectations existantes sont ainsi préservées sans intervention.

**Tests :** `db/index.test.js` → « migration auto-pop depuis tasks.collaborator_id ».

### RG-GANTT-1707

Le plan de charge en **mode global** (cross-projet) doit refléter la même
charge multi-collaborateur que le mode projet. L'endpoint
`/api/workload/global` expose donc, pour chaque activité, la liste complète
`collaborators[]` lue depuis `task_assignments` (et plus seulement le champ
legacy `tasks.collaborator_id`). Sans cela, une tâche affectée à plusieurs
collaborateurs ne peignait sa charge que sur le 1er d'entre eux en vue
globale, alors qu'elle apparaissait correctement répartie en vue projet
(qui lit `/api/state`, lequel joint déjà `task_assignments`). Une tâche
sans aucun collaborateur affecté (ni legacy ni multi-collab) est exclue du
résultat (elle ne contribue à aucune ligne du plan de charge). _(v2.3,
2026-05-28.)_

**Tests :** `server/app.test.js` → « expose la liste multi-collab (collaborators[]) ».

---

## Famille 19 — Allocation absorbante (v2.1 / F2.9)

Verrouille la sauvegarde d'une activité et le replan global du projet quand
la **capacité cumulée** des collaborateurs affectés ne suffit pas à absorber
la charge demandée. L'utilisateur a le choix : étendre l'allocation
limitante via le dialog dédié, ou aller ajuster manuellement les
affectations dans l'onglet « Affectation ».

> _Note de numérotation_ : cette famille a été renumérotée de 1900-1907 vers
> **1950-1957** (2026-05-26) pour libérer la plage 1900-1910 qui appartient
> à la Famille 10 (Replanification v2.2/v2.3).

### RG-GANTT-1950

Pour une activité (kind=task) avec une charge `> 0` et au moins un
collaborateur affecté, on calcule un **shortfall** `missing` =
`charge − absorbed`, où `absorbed` est la capacité cumulée (somme additive
des `pct × (1 − absence)` de tous les collabs affectés) sur les jours
ouvrés entre `start_date` et `max(end_date)` des allocations existantes.
Si `missing > 0` (au-delà d'une tolérance numérique de 1e-9), la
sauvegarde de l'activité est bloquée et un dialog s'ouvre.

**Tests :** `src/lib/utils.test.ts` → bloc `computeAllocationShortfall
(v2.1 / F2.9 / RG-GANTT-1950 / RG-GANTT-1951 / RG-GANTT-1952)` (7 cas :
aucun collab, aucune alloc, 100 % suffisant, 2 collabs Q1, trou Q2,
démarre après fin alloc, 50 % insuffisant).

### RG-GANTT-1951

La **capacité cumulée** est calculée comme dans `computeEndFromCharge`
(invariant déjà testé v2.0/F6) — additive sur tous les collabs affectés à
la tâche. Une tâche affectée à 2 collabs dont l'un finit son allocation
plus tôt peut quand même être absorbée si l'autre couvre la durée
restante (Q1=A : pas d'alerte tant que le total absorbe).

**Tests :** `src/lib/utils.test.ts` → « RG-GANTT-1951 — Q1 — 2 collabs
Alice 1j + Bob 9j → missing = 0 ».

### RG-GANTT-1952

Un **trou d'allocation** au milieu n'est pas en soi un blocage : si la
charge peut s'absorber sur les jours dispos avant + après le trou, la
sauvegarde passe (Q2 — pas d'alerte tant que le total absorbe).

**Tests :** `src/lib/utils.test.ts` → « RG-GANTT-1952 — Q2 — trou
d'allocation au milieu : charge absorbée sur les jours dispos ».

### RG-GANTT-1953

Le dialog `AllocationFixDialog` propose, pour un taux d'extension choisi
parmi {25, 50, 75, 100}, une **date d'extension auto-calculée** qui est
la première date où la capacité cumulée étendue absorberait le manque.
La date est **éditable** par l'utilisateur (Q3=C), mais bornée par un
`min` égal à la date proposée (interdit de saisir plus tôt — incohérent
avec la simulation).

**Tests :** `src/lib/utils.test.ts` → bloc `computeExtensionPlan
(v2.1 / F2.9.B / RG-GANTT-1953 / RG-GANTT-1954)` → « 1 collab, manque
3j à 100 % → PATCH end_date ».

### RG-GANTT-1954

Q5=C — Quand on étend l'allocation d'un collab :

- si la **dernière allocation existante** du couple (projet, collab) a déjà
  le `pct` cible, on **PATCH** son `end_date` (fusion par prolongation) ;
- sinon, on **CREATE** une nouvelle allocation `[lendemain_de_l_existante,
targetEndDate]` au `pct` cible (préserve l'historique d'allocations à
  d'autres taux).

**Tests :** `src/lib/utils.test.ts` → « RG-GANTT-1954 — Q5=C — changement
de % → CREATE nouvelle allocation » ; « RG-GANTT-1954 — 1 collab,
allocation 100 % existante → PATCH end_date ».

### RG-GANTT-1955

Q6 — Après l'extension d'allocation, le `end_date` de la tâche est
**recalculé automatiquement** par `computeEndFromCharge` au moment où le
`onSave` est rejoué (la charge reste source de vérité). Si l'utilisateur
préfère figer la fin, il décoche « Replanifier après enregistrement » dans
le TaskEditor (pattern v1.22 existant).

**Tests :** `src/lib/utils.test.ts` → bloc `computeEndFromCharge
(v2.0 / v2.1 / RG-GANTT-1955)` ; intégration end-to-end pas testée
(manipulation UI).

### RG-GANTT-1956

Le `Replan` global est bloqué dès qu'**au moins une activité** du projet
courant a un `missing > 0`. Le `ReplanAllocationFixDialog` propose un
récapitulatif Q4=B : une ligne par tâche en problème, cochée par défaut,
avec date + % éditables. Les actions globales « Tout cocher / Tout
décocher » basculent toutes les cases. « Étendre et replanifier » exécute
en série les extensions cochées, puis relance automatiquement le replan
une fois le state rafraîchi.

**Tests :** `src/lib/utils.test.ts` → bloc `scanReplanShortfalls
(v2.1 / F2.9.C / RG-GANTT-1956)` (6 tests : phases ignorées, sans collab
ignoré, sans charge ignoré, absorbable exclu, non absorbable inclus, mix).

### RG-GANTT-1957

Endpoint `PATCH /api/allocations/:id` (v2.1 / F2.9) : met à jour une
période d'allocation existante (partiel — tout champ omis reste
inchangé). Validations dupliquées côté DAL : pct ∈ {25, 50, 75, 100},
`start_date ≤ end_date`, pas de chevauchement avec une autre période du
même (projet, collab) — l'id courant est exclu du check d'overlap.
404 si l'id n'existe pas, 400 sinon avec un `code` applicatif.

**Tests :** `db/index.test.js` → 4 tests `updateMemberAllocation`
(RG-GANTT-1957) ; `server/app.test.js` → bloc `v2.1 / RG-GANTT-1957 —
PATCH /api/allocations/:id` (4 tests d'intégration HTTP 200/404/400/400).

---

## Famille 20 — Grilles éditables Affectation & Congés (v2.1 / F4 + F5)

Refonte des onglets « Affectation » et « Congés » en grilles calendaires
calquées sur le Plan de charge. Édition directe à la souris (clic =
cycle palier, drag-paint horizontal) pour éviter les formulaires
répétitifs.

### RG-GANTT-2000

**Grille Affectation** (`MembersGrid`) — chaque cellule représente le pct
d'allocation d'un collaborateur membre du projet pour un jour donné.
Le clic gauche cycle au palier suivant dans
`vide → 25 → 50 → 75 → 100 → vide`. Un seul commit serveur par clic.

**Tests :** non couvert par tests automatisés (interaction UI souris) —
vérifié visuellement.

### RG-GANTT-2001

**Drag-paint horizontal** (commun F4/F5 via le hook `useDragPaint`) :
mousedown sur une cellule capture la ligne et la valeur du pinceau
(= valeur cible après cycle). Mousemove peint toutes les cellules
survolées de la **même ligne** avec cette valeur (verrouillage horizontal,
Q3). Mouseup commit en batch via le callback parent. Écrasement
silencieux Q2 : les valeurs existantes différentes sont remplacées sans
confirmation.

**Tests :** non couvert par tests automatisés (drag souris) — vérifié
visuellement. Le hook est typé `<V>` générique pour mutualiser F4 et F5.

### RG-GANTT-2002

**Compactage Affectation** (`rebuildAllocationsForCollab`) — après
modification jour-par-jour via la grille, on **rebuild from scratch** les
allocations du couple (projet, collab) en :

1. supprimant toutes les anciennes (toDelete = ids existants) ;
2. créant des **runs contigus de même pct** (jours calendaires).

Évite la complexité de PATCH partiel sur des périodes existantes
fragmentées. Les jours à `pct = 0` sont des trous (= jours libres).

**Tests :** `src/lib/utils.test.ts` → 6 tests `rebuildAllocationsForCollab`
(vide, 1 jour isolé, compaction, split milieu, retrait milieu, ignore
autres collabs/projets).

### RG-GANTT-2003

**Grille Congés** (`AbsencesGrid`) — chaque cellule représente la fraction
d'absence d'un collaborateur pour un jour donné. Le clic cycle dans
`vide → 0,25 → 0,5 → 0,75 → 1 → vide`. Cross-projet : la grille montre
tous les collabs connus, pas seulement les membres du projet courant
(cohérent avec RG-GANTT-1401).

**Tests :** non couvert par tests automatisés (interaction UI) — vérifié
visuellement.

### RG-GANTT-2004

**Commit Congés** : 1 jour = 1 ligne en base (PRIMARY KEY composite
`(collab, date)` — RG-GANTT-1403). Pas de compactage nécessaire :
chaque cellule génère soit un POST (UPSERT serveur, fraction > 0) soit
un DELETE (fraction = 0). 404 silencieux sur DELETE = la cellule était
déjà vide (cas drag passant sur des jours libres).

**Tests :** route POST/DELETE absences couverte par les tests v2.0/F3
existants (RG-GANTT-1403, 1405, 1406). Intégration grille-spécifique
non couverte (manipulation UI).

### RG-GANTT-2005

**Bouton « + Période »** conservé sur les deux grilles : ouvre un
mini-formulaire inline (date début, date fin, % ou fraction) pour saisir
une plage entière en une fois. Côté Affectation, 1 POST allocation. Côté
Congés, 1 POST par jour ouvré de la plage (les week-ends sont skippés).

**Tests :** routes existantes (RG-GANTT-1300, RG-GANTT-1403). Intégration
mini-form non couverte (manipulation UI).

### RG-GANTT-2006

**Drag oblique** (vertical) **désactivé** sur les deux grilles : le hook
`useDragPaint` mémorise la ligne de départ au mousedown et ignore les
cellules d'autres lignes pendant le drag. Évite les peintures
involontaires sur des collabs voisins.

**Tests :** propriété du hook `useDragPaint` ; vérifié par revue de code,
pas par test automatisé (souris).

---

## Famille 21 — Refonte Replan v2.3 (date démarrage projet + dates au plus tôt)

Refonte du modèle de planification autour d'une idée centrale : la
`start_date` d'une activité est CALCULÉE par le Replan (au plus tôt
possible compte tenu des contraintes), elle n'est plus une donnée saisie.
Un nouveau concept central, la **date de démarrage du projet**
(`project_start_date`), sert de borne basse globale par défaut.

Cf. [docs/superpowers/specs/2026-05-25-refonte-replan-projet.md](./superpowers/specs/2026-05-25-refonte-replan-projet.md).

### RG-GANTT-2100

**(v2.3 — date démarrage projet)** Chaque projet a une date de démarrage
persistée (colonne `projects.project_start_date`, NOT NULL). Sert de
borne basse globale par défaut dans le Replan. Peut être dans le passé
ou dans le futur, sans restriction. Saisie à la création (défaut `today`)
et modifiable ultérieurement via la modal Paramètres (RG-GANTT-2101).

**Tests :** `db/index.test.js` → 2 tests `initDb` (colonne NOT NULL + migration ancienne base) ; `server/app.test.js` → « POST accepte project_start_date » + « POST sans → défaut today » + « PATCH modifie project_start_date ».

### RG-GANTT-2101

**(v2.3 — modal Paramètres du projet)** Une modal « Paramètres du projet »
accessible via le bouton crayon ✏️ déjà présent dans la barre du sélecteur
de projet (à côté des boutons ➕ créer et 🗑️ supprimer) regroupe les
réglages éditables du projet :

- **Nom du projet** (champ texte ; remplace l'ancien `askPrompt`).
- **Date de démarrage** (`project_start_date`, date picker).

Le toggle « Planification anticipée » (RG-GANTT-1910) reste à son
emplacement actuel (à côté du bouton Replan), non déplacé dans la modal.

À l'enregistrement, si la date a changé, une case à cocher
« Replanifier immédiatement après l'enregistrement » (cochée par défaut)
permet de déclencher un Replan dans la foulée (même pattern opt-out que
RG-GANTT-0909).

À la création d'un nouveau projet (bouton ➕), un dialog équivalent
demande **nom + date de démarrage** (défaut : `today`).

**Tests :** `ProjectSettingsModal.test.tsx` (7 cas dont validation RG-2110) ; `CreateProjectDialog.test.tsx` (5 cas) ; `App.test.tsx` → 4 tests d'intégration (création, annulation, édition, désactivation Enregistrer sans modif).

### RG-GANTT-2103

**(v2.3 — Option γ : `start_date` figée si `progress > 0`)** Une activité
en cours (`0 < progress < 100`) conserve sa `start_date` historique : le
Replan ne la recalcule jamais, il ne touche qu'à `end_date`.

`end_date` est calculée comme la consommation du reste à faire
(`charge_jours × (1 − progress/100)`, RG-GANTT-1904) sur les créneaux
libres du collaborateur à partir de `MAX(today, start_date)`.

Pour les activités jamais démarrées (`progress = 0`), `start_date` est
recalculée à la borne basse globale (RG-GANTT-1903). Pour les activités
terminées (`progress = 100`), tout est figé (RG-GANTT-1902).

**Tests :** `utils.test.ts` → bloc `v2.3 / RG-1903` (4 cas couvrant progress=0/30 × passé/futur).

### RG-GANTT-2104

**(v2.3 — Plan de charge utilise la timeline du moteur)** Le Plan de
charge (`computeWorkload`) peut consommer en entrée la **timeline
effective produite par le moteur Replan** (cf. `computeReplanResult`)
au lieu de lire naïvement les plages `[start_date, end_date]`.

API : la fonction `computeReplanResult` retourne `{ moves, timeline }`
où `timeline: Map<collabId, TimelineEntry[]>` recense les intervalles
`[start, end]` effectivement consommés par chaque collaborateur. Cette
map est passée en paramètre optionnel `engineTimeline` à
`computeWorkload` qui peint alors la charge uniquement sur ces
intervalles (plus de fausse surcharge par chevauchement visuel de
plages).

L'opt-in se fait côté UI (App.tsx + WorkloadChart) en mémoïsant un
appel `computeReplanResult(...)` à chaque rendu et en passant la
`timeline` au composant. Cf. § 4 de la spec (« replan à la volée »).

**Tests :** `utils.test.ts` → tests existants `computeWorkload` (rétrocompat sans `engineTimeline`).

**Câblage UI livré (2026-05-26)** : `App.tsx` mémoïse un appel
`computeReplanResult(...)` à chaque rendu et passe la `timeline` en prop
`engineTimeline` à `<WorkloadChart>` (uniquement en `scope='current'`,
le scope `'global'` reste en lecture par plage car la timeline n'est
calculée que pour le projet courant). Coût : ~5-15 ms par rendu mémoïsé.

### RG-GANTT-2105

**(v2.3 — Détection de surcharge cohérente avec le moteur)**
`detectOverloads` peut également consommer la timeline du moteur
Replan : deux intervalles consommés du même collab qui se chevauchent
constituent une vraie surcharge. Par construction le moteur ne produit
jamais ce cas (il place séquentiellement sur des créneaux libres) — la
détection ne devrait donc jamais lever d'alerte « surcharge » sur un
état issu d'un Replan récent.

Le détecteur continue de signaler les autres incohérences :
prédécesseurs violés (RG-GANTT-0904), priorité violée (RG-GANTT-0803),
SNET violé (RG-GANTT-0805), FNLT dépassée (RG-GANTT-1510), prédécesseur
terminé dans le futur (RG-GANTT-2106).

**Tests :** `utils.test.ts` → tests existants `detectOverloads` (rétrocompat) ; câblage UI à venir.

### RG-GANTT-2106

**(v2.3 — Prédécesseur terminé dans le futur)** Cas limite : si une
activité A a un prédécesseur P tel que `P.progress = 100` ET
`P.end_date > today` (P est marquée terminée mais sa fin annoncée est
dans le futur — incohérence métier), le moteur **ignore la contrainte
de prédécesseur** lors du placement de A. A peut démarrer dès la borne
basse globale (RG-GANTT-1903).

Le bandeau d'incohérences affiche une alerte (`kind`
`predecessor_terminated_in_future`, severity `warning`) pour que
l'utilisateur arbitre : corriger la fin du prédécesseur ou réduire son
`progress` sous 100.

**Tests :** `utils.test.ts` → tests `checkCoherence` (à étendre dans une itération suivante avec un cas explicite).

### RG-GANTT-2107

**(v2.3 — Jalon sans prédécesseur)** Un jalon (`kind = 'milestone'`)
sans prédécesseur est aujourd'hui traité par le serveur via
`recomputeAncestorPhases` et la cascade : sa date est respectée telle
quelle. Pour le replan, les jalons restent hors de
`replanTasks` (ils ne sont jamais déplacés par le moteur) ; leur date
est éventuellement ajustée par la cascade serveur via
`propagateToSuccessors` lorsque leur prédécesseur bouge.

Statu quo retenu : les jalons sans prédécesseur conservent leur
`start_date = end_date` saisie. Pour forcer une date précise, on
utilise la propriété de saisie directe (pas SNET — le SNET n'a pas
de sens pour un point dans le temps).

### RG-GANTT-2108

**(v2.3 — Phase vide)** Une phase sans enfants directs (cas dégénéré
possible à la création ou après suppression du dernier enfant) garde
les dates qui lui ont été assignées au moment de la création.
`recomputePhaseDates` ne recalcule pas ses dates en l'absence
d'enfants (silence par défaut).

L'utilisateur peut éditer manuellement ces dates via le TaskEditor.

### RG-GANTT-2109

**(v2.3 — Activité sans collaborateur)** Une activité sans
collaborateur affecté est traitée par le moteur comme si elle disposait
d'un collaborateur fictif à **capacité infinie** :

- Aucune contrainte de timeline (pas de chevauchement à éviter).
- Aucune surcharge à signaler.
- Durée = `charge_jours` × jours ouvrés bruts (allocation ignorée).
- Les autres contraintes restent appliquées (prédécesseur, SNET,
  `project_start_date`, today si mode normal).

Comportement déjà conforme dans le code (`placeTaskInTimeline` ne
consulte aucune timeline si `collabIds.length === 0`).

### RG-GANTT-2102

**(v2.3 — suppression du concept de démo)** Le code initialisant la base
avec des données d'exemple est supprimé : pas de seed automatique au
boot, pas d'endpoint `POST /api/reset`, pas de bouton « ↺ Restaurer
démo » dans l'UI. Les données existantes en base ne sont pas wipées :
elles deviennent des données utilisateur normales. À la création d'un
nouveau projet, aucune tâche n'est créée par défaut.

`DEMO_STATE` reste accessible en interne uniquement comme fixture pour
les tests unitaires et d'intégration (cf. `server/app.test.js`).

**Tests :** absence de l'endpoint vérifiée implicitement (le bouton et la
route n'existent plus dans le code) ; `server/app.test.js` n'inclut plus
le bloc `POST /api/reset`.

### RG-GANTT-2110

**(v2.3 — validation date démarrage)** À la modification de la date de
démarrage d'un projet, la nouvelle valeur est **rejetée avec une erreur**
si elle est postérieure à la `start_date` d'au moins une activité du
projet ayant `progress > 0` (en cours ou terminée).

Les activités à `progress = 0` ne sont pas concernées : leur `start_date`
est recalculée par le prochain Replan, qui les ramène à la nouvelle date
projet.

Implémentée côté serveur (DAL `updateProject`) — défense en profondeur
côté client à venir dans la modal Paramètres.

**Tests :** `server/app.test.js` → « PATCH refusé si date > start d'une tâche progress>0 ».

---

## Famille 22 — Tooltip custom (v2.2)

### RG-GANTT-2200

**(v2.2 / F1)** Le composant `Tooltip` (utilisé pour les info-bulles
boutons et icônes de l'app) implémente un comportement custom qui remplace
le `title=` natif HTML (délai d'apparition non contrôlable, disparition
au moindre mouvement) :

- Apparition après un **délai court** (par défaut 150 ms) au **survol
  souris** OU au **focus clavier**.
- Disparition immédiate au `mouseleave` ou au `blur`.
- Le délai en cours est **annulé** si la souris quitte avant son
  expiration (pas d'apparition fantôme).
- Rendu via `createPortal` dans `document.body` pour ne pas être tronqué
  par un `overflow-hidden` du parent.
- Style proche d'une bulle macOS native (fond slate-100, bordure
  slate-300, texte slate-800) — harmonisé avec le reste de l'app.

**Tests :** `src/components/Tooltip.test.tsx` → bloc
`Tooltip (RG-GANTT-2200)` (6 tests : pas affiché au montage, apparition
après délai mouseenter, annulation si la souris quitte avant la fin,
disparition au mouseleave, apparition au focus / disparition au blur,
respect d'un délai personnalisé).

---

### RG-GANTT-2300

**(v2.5 / Morcellement)** Le moteur Replan place la charge d'une activité en
**tissant autour des obstacles** : il consomme les jours-ouvrés-équivalents à
partir de la borne basse au plus tôt en **sautant** les jours sans capacité
(week-end / férié / congé / hors-allocation) **ET** les jours déjà pris par une
autre activité du même collaborateur. Les jours travaillés peuvent donc être
**non contigus**, ce qui **minimise la date de fin** — objectif premier du
Replan (analogie « GPS : le chemin le plus court »). En multi-collaborateur, un
jour n'est retenu que s'il est libre pour tous les affectés (capacité additive).

**Tests :** `src/lib/utils.test.ts` → bloc `RG-GANTT-2300 — placement tissé`
(tisse autour d'un jour obstacle pour finir plus tôt ; multi-collab).

---

### RG-GANTT-2301

**(v2.5 / Morcellement)** Le tissage ne crée **jamais de trou inutile** :
quand le placement contigu finit aussi tôt que le placement tissé (aucun
obstacle dans la fenêtre), les jours travaillés restent contigus. Un trou
n'apparaît que lorsqu'il fait gagner des jours sur la date de fin.

**Tests :** `src/lib/utils.test.ts` → `RG-GANTT-2301 — aucun trou quand le bloc
contigu finit aussi tôt`.

---

### RG-GANTT-2302

**(v2.5 / Morcellement)** La timeline effective exposée par le moteur
(`computeReplanResult().timeline`, consommée par le Plan de charge et la
détection de surcharge) émet **une entrée par jour réellement travaillé**
(`[jour, jour]`) au lieu d'un bloc contigu `[start, end]`. La grille interne du
moteur est un ensemble de **jours possédés** par collaborateur (`Set<jour>`),
pré-rempli par les activités terminées (obstacles que le moteur contourne mais
ne déplace jamais).

**Tests :** `src/lib/utils.test.ts` → bloc `RG-GANTT-2300 — placement tissé` et
`RG-GANTT-2303 — surcharge sur jours travaillés` (la timeline jour-par-jour est
vérifiée via les dates proposées et l'absence de fausse surcharge).

---

### RG-GANTT-2303

**(v2.5 / Morcellement)** La **surcharge** se mesure désormais sur les **jours
réellement travaillés** (timeline moteur), pas sur le chevauchement naïf des
enveloppes `[start, end]`. Deux activités dont les enveloppes se chevauchent
mais dont les jours travaillés sont **disjoints** (morcellement) ne déclenchent
**aucune** surcharge. Conséquence : une surcharge signalée par le bandeau de
cohérence (cf. RG-GANTT-0807) correspond à un **conflit non résolvable par
Replan** — typiquement deux activités **terminées** (`progress=100`, verrouillées)
qui partagent un jour travaillé. Les conflits entre activités mobiles sont
résolus silencieusement par le tissage au prochain Replan.

**Tests :** `src/lib/utils.test.ts` → bloc `RG-GANTT-2303 — surcharge sur jours
travaillés` ; `src/App.test.tsx` → `RG-GANTT-0807` (fixture de surcharge non
résolvable : deux activités terminées qui se chevauchent).

---

### RG-GANTT-2304

**(v2.5 / Morcellement)** Dans le diagramme de Gantt, une activité morcelée est
affichée comme **une seule barre-enveloppe** `[1er jour travaillé, dernier jour
travaillé]`, à l'intérieur de laquelle les **jours creux** (jours ouvrés non
travaillés parce qu'un obstacle les occupait) sont **hachurés en gris**. Repère
visuel pur (sans interaction), calé sur la timeline moteur. La date de début de
l'activité morcelée est son **1er jour réellement travaillé**.

**Tests :** `src/components/GanttChart.tsx` (rendu `renderHollowDays`, vérifié
visuellement) ; logique de placement couverte par RG-GANTT-2300..2302.

---

## Synthèse de couverture

Comptage automatisé par le méta-test `docs/regles-metier.coverage.test.js`
(quota d'orphelines `MAX_ALLOWED_ORPHANS`). Cible : **0 orpheline**
(chaque RG documentée doit voir son ID `RG-GANTT-XXXX` apparaître dans le
nom d'au moins un `it(...)` / `describe(...)` ou dans un commentaire d'un
fichier `*.test.*`).

| Famille                                | Plage                            |  Règles |
| -------------------------------------- | -------------------------------- | ------: |
| 1 — Communes                           | 0001..0007                       |       7 |
| 2 — Activités                          | 0100..0105                       |       6 |
| 3 — Jalons                             | 0200..0209                       |      10 |
| 4 — Phases                             | 0300..0309                       |      10 |
| 5 — Prédécesseur et délai              | 0400..0409                       |      10 |
| 6 — Priorité                           | 0500..0504                       |       5 |
| 7 — Surcharge collaborateur            | 0600..0606                       |       7 |
| 8 — SNET                               | 0700..0709                       |      10 |
| 9 — Cohérence                          | 0800..0807                       |       8 |
| 10 — Replanification (v0.x → v2.3)     | 0900..0909, 1900..1910           |      21 |
| 11 — Calendrier                        | 1000,1001,1003..1005             |       5 |
| 12 — Hiérarchie / Projets              | 1100..1107                       |       8 |
| 12bis — Memberships (v2.0/F1)          | 1200..1205                       |       6 |
| 13 — Allocations % (v2.0/F2)           | 1300..1305,1310..1313            |      10 |
| 14 — Absences (v2.0/F3)                | 1400..1406                       |       7 |
| 15 — FNLT (v2.0/F4)                    | 1500..1505,1510                  |       7 |
| 16 — Plan de charge (v2.0/F5)          | 1600..1602,1610..1611,1620..1621 |       7 |
| 17 — Multi-collab (v2.0/F6)            | 1700..1706                       |       7 |
| 19 — Allocation absorbante (v2.1/F2.9) | 1950..1957                       |       8 |
| 20 — Grilles éditables (v2.1/F4+F5)    | 2000..2006                       |       7 |
| 21 — Refonte Replan v2.3               | 2100..2110                       |      11 |
| 22 — Tooltip custom (v2.2)             | 2200                             |       1 |
| 23 — Morcellement (v2.5)               | 2300..2304                       |       5 |
| **Total**                              | —                                | **183** |

**Notes de couverture :**

- Famille 10 (Replan v0.x..v2.1) garde la plage 0900..0910. Les RG ajoutées
  en v2.2/v2.3 (invariance charge, progress=100 lockée, borne basse globale,
  mode planification anticipée) ont été regroupées sous le sous-titre
  « Famille 10bis » et conservent leurs IDs 1900..1910.
- Famille 19 (Allocation absorbante) a été renumérotée de 1900..1907 vers
  **1950..1957** le 2026-05-26 pour libérer le conflit d'IDs avec la
  Famille 10bis. Les tests F2.9 ont été renommés en conséquence.
- Famille 20 — les helpers purs (`rebuildAllocationsForCollab`,
  `useDragPaint`) sont couverts pour leur logique pure ; les interactions
  souris (clic / drag oblique désactivé / mini-form Période) sont vérifiées
  visuellement, pas par tests automatisés (manipuler des
  mousedown/mouseup/mousemove en jsdom est fragile).
- Famille 22 (Tooltip custom) ne contient qu'une RG, dédiée au comportement
  d'apparition / disparition / délai d'un tooltip survol/focus. C'est une
  règle UX promue depuis un commentaire de `Tooltip.tsx` (refonte 2026-05-23).
- **Ancienne « Famille 18 — Charge stockée (v2.0/F0) »** (présente dans une
  synthèse antérieure avec 5 règles) **a été retirée le 2026-05-26 car c'était
  un fantôme de comptage** : aucune RG `### RG-GANTT-18XX` n'a jamais été
  rédigée dans le catalogue. Le comportement « charge_jours stockée, source
  de vérité de la durée » qu'elle prétendait couvrir est en réalité porté par
  **RG-GANTT-0100** (Famille 2 — Activités), déjà comptée. Aucune règle n'a
  donc été perdue : le total passe mécaniquement de l'ancien décompte gonflé
  à 175 réelles.
