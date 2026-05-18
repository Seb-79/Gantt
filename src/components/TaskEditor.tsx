// =============================================================================
// COMPOSANT TaskEditor — Gantt v1.3
// =============================================================================
// Modal léger pour éditer (ou créer) une tâche / jalon : nom, type, dates,
// avancement, collaborateur, phase parent, prédécesseur, couleur.
//
// État local synchronisé sur la prop `task` (édition) ou vide (création).
// Validation côté client : end_date >= start_date + auto-recalage de
// end_date quand start_date avance (manuellement ou via un prédécesseur).
// Affichage d'un message d'erreur lisible dans le modal en cas de souci.
// La validation forte reste faite par Zod côté serveur.
//
// Règles métier :
//   • Si un PRÉDÉCESSEUR est sélectionné, la `start_date` est initialisée sur
//     sa `end_date` mais reste éditable : l'utilisateur peut décaler le début
//     plus tard. En revanche, il ne peut pas la mettre AVANT la fin du
//     prédécesseur (attribut `min` + validation côté `handleSave`).
//   • Un jalon peut servir de prédécesseur (sa date de fin == sa date de jalon).
//     Seules les phases sont exclues du menu.
//   • Quand la `start_date` change (manuellement ou via prédécesseur) et
//     dépasse la `end_date`, on recale `end_date = start_date` automatiquement.
//   • La COULEUR est éditable. Valeur initiale = couleur effective (collab >
//     défaut). Bouton "↺ Auto" pour revenir à null (= ré-hériter du collab).
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import {
  addWorkingDays,
  computeEndFromCharge,
  computeMaxStartFromPredecessors,
  DEFAULT_TASK_COLOR,
  effectiveTaskColor,
  isNonWorkingDay,
  maxIso,
  workingDaysBetween,
} from '../lib/utils'
import PredecessorPicker, { type PredecessorEntry } from './PredecessorPicker'
import type {
  Collaborator,
  CollaboratorAbsence,
  MemberAllocation,
  Task,
  TaskKind,
} from '../lib/types'

interface Props {
  /** Tâche à éditer (null = création). */
  task: Task | null
  /** Pour la création : valeurs initiales à pré-remplir (sinon vide). */
  defaults?: Partial<Task>
  /** Liste des collaborateurs disponibles dans le menu. */
  collaborators: Collaborator[]
  /** v2.0 / F1 — Ids des collaborateurs membres du projet courant. La dropdown
   *  filtre les `collaborators` à cet ensemble (RG-GANTT-1200). Optionnel pour
   *  la rétro-compat des tests qui ne le passent pas ; si absent, on ne filtre
   *  pas (comportement v1.x). */
  memberIds?: string[]
  /** v2.0 / F2 — Allocations du projet courant (toutes paires confondues).
   *  Quand fournies, la date de fin affichée est recalculée en consommant la
   *  capacité quotidienne du collab sélectionné (allocation %). Optionnel
   *  pour rétro-compat. */
  memberAllocations?: MemberAllocation[]
  /** v2.0 / F3 — Absences cross-projet. Quand fournies, la fin affichée
   *  prend aussi en compte les jours d'absence du collab sélectionné
   *  (lecture multiplicative). Optionnel pour rétro-compat. */
  absences?: CollaboratorAbsence[]
  /** v2.0 / F2 — Id du projet courant (nécessaire pour le contexte
   *  d'allocation). Optionnel pour rétro-compat. */
  projectId?: string | null
  /** Liste des tâches existantes (pour les menus parent / prédécesseur). */
  tasks: Task[]
  /**
   * Callback de validation. Reçoit les champs édités.
   *
   * v1.22 — Deuxième paramètre `options.replan` : si `true`, le caller doit
   * relancer un Replan complet juste après la sauvegarde. La case à cocher
   * « Replanifier après enregistrement » (visible uniquement en mode édition)
   * pilote cette intention. Défaut côté UI = coché → `true`.
   */
  onSave: (patch: Partial<Task>, options?: { replan?: boolean }) => void
  /** Callback fermeture sans sauver. */
  onClose: () => void
  /** Callback suppression (uniquement en mode édition). */
  onDelete?: () => void
}

/** Modal d'édition. Affichée si on clique sur une tâche dans le Gantt. */
export default function TaskEditor({
  task,
  defaults,
  collaborators,
  memberIds,
  memberAllocations,
  absences,
  projectId,
  tasks,
  onSave,
  onClose,
  onDelete,
}: Props) {
  // État local. On le réinitialise à chaque ouverture (changement de prop).
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TaskKind>('task')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [progress, setProgress] = useState(0)
  const [collabId, setCollabId] = useState<string>('')
  const [parentId, setParentId] = useState<string>('')
  /** v1.22 — Liste multi-prédécesseurs (1 entrée = 1 lien avec son lag).
   *  Remplace l'ancien couple `predecessorId` / `lag` (mono-pred). La date de
   *  début est alignée sur MAX(pred.end + lag) à chaque mutation de la liste. */
  const [predecessorsList, setPredecessorsList] = useState<PredecessorEntry[]>(
    [],
  )
  /** Couleur custom (hex, vide = utiliser la couleur effective). */
  const [color, setColor] = useState<string>('')
  /** v1.9 — Charge en jours ouvrés (uniquement pour kind='task'). La date
   *  de fin est dérivée de start_date + charge ; éditer end_date met à jour
   *  charge en miroir pour rester cohérent. */
  const [charge, setCharge] = useState<number>(1)
  /** v1.18 / v1.24 — Priorité d'une activité : entier 1..5 obligatoire,
   *  défaut **3**. Sur les jalons et les phases, la priorité n'a pas de sens
   *  et reste à `null` (le champ est masqué dans le formulaire). */
  const [priority, setPriority] = useState<number | null>(3)
  /** v1.24 — Contrainte SNET « Ne doit pas démarrer avant le » : chaîne ISO
   *  YYYY-MM-DD ou vide (= pas de contrainte). Masquée pour les phases. */
  const [notBeforeDate, setNotBeforeDate] = useState<string>('')
  /** v2.0 / F4 — Contrainte FNLT « Fin au plus tard » : chaîne ISO ou vide
   *  (= pas de deadline). Masquée pour les phases. NON BLOQUANTE : si la
   *  fin calculée dépasse, on signale via le bandeau de cohérence et la barre
   *  Gantt — la sauvegarde n'est jamais rejetée. */
  const [notLaterThanDate, setNotLaterThanDate] = useState<string>('')
  /** Message d'erreur de validation à afficher dans le modal (null = OK). */
  const [error, setError] = useState<string | null>(null)
  /**
   * v1.22 — Coché par défaut en mode édition : à l'enregistrement, le caller
   * relance un Replan complet sur le projet pour préserver les invariants
   * (charge, prédécesseurs, priorités). Décocher la case permet à
   * l'utilisateur de figer son geste (typiquement quand il veut placer une
   * tâche dans le passé sans que l'algo la repousse).
   */
  const [replanAfterSave, setReplanAfterSave] = useState<boolean>(true)

  // Réinitialisation de l'état local à chaque ouverture (changement de
  // task ou defaults). setState dans l'effect est ici intentionnel —
  // c'est précisément ce qui permet de re-synchroniser le formulaire.
  useEffect(() => {
    const src = task || defaults || {}
    const initStart = src.start_date || ''
    const initEnd = src.end_date || src.start_date || ''
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(src.name || '')
    setKind(src.kind || 'task')
    setStartDate(initStart)
    setEndDate(initEnd)
    setProgress(src.progress ?? 0)
    setCollabId(src.collaborator_id || '')
    setParentId(src.parent_id || '')
    // v1.22 — Liste de prédécesseurs : privilégie le nouveau format
    // `predecessors[]` ; retombe sur l'alias mono-pred `predecessor_id` /
    // `predecessor_lag` pour les tâches/tests issus de v1.20-.
    if (Array.isArray(src.predecessors) && src.predecessors.length > 0) {
      setPredecessorsList(
        src.predecessors.map((p) => ({
          id: p.id,
          lag: Math.max(0, Math.floor(Number(p.lag) || 0)),
        })),
      )
    } else if (src.predecessor_id) {
      setPredecessorsList([
        {
          id: src.predecessor_id,
          lag: Math.max(0, Math.floor(Number(src.predecessor_lag) || 0)),
        },
      ])
    } else {
      setPredecessorsList([])
    }
    setColor(src.color || '')
    // v1.9 / v2.0 — Charge initiale :
    //   • Source de vérité depuis v2.0 : `task.charge_jours` (valeur stockée).
    //   • Filet de sécurité : back-dérive depuis l'écart courant si l'activité
    //     vient d'une base ancienne ou d'un payload sans charge_jours.
    //   • Min 1 (convention « une activité dure au moins 1 jour »).
    let initCharge = 1
    if (typeof src.charge_jours === 'number' && src.charge_jours >= 1) {
      initCharge = src.charge_jours
    } else if (initStart && initEnd) {
      initCharge = Math.max(1, workingDaysBetween(initStart, initEnd))
    }
    setCharge(initCharge)
    // v1.18 / v1.24 — Priorité d'une activité :
    //   • si la tâche en édition est une activité : on charge la valeur en
    //     base ; si invalide / absente, on initialise à 3 (défaut métier Pr2),
    //   • sinon (jalon / phase) : null (le champ est masqué).
    const rawPrio = src.priority
    const isTask = (src.kind || 'task') === 'task'
    if (!isTask) {
      setPriority(null)
    } else if (typeof rawPrio === 'number' && rawPrio >= 1 && rawPrio <= 5) {
      setPriority(Math.floor(rawPrio))
    } else {
      setPriority(3)
    }
    // v1.24 — Contrainte SNET initialisée depuis la base (vide si null).
    setNotBeforeDate(src.not_before_date || '')
    // v2.0 / F4 — FNLT initialisée depuis la base (vide si null).
    setNotLaterThanDate(src.not_later_than_date || '')
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [task, defaults])

  /**
   * v2.0 / F2 — Helper local : calcule la date de fin d'une activité depuis
   * sa charge en consommant la capacité allouée du collab sélectionné. Sans
   * collab sélectionné OU sans allocations OU sans projectId, retombe sur le
   * comportement F0 (jours ouvrés bruts).
   *
   * @param start  Date de début YYYY-MM-DD.
   * @param c      Charge en jours ouvrés (≥ 1).
   * @returns      Date de fin YYYY-MM-DD.
   */
  function endFromCharge(start: string, c: number): string {
    if (collabId && projectId && memberAllocations) {
      return computeEndFromCharge(start, c, {
        projectId,
        collaboratorId: collabId,
        allocations: memberAllocations,
        absences,
      })
    }
    return addWorkingDays(start, c)
  }

  /**
   * Modifie la date de début (saisie manuelle).
   *
   * v1.9 — Pour une tâche, la fin est dérivée : end_date = start + charge
   * (en jours ouvrés). Pour les autres types (milestone / phase), on conserve
   * l'ancien comportement (recale end_date si elle devient antérieure).
   * v1.10 — Si un prédécesseur est défini, on infère le nouveau délai depuis
   * (value - pred.end) pour rester cohérent (l'utilisateur a explicitement
   * choisi une date plus tardive).
   * v2.0 / F2 — La fin est désormais calculée via `endFromCharge` qui
   * consomme l'allocation du collab quand disponible.
   *
   * @param value  Nouvelle date ISO YYYY-MM-DD (ou '' si l'input est vidé).
   */
  function handleStartDateChange(value: string) {
    setStartDate(value)
    if (kind === 'task' && value) {
      setEndDate(endFromCharge(value, charge))
    } else {
      setEndDate((current) => maxIso(current, value))
    }
    // v1.22 — Plus d'inférence de lag depuis l'écart : le lag est porté par
    // chaque lien dans `predecessorsList` et édité explicitement dans le
    // PredecessorPicker. La validation du minimum est faite à la sauvegarde.
    setError(null)
  }

  /**
   * v1.9 — Modifie la charge (jours ouvrés) → recalcule end_date.
   * La valeur est bornée à un entier ≥ 1.
   *
   * @param raw  Valeur saisie (string venant de l'input number).
   */
  function handleChargeChange(raw: string) {
    const n = Math.max(1, Math.floor(Number(raw) || 1))
    setCharge(n)
    if (startDate && kind === 'task') {
      setEndDate(endFromCharge(startDate, n))
    }
    setError(null)
  }

  /**
   * v1.9 — Modifie la date de fin manuellement → recalcule la charge
   * correspondante pour rester cohérent. Permet à l'utilisateur de saisir
   * "je veux finir le X" sans passer par la charge.
   *
   * @param value  Date ISO YYYY-MM-DD.
   */
  function handleEndDateChange(value: string) {
    setEndDate(value)
    if (kind === 'task' && startDate && value && value >= startDate) {
      setCharge(Math.max(1, workingDaysBetween(startDate, value)))
    }
    setError(null)
  }

  /**
   * v1.22 — Callback de mutation de la liste de prédécesseurs (depuis le
   * PredecessorPicker). On met à jour l'état local puis on aligne
   * automatiquement `start_date` sur la borne basse `MAX(pred.end + lag)` SI
   * la borne actuelle est dépassée. Une `start_date` déjà postérieure à la
   * borne est respectée (le lag fonctionne comme un MINIMUM).
   *
   * @param next  Nouvelle liste { id, lag }.
   */
  function handlePredecessorsChange(next: PredecessorEntry[]) {
    setPredecessorsList(next)
    if (kind === 'phase') return
    const minStart = computeMaxStartFromPredecessors(next, tasks)
    if (minStart && startDate < minStart) {
      setStartDate(minStart)
      if (kind === 'task') {
        setEndDate(endFromCharge(minStart, charge))
      } else if (kind === 'milestone') {
        setEndDate(minStart)
      } else {
        setEndDate((current) => maxIso(current, minStart))
      }
    }
    setError(null)
  }

  /**
   * v2.0 / F1 — Sous-liste des collaborateurs proposables dans la dropdown.
   * Filtrée aux membres du projet courant (RG-GANTT-1200) ; on conserve aussi
   * le collab actuellement affecté à la tâche s'il n'est plus membre, pour
   * que l'utilisateur le voie clairement (et puisse le retirer s'il le veut).
   * Si `memberIds` n'est pas fourni (tests legacy), on n'applique aucun filtre.
   */
  const eligibleCollaborators = useMemo(() => {
    if (!memberIds) return collaborators
    const allowed = new Set(memberIds)
    if (collabId) allowed.add(collabId)
    return collaborators.filter((c) => allowed.has(c.id))
  }, [collaborators, memberIds, collabId])

  /**
   * Couleur "proposée par défaut" pour le picker quand l'utilisateur n'a
   * pas défini de couleur custom. = couleur du collab si présent, sinon
   * couleur grise par défaut.
   */
  const defaultColor = useMemo(() => {
    if (collabId) {
      const c = collaborators.find((x) => x.id === collabId)
      if (c) return c.color
    }
    return DEFAULT_TASK_COLOR
  }, [collabId, collaborators])

  /**
   * v1.22 — Date minimale autorisée pour `start_date` = `MAX(pred.end + lag)`
   * sur la liste actuelle de prédécesseurs (PERT). Chaîne vide = pas de borne.
   */
  const minStart = useMemo(
    () => computeMaxStartFromPredecessors(predecessorsList, tasks),
    [predecessorsList, tasks],
  )

  /**
   * Calcule le tooltip à afficher sur le champ "Début" selon le contexte.
   * Évite un ternaire imbriqué dans le JSX (cf. `sonarjs/no-nested-conditional`).
   */
  function startDateTooltip(): string | undefined {
    if (kind === 'phase') return 'Calculée automatiquement à partir des enfants'
    if (minStart)
      return `Doit être ≥ ${minStart} (max des fins de prédécesseurs + lag)`
    return undefined
  }

  /**
   * v1.9 — Calcule le tooltip à afficher sur le champ "Fin" selon le type.
   * Extrait pour éviter un ternaire imbriqué dans le JSX.
   */
  function endDateTooltip(): string | undefined {
    if (kind === 'phase') return 'Calculée automatiquement à partir des enfants'
    // v2.0 — La fin n'est plus directement éditable pour une activité : elle
    // dérive de start + charge. Le tooltip reflète ce changement de sémantique.
    if (kind === 'task')
      return 'Calculée à partir du début et de la charge (en jours ouvrés).'
    return undefined
  }

  /**
   * v2.0 / F4 — Validations métier extraites pour limiter la complexité
   * cognitive de `handleSave` (sonarjs). Renvoie un message d'erreur lisible
   * (à afficher dans le bandeau) ou `null` si tout est OK.
   *
   * Ordre : du plus simple au plus complexe (nom → dates).
   */
  function validateForm(finalEnd: string): string | null {
    if (!name.trim()) return 'Le nom est obligatoire.'
    if (!startDate) return 'La date de début est obligatoire.'
    // v1.22 — Le début ne peut pas être antérieur à la borne basse calculée
    // depuis les prédécesseurs (MAX(pred.end + lag)).
    if (kind !== 'phase' && minStart && startDate < minStart) {
      return `La date de début doit être ≥ ${minStart} (max des fins de prédécesseurs + lag).`
    }
    // v1.24 — Contrainte SNET « Ne doit pas démarrer avant le » : blocage
    // explicite à la saisie. À l'inverse, le FNLT (v2.0/F4) est non bloquant.
    if (kind !== 'phase' && notBeforeDate && startDate < notBeforeDate) {
      return `La date de début ne peut pas être antérieure au « Ne doit pas démarrer avant le » (${notBeforeDate}).`
    }
    if (kind !== 'milestone' && finalEnd < startDate) {
      return 'La date de fin doit être supérieure ou égale à la date de début.'
    }
    return null
  }

  /**
   * Valide les champs puis appelle onSave. Affiche un message d'erreur
   * dans le modal (au lieu d'un alert technique) si la validation échoue.
   */
  function handleSave() {
    const finalEnd = kind === 'milestone' ? startDate : endDate || startDate
    const err = validateForm(finalEnd)
    if (err) {
      setError(err)
      return
    }
    setError(null)
    onSave(
      {
        name: name.trim(),
        kind,
        start_date: startDate,
        end_date: finalEnd,
        progress,
        // v1.6 — Une phase n'a ni collaborateur ni prédécesseur (forcés à null
        // côté DAL aussi, mais on doublonne ici pour ne pas envoyer de bruit).
        // v1.24 — Règle J3 : un jalon n'a pas non plus de collaborateur.
        collaborator_id: kind === 'task' ? collabId || null : null,
        parent_id: parentId || null,
        // v1.22 — Liste multi-prédécesseurs (nouveau format). Phase → vide.
        predecessors: kind === 'phase' ? [] : predecessorsList,
        // v1.18 / v1.24 — Priorité obligatoire (1..5, défaut 3) UNIQUEMENT
        // pour les activités. Pour les jalons et les phases, on envoie null.
        priority: kind === 'task' ? (priority ?? 3) : null,
        // v1.24 — Contrainte SNET (vide → null). Forcée à null pour les phases.
        not_before_date: kind === 'phase' ? null : notBeforeDate || null,
        // v2.0 / F4 — FNLT (vide → null). Forcée à null pour les phases.
        not_later_than_date: kind === 'phase' ? null : notLaterThanDate || null,
        // v2.0 — Charge en jours ouvrés (source de vérité pour les activités).
        // Le DAL recalculera end_date depuis (start_date + charge_jours).
        // Jalon / phase : on n'envoie rien (le DAL forcera NULL).
        ...(kind === 'task' ? { charge_jours: charge } : {}),
        // color: '' (vide) → null (= hériter automatiquement)
        color: color || null,
      },
      // v1.22 — N'envoie l'option `replan` qu'en mode édition (la case n'est
      // visible que là). À la création, le caller décidera lui-même.
      task ? { replan: replanAfterSave } : undefined,
    )
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          {task ? 'Modifier' : 'Nouvelle tâche / jalon / phase'}
        </h2>

        {/* Bandeau d'erreur lisible (validation locale OU erreur API
            transmise via prop ultérieurement). */}
        {error && (
          <div
            className="text-sm rounded border border-red-300 bg-red-50 text-red-700 px-3 py-2"
            role="alert"
          >
            {error}
          </div>
        )}

        <label className="block text-sm">
          <span className="text-slate-600">Nom</span>
          <input
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <div className="flex gap-2">
          <label className="block text-sm flex-1">
            <span className="text-slate-600">Type</span>
            <select
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={kind}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              <option value="task">Tâche</option>
              <option value="milestone">Jalon</option>
              <option value="phase">Phase (regroupement)</option>
            </select>
          </label>

          <label className="block text-sm flex-1">
            <span className="text-slate-600">Avancement (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              disabled={kind === 'milestone' || kind === 'phase'}
            />
          </label>
        </div>

        {/* v1.6 — Bandeau d'aide spécifique aux phases. */}
        {kind === 'phase' && (
          <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
            🗂️ <strong>Phase</strong> : les dates seront calculées
            automatiquement à partir des activités enfants (début = la plus
            précoce, fin = la plus tardive). Une phase n'a pas de collaborateur
            ni de prédécesseur.
          </div>
        )}

        <div className="flex gap-2">
          <label className="block text-sm flex-1">
            <span className="text-slate-600">
              Début
              {minStart && (
                <span
                  className="ml-1 text-xs text-slate-400"
                  title={`Minimum : ${minStart} (max des fins de prédécesseurs + lag)`}
                >
                  (≥ {minStart})
                </span>
              )}
            </span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500"
              value={startDate}
              min={minStart || undefined}
              onChange={(e) => handleStartDateChange(e.target.value)}
              disabled={kind === 'phase'}
              title={startDateTooltip()}
            />
          </label>

          {/* v1.9 — Champ Charge (jours ouvrés). Affiché uniquement pour
              kind='task' : un jalon est ponctuel, une phase est auto-calculée. */}
          {kind === 'task' && (
            <label className="block text-sm w-28">
              <span
                className="text-slate-600"
                title="Nombre de jours ouvrés (lundi-vendredi). Détermine la date de fin."
              >
                Charge (j)
              </span>
              <input
                type="number"
                min={1}
                step={1}
                className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
                value={charge}
                onChange={(e) => handleChargeChange(e.target.value)}
                title="Nombre de jours ouvrés (lundi-vendredi). La date de fin est recalculée automatiquement (les week-ends sont sautés)."
              />
            </label>
          )}

          {/* v2.0 — Pour une activité, la date de fin devient READ-ONLY :
              elle est désormais DÉRIVÉE de (start_date + charge_jours), la
              charge étant la source de vérité. L'utilisateur saisit la charge,
              le champ « Fin » affiche le résultat. Pour les jalons / phases,
              comportement inchangé (jalon : fin = début forcé ; phase : fin =
              MAX des enfants). */}
          <label className="block text-sm flex-1">
            <span className="text-slate-600">
              Fin
              {kind === 'task' && (
                <span
                  className="ml-1 text-xs text-slate-400"
                  title="Calculée automatiquement depuis le début et la charge."
                >
                  (calculée)
                </span>
              )}
            </span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-500 read-only:bg-slate-50 read-only:text-slate-500"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => handleEndDateChange(e.target.value)}
              disabled={kind === 'milestone' || kind === 'phase'}
              readOnly={kind === 'task'}
              title={endDateTooltip()}
            />
          </label>
        </div>

        {/* Collaborateur — masqué pour les phases ET les jalons (règle J3 v1.24 :
            seules les activités sont affectées à un collaborateur ; un jalon est
            un point de repère ponctuel, une phase est une synthèse). */}
        {kind === 'task' && (
          <label className="block text-sm">
            <span className="text-slate-600">
              Collaborateur
              {memberIds && (
                <span
                  className="ml-1 text-xs text-slate-400"
                  title="Seuls les membres du projet sont proposés. Pour ajouter quelqu’un, passez par l’onglet « Affectation »."
                >
                  (membres du projet)
                </span>
              )}
            </span>
            <select
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={collabId}
              onChange={(e) => setCollabId(e.target.value)}
            >
              <option value="">— aucun —</option>
              {eligibleCollaborators.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* v2.0 / F1 — Info-bulle quand la liste est vide : oriente
                l'utilisateur vers l'onglet d'affectation pour débloquer. */}
            {memberIds && eligibleCollaborators.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Aucun collaborateur n’est encore membre de ce projet. Ouvrez
                l’onglet « Affectation » pour en ajouter.
              </p>
            )}
          </label>
        )}

        <label className="block text-sm">
          <span className="text-slate-600">Phase parent</span>
          <select
            className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">— aucune —</option>
            {/* v1.6 — Une "phase parent" doit être de kind='phase'. */}
            {tasks
              .filter((t) => t.id !== task?.id && t.kind === 'phase')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>

        {/* v1.22 — Prédécesseurs (multi). Masqué pour les phases (qui n'ont
            jamais de prédécesseur). Le PredecessorPicker affiche les chips
            sélectionnées + un popover arborescent pour en ajouter. */}
        {kind !== 'phase' && (
          <div className="text-sm">
            <span className="text-slate-600">
              Prédécesseurs
              <span className="ml-1 text-xs text-slate-400">
                (facultatif — la date de début se cale sur le plus tardif)
              </span>
            </span>
            <div className="mt-1">
              <PredecessorPicker
                task={task}
                allTasks={tasks}
                value={predecessorsList}
                onChange={handlePredecessorsChange}
              />
            </div>
          </div>
        )}

        {/* v1.24 — Contrainte SNET « Ne doit pas démarrer avant le ».
            Masquée pour les phases (dont les dates sont synthétisées depuis
            les enfants). La validation au save bloque toute date de début
            antérieure à cette borne ; un avertissement non-bloquant signale
            une saisie tombant un week-end ou un jour férié français. */}
        {kind !== 'phase' && (
          <label className="block text-sm">
            <span className="text-slate-600">
              Ne doit pas démarrer avant le
              <span className="ml-1 text-xs text-slate-400">
                (facultatif — borne indépendante du prédécesseur)
              </span>
            </span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={notBeforeDate}
              onChange={(e) => setNotBeforeDate(e.target.value)}
              title="Date avant laquelle la tâche ne peut pas démarrer. La règle « plus tardive gagne » s'applique entre cette date et la fin du prédécesseur."
            />
            {/* Avertissement non-bloquant si la date tombe un jour non ouvré.
                Le serveur snape automatiquement au prochain jour ouvré, mais
                on prévient l'utilisateur pour qu'il puisse corriger si besoin. */}
            {notBeforeDate &&
              isNonWorkingDay(new Date(notBeforeDate + 'T00:00:00')) && (
                <span className="block mt-1 text-xs text-amber-700">
                  ⚠ Cette date tombe un week-end ou un jour férié. Elle sera
                  appliquée au prochain jour ouvré.
                </span>
              )}
          </label>
        )}

        {/* v2.0 / F4 — Contrainte FNLT « Fin au plus tard ». Sœur jumelle du
            SNET mais NON BLOQUANTE : si la date de fin calculée dépasse cette
            valeur, on n'empêche pas la sauvegarde — un signal visuel (bandeau
            de cohérence + icône rouge en bout de barre) avertit l'utilisateur.
            Masquée pour les phases. */}
        {kind !== 'phase' && (
          <label className="block text-sm">
            <span className="text-slate-600">
              Fin au plus tard
              <span className="ml-1 text-xs text-slate-400">
                (facultatif — deadline non bloquante)
              </span>
            </span>
            <input
              type="date"
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={notLaterThanDate}
              min={notBeforeDate || startDate || undefined}
              onChange={(e) => setNotLaterThanDate(e.target.value)}
              title="Date de fin AU PLUS TARD souhaitée. Si la fin calculée dépasse, c'est signalé visuellement mais la sauvegarde reste possible."
            />
            {/* Avertissement non-bloquant si la deadline est déjà dépassée
                par la fin calculée. Le calcul reste exact côté serveur. */}
            {notLaterThanDate && endDate && endDate > notLaterThanDate && (
              <span className="block mt-1 text-xs text-red-700">
                ⚠ La fin calculée ({endDate}) dépasse cette deadline. La tâche
                sera signalée comme « en retard » dans le bandeau d'alertes.
              </span>
            )}
          </label>
        )}

        {/* v1.18 / v1.24 — Priorité OBLIGATOIRE sur les activités (1..5,
            défaut 3). Masquée pour les jalons et les phases (qui n'ont ni
            collaborateur, ni replan applicable). 1 = la plus prioritaire,
            5 = la moins. */}
        {kind === 'task' && (
          <label className="block text-sm">
            <span className="text-slate-600">
              Priorité
              <span className="ml-1 text-xs text-slate-400">
                (1 = plus prioritaire, 5 = moins ; utilisée par « Replan »)
              </span>
            </span>
            <select
              className="mt-1 block w-full border border-slate-300 rounded px-2 py-1.5"
              value={String(priority ?? 3)}
              onChange={(e) => setPriority(Number(e.target.value))}
              title="1 = la plus prioritaire, 5 = la moins. Défaut : 3."
            >
              <option value="1">1 (la plus prioritaire)</option>
              <option value="2">2</option>
              <option value="3">3 (par défaut)</option>
              <option value="4">4</option>
              <option value="5">5 (la moins prioritaire)</option>
            </select>
          </label>
        )}

        {/* COULEUR — éditable, par défaut = couleur effective */}
        <div className="block text-sm">
          <span className="text-slate-600">Couleur de la barre</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              className="h-9 w-14 border border-slate-300 rounded cursor-pointer"
              value={
                color ||
                effectiveTaskColor(
                  // tâche fictive juste pour le calcul de couleur effective
                  {
                    id: '',
                    name: '',
                    kind: 'task',
                    start_date: '',
                    end_date: '',
                    progress: 0,
                    collaborator_id: collabId || null,
                    color: null,
                    parent_id: null,
                    predecessor_id: null,
                    predecessor_lag: 0,
                    priority: null,
                    not_before_date: null,
                    not_later_than_date: null,
                    charge_jours: null,
                    position: 0,
                    project_id: '',
                  },
                  collaborators,
                )
              }
              onChange={(e) => setColor(e.target.value)}
              title="Choisir une couleur personnalisée"
            />
            <span className="text-xs text-slate-500 flex-1">
              {color ? (
                <>Couleur personnalisée : {color}</>
              ) : (
                <>
                  Auto :{' '}
                  <span
                    className="inline-block w-3 h-3 rounded align-middle mr-1"
                    style={{ backgroundColor: defaultColor }}
                  />
                  hérite du collaborateur
                </>
              )}
            </span>
            {color && (
              <button
                type="button"
                className="px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-100"
                onClick={() => setColor('')}
                title="Repasser en automatique (hérite du collaborateur)"
              >
                ↺ Auto
              </button>
            )}
          </div>
        </div>

        {/* v1.22 — Case « Replanifier après enregistrement », visible UNIQUEMENT
            en mode édition. Cochée par défaut : à l'enregistrement, le caller
            relance un Replan complet pour préserver les invariants métier
            (charge collab, prédécesseurs, priorités). Décocher = figer son
            geste — typiquement quand on a délibérément déplacé une tâche
            dans le passé et qu'on ne veut pas la voir poussée. */}
        {task && (
          <label className="flex items-center gap-2 pt-2 text-sm text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 accent-amber-500"
              checked={replanAfterSave}
              onChange={(e) => setReplanAfterSave(e.target.checked)}
            />
            <span>
              🔄 Replanifier le projet après enregistrement
              <span className="ml-1 text-xs text-slate-500">
                (recommandé pour préserver charge et prédécesseurs)
              </span>
            </span>
          </label>
        )}

        <div className="flex justify-between pt-2">
          {task && onDelete ? (
            <button
              className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50"
              onClick={onDelete}
            >
              Supprimer
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
              onClick={onClose}
            >
              Annuler
            </button>
            <button
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={handleSave}
            >
              {task ? 'Enregistrer' : 'Créer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
