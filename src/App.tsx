// =============================================================================
// APP — Gantt v1
// =============================================================================
// Composant racine :
//   • Charge l'état depuis l'API au mount, puis polling 5 s
//   • Gère le zoom (largeur d'un jour en px)
//   • Gère la fenêtre temporelle (4 mois par défaut)
//   • Permet création / édition / suppression de tâches via TaskEditor
//   • Bouton "Capture d'écran PNG" via html-to-image (téléchargement direct)
//   • v1.8 — Sélecteur multi-projets avec création / renommage / suppression
//     (le projet courant est persisté en localStorage).
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import GanttChart from './components/GanttChart'
import TaskEditor from './components/TaskEditor'
import WorkloadChart from './components/WorkloadChart'
import CoherenceAlert from './components/CoherenceAlert'
import MembersGrid from './components/MembersGrid'
// v2.2 / F5 — Vue Affectation × Tous les projets (mode 'all' du sélecteur).
import MembersGridGlobal from './components/MembersGridGlobal'
import AbsencesGrid from './components/AbsencesGrid'
import Dialogs from './components/Dialogs'
// v2.2 / F1 — Tooltip custom : remplace les attributs HTML natifs `title=` de la
// toolbar dont le délai d'apparition (~700-1500 ms) et le comportement de
// disparition au moindre mouvement rendaient l'usage frustrant.
import { Tooltip } from './components/Tooltip'
// v2.2 / F2 — Sélecteur de projet enrichi (un projet OU « Tous les projets »).
// Remplace le <select> natif + le bouton « 🌐 Global / 📁 Courant » en un seul
// menu déroulant custom. F3 ajoutera la multi-sélection.
import { ProjectFilter } from './components/ProjectFilter'
// v2.0 — Remplace window.confirm / window.prompt (qui affichent l'en-tête
// « localhost:5174 indique ») par des modales custom alignées sur le style
// de l'app. Voir src/lib/dialogs.ts pour le détail.
import { askAlert, askConfirm, askPrompt } from './lib/dialogs'
import {
  checkCoherence,
  clampDayWidth,
  defaultWindow,
  DEFAULT_DAY_WIDTH,
  filterCollapsed,
  makeId,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
  rebuildAllocationsForCollab,
  replanTasks,
  scanReplanShortfalls,
  sortTasksHierarchically,
  todayIso,
  windowFromTasks,
} from './lib/utils'
import type { ExtensionPlan, ReplanMove } from './lib/utils'
import type { ReplanShortfallItem } from './components/ReplanAllocationFixDialog'
import ReplanAllocationFixDialog from './components/ReplanAllocationFixDialog'
import type {
  Collaborator,
  GanttState,
  ProjectSelection,
  Task,
} from './lib/types'

/** Intervalle (ms) du polling de synchronisation. */
const POLL_INTERVAL = 5000

/** Clé localStorage utilisée pour mémoriser le projet ouvert d'une session à l'autre. */
const LS_CURRENT_PROJECT = 'gantt.currentProjectId'

/** v1.11 — Clé localStorage pour mémoriser l'affichage des dates de barres. */
const LS_SHOW_DATES = 'gantt.showDates'

/** v1.13 — Clé localStorage pour mémoriser l'affichage du nom dans les barres. */
const LS_SHOW_BAR_NAMES = 'gantt.showBarNames'

/** v1.13.1 — Clé localStorage pour mémoriser le niveau de zoom (dayWidth, px). */
const LS_DAY_WIDTH = 'gantt.dayWidth'

/** v1.16 — Clé localStorage pour mémoriser l'onglet actif (Gantt / Charge). */
const LS_VIEW = 'gantt.view'

/** v1.17 — Clé localStorage pour mémoriser la mise en évidence des sous-charges. */
const LS_HIGHLIGHT_UNDERLOAD = 'gantt.highlightUnderload'

/** v1.20 — Clé localStorage pour mémoriser les phases repliées (JSON: string[]). */
const LS_COLLAPSED_PHASES = 'gantt.collapsedPhases'

/** v2.0 / F5 — Clé localStorage pour mémoriser le scope du plan de charge.
 *  Conservée pour la migration depuis les versions antérieures à v2.2/F3. */
const LS_WORKLOAD_SCOPE = 'gantt.workloadScope'

/** v2.2 / F3 — Clé localStorage pour mémoriser la sélection projet (single /
 *  all / subset). Sérialisée en JSON via `lsSet`. Remplace `LS_WORKLOAD_SCOPE`
 *  en source de vérité. */
const LS_PROJECT_SELECTION = 'gantt.projectSelection'

/** v1.16 / v2.0 — Vues disponibles dans l'app :
 *    • 'gantt'    → planning (par défaut)
 *    • 'workload' → plan de charge par collaborateur
 *    • 'members'  → v2.0 / F1 : affectation des collaborateurs au projet
 *    • 'absences' → v2.0 / F3 : congés cross-projet */
type View = 'gantt' | 'workload' | 'members' | 'absences'

/** État réseau pour le badge en haut à droite. */
type NetStatus = 'idle' | 'loading' | 'ok' | 'error'

/**
 * v1.17 — Helpers `localStorage` à try/catch unique. Centralisent la
 * gestion du mode privé strict (Safari, etc.) qui peut lever sur read/write,
 * et réduisent la complexité cognitive des initialiseurs `useState` et
 * des toggles côté `App`.
 *
 * @param key       Clé localStorage.
 * @param fallback  Valeur retournée si la clé est absente ou inaccessible.
 * @returns         La chaîne stockée, ou `fallback`.
 */
function lsGet(key: string, fallback: string | null = null): string | null {
  try {
    const v = localStorage.getItem(key)
    return v ?? fallback
  } catch {
    return fallback
  }
}

/**
 * v1.17 — Écrit une valeur dans `localStorage` en silenciant les erreurs
 * (mode privé strict). Utilisé par les toggles persistants.
 */
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage indisponible — on continue, l'état reste en mémoire.
  }
}

/**
 * v2.2 / F3 — Initialise `projectSelection` au démarrage de l'app :
 *   1. Si LS_PROJECT_SELECTION contient un JSON valide → on l'utilise.
 *   2. Sinon migration depuis LS_WORKLOAD_SCOPE ('global' → mode 'all').
 *   3. Défaut : mode 'single' sur le projet sauvegardé (ou '' si base vide).
 *
 * Extrait pour limiter la complexité cognitive du composant `App`.
 */
function readInitialProjectSelection(): ProjectSelection {
  const stored = lsGet(LS_PROJECT_SELECTION)
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { mode?: string; projectId?: string }
      // v2.2 / F3 refondu : seuls 'single' et 'all' sont valides.
      // Le mode 'subset' éventuellement persisté en LS est désormais
      // normalisé en 'all' (la sémantique la plus proche).
      if (parsed.mode === 'all') return { mode: 'all' }
      if (parsed.mode === 'subset') return { mode: 'all' }
      if (parsed.mode === 'single' && typeof parsed.projectId === 'string') {
        return { mode: 'single', projectId: parsed.projectId }
      }
    } catch {
      // JSON invalide → fallback vers la migration ci-dessous.
    }
  }
  // Migration depuis l'ancienne clé LS_WORKLOAD_SCOPE.
  if (lsGet(LS_WORKLOAD_SCOPE) === 'global') return { mode: 'all' }
  return { mode: 'single', projectId: lsGet(LS_CURRENT_PROJECT) ?? '' }
}

export default function App() {
  /** État serveur (projets + collaborateurs + tâches du projet courant + version). */
  const [state, setState] = useState<GanttState | null>(null)
  /**
   * Id du projet actuellement affiché. Persisté en localStorage pour
   * réouvrir le même projet à la prochaine session. Le serveur fait
   * autorité : si l'id stocké n'existe plus (projet supprimé ailleurs),
   * la réponse `/api/state` renvoie le 1er projet et on se resynchronise.
   */
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(() =>
    lsGet(LS_CURRENT_PROJECT),
  )
  /** Statut réseau pour feedback visuel. */
  const [status, setStatus] = useState<NetStatus>('idle')
  /**
   * Largeur d'un jour en pixels — pilote le zoom.
   * v1.13.1 — Initialisé depuis localStorage si présent (valeur clampée
   * pour rester dans [MIN_DAY_WIDTH, MAX_DAY_WIDTH] et survivre à un
   * changement de bornes en code).
   */
  const [dayWidth, setDayWidth] = useState<number>(() => {
    const raw = lsGet(LS_DAY_WIDTH)
    if (raw === null) return DEFAULT_DAY_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_DAY_WIDTH
    return clampDayWidth(parsed)
  })

  // v1.13.1 — Persistance du zoom : à chaque changement, on l'écrit en
  // localStorage. Stocker en dehors du setter laisse la liberté d'écrire
  // dayWidth depuis n'importe où (slider, +, −, raccourci futur) sans
  // dupliquer la logique de persistance.
  useEffect(() => {
    lsSet(LS_DAY_WIDTH, String(dayWidth))
  }, [dayWidth])
  /** Bornes du calendrier visible (4 mois par défaut depuis aujourd'hui). */
  const [{ startIso, endIso }, setWindow] = useState(() => defaultWindow())
  /** Tâche en cours d'édition (null = pas de modal). */
  const [editing, setEditing] = useState<Task | null>(null)
  /** true = modal en mode création. */
  const [creating, setCreating] = useState(false)
  /**
   * v1.11 — Affichage des dates de début/fin sur les barres du planning
   * (format 'dd/MM'). Persisté en localStorage pour conserver le choix
   * d'une session à l'autre.
   */
  const [showDates, setShowDates] = useState<boolean>(
    () => lsGet(LS_SHOW_DATES) === '1',
  )
  /**
   * v1.13 — Affichage du nom de la tâche à l'intérieur des barres. Activé
   * par défaut (planning textuel) ; on peut le désactiver pour obtenir un
   * planning purement graphique (utile en mode dézoom ou capture). Persisté
   * en localStorage : seule la valeur '0' inhibe (toute autre valeur =
   * défaut "affiché", y compris l'absence de clé).
   */
  const [showBarNames, setShowBarNames] = useState<boolean>(
    () => lsGet(LS_SHOW_BAR_NAMES) !== '0',
  )
  /**
   * v1.16 — Onglet actif. Par défaut « gantt » (planning) ; bascule vers
   * « workload » pour afficher le plan de charge par collaborateur.
   * Persisté en localStorage pour revenir sur la même vue à l'ouverture.
   */
  const [view, setView] = useState<View>(() => {
    // v2.0 / F1+F3 — Ajout des vues 'members' et 'absences'. On valide
    // explicitement la valeur lue dans localStorage pour éviter qu'une
    // valeur exotique ne casse l'UI.
    const stored = lsGet(LS_VIEW)
    if (stored === 'workload' || stored === 'members' || stored === 'absences')
      return stored
    return 'gantt'
  })
  /**
   * v1.17 — Met en évidence les sous-charges (< 1 jour) en jaune sur la
   * vue Plan de charge, de manière symétrique au rouge appliqué aux
   * surcharges. Optionnel et désactivé par défaut (palette bleue d'origine).
   */
  const [highlightUnderload, setHighlightUnderload] = useState<boolean>(
    () => lsGet(LS_HIGHLIGHT_UNDERLOAD) === '1',
  )
  /**
   * v2.2 / F3 — Sélection projet : pilote le périmètre du Plan de charge.
   * Trois modes (cf. `ProjectSelection` dans types.ts) : single / all / subset.
   * Persisté en localStorage. Migration automatique depuis l'ancienne clé
   * LS_WORKLOAD_SCOPE pour les utilisateurs venant de v2.1 ou antérieur.
   */
  const [projectSelection, setProjectSelection] = useState<ProjectSelection>(
    readInitialProjectSelection,
  )

  /**
   * v2.2 / F3 — Scope dérivé pour le Plan de charge :
   *   • mode 'single' → scope 'current' (utilise state.tasks).
   *   • mode 'all' ou 'subset' → scope 'global' (utilise globalTasks).
   * Préservé comme `workloadScope` pour minimiser le delta avec le code v2.1.
   */
  const workloadScope: 'current' | 'global' =
    projectSelection.mode === 'single' ? 'current' : 'global'

  /**
   * v2.2 / F3 (refondu) — Indique si l'on est en mode « Tous les projets ».
   * Dans cet état, l'édition est désactivée (création/renommage/suppression
   * de tâche/projet requiert un projet précis, donc le mode single).
   */
  const isGlobalView = projectSelection.mode === 'all'
  /**
   * v2.0 / F5 — Tâches cross-projet fetchées depuis /api/workload/global,
   * `null` tant qu'on n'a pas demandé la vue globale. Re-fetchées à chaque
   * passage en mode global pour refléter les mutations entre-temps.
   */
  const [globalTasks, setGlobalTasks] = useState<Task[] | null>(null)
  /**
   * v1.18 — Aperçu de replanification en attente d'approbation. `null` quand
   * la modal est fermée, sinon contient la liste des déplacements proposés
   * par `replanTasks` (cf. utils.ts). Validée par "Appliquer", abandonnée
   * par "Annuler" (la modal se ferme sans envoyer de PATCH).
   */
  const [replanPreview, setReplanPreview] = useState<ReplanMove[] | null>(null)
  /**
   * v2.1 / F2.9.C — État de blocage du Replan par manque d'allocation. Null
   * = pas de blocage. Quand non-null, le `ReplanAllocationFixDialog`
   * (F2.9.D) s'ouvre et propose au user d'étendre les allocations en lot
   * avant de relancer le replan. `scope` mémorise « full » ou « partial »
   * pour relancer la bonne portée après extension.
   */
  const [replanShortfall, setReplanShortfall] = useState<{
    items: ReplanShortfallItem[]
    scope: 'full' | 'partial'
  } | null>(null)
  /**
   * v2.1 / F2.9.C — Scope mémorisé pour re-déclencher `handleOpenReplan`
   * automatiquement après que les extensions d'allocation ont été appliquées
   * (le state React a été rafraîchi via fetchState). Null = pas en attente.
   */
  const [pendingReplanScope, setPendingReplanScope] = useState<
    'full' | 'partial' | null
  >(null)
  /**
   * v1.20 — Set d'ids de phases actuellement repliées. Persisté en
   * localStorage (clé `gantt.collapsedPhases`, JSON string[]). Quand une
   * phase est dans ce set, ses enfants (et petits-enfants) sont masqués
   * dans la liste des tâches ET dans le planning. La phase elle-même reste
   * visible (avec un chevron pour la déplier). N'altère ni les données
   * serveur ni la logique de replan : effet purement visuel.
   */
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(() => {
    const raw = lsGet(LS_COLLAPSED_PHASES)
    if (!raw) return new Set()
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set()
      return new Set(parsed.filter((x): x is string => typeof x === 'string'))
    } catch {
      return new Set()
    }
  })

  /** Référence sur le bloc Gantt — utilisée pour la capture PNG. */
  const ganttRef = useRef<HTMLDivElement | null>(null)

  /**
   * Drapeau "fenêtre déjà recalée à partir des tâches" : empêche d'écraser
   * la navigation manuelle de l'utilisateur (boutons « mois / sem »)
   * lors des polls suivants.
   */
  const initialWindowSet = useRef(false)

  /**
   * Tâches triées hiérarchiquement : chaque enfant juste après son parent.
   * Mémoïsé pour ne recalculer que si la liste change vraiment.
   */
  const orderedTasks = useMemo(
    () => (state ? sortTasksHierarchically(state.tasks) : []),
    [state],
  )

  /**
   * v2.2 / F3 (refondu) — Tâches globales passées au WorkloadChart en mode
   * 'all' (vue agrégée tous projets). En mode 'single', cette prop est
   * ignorée par le chart (scope='current' utilise state.tasks directement).
   */
  const effectiveGlobalTasks: Task[] | undefined = globalTasks ?? undefined

  /**
   * v2.2 / F3 refondu — Garde-fou de cohérence : si l'utilisateur arrive sur
   * l'onglet Gantt alors que le mode est 'all' (cas typique : état persisté
   * depuis une session Charge/Affectation), on bascule automatiquement en
   * 'single' sur le projet d'édition actif. Sans ce garde-fou, le Gantt
   * resterait vide (par design il n'affiche qu'un seul projet).
   *
   * On attend que `currentProjectId` soit défini (chargé depuis /api/state)
   * avant d'agir, pour ne pas créer une sélection avec un id vide.
   */
  useEffect(() => {
    if (
      view === 'gantt' &&
      projectSelection.mode === 'all' &&
      currentProjectId
    ) {
      const fallback: ProjectSelection = {
        mode: 'single',
        projectId: currentProjectId,
      }
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setProjectSelection(fallback)
      lsSet(LS_PROJECT_SELECTION, JSON.stringify(fallback))
    }
  }, [view, projectSelection.mode, currentProjectId])

  /**
   * v1.20 — Liste des tâches RÉELLEMENT affichées : `orderedTasks` filtrées
   * des descendants des phases repliées. `replanTasks` continue d'utiliser
   * `orderedTasks` (la replanification raisonne sur l'ensemble complet,
   * indépendamment du repli visuel).
   */
  const visibleTasks = useMemo(
    () => filterCollapsed(orderedTasks, collapsedPhases),
    [orderedTasks, collapsedPhases],
  )

  /**
   * v1.21 — Audit de cohérence du projet courant. Recalculé à chaque
   * changement de `orderedTasks` (drag, save, polling). Pur, déterministe,
   * < 1 ms à l'échelle d'un projet. Quand la liste est vide, le bandeau
   * `CoherenceAlert` se cache automatiquement.
   */
  const coherenceIssues = useMemo(
    () => checkCoherence(orderedTasks),
    [orderedTasks],
  )

  /** Objet du projet courant (résolu depuis `state.projects`). */
  const currentProject = useMemo(() => {
    if (!state || !state.current_project_id) return null
    return state.projects.find((p) => p.id === state.current_project_id) || null
  }, [state])

  /**
   * v1.4 — Au premier chargement de l'état, recale la fenêtre de visualisation
   * sur le LUNDI de la semaine de la tâche démarrant le plus tôt (plutôt que
   * d'afficher 4 mois à partir d'aujourd'hui). N'est exécuté qu'une seule fois
   * grâce au drapeau `initialWindowSet`, pour ne pas écraser ensuite les
   * déplacements manuels de l'utilisateur dans le calendrier.
   */
  useEffect(() => {
    if (!state || initialWindowSet.current) return
    if (state.tasks.length === 0) return
    initialWindowSet.current = true
    /* eslint-disable react-hooks/set-state-in-effect */
    setWindow(windowFromTasks(state.tasks, 4))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [state])

  /**
   * Récupère l'état complet depuis l'API. Met à jour status + state.
   * v1.8 — Si un projet est sélectionné, on passe son id en query string ;
   * le serveur renvoie `current_project_id` (peut différer si l'id demandé
   * a disparu) — on re-synchronise l'état local sur cette valeur.
   */
  const fetchState = useCallback(async () => {
    try {
      const url = currentProjectId
        ? `/api/state?project_id=${encodeURIComponent(currentProjectId)}`
        : '/api/state'
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: GanttState = await res.json()
      setState((prev) => {
        // Évite un re-render inutile si la version n'a pas bougé ET que le
        // projet courant n'a pas changé.
        if (
          prev &&
          prev.version === data.version &&
          prev.current_project_id === data.current_project_id
        ) {
          return prev
        }
        return data
      })
      // Le serveur peut substituer un autre projet si celui demandé a été
      // supprimé : on aligne le state local + localStorage.
      if (
        data.current_project_id &&
        data.current_project_id !== currentProjectId
      ) {
        setCurrentProjectId(data.current_project_id)
        lsSet(LS_CURRENT_PROJECT, data.current_project_id)
      }
      setStatus('ok')
    } catch (err) {
      console.error('[fetchState]', err)
      setStatus('error')
    }
  }, [currentProjectId])

  // Mount : 1er chargement + polling 5 s.
  // setState dans l'effect est ici intentionnel (subscribe à un système
  // externe : l'API HTTP) — on désactive la règle React 19 dédiée.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    fetchState()
    const id = setInterval(fetchState, POLL_INTERVAL)
    return () => clearInterval(id)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [fetchState])

  /**
   * Envoie une mutation et rafraîchit immédiatement l'état local.
   *
   * @param method  Méthode HTTP (POST / PATCH / DELETE).
   * @param url     URL relative (ex. /api/tasks).
   * @param body    Corps JSON éventuel.
   */
  const mutate = useCallback(
    async (method: string, url: string, body?: unknown) => {
      setStatus('loading')
      try {
        const res = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        })
        if (!res.ok) {
          // Parsing du JSON d'erreur de l'API pour afficher un message
          // lisible plutôt que le payload brut "{error:..., details:[…]}".
          throw new Error(await formatApiError(res))
        }
        await fetchState()
      } catch (err) {
        console.error('[mutate]', err)
        setStatus('error')
        await askAlert(`Erreur : ${(err as Error).message}`)
      }
    },
    [fetchState],
  )

  /** Reset des données démo. */
  const handleReset = async () => {
    if (!(await askConfirm('Restaurer les données de démonstration ?'))) return
    mutate('POST', '/api/reset')
  }

  /**
   * v2.0 / F1 — Ajoute un collaborateur à l'équipe du projet courant. Aucun
   * effet si la base n'a pas encore de projet (cas tout début, on évite un
   * POST en 400). L'API est idempotente : un re-clic sur un collab déjà
   * membre ne fait rien (et n'incrémente pas la version).
   */
  const handleAddProjectMember = useCallback(
    (collaboratorId: string) => {
      if (!currentProjectId) return
      mutate(
        'POST',
        `/api/projects/${encodeURIComponent(currentProjectId)}/members`,
        { collaborator_id: collaboratorId },
      )
    },
    [currentProjectId, mutate],
  )

  /**
   * v2.2 / F4 — Crée un nouveau collaborateur (entité globale) ET l'affecte
   * immédiatement au projet courant. Déclenché par le bouton « + Nouveau »
   * dans l'en-tête de la vue Affectation.
   *
   * Couleur par défaut bleue (`#3b82f6`) — l'utilisateur pourra la changer
   * plus tard (UI dédiée à venir). Nom non vide requis (askPrompt valide).
   *
   * Le chaînage est volontairement séquentiel (await sur la création avant
   * l'affectation) pour éviter une race où l'affectation serait POSTée avant
   * que le collab n'existe en base.
   */
  const handleCreateCollaborator = useCallback(async () => {
    if (!currentProjectId) return
    const rawName = await askPrompt('Nom du nouveau collaborateur :', '')
    const name = rawName?.trim()
    if (!name) return
    const id = makeId('c')
    // 1. Crée le collab via un fetch direct (mutate swallow l'erreur, on a
    //    besoin de la propagation pour ne PAS POSTer le membership si la
    //    création échoue — typiquement collision d'id, rare mais possible).
    try {
      setStatus('loading')
      const res = await fetch('/api/collaborators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, color: '#3b82f6' }),
      })
      if (!res.ok) throw new Error(await formatApiError(res))
    } catch (err) {
      console.error('[createCollaborator]', err)
      setStatus('error')
      await askAlert(`Erreur : ${(err as Error).message}`)
      return
    }
    // 2. Affecte le nouveau collab au projet courant (POST membership).
    //    `mutate` enchaîne le re-fetch du state → le sélecteur de candidats
    //    et la liste des membres se rafraîchissent automatiquement.
    mutate(
      'POST',
      `/api/projects/${encodeURIComponent(currentProjectId)}/members`,
      { collaborator_id: id },
    )
  }, [currentProjectId, mutate])

  /**
   * v2.0 / F2 — Ajoute une période d'allocation pour un membre du projet
   * courant. Le serveur valide les invariants (% ∈ {25,50,75,100}, pas de
   * chevauchement, membership existante) et renvoie 400 en cas de violation
   * — le helper `mutate` affichera l'erreur dans une alert.
   */
  const handleAddMemberAllocation = useCallback(
    (
      collaboratorId: string,
      body: { start_date: string; end_date: string; allocation_pct: number },
    ) => {
      if (!currentProjectId) return
      mutate(
        'POST',
        `/api/projects/${encodeURIComponent(currentProjectId)}/members/${encodeURIComponent(collaboratorId)}/allocations`,
        body,
      )
    },
    [currentProjectId, mutate],
  )

  /**
   * v2.1 / F4 — Commit du drag-paint / clic dans la grille « Affectation ».
   * Calcule un `AllocationRebuildPlan` à partir des allocations courantes et
   * des changements jour-par-jour, puis exécute en série :
   *   1. DELETE de chaque ancienne allocation (toDelete) ;
   *   2. POST de chaque nouvelle période compactée (toCreate).
   * Termine par un seul `fetchState` pour rafraîchir l'UI.
   *
   * @param collaboratorId  Collaborateur cible (ligne du drag).
   * @param changes         Map<dateIso, pct> (pct=0 = jour libre).
   */
  /**
   * v2.2 / F5 — Commit d'un changement de pct sur la grille globale
   * « Affectation × Tous les projets ». Variante du handler ci-dessous,
   * paramétrée par le `projectId` cible (le couple est désigné par
   * (collaboratorId, projectId)).
   *
   * Limité à 1 jour à la fois (clic-cycle V1, pas de drag-paint global).
   */
  const handleCommitGlobalCellChange = useCallback(
    async (
      collaboratorId: string,
      projectId: string,
      dayIso: string,
      newPct: number,
    ) => {
      if (!state) return
      const changes = new Map<string, number>([[dayIso, newPct]])
      const plan = rebuildAllocationsForCollab({
        projectId,
        collaboratorId,
        existing: state.all_member_allocations,
        changes,
      })
      setStatus('loading')
      try {
        for (const id of plan.toDelete) {
          const res = await fetch(
            `/api/allocations/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
          )
          if (!res.ok && res.status !== 404) {
            throw new Error(await formatApiError(res))
          }
        }
        for (const period of plan.toCreate) {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(collaboratorId)}/allocations`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(period),
            },
          )
          if (!res.ok) {
            throw new Error(await formatApiError(res))
          }
        }
        await fetchState()
      } catch (err) {
        console.error('[commitGlobalCellChange]', err)
        setStatus('error')
        await askAlert(
          `Mise à jour de l'allocation impossible : ${(err as Error).message}`,
        )
      }
    },
    [state, fetchState],
  )

  const handleCommitAllocationGrid = useCallback(
    async (collaboratorId: string, changes: Map<string, number>) => {
      if (!state || !currentProjectId) return
      const plan = rebuildAllocationsForCollab({
        projectId: currentProjectId,
        collaboratorId,
        existing: state.member_allocations,
        changes,
      })
      setStatus('loading')
      try {
        // DELETE puis POST en série : on garde la sémantique des invariants
        // (no-overlap) et la cohérence si une op échoue en cours de route.
        for (const id of plan.toDelete) {
          const res = await fetch(
            `/api/allocations/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
          )
          if (!res.ok && res.status !== 404) {
            throw new Error(await formatApiError(res))
          }
        }
        for (const period of plan.toCreate) {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(currentProjectId)}/members/${encodeURIComponent(collaboratorId)}/allocations`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(period),
            },
          )
          if (!res.ok) {
            throw new Error(await formatApiError(res))
          }
        }
        await fetchState()
      } catch (err) {
        console.error('[commitAllocationGrid]', err)
        setStatus('error')
        await askAlert(
          `Mise à jour de l'allocation impossible : ${(err as Error).message}`,
        )
      }
    },
    [state, currentProjectId, fetchState],
  )

  /**
   * v2.1 / F5 — Commit du drag-paint / clic dans la grille « Congés ».
   * Pour chaque jour modifié :
   *   • fraction > 0 → POST absence (UPSERT serveur, RG-GANTT-1403) ;
   *   • fraction = 0 → DELETE absence (no-op si elle n'existait pas).
   * Exécute en série puis fait un seul `fetchState`.
   *
   * @param collaboratorId  Collaborateur cible (ligne du drag).
   * @param changes         Map<dateIso, fraction>.
   */
  const handleCommitAbsencesGrid = useCallback(
    async (collaboratorId: string, changes: Map<string, number>) => {
      setStatus('loading')
      try {
        for (const [date, fr] of changes) {
          if (fr > 0) {
            const res = await fetch(
              `/api/collaborators/${encodeURIComponent(collaboratorId)}/absences`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date, fraction: fr }),
              },
            )
            if (!res.ok) throw new Error(await formatApiError(res))
          } else {
            const res = await fetch(
              `/api/collaborators/${encodeURIComponent(collaboratorId)}/absences/${encodeURIComponent(date)}`,
              { method: 'DELETE' },
            )
            // 404 silencieux = jour qui n'avait pas d'absence (cas drag qui
            // passe sur des cases vides). Tout autre 4xx/5xx remonte.
            if (!res.ok && res.status !== 404) {
              throw new Error(await formatApiError(res))
            }
          }
        }
        await fetchState()
      } catch (err) {
        console.error('[commitAbsencesGrid]', err)
        setStatus('error')
        await askAlert(
          `Mise à jour des congés impossible : ${(err as Error).message}`,
        )
      }
    },
    [fetchState],
  )

  /**
   * v2.1 / F5 — Ajout d'une plage de congés en une fois (mini-formulaire
   * « + Période »). On POST une absence par jour OUVRÉ entre start et end
   * (les jours non ouvrés sont skip — un congé sur un samedi n'a pas de sens
   * métier, et le serveur n'a pas de validation côté date).
   */
  const handleAddAbsencePeriod = useCallback(
    async (
      collaboratorId: string,
      body: { start_date: string; end_date: string; fraction: number },
    ) => {
      setStatus('loading')
      try {
        let cur = body.start_date
        while (cur <= body.end_date) {
          const d = new Date(cur + 'T00:00:00')
          // Skip week-ends (samedi=6, dimanche=0). On laisse les fériés
          // passer : un congé en semaine sur un férié reste sémantiquement
          // valide même si redondant (ne nuit pas).
          const dow = d.getDay()
          if (dow !== 0 && dow !== 6) {
            const res = await fetch(
              `/api/collaborators/${encodeURIComponent(collaboratorId)}/absences`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: cur, fraction: body.fraction }),
              },
            )
            if (!res.ok) throw new Error(await formatApiError(res))
          }
          // Avance d'un jour calendaire.
          d.setDate(d.getDate() + 1)
          cur = d.toISOString().slice(0, 10)
        }
        await fetchState()
      } catch (err) {
        console.error('[addAbsencePeriod]', err)
        setStatus('error')
        await askAlert(
          `Ajout de la période impossible : ${(err as Error).message}`,
        )
      }
    },
    [fetchState],
  )

  /**
   * v2.1 / F2.9 — Exécute un plan d'extension d'allocation (Q5=C : un mix de
   * PATCH d'allocations existantes et de POST de nouvelles allocations). Les
   * opérations sont SÉQUENTIELLES (l'invariant « pas de chevauchement » est
   * vérifié à chaque write côté DAL ; un ordre parallèle pourrait faire échouer
   * un POST qui chevauche un PATCH non encore appliqué).
   *
   * Au terme du plan, un seul `fetchState` rapatrie l'état frais. Les erreurs
   * 4xx sont propagées via `askAlert` (cohérent avec `mutate`).
   *
   * @param plan  Plan d'extension produit par `computeExtensionPlan`.
   */
  const handleExtendAllocations = useCallback(
    async (plan: ExtensionPlan) => {
      if (!currentProjectId) return
      setStatus('loading')
      try {
        for (const op of plan.operations) {
          let res: Response
          if (op.kind === 'patch') {
            if (!op.allocationId) continue
            res = await fetch(
              `/api/allocations/${encodeURIComponent(op.allocationId)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  end_date: op.endDate,
                  allocation_pct: op.pct,
                }),
              },
            )
          } else {
            res = await fetch(
              `/api/projects/${encodeURIComponent(currentProjectId)}/members/${encodeURIComponent(op.collaboratorId)}/allocations`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  start_date: op.startDate,
                  end_date: op.endDate,
                  allocation_pct: op.pct,
                }),
              },
            )
          }
          if (!res.ok) {
            throw new Error(await formatApiError(res))
          }
        }
        await fetchState()
      } catch (err) {
        console.error('[extendAllocations]', err)
        setStatus('error')
        await askAlert(
          `Extension d'allocation impossible : ${(err as Error).message}`,
        )
        throw err
      }
    },
    [currentProjectId, fetchState],
  )

  /** Capture le bloc Gantt en PNG et déclenche le téléchargement. */
  const handleScreenshot = async () => {
    if (!ganttRef.current) return
    try {
      const dataUrl = await toPng(ganttRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2, // résolution doublée (qualité PowerPoint)
      })
      const link = document.createElement('a')
      link.download = `gantt-${new Date().toISOString().slice(0, 10)}.png`
      link.href = dataUrl
      link.click()
    } catch (err) {
      console.error('[screenshot]', err)
      await askAlert('Capture impossible — voir la console.')
    }
  }

  /**
   * v1.22 — Applique une série de déplacements de tâches sur le serveur
   * (un PATCH par tâche, séquentiel pour respecter l'ordre topologique
   * produit par `replanTasks` : prédécesseurs avant successeurs). Puis
   * resynchronise l'état local via `fetchState`. Réutilisé par
   * `handleApplyReplan` (modal d'aperçu) et `handleSaveTask` (auto-replan
   * après enregistrement).
   *
   * @param moves  Déplacements à appliquer (issus de `replanTasks`).
   */
  const submitReplanMoves = useCallback(
    async (moves: ReplanMove[]) => {
      if (moves.length === 0) return
      setStatus('loading')
      try {
        for (const m of moves) {
          const res = await fetch(`/api/tasks/${m.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // v1.23 — Inclut `predecessor_lag` pour que le serveur prenne la
            // branche « lagInPatch=true » et PRÉSERVE le délai utilisateur
            // (sinon il ré-inférerait un lag depuis le nouveau gap, ce qui
            // écrasait la valeur saisie — bug v1.22 / Test délai).
            // v2.2 / RG-W — Inclut `charge_jours` pour empêcher la
            // back-dérivation côté serveur (RG-GANTT-1900 invariance de la
            // charge sous Replan). Le moteur ne modifie JAMAIS la charge ;
            // ce champ active le cas 3a' du serveur qui honore les trois
            // valeurs telles quelles.
            body: JSON.stringify({
              start_date: m.newStart,
              end_date: m.newEnd,
              predecessor_lag: m.predecessor_lag,
              charge_jours: m.charge_jours,
            }),
          })
          if (!res.ok) {
            throw new Error(await formatApiError(res))
          }
        }
        await fetchState()
      } catch (err) {
        console.error('[replan]', err)
        setStatus('error')
        await askAlert(
          `Erreur pendant la replanification : ${(err as Error).message}`,
        )
      }
    },
    [fetchState],
  )

  /**
   * Sauvegarde du formulaire (création ou édition).
   *
   * v1.22 — Quand `options.replan === true` (cas par défaut depuis la case
   * « Replanifier après enregistrement » du `TaskEditor` en mode édition),
   * un Replan complet est lancé automatiquement après le PATCH : on relit
   * l'état frais depuis l'API (pour ne pas dépendre du cycle de re-render
   * React) puis on applique les déplacements proposés par `replanTasks`,
   * sans passer par la modal d'aperçu. Le réseau est synchronisé via le
   * badge de statut habituel.
   *
   * @param patch    Champs édités à PATCHer ou POSTer.
   * @param options  { replan?: boolean } — uniquement consulté en édition.
   */
  const handleSaveTask = async (
    patch: Partial<Task>,
    options: { replan?: boolean } = {},
  ) => {
    const wasEditing = editing
    setEditing(null)
    setCreating(false)
    if (wasEditing) {
      await mutate('PATCH', `/api/tasks/${wasEditing.id}`, patch)
    } else {
      // v1.8 — Une nouvelle tâche appartient toujours au projet courant.
      await mutate('POST', '/api/tasks', {
        id: makeId('t'),
        ...patch,
        project_id: currentProjectId ?? undefined,
      })
    }
    // v1.22 — Replan automatique uniquement à l'édition (la case n'est pas
    // proposée à la création). On va chercher l'état le plus frais via
    // l'API plutôt que `state` du closure (qui peut être en retard d'un
    // tick par rapport au PATCH qu'on vient d'envoyer).
    if (wasEditing && options.replan) {
      try {
        const url = currentProjectId
          ? `/api/state?project_id=${encodeURIComponent(currentProjectId)}`
          : '/api/state'
        const res = await fetch(url)
        if (!res.ok) return
        const data: GanttState = await res.json()
        // v2.0 / F2/F3 — Replan automatique post-save : consomme aussi la
        // capacité allouée et les absences pour rester cohérent avec le
        // replan manuel.
        const moves = replanTasks(
          sortTasksHierarchically(data.tasks),
          data.member_allocations,
          data.collaborator_absences,
        )
        await submitReplanMoves(moves)
      } catch (err) {
        console.error('[auto-replan]', err)
        setStatus('error')
      }
    }
  }

  // ---------------------------------------------------------------------------
  // v1.8 — Gestion des projets (création, renommage, suppression, sélection)
  // ---------------------------------------------------------------------------

  /** Change de projet courant et persiste le choix. */
  const handleSelectProject = (id: string) => {
    setCurrentProjectId(id)
    lsSet(LS_CURRENT_PROJECT, id)
    // Reset du drapeau de cadrage initial pour qu'on recale la fenêtre
    // temporelle sur les tâches du nouveau projet.
    initialWindowSet.current = false
  }

  /**
   * Crée un nouveau projet (prompt simple) ET bascule l'app dessus.
   *
   * v2.2 — On passe par `handleProjectSelectionChange` plutôt que par
   * `handleSelectProject` directement : sans ça, le `projectSelection`
   * (source de vérité du <ProjectFilter>) restait sur l'ancien projet
   * alors que `currentProjectId` pointait sur le nouveau, ce qui faisait
   * croire à l'utilisateur que la bascule n'avait pas eu lieu. Voir aussi
   * le garde-fou symétrique dans handleProjectSelectionChange / selectView.
   */
  const handleCreateProject = async () => {
    const raw = await askPrompt('Nom du nouveau projet :', 'Nouveau projet')
    const name = raw?.trim()
    if (!name) return
    const id = makeId('p')
    await mutate('POST', '/api/projects', { id, name })
    handleProjectSelectionChange({ mode: 'single', projectId: id })
  }

  /** Renomme le projet courant (prompt). */
  const handleRenameProject = async () => {
    if (!currentProject) return
    const raw = await askPrompt('Nouveau nom :', currentProject.name)
    const name = raw?.trim()
    if (!name || name === currentProject.name) return
    await mutate('PATCH', `/api/projects/${currentProject.id}`, { name })
  }

  /** Supprime le projet courant après confirmation.
   *
   * v1.24 — Règle RG-GANTT-1106 : la suppression est désormais autorisée
   * même si c'est le DERNIER projet. Dans ce cas, on confirme avec un
   * message renforcé pour bien avertir l'utilisateur du résultat (base
   * vide, plus rien à afficher). */
  const handleDeleteProject = async () => {
    if (!currentProject || !state) return
    const isLast = state.projects.length <= 1
    const ok = await askConfirm(
      isLast
        ? `Supprimer le projet « ${currentProject.name} » ?\n\nC'est le dernier projet : la base sera vide après suppression. Vous pourrez créer un nouveau projet à tout moment.`
        : `Supprimer le projet « ${currentProject.name} » et toutes ses tâches ?\n\nCette action est irréversible.`,
    )
    if (!ok) return
    // Si un autre projet existe, on bascule dessus AVANT la suppression
    // pour que le refetch ne reparte pas sur un id invalide. Sinon (cas
    // « dernier projet »), le serveur renverra current_project_id = null
    // et la vue affichera l'état vide.
    const fallback = state.projects.find((p) => p.id !== currentProject.id)
    if (fallback) handleSelectProject(fallback.id)
    await mutate('DELETE', `/api/projects/${currentProject.id}`)
  }

  /** Suppression de la tâche en cours d'édition. */
  const handleDeleteTask = async () => {
    if (!editing) return
    if (!(await askConfirm(`Supprimer « ${editing.name} » ?`))) return
    mutate('DELETE', `/api/tasks/${editing.id}`)
    setEditing(null)
  }

  /**
   * v1.5 — Déplacement par drag & drop : appelle l'endpoint /move avec
   * { parent_id, before_id }.
   *
   * @param draggedId  Id de la tâche déplacée.
   * @param parentId   Nouveau parent (null = racine).
   * @param beforeId   Id du sibling avant lequel insérer (null = en fin).
   */
  const handleMoveTask = (
    draggedId: string,
    parentId: string | null,
    beforeId: string | null,
  ) => {
    mutate('POST', `/api/tasks/${draggedId}/move`, {
      parent_id: parentId,
      before_id: beforeId,
    })
  }

  /**
   * v1.9 — Redimensionnement / déplacement par drag sur la barre dans le
   * planning. Patch les dates côté API (le DAL gère ensuite la borne
   * prédécesseur et le recalcul des phases ancêtres).
   *
   * @param taskId  Id de la tâche modifiée.
   * @param patch   { start_date?, end_date? }
   */
  const handleResizeTask = (
    taskId: string,
    patch: { start_date?: string; end_date?: string },
  ) => {
    mutate('PATCH', `/api/tasks/${taskId}`, patch)
  }

  /**
   * v1.23 — F2 : création d'un lien prédécesseur par drag-to-link dans le
   * planning. Lit la liste actuelle de prédécesseurs de la tâche cible et
   * ajoute la source (lag=0). Si elle est déjà présente, no-op. Le serveur
   * filtre silencieusement les cycles indirects (cf. `wouldCreateCycle`
   * dans le DAL).
   *
   * @param sourceId  Id de la tâche source (handle d'origine).
   * @param targetId  Id de la tâche cible (réceptrice du nouveau lien).
   */
  const handleCreateLink = (sourceId: string, targetId: string) => {
    if (!state) return
    const target = state.tasks.find((t) => t.id === targetId)
    if (!target) return
    // Cible phase : pas de lien possible (filtré aussi côté GanttChart).
    if (target.kind === 'phase') return
    const current = target.predecessors ?? []
    if (current.some((p) => p.id === sourceId)) return // déjà lié
    const next = [...current, { id: sourceId, lag: 0 }]
    mutate('PATCH', `/api/tasks/${targetId}`, { predecessors: next })
  }

  /**
   * v1.23 — F4 : suppression d'un lien prédécesseur par clic sur la flèche
   * dans le planning. Lit la liste actuelle des prédécesseurs de la tâche
   * cible et en retire l'entrée correspondant à `sourceId`. La confirmation
   * utilisateur (`window.confirm`) est demandée par `PredecessorArrows`
   * AVANT que ce handler soit invoqué — ici, on applique directement.
   *
   * @param sourceId  Id du prédécesseur retiré.
   * @param targetId  Id de la tâche dont on retire le lien.
   */
  const handleDeleteLink = (sourceId: string, targetId: string) => {
    if (!state) return
    const target = state.tasks.find((t) => t.id === targetId)
    if (!target) return
    const current = target.predecessors ?? []
    const next = current.filter((p) => p.id !== sourceId)
    // Si rien n'a changé (id absent), inutile de PATCH (évite un bump de
    // version « gratuit » en base et un round-trip réseau).
    if (next.length === current.length) return
    mutate('PATCH', `/api/tasks/${targetId}`, { predecessors: next })
  }

  /**
   * v1.11 — Bascule l'affichage des dates des barres et persiste le choix
   * en localStorage.
   */
  const toggleShowDates = () => {
    setShowDates((v) => {
      const next = !v
      lsSet(LS_SHOW_DATES, next ? '1' : '0')
      return next
    })
  }

  /**
   * v1.13 — Bascule l'affichage du nom des tâches dans les barres et
   * persiste le choix. Défaut = affiché ; on n'écrit '0' que pour la
   * négation (la clé absente compte donc comme « affiché »).
   */
  const toggleShowBarNames = () => {
    setShowBarNames((v) => {
      const next = !v
      lsSet(LS_SHOW_BAR_NAMES, next ? '1' : '0')
      return next
    })
  }

  /**
   * v1.16 — Bascule l'onglet actif et persiste le choix. Pas de no-op si
   * `next === view` (le bouton se contente d'appeler setView(next), React
   * détecte l'égalité référentielle).
   */
  const selectView = (next: View) => {
    setView(next)
    lsSet(LS_VIEW, next)
    // v2.2 / F3 refondu — Le Gantt est mono-projet par design. Si l'utilisateur
    // bascule depuis Charge/Affectation en mode 'all', on retombe automatiquement
    // sur le projet d'édition actif (currentProjectId) pour éviter une vue vide.
    if (
      next === 'gantt' &&
      projectSelection.mode === 'all' &&
      currentProjectId
    ) {
      const fallback: ProjectSelection = {
        mode: 'single',
        projectId: currentProjectId,
      }
      setProjectSelection(fallback)
      lsSet(LS_PROJECT_SELECTION, JSON.stringify(fallback))
    }
  }

  /**
   * v1.17 — Bascule l'option « sous-charges en jaune » sur la vue Charge
   * et persiste le choix.
   */
  const toggleHighlightUnderload = () => {
    setHighlightUnderload((v) => {
      const next = !v
      lsSet(LS_HIGHLIGHT_UNDERLOAD, next ? '1' : '0')
      return next
    })
  }

  /**
   * v2.2 / F3 — Callback unique de `<ProjectFilter>` : applique la nouvelle
   * sélection (single / all / subset), persiste en localStorage, et synchronise
   * `currentProjectId` quand on passe en mode single sur un nouveau projet
   * (déclenche le re-fetch de /api/state via le useEffect dédié).
   */
  const handleProjectSelectionChange = (next: ProjectSelection) => {
    setProjectSelection(next)
    lsSet(LS_PROJECT_SELECTION, JSON.stringify(next))
    // Synchronise le « projet d'édition actif » uniquement en mode single :
    // en multi (all / subset), on conserve le dernier projet single pour ne
    // pas perdre le contexte d'édition au retour en single.
    if (next.mode === 'single' && next.projectId !== currentProjectId) {
      handleSelectProject(next.projectId)
    }
  }

  /**
   * v2.0 / F5 — Fetch des tâches cross-projet pour le plan de charge global.
   * Déclenché à chaque passage en mode global ET à chaque incrément de
   * version (pour refléter les mutations entre-temps). En mode current, on
   * vide le cache local pour ne pas servir une version périmée en cas de
   * re-bascule.
   */
  useEffect(() => {
    if (workloadScope !== 'global' || !state) {
      // Reset au passage en current (libère la mémoire et évite les fuites
      // de données entre projets si l'utilisateur bascule plusieurs fois).
      // setState dans l'effect est ici intentionnel (subscribe à un système
      // externe : l'API HTTP) — on désactive la règle React 19 dédiée.
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setGlobalTasks(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/workload/global')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: { tasks: Task[] } = await res.json()
        if (!cancelled) setGlobalTasks(data.tasks)
      } catch (err) {
        console.error('[workload/global]', err)
        if (!cancelled) setGlobalTasks([])
      }
    })()
    return () => {
      cancelled = true
    }
    // On dépend uniquement de `workloadScope` et `state?.version` (entier
    // monotone) : `state` complet provoquerait un re-fetch à chaque mutation
    // alors que la version suffit à signaler un changement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workloadScope, state?.version])

  /**
   * v1.20 — Bascule l'état replié/déplié d'une phase. Persiste le set
   * mis à jour en localStorage. Aucune mutation côté serveur.
   *
   * @param phaseId  Id de la phase à basculer.
   */
  const toggleCollapse = useCallback((phaseId: string) => {
    setCollapsedPhases((prev) => {
      const next = new Set(prev)
      if (next.has(phaseId)) next.delete(phaseId)
      else next.add(phaseId)
      lsSet(LS_COLLAPSED_PHASES, JSON.stringify([...next]))
      return next
    })
  }, [])

  /**
   * v1.18 / v1.21 — Ouvre la modal d'aperçu de replanification.
   *
   *   • `scope='full'`    : toutes les tâches sont candidates au déplacement
   *                         (comportement historique).
   *   • `scope='partial'` : seules les tâches concernées par les incohérences
   *                         actuelles (et leurs successeurs transitifs) sont
   *                         déplaçables ; les autres restent verrouillées
   *                         comme obstacles dans le timeline.
   *
   * Calcule les déplacements via la fonction pure `replanTasks` ; si aucun
   * déplacement n'est nécessaire, affiche un alert et n'ouvre pas la modal.
   *
   * @param scope  Portée du replan (cf. ci-dessus).
   */
  const handleOpenReplan = async (scope: 'full' | 'partial' = 'full') => {
    if (!state) return
    // v2.0 / F2 — Le replan consomme la capacité quotidienne réelle de chaque
    // collab : on lui passe `member_allocations` du projet courant.
    // v2.0 / F3 — Les absences personnelles (cross-projet) sont également
    // injectées pour que la pondération multiplicative s'applique aussi pendant
    // le replan (sinon le replan replacerait des tâches sur des jours en congé).
    const allocs = state.member_allocations
    const absences = state.collaborator_absences
    // v2.1 / F2.9.C — Avant tout calcul de replan, vérifier que TOUTES les
    // activités du projet courant ont une allocation suffisante. Si certaines
    // ne sont pas absorbables, on bloque et on propose une extension en lot
    // via le `ReplanAllocationFixDialog` (Q4=B : dialog récapitulatif unique).
    if (state.current_project_id) {
      const shortfallItems = scanReplanShortfalls(
        orderedTasks,
        state.current_project_id,
        allocs,
        absences,
      )
      if (shortfallItems.length > 0) {
        setReplanShortfall({ items: shortfallItems, scope })
        return
      }
    }
    // v2.2 — Replan partiel abandonné (RG-GANTT-0905 supprimée) ; toutes les
    // activités sont candidates au déplacement.
    const moves = replanTasks(orderedTasks, allocs, absences)
    if (moves.length === 0) {
      await askAlert(
        scope === 'partial'
          ? 'Aucun déplacement nécessaire — les incohérences ne peuvent pas être résolues sans déverrouiller d’autres tâches (essayez « Replan complet »).'
          : 'Aucune surcharge détectée — rien à replanifier.',
      )
      return
    }
    setReplanPreview(moves)
  }

  /**
   * v2.1 / F2.9.C — Callback du `ReplanAllocationFixDialog` : exécute en
   * série les plans d'extension validés par l'utilisateur, puis re-déclenche
   * automatiquement `handleOpenReplan(scope)` via `pendingReplanScope` une
   * fois le state rafraîchi (cf. useEffect plus bas).
   *
   * Si l'extension échoue à mi-chemin, `handleExtendAllocations` affiche déjà
   * un `askAlert` et le dialog reste ouvert (état `replanShortfall` non
   * touché) → l'utilisateur peut réessayer ou annuler.
   */
  const handleApplyReplanExtensions = async (plans: ExtensionPlan[]) => {
    if (!replanShortfall) return
    const scope = replanShortfall.scope
    try {
      for (const plan of plans) {
        await handleExtendAllocations(plan)
      }
      setReplanShortfall(null)
      setPendingReplanScope(scope)
    } catch {
      // L'erreur a déjà été affichée par `handleExtendAllocations`.
    }
  }

  /**
   * v2.1 / F2.9.C — Quand des extensions ont été appliquées en amont d'un
   * replan, on attend que le `state` React soit rafraîchi (changement de
   * `version`) avant de relancer `handleOpenReplan` avec le scope mémorisé.
   * Évite la race condition : appeler `handleOpenReplan` juste après
   * `fetchState()` lirait l'ancien `state` (le setState est asynchrone).
   */
  useEffect(() => {
    if (!pendingReplanScope || !state) return
    const scope = pendingReplanScope
    /* eslint-disable react-hooks/set-state-in-effect */
    setPendingReplanScope(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    void handleOpenReplan(scope)
    // `handleOpenReplan` n'est pas listé en deps : il dépend de `state` et
    // `orderedTasks` qui sont déjà couverts par le dep `state?.version` via
    // re-création du closure à chaque render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.version, pendingReplanScope])

  /**
   * v1.18 — Applique les déplacements de l'aperçu (modal Replan). Délègue à
   * `submitReplanMoves` (cf. plus haut) pour mutualiser le code de cascade
   * de PATCH + resync. La modal est fermée AVANT la 1re requête pour ne pas
   * laisser un état "Appliquer" cliquable pendant la propagation.
   */
  const handleApplyReplan = async () => {
    if (!replanPreview || replanPreview.length === 0) return
    const moves = replanPreview
    setReplanPreview(null)
    await submitReplanMoves(moves)
  }

  /** Décalle la fenêtre temporelle de N jours (négatif = passé). */
  const shiftWindow = (days: number) => {
    setWindow((w) => {
      const start = new Date(w.startIso)
      const end = new Date(w.endIso)
      start.setDate(start.getDate() + days)
      end.setDate(end.getDate() + days)
      return {
        startIso: start.toISOString().slice(0, 10),
        endIso: end.toISOString().slice(0, 10),
      }
    })
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* ---------------------------------------------------------------- */}
      {/* HEADER — titre + statut + actions                                */}
      {/* ---------------------------------------------------------------- */}
      {/* v1.8 — Header compact sur une seule ligne. Boutons icône avec
          tooltip pour les actions, libellés ultracourts pour le reste.
          `flex-nowrap` + `overflow-hidden` empêchent le retour à la ligne ;
          le select projet `min-w-0` peut rétrécir si nécessaire. */}
      <header className="bg-white border-b border-slate-200 px-3 py-2 flex items-center gap-2 flex-nowrap overflow-hidden whitespace-nowrap">
        <h1 className="text-lg font-bold text-slate-800 shrink-0" title="Gantt">
          📊
        </h1>

        <ViewTabs view={view} onChange={selectView} />

        {/* v1.8 — Sélecteur de projet + actions CRUD.
            v2.2 / F3 refondu — Le sélecteur est :
              • masqué sur l'onglet Congés (les absences sont cross-projet
                par nature : la notion de projet n'a aucun sens ici) ;
              • limité à la sélection mono-projet sur l'onglet Gantt
                (allowAll=false : pas d'option « Tous les projets »).
            Pour permettre malgré tout les actions CRUD projet (créer,
            renommer, supprimer) depuis la vue Congés, on garde le bloc
            visible mais on cache uniquement le <ProjectFilter>. */}
        {state && (
          <div className="flex items-center gap-1 pl-2 border-l border-slate-200 min-w-0">
            {view !== 'absences' && (
              <ProjectFilter
                projects={state.projects}
                selection={projectSelection}
                onChange={handleProjectSelectionChange}
                allowAll={view !== 'gantt'}
              />
            )}
            <Tooltip label="Nouveau projet">
              <button
                className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
                onClick={handleCreateProject}
              >
                +
              </button>
            </Tooltip>
            <Tooltip
              label={
                isGlobalView
                  ? 'Édition désactivée en multi-projets : sélectionne un projet unique'
                  : 'Renommer le projet'
              }
            >
              <button
                className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleRenameProject}
                disabled={!currentProject || isGlobalView}
              >
                ✎
              </button>
            </Tooltip>
            {/* v1.24 — Règle RG-GANTT-1106 : la suppression est autorisée
                même pour le dernier projet. Le bouton n'est désactivé que
                lorsqu'il n'y a aucun projet courant (cas "base vide") ou en
                multi-projets (v2.2 / F3). */}
            <Tooltip
              label={(() => {
                if (isGlobalView) {
                  return 'Édition désactivée en multi-projets : sélectionne un projet unique'
                }
                if (state.projects.length <= 1) {
                  return 'Supprimer le projet (base vide après suppression)'
                }
                return 'Supprimer le projet'
              })()}
            >
              <button
                className="w-7 h-7 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                onClick={handleDeleteProject}
                disabled={!currentProject || isGlobalView}
              >
                🗑
              </button>
            </Tooltip>
          </div>
        )}

        {/* Navigation temporelle — icônes seules + tooltips */}
        <div className="flex items-center gap-1 pl-2 border-l border-slate-200 shrink-0">
          <Tooltip label="Reculer d'un mois">
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => shiftWindow(-30)}
            >
              «
            </button>
          </Tooltip>
          <Tooltip label="Reculer d'une semaine">
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => shiftWindow(-7)}
            >
              ‹
            </button>
          </Tooltip>
          <Tooltip label="Recentrer sur aujourd'hui">
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => setWindow(defaultWindow())}
            >
              ⌂
            </button>
          </Tooltip>
          <Tooltip label="Avancer d'une semaine">
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => shiftWindow(7)}
            >
              ›
            </button>
          </Tooltip>
          <Tooltip label="Avancer d'un mois">
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => shiftWindow(30)}
            >
              »
            </button>
          </Tooltip>
        </div>

        {/* Zoom — slider plus court, libellé masqué */}
        <div
          className="flex items-center gap-1 pl-2 border-l border-slate-200 shrink-0"
          title="Zoom (largeur d'un jour)"
        >
          <Tooltip label="Dézoomer">
            <button
              className="w-7 h-7 rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => setDayWidth((v) => clampDayWidth(v - 4))}
            >
              −
            </button>
          </Tooltip>
          <input
            type="range"
            min={MIN_DAY_WIDTH}
            max={MAX_DAY_WIDTH}
            value={dayWidth}
            onChange={(e) => setDayWidth(clampDayWidth(Number(e.target.value)))}
            className="w-24"
          />
          <Tooltip label="Zoomer">
            <button
              className="w-7 h-7 rounded border border-slate-300 hover:bg-slate-100"
              onClick={() => setDayWidth((v) => clampDayWidth(v + 4))}
            >
              +
            </button>
          </Tooltip>
        </div>

        {/* Actions globales — alignées à droite, icônes seules */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* v1.17 — Toggle « sous-charges en jaune » : ne s'affiche que
              sur l'onglet Plan de charge (effet visible uniquement sur les
              cellules). Fond jaune pâle quand actif pour rappeler la palette
              qu'il déclenche. */}
          {view === 'workload' && (
            <Tooltip
              label={
                highlightUnderload
                  ? 'Masquer la mise en évidence des sous-charges'
                  : 'Mettre en évidence les sous-charges (< 1 j) en jaune'
              }
            >
              <button
                className={[
                  'w-7 h-7 text-sm rounded border border-slate-300',
                  highlightUnderload
                    ? 'bg-yellow-200 text-yellow-900 border-yellow-400'
                    : 'hover:bg-slate-100',
                ].join(' ')}
                onClick={toggleHighlightUnderload}
                aria-pressed={highlightUnderload}
              >
                🟡
              </button>
            </Tooltip>
          )}
          {/* v2.2 / F2 — Le bouton « 🌐 Global / 📁 Courant » a été retiré :
              sa fonction est désormais intégrée au <ProjectFilter> via l'option
              « 🌐 Tous les projets ». */}
          {/* v1.16 — Les toggles "nom" et "dates" ne concernent que la vue
              Gantt (rendu des barres). On les masque sur la vue Charge. */}
          {view === 'gantt' && (
            <>
              {/* v1.13 — Toggle d'affichage du nom des tâches dans les barres.
                  ACTIF par défaut : fond bleu pâle quand affiché, neutre quand
                  masqué (T sans fond = "texte masqué"). */}
              <Tooltip
                label={
                  showBarNames
                    ? 'Masquer le nom des tâches dans les barres'
                    : 'Afficher le nom des tâches dans les barres'
                }
              >
                <button
                  className={[
                    'w-7 h-7 text-xs rounded border border-slate-300',
                    showBarNames
                      ? 'bg-blue-100 text-blue-700 border-blue-300'
                      : 'hover:bg-slate-100',
                  ].join(' ')}
                  onClick={toggleShowBarNames}
                  aria-pressed={showBarNames}
                >
                  T
                </button>
              </Tooltip>
              {/* v1.11 — Toggle d'affichage des dates de début/fin sur les barres.
                  État actif (showDates=true) souligné par un fond bleu pâle. */}
              <Tooltip
                label={
                  showDates
                    ? 'Masquer les dates sur les barres'
                    : 'Afficher les dates de début/fin sur les barres'
                }
              >
                <button
                  className={[
                    'w-7 h-7 text-sm rounded border border-slate-300',
                    showDates
                      ? 'bg-blue-100 text-blue-700 border-blue-300'
                      : 'hover:bg-slate-100',
                  ].join(' ')}
                  onClick={toggleShowDates}
                  aria-pressed={showDates}
                >
                  📅
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip
            label={
              isGlobalView
                ? 'Édition désactivée en multi-projets : sélectionne un projet unique'
                : 'Nouvelle tâche / jalon / phase'
            }
          >
            <button
              className="h-7 px-2 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => setCreating(true)}
              disabled={isGlobalView}
            >
              + Tâche
            </button>
          </Tooltip>
          {/* v1.18 — Replan : analyse les surcharges et propose un aperçu
              des déplacements ; appliqué seulement après confirmation.
              v2.2 / F3 — Désactivé en multi-projets (le solveur opère sur un
              seul projet à la fois). */}
          <Tooltip
            label={
              isGlobalView
                ? 'Replan désactivé en multi-projets : sélectionne un projet unique'
                : 'Replanifier automatiquement les tâches en surcharge'
            }
          >
            <button
              className="h-7 px-2 text-sm rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => handleOpenReplan('full')}
              disabled={!state || isGlobalView}
            >
              🔄 Replan
            </button>
          </Tooltip>
          <Tooltip label="Capture PNG du Gantt (pour PowerPoint)">
            <button
              className="w-7 h-7 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={handleScreenshot}
            >
              📷
            </button>
          </Tooltip>
          <Tooltip label="Restaurer les données de démonstration" align="end">
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={handleReset}
            >
              ↺
            </button>
          </Tooltip>
          <StatusBadge status={status} />
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* CONTENU PRINCIPAL — Gantt OU Plan de charge selon l'onglet        */}
      {/* ---------------------------------------------------------------- */}
      {/* v1.16 — Le ganttRef enveloppe les deux vues : la capture PNG du
          bouton 📷 fonctionne donc indifféremment sur le planning ou sur
          le plan de charge (selon ce qui est affiché). */}
      <main className="flex-1 p-4 overflow-auto">
        {state ? (
          <div ref={ganttRef}>
            {/* v1.21 — Bandeau d'alerte des incohérences (au-dessus du planning).
                Auto-masqué quand `coherenceIssues` est vide. N'apparaît que sur
                la vue Gantt pour ne pas surcharger le plan de charge. */}
            {view === 'gantt' && (
              <CoherenceAlert
                issues={coherenceIssues}
                onReplanFull={() => handleOpenReplan('full')}
                onReplanPartial={() => handleOpenReplan('partial')}
              />
            )}
            {/* v2.0 / F1 — Trois vues désormais : 'gantt', 'workload' ou
                'members'. On bascule explicitement (les sonarjs ternaires
                imbriqués deviendraient ingérables sinon). */}
            {view === 'gantt' && (
              <GanttChart
                windowStart={startIso}
                windowEnd={endIso}
                dayWidth={dayWidth}
                tasks={visibleTasks}
                allTasks={orderedTasks}
                collaborators={state.collaborators}
                onTaskClick={setEditing}
                onMoveTask={handleMoveTask}
                onResizeTask={handleResizeTask}
                onCreateLink={handleCreateLink}
                onDeleteLink={handleDeleteLink}
                showDates={showDates}
                showBarNames={showBarNames}
                onShiftWindow={shiftWindow}
                collapsedPhases={collapsedPhases}
                onToggleCollapse={toggleCollapse}
              />
            )}
            {view === 'workload' && (
              <WorkloadChart
                windowStart={startIso}
                windowEnd={endIso}
                dayWidth={dayWidth}
                tasks={orderedTasks}
                collaborators={state.collaborators}
                memberAllocations={state.member_allocations}
                allMemberAllocations={state.all_member_allocations}
                absences={state.collaborator_absences}
                scope={workloadScope}
                // v2.2 / F3 — Tâches globales effectivement affichées :
                // filtrées par sous-ensemble en mode 'subset', sinon brutes.
                // Calcul mémoïsé : voir `effectiveGlobalTasks`.
                globalTasks={effectiveGlobalTasks}
                highlightUnderload={highlightUnderload}
                onShiftWindow={shiftWindow}
              />
            )}
            {view === 'members' && projectSelection.mode === 'single' && (
              <MembersGrid
                windowStart={startIso}
                windowEnd={endIso}
                dayWidth={dayWidth}
                collaborators={state.collaborators}
                memberIds={state.current_project_members}
                memberAllocations={state.member_allocations}
                projectName={currentProject?.name ?? null}
                projectId={state.current_project_id}
                onAddMember={handleAddProjectMember}
                onCreateCollaborator={handleCreateCollaborator}
                onAddAllocation={handleAddMemberAllocation}
                onCommitChanges={handleCommitAllocationGrid}
                onShiftWindow={shiftWindow}
              />
            )}
            {/* v2.2 / F5 — Vue Affectation en mode « Tous les projets ». */}
            {view === 'members' && projectSelection.mode === 'all' && (
              <MembersGridGlobal
                windowStart={startIso}
                windowEnd={endIso}
                dayWidth={dayWidth}
                projects={state.projects}
                collaborators={state.collaborators}
                allProjectMembers={state.all_project_members}
                allMemberAllocations={state.all_member_allocations}
                onCommitCellChange={handleCommitGlobalCellChange}
                onShiftWindow={shiftWindow}
              />
            )}
            {view === 'absences' && (
              <AbsencesGrid
                windowStart={startIso}
                windowEnd={endIso}
                dayWidth={dayWidth}
                collaborators={state.collaborators}
                absences={state.collaborator_absences}
                onCommitChanges={handleCommitAbsencesGrid}
                onAddPeriod={handleAddAbsencePeriod}
                onShiftWindow={shiftWindow}
              />
            )}
          </div>
        ) : (
          <p className="text-slate-500">Chargement…</p>
        )}
      </main>

      {/* ---------------------------------------------------------------- */}
      {/* MODAL d'édition / création                                       */}
      {/* ---------------------------------------------------------------- */}
      {/* v1.18 — Modal d'aperçu Replan (fermée si replanPreview est null). */}
      {replanPreview && state && (
        <ReplanPreviewModal
          moves={replanPreview}
          collaborators={state.collaborators}
          onCancel={() => setReplanPreview(null)}
          onApply={handleApplyReplan}
        />
      )}

      {/* v2.1 / F2.9.D — Modal de blocage du Replan par allocations
          insuffisantes (Q4=B : récapitulatif unique, cochable, avec date + %
          par tâche). S'ouvre depuis `handleOpenReplan` et se ferme soit par
          « Annuler le replan », soit après que les extensions choisies ont
          été appliquées (auto-relance du replan via pendingReplanScope). */}
      {replanShortfall && state && state.current_project_id && (
        <ReplanAllocationFixDialog
          items={replanShortfall.items}
          projectId={state.current_project_id}
          collaborators={state.collaborators}
          allocations={state.member_allocations}
          absences={state.collaborator_absences}
          onApply={handleApplyReplanExtensions}
          onCancel={() => setReplanShortfall(null)}
        />
      )}

      {(editing || creating) && state && (
        <TaskEditor
          task={editing}
          defaults={
            creating
              ? {
                  // v1.3 — Dates par défaut = aujourd'hui (et non plus
                  // le 1er du mois affiché), pour ne pas créer une tâche
                  // dans le passé sans s'en rendre compte.
                  start_date: todayIso(),
                  end_date: todayIso(),
                  kind: 'task',
                  progress: 0,
                }
              : undefined
          }
          collaborators={state.collaborators}
          memberIds={state.current_project_members}
          memberAllocations={state.member_allocations}
          absences={state.collaborator_absences}
          projectId={state.current_project_id}
          tasks={orderedTasks}
          onSave={handleSaveTask}
          onClose={() => {
            setEditing(null)
            setCreating(false)
          }}
          onDelete={editing ? handleDeleteTask : undefined}
          onExtendAllocations={handleExtendAllocations}
        />
      )}
      {/* Mount unique des modales custom (confirm / prompt). Doit rester
          en bas pour passer au-dessus du reste en z-index. */}
      <Dialogs />
    </div>
  )
}

/**
 * Convertit une réponse HTTP d'erreur (400/404/500) en message utilisateur
 * lisible. Tente de parser le JSON `{ error, details: [{ where, path, message }] }`
 * renvoyé par l'API ; à défaut, retombe sur le texte brut.
 *
 * @param res  Réponse HTTP (déjà constatée non-ok).
 * @returns    Chaîne courte affichable à l'utilisateur.
 */
/**
 * Formate un détail Zod (`{ where, path, message }`) en ligne lisible.
 * @param d  Objet détail tel que renvoyé par l'API.
 */
function formatErrorDetail(d: { path?: unknown; message?: unknown }): string {
  const path = Array.isArray(d.path) ? d.path.join('.') : ''
  return `• ${path ? path + ' : ' : ''}${d.message}`
}

async function formatApiError(res: Response): Promise<string> {
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return `HTTP ${res.status}`
  }
  if (!data || typeof data !== 'object' || !('error' in data)) {
    return JSON.stringify(data)
  }
  const lines: string[] = [String((data as { error: unknown }).error)]
  const details = (data as { details?: unknown }).details
  if (Array.isArray(details)) {
    for (const d of details) lines.push(formatErrorDetail(d))
  }
  return lines.join('\n')
}

/**
 * v1.16 — Onglets compacts « Gantt | Charge » utilisés dans le header.
 * Extrait de `App` pour alléger sa complexité cognitive.
 *
 * @param view      Onglet actuellement sélectionné.
 * @param onChange  Callback appelé avec la nouvelle vue lors d'un clic.
 */
function ViewTabs({
  view,
  onChange,
}: {
  view: View
  onChange: (v: View) => void
}) {
  // v2.2 — Les tooltips des onglets utilisent désormais <Tooltip> custom
  // (et non plus l'attribut HTML `title=`) pour un rendu cohérent avec le
  // reste de la toolbar (couleur, délai, position).
  return (
    <div
      className="flex items-center rounded border border-slate-300 overflow-hidden shrink-0"
      role="tablist"
      aria-label="Vue"
    >
      <Tooltip label="Vue planning Gantt">
        <button
          className={[
            'h-7 px-2 text-xs font-medium',
            view === 'gantt'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-white text-slate-700 hover:bg-slate-100',
          ].join(' ')}
          onClick={() => onChange('gantt')}
          role="tab"
          aria-selected={view === 'gantt'}
        >
          Gantt
        </button>
      </Tooltip>
      <Tooltip label="Vue plan de charge par collaborateur">
        <button
          className={[
            'h-7 px-2 text-xs font-medium border-l border-slate-300',
            view === 'workload'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-white text-slate-700 hover:bg-slate-100',
          ].join(' ')}
          onClick={() => onChange('workload')}
          role="tab"
          aria-selected={view === 'workload'}
        >
          Charge
        </button>
      </Tooltip>
      {/* v2.0 / F1 — Onglet « Affectation projet » : liste les collaborateurs
          membres du projet courant et permet d'en ajouter. */}
      <Tooltip label="Affecter les collaborateurs au projet">
        <button
          className={[
            'h-7 px-2 text-xs font-medium border-l border-slate-300',
            view === 'members'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-white text-slate-700 hover:bg-slate-100',
          ].join(' ')}
          onClick={() => onChange('members')}
          role="tab"
          aria-selected={view === 'members'}
        >
          Affectation
        </button>
      </Tooltip>
      {/* v2.0 / F3 — Onglet « Congés » (cross-projet) : saisie des absences
          de chaque collab. L'absence diminue multiplicativement la capacité
          du collab sur tous ses projets simultanément. */}
      <Tooltip label="Gérer les absences (congés) — cross-projet">
        <button
          className={[
            'h-7 px-2 text-xs font-medium border-l border-slate-300',
            view === 'absences'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-white text-slate-700 hover:bg-slate-100',
          ].join(' ')}
          onClick={() => onChange('absences')}
          role="tab"
          aria-selected={view === 'absences'}
        >
          Congés
        </button>
      </Tooltip>
    </div>
  )
}

/**
 * v1.18 — Modal d'aperçu des déplacements proposés par « Replan ». Liste
 * chaque tâche déplacée (nom, collaborateur, anciennes vs nouvelles dates)
 * et propose Annuler / Appliquer. La fonction `replanTasks` est appelée en
 * amont par le caller : on reçoit déjà les `moves` à afficher.
 *
 * @param moves          Déplacements à présenter.
 * @param collaborators  Pour afficher le nom du collab à côté de chaque tâche.
 * @param onCancel       Ferme la modal sans rien appliquer.
 * @param onApply        Lance les PATCH (séquentiels) sur les tâches.
 */
function ReplanPreviewModal({
  moves,
  collaborators,
  onCancel,
  onApply,
}: {
  moves: ReplanMove[]
  collaborators: Collaborator[]
  onCancel: () => void
  onApply: () => void
}) {
  // Index id → nom pour lookup rapide.
  const collabName = new Map(collaborators.map((c) => [c.id, c.name]))
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-label="Aperçu de la replanification"
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          🔄 Replanification — {moves.length} tâche
          {moves.length > 1 ? 's' : ''} à déplacer
        </h2>
        <p className="text-xs text-slate-600">
          Les tâches ci-dessous seront décalées dans le temps pour résoudre les
          surcharges de collaborateur, en respectant les prédécesseurs et les
          priorités. Aucune tâche n'est avancée ; seules les dates sont
          modifiées (la charge en jours ouvrés est préservée).
        </p>
        <div className="max-h-96 overflow-y-auto border border-slate-200 rounded">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 sticky top-0">
              <tr className="text-left text-slate-600">
                <th className="px-2 py-1.5">Tâche</th>
                <th className="px-2 py-1.5">Collaborateur</th>
                <th className="px-2 py-1.5">Avant</th>
                <th className="px-2 py-1.5">Après</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-medium">{m.name}</td>
                  <td className="px-2 py-1.5 text-slate-600">
                    {m.collaborator_id
                      ? (collabName.get(m.collaborator_id) ?? '—')
                      : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {m.oldStart} → {m.oldEnd}
                  </td>
                  <td className="px-2 py-1.5 text-emerald-700 font-medium">
                    {m.newStart} → {m.newEnd}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
            onClick={onCancel}
          >
            Annuler
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-amber-500 text-white hover:bg-amber-600"
            onClick={onApply}
          >
            Appliquer
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Petit badge de statut réseau (en haut à droite). v1.8 — Compacté en
 * icône seule pour tenir sur une ligne ; le label complet reste accessible
 * via le tooltip `title`.
 */
function StatusBadge({ status }: { status: NetStatus }) {
  const cfg = {
    idle: {
      text: '…',
      label: 'En attente',
      cls: 'bg-slate-200 text-slate-600',
    },
    loading: {
      text: '⟳',
      label: 'Sauvegarde en cours',
      cls: 'bg-amber-100 text-amber-700',
    },
    ok: {
      text: '✓',
      label: 'Synchronisé',
      cls: 'bg-emerald-100 text-emerald-700',
    },
    error: {
      text: '✕',
      label: 'Erreur réseau',
      cls: 'bg-red-100 text-red-700',
    },
  }[status]
  return (
    <Tooltip label={cfg.label} align="end">
      <span
        className={`inline-flex items-center justify-center w-7 h-7 text-sm rounded ${cfg.cls}`}
      >
        {cfg.text}
      </span>
    </Tooltip>
  )
}
