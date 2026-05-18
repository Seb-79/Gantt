# Règles de gestion — Application Gantt

**Version applicative couverte : v2.0 (F0 — charge stockée + F1 — memberships + F2 — allocations %)**
**Date de dernière mise à jour : 2026-05-19**
**Couverture de test : 117 / 117 (100 %)**

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

**Tests :** `db/index.test.js` → « v1.24 / Pr2 — jalon créé avec priorité → priorité forcée à null » (étendu aux phases via normalizePriority).

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
**1 et 5**, où 1 est la plus prioritaire et 5 la moins.

**Tests :** `db/index.test.js` → « v1.24 / Pr2 — activité créée sans priorité → priorité 3 par défaut ».

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

Quand des incohérences sont détectées, le bandeau propose deux
actions : **Replan complet** (toutes les activités du projet) et
**Replan partiel** (seules les activités concernées par les
incohérences).

**Tests :** `App.test.tsx` → « affiche le bandeau quand une surcharge existe + énumère les 2 boutons » ; « "Replan complet" depuis le bandeau ouvre la modal habituelle » ; « "Replan partiel" ne déplace que les tâches concernées ».

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

La replanification ne déplace **jamais** une activité vers une date
antérieure à sa date de début actuelle. C'est un mouvement vers le
futur uniquement.

**Tests :** `utils.test.ts` → « v1.24 — RG-GANTT-0903 — une activité isolée et libre n`est PAS ramenée en arrière par le replan » ; « après replan, la borne basse de chaque activité est >= sa start_date d`origine ».

### RG-GANTT-0904

La replanification respecte la contrainte de prédécesseur : début ≥
fin du prédécesseur + délai.

**Tests :** `utils.test.ts` → « pousse la 2e tâche après la 1re quand elles se chevauchent pour le même collab ».

### RG-GANTT-0905

**(v1.24, SNET)** La replanification respecte aussi la date de
démarrage au plus tôt comme borne basse supplémentaire.

**Tests :** `utils.test.ts` → cf. RG-GANTT-0703 / 0709 (« SNET > pred.end + lag → la borne basse de replan est le SNET »).

### RG-GANTT-0906

Le **Replan partiel** ne déplace que les activités directement
impliquées dans une incohérence (et leurs successeurs transitifs).
Toutes les autres activités bloquent leurs créneaux courants.

**Tests :** `utils.test.ts` → bloc `replanTasks — variante PARTIELLE (concernedIds)` ; `App.test.tsx` → « "Replan partiel" ne déplace que les tâches concernées ».

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

**Tests :** `App.test.tsx` → « case cochée par défaut : un Replan suit le PATCH d'édition » ; « case décochée : aucun replan, seul le PATCH d'édition part ».

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

---

## Synthèse de couverture

| Famille                       |  Règles |            Couverture |
| ----------------------------- | ------: | --------------------: |
| 1 — Communes                  |       7 |                 7 / 7 |
| 2 — Activités                 |       6 |                 6 / 6 |
| 3 — Jalons                    |       7 |                 7 / 7 |
| 4 — Phases                    |      10 |               10 / 10 |
| 5 — Prédécesseur et délai     |      10 |               10 / 10 |
| 6 — Priorité                  |       5 |                 5 / 5 |
| 7 — Surcharge collaborateur   |       7 |                 7 / 7 |
| 8 — SNET                      |      10 |               10 / 10 |
| 9 — Cohérence                 |       8 |                 8 / 8 |
| 10 — Replanification          |      10 |               10 / 10 |
| 11 — Calendrier               |       5 |                 5 / 5 |
| 12 — Hiérarchie / Projets     |       8 |                 8 / 8 |
| 12bis — Memberships (v2.0/F1) |       6 |                 6 / 6 |
| 13 — Allocations % (v2.0/F2)  |      10 |               10 / 10 |
| 14 — Charge stockée (v2.0/F0) |       5 |                 5 / 5 |
| **Total**                     | **114** | **114 / 114 (100 %)** |
