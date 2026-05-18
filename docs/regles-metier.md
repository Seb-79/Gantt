# Règles de gestion — Application Gantt

**Version applicative couverte : v1.24**
**Date de dernière mise à jour : 2026-05-18**

Ce document est le **référentiel vivant** des règles de gestion métier de
l'application. Chaque règle porte un identifiant stable de la forme
`RG-GANTT-XXXX` (XXXX entre 0001 et 9999). Avant tout commit qui touche
au comportement applicatif, vérifier que chaque règle impactée reste
couverte par au moins un test automatique.

Les règles sont rédigées en **langage métier** (vocabulaire d'utilisateur,
pas de jargon technique). Elles sont organisées en **familles
thématiques** pour faciliter la lecture.

---

## Famille 1 — Règles communes à tous les types

### RG-GANTT-0001

Une tâche est de l'un des trois types suivants : **activité**, **jalon**
ou **phase**. Le type est défini à la création et peut être modifié
ensuite.

### RG-GANTT-0002

Toute tâche est obligatoirement rattachée à un projet unique. Il
n'existe pas de tâche orpheline.

### RG-GANTT-0003

L'avancement d'une tâche est un pourcentage entier compris entre 0 et
100 inclus.

### RG-GANTT-0004

La date de fin d'une tâche est toujours supérieure ou égale à sa date
de début. Pour un jalon, ces deux dates sont identiques par
construction.

### RG-GANTT-0005

Le nom d'une tâche est obligatoire et ne peut pas être vide.

### RG-GANTT-0006

À chaque modification de donnée (création, édition, suppression), le
système incrémente un numéro de version interne. Les **navigateurs
ouverts** consultent ce numéro toutes les 5 secondes pour se rafraîchir
automatiquement quand une autre personne a modifié le planning.

### RG-GANTT-0007

Chaque tâche a une couleur effective :

1. couleur personnalisée si saisie, sinon
2. couleur du collaborateur (uniquement pour les activités), sinon
3. couleur grise par défaut.

---

## Famille 2 — Activités

### RG-GANTT-0100

Une activité a une **charge** exprimée en jours ouvrés (≥ 1) qui
détermine sa date de fin à partir de sa date de début.

### RG-GANTT-0101

Une activité peut être affectée à un seul collaborateur ou rester non
affectée.

### RG-GANTT-0102

Une activité peut avoir une couleur personnalisée ; à défaut, elle
hérite de la couleur de son collaborateur.

### RG-GANTT-0103

Une activité peut être rattachée à une phase parente (qui la regroupe
dans la hiérarchie d'affichage).

### RG-GANTT-0104

Une activité peut avoir une tâche prédécesseur (activité ou jalon).

### RG-GANTT-0105

Une activité peut être déplacée librement à la souris dans le
diagramme, y compris dans le passé. Les éventuelles incohérences avec
les autres règles métier sont signalées a posteriori dans le bandeau
d'alertes.

---

## Famille 3 — Jalons

### RG-GANTT-0200

Un jalon est un point ponctuel. Sa date de fin est toujours identique
à sa date de début.

### RG-GANTT-0201

Un jalon n'a pas de charge : sa durée visuelle est de zéro jour.

### RG-GANTT-0202

**(v1.24, J3)** Un jalon n'a pas de collaborateur affecté. Toute
affectation ancienne est silencieusement effacée par le système.

### RG-GANTT-0203

Un jalon peut avoir un prédécesseur ; les règles de prédécesseur
s'appliquent à lui comme à une activité.

### RG-GANTT-0204

Un jalon peut servir de prédécesseur à d'autres tâches.

### RG-GANTT-0205

Un jalon peut être rattaché à une phase parente (qui le contient dans
la hiérarchie d'affichage). Au maximum une seule phase parente.

### RG-GANTT-0206

**(v1.24, J3)** La couleur d'un jalon ne dérive jamais d'un
collaborateur (puisqu'un jalon n'en a pas) : seules la couleur
personnalisée ou la couleur grise par défaut s'appliquent.

---

## Famille 4 — Phases

### RG-GANTT-0300

Une phase est un regroupement dont la date de début est la **plus
précoce** parmi celles de ses enfants directs, et la date de fin la
**plus tardive**.

### RG-GANTT-0301

Une phase sans enfant conserve ses dates inchangées (aucun
écrasement).

### RG-GANTT-0302

Une phase n'a pas de collaborateur affecté.

### RG-GANTT-0303

Une phase n'a pas de prédécesseur ni de délai associés.

### RG-GANTT-0304

Une phase n'a pas de priorité.

### RG-GANTT-0305

Une phase ne peut pas servir de prédécesseur à une autre tâche.

### RG-GANTT-0306

Une phase peut contenir des activités, des jalons et d'autres phases
(imbrication libre).

### RG-GANTT-0307

Supprimer une phase supprime tout ce qu'elle contient (activités,
jalons et sous-phases). Aucun élément n'est laissé orphelin dans le
projet.

### RG-GANTT-0308

Une phase peut être repliée ou dépliée visuellement pour masquer ou
afficher ses descendants. Cet état est purement visuel et ne modifie
pas les données.

### RG-GANTT-0309

**(v1.24, SNET)** Une phase ne porte jamais de date de démarrage au
plus tôt (cf. famille 8). Toute valeur ancienne est silencieusement
effacée par le système.

---

## Famille 5 — Prédécesseur et délai

### RG-GANTT-0400

Une tâche ne peut pas être son propre prédécesseur, ni avoir l'un de
ses descendants comme prédécesseur (anti-cycle).

### RG-GANTT-0401

Si une tâche a un prédécesseur, sa date de début ne peut pas être
antérieure à la fin du prédécesseur.

### RG-GANTT-0402

Le **délai** entre la fin du prédécesseur et le début du successeur
s'exprime en jours ouvrés (≥ 0). C'est un minimum : une date de début
plus tardive que le minimum imposé est respectée.

### RG-GANTT-0403

Quand l'utilisateur saisit explicitement un délai dans le formulaire,
ce délai est la consigne ferme. Le système recalcule alors la date de
début à partir de la fin du prédécesseur augmentée de ce délai.

### RG-GANTT-0404

Quand l'utilisateur déplace une activité à la souris dans le
diagramme (sans toucher au champ « Délai »), le système met à jour
automatiquement le délai pour refléter le nouvel écart entre la fin
du prédécesseur et le nouveau début. Le délai s'adapte donc à
l'intention exprimée par le geste.

### RG-GANTT-0405

Une tâche sans prédécesseur a un délai forcément égal à 0.

### RG-GANTT-0406

Allonger la durée d'un prédécesseur **pousse** ses successeurs pour
préserver le délai. Raccourcir le prédécesseur **ne ramène pas** les
successeurs en arrière (le délai est un minimum, pas un écart figé).

### RG-GANTT-0407

Quand une tâche X est modifiée et que ses successeurs directs (Y)
doivent être poussés, les successeurs des successeurs (Z) sont eux
aussi poussés en chaîne. Le décalage se propage tant que c'est
nécessaire sur toute la chaîne de dépendances.

### RG-GANTT-0408

Si la nouvelle date de fin d'un prédécesseur tombe un week-end ou un
jour férié, la date de début du successeur est **automatiquement
reportée au prochain jour ouvré**.

### RG-GANTT-0409

Les jalons peuvent servir de prédécesseur. Comme un jalon est un
point ponctuel (un seul jour), c'est cette unique date qui sert de
référence à ses successeurs.

---

## Famille 6 — Priorité

### RG-GANTT-0500

**(v1.24, Pr2)** Toute activité a une priorité entière comprise entre
**1 et 5**, où 1 est la plus prioritaire et 5 la moins.

### RG-GANTT-0501

**(v1.24, Pr2)** Quand l'utilisateur ne saisit rien, la priorité par
défaut d'une activité est **3**.

### RG-GANTT-0502

**(v1.24, Pr2)** Les jalons et les phases n'ont pas de priorité (le
champ n'existe pas pour eux).

### RG-GANTT-0503

La priorité n'a aucun effet visuel direct dans le diagramme ni sur le
calcul de charge. Elle sert exclusivement d'arbitre lors de la
replanification et de la détection d'incohérences de priorité.

### RG-GANTT-0504

La priorité est utilisée pour départager les activités lors de la
replanification : la priorité 1 est traitée avant la 5. En cas
d'égalité, l'ordre d'affichage tranche.

---

## Famille 7 — Surcharge collaborateur

### RG-GANTT-0600

Chaque activité affectée à un collaborateur consomme **un
jour-personne par jour ouvré** sur son intervalle.

### RG-GANTT-0601

Seules les activités comptent dans le calcul de charge. Les jalons et
les phases sont ignorés (un jalon est ponctuel, une phase est une
synthèse).

### RG-GANTT-0602

Seuls les jours ouvrés sont comptabilisés. Les week-ends et jours
fériés français comptent comme zéro charge.

### RG-GANTT-0603

Une activité sans collaborateur n'est imputée à personne dans le plan
de charge, mais reste affichée normalement dans le diagramme.

### RG-GANTT-0604

La charge journalière d'un collaborateur est la **somme** des
activités qui se recouvrent ce jour-là. Deux activités le même jour =
charge de 2 (= surcharge).

### RG-GANTT-0605

Le plan de charge affiche un code couleur par cellule selon la charge
du jour :

- rouge : charge > 1 (surcharge) ;
- vert : charge = 1 (journée pleine) ;
- nuances de bleu : charge entre 0 et 1 (sous-charge) ;
- vide : charge = 0.

### RG-GANTT-0606

Un mode optionnel « mettre en évidence les sous-charges » bascule les
cellules dont la charge est strictement inférieure à 1 sur une
palette jaune, sans toucher aux états plein (vert) et surcharge
(rouge).

---

## Famille 8 — Contrainte « Ne doit pas démarrer avant le » (SNET)

### RG-GANTT-0700

**(v1.24, SNET)** Une activité ou un jalon peut porter une **date de
démarrage au plus tôt** facultative en dessous de laquelle la tâche
ne peut pas commencer.

### RG-GANTT-0701

**(v1.24, SNET)** La date de démarrage au plus tôt est facultative
(vide par défaut). Une tâche sans cette contrainte se comporte comme
avant la v1.24.

### RG-GANTT-0702

**(v1.24, SNET)** Les phases ne portent jamais de date de démarrage
au plus tôt. Toute valeur ancienne est silencieusement effacée par
le système.

### RG-GANTT-0703

**(v1.24, SNET)** Si une tâche a à la fois un prédécesseur et une
date de démarrage au plus tôt, sa date de début effective doit
respecter **le plus tardif des deux** (règle « la plus tardive
gagne »).

### RG-GANTT-0704

**(v1.24, SNET)** Si la date de démarrage au plus tôt saisie tombe un
week-end ou un jour férié, elle est **appliquée au prochain jour
ouvré**.

### RG-GANTT-0705

**(v1.24, SNET)** L'utilisateur a le droit de saisir une date de
démarrage au plus tôt qui tombe un jour non ouvré. Dans ce cas, le
formulaire affiche un **avertissement non bloquant** signalant que
la date sera reportée au prochain jour ouvré.

### RG-GANTT-0706

**(v1.24, SNET)** Si l'utilisateur tente d'enregistrer une activité
ou un jalon dont la date de début est antérieure à sa date de
démarrage au plus tôt, l'enregistrement est **bloqué** avec un
message d'erreur clair dans le formulaire.

### RG-GANTT-0707

**(v1.24, SNET)** Si l'utilisateur déplace une activité à la souris
en dessous de sa date de démarrage au plus tôt, le déplacement est
autorisé mais une **incohérence rouge** est immédiatement levée
dans le bandeau d'alertes. Le bouton Replan permet de corriger.

### RG-GANTT-0708

**(v1.24, SNET)** La date de démarrage au plus tôt est matérialisée
dans le diagramme par un **petit triangle gris discret** positionné
au jour ouvré effectif. Une info-bulle au survol affiche la date.

### RG-GANTT-0709

**(v1.24, SNET)** La replanification respecte la date de démarrage
au plus tôt comme borne basse : aucun déplacement proposé ne peut
amener une tâche en deçà de cette date.

---

## Famille 9 — Cohérence (bandeau d'alertes)

### RG-GANTT-0800

Une **surcharge** est signalée (erreur rouge) dès qu'au moins une
journée ouvrée est commune entre deux activités d'un même
collaborateur.

### RG-GANTT-0801

Aucune surcharge n'est signalée entre activités de collaborateurs
différents.

### RG-GANTT-0802

Une **violation de prédécesseur** est signalée (erreur rouge) quand
une tâche démarre avant la fin de son prédécesseur.

### RG-GANTT-0803

Une **violation de priorité** est signalée (avertissement jaune)
quand deux activités d'un même collaborateur ont des priorités
strictement différentes et que la moins prioritaire démarre avant la
plus prioritaire.

### RG-GANTT-0804

Aucune alerte de priorité n'est levée si les deux activités ont la
même priorité, ou si une seule des deux est priorisée explicitement.

### RG-GANTT-0805

**(v1.24, SNET)** Une **violation de date de démarrage au plus tôt**
est signalée (erreur rouge) quand une tâche démarre avant sa date de
démarrage au plus tôt (reportée au prochain jour ouvré le cas
échéant).

### RG-GANTT-0806

Quand un projet est cohérent (aucune incohérence détectée), aucun
bandeau d'alertes n'est affiché au-dessus du planning.

### RG-GANTT-0807

Quand des incohérences sont détectées, le bandeau propose deux
actions : **Replan complet** (toutes les activités du projet) et
**Replan partiel** (seules les activités concernées par les
incohérences).

---

## Famille 10 — Replanification

### RG-GANTT-0900

La replanification ne déplace que les activités. Les jalons et les
phases suivent ensuite automatiquement par la cascade des
prédécesseurs.

### RG-GANTT-0901

La replanification traite les activités par **priorité croissante**
(1 d'abord, 5 en dernier). En cas d'égalité de priorité, l'ordre
d'affichage tranche.

### RG-GANTT-0902

Une activité prédécesseur est traitée avant ses successeurs,
indépendamment de leur priorité respective (la dépendance prime sur
la priorité).

### RG-GANTT-0903

La replanification ne déplace **jamais** une activité vers une date
antérieure à sa date de début actuelle. C'est un mouvement vers le
futur uniquement.

### RG-GANTT-0904

La replanification respecte la contrainte de prédécesseur : début ≥
fin du prédécesseur + délai.

### RG-GANTT-0905

**(v1.24, SNET)** La replanification respecte aussi la date de
démarrage au plus tôt comme borne basse supplémentaire.

### RG-GANTT-0906

Le **Replan partiel** ne déplace que les activités directement
impliquées dans une incohérence (et leurs successeurs transitifs).
Toutes les autres activités bloquent leurs créneaux courants.

### RG-GANTT-0907

Une replanification produit un **aperçu** modifiable. L'utilisateur
peut **annuler** sans rien envoyer au serveur, ou **appliquer** pour
enregistrer les déplacements.

### RG-GANTT-0908

Le délai saisi par l'utilisateur est **préservé** lors d'une
replanification : il n'est pas ré-inféré depuis le nouvel écart entre
prédécesseur et successeur.

### RG-GANTT-0909

Par défaut, après chaque modification d'une tâche via le formulaire,
un Replan complet est relancé automatiquement. L'utilisateur peut
décocher cette option pour figer son geste sans replanification.

---

## Famille 11 — Calendrier et jours ouvrés

### RG-GANTT-1000

Les samedis et dimanches sont des jours non ouvrés et ne sont jamais
décomptés dans une charge ni dans un calcul de délai.

### RG-GANTT-1001

Les **11 jours fériés français** (8 fixes + 3 dérivés de Pâques)
sont des jours non ouvrés. Le calcul est **algorithmique et valable
pour toute année** (2027, 2030, 2050, …) — aucune intervention
manuelle n'est nécessaire dans le futur.

### RG-GANTT-1003

Une date qui tombe un week-end ou un jour férié est **automatiquement
reportée au jour ouvré suivant** dès qu'elle est utilisée comme
borne de début.

### RG-GANTT-1004

Une date qui tombe un week-end ou un jour férié est **automatiquement
avancée au jour ouvré précédent** dès qu'elle est utilisée comme
borne de fin.

### RG-GANTT-1005

Une charge de N jours ouvrés saute les week-ends et les jours
fériés : par exemple un lundi + 5 jours ouvrés tombe sur le vendredi
de la même semaine si aucun férié n'intervient, ou sur le lundi
suivant si un jour férié est traversé.

---

## Famille 12 — Hiérarchie, collaborateurs et projets

### RG-GANTT-1100

Une tâche peut être déplacée dans la hiérarchie : changement de
phase parente, changement de position parmi les frères.

### RG-GANTT-1101

Quand l'utilisateur déplace une tâche dans la hiérarchie pour en
faire l'enfant d'une autre, il ne peut pas la déposer à l'intérieur
de l'une de ses propres sous-tâches — sinon le système refuse pour
empêcher la création d'une boucle (A contiendrait B qui contiendrait
A).

### RG-GANTT-1102

Un collaborateur est caractérisé par un nom, une couleur de
pastille, et un **ordre d'affichage** dans la liste (1er, 2e, etc.).

### RG-GANTT-1103

Supprimer un collaborateur **détache** ses activités (le
collaborateur de chacune passe à « aucun ») sans supprimer les
activités elles-mêmes.

### RG-GANTT-1104

Un projet regroupe des phases, jalons et activités. Plusieurs
projets peuvent coexister dans la base, mais un seul est chargé à la
fois dans le diagramme.

### RG-GANTT-1105

Supprimer un projet supprime également toutes les tâches qu'il
contient (cascade).

### RG-GANTT-1106

**(v1.24)** L'utilisateur peut supprimer **tous les projets** d'une
base, y compris le dernier. Dans ce cas, le diagramme apparaît vide
et l'utilisateur peut créer un nouveau projet à tout moment.

### RG-GANTT-1107

Les collaborateurs sont **partagés** entre tous les projets : ils
restent disponibles quel que soit le projet chargé.

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
