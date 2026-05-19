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
import ProjectMembers from './components/ProjectMembers'
import Absences from './components/Absences'
import {
  checkCoherence,
  clampDayWidth,
  concernedTaskIds,
  defaultWindow,
  DEFAULT_DAY_WIDTH,
  filterCollapsed,
  makeId,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
  replanTasks,
  sortTasksHierarchically,
  todayIso,
  windowFromTasks,
} from './lib/utils'
import type { ReplanMove } from './lib/utils'
import type { Collaborator, GanttState, Task } from './lib/types'

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

/** v2.0 / F5 — Clé localStorage pour mémoriser le scope du plan de charge. */
const LS_WORKLOAD_SCOPE = 'gantt.workloadScope'

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
   * v2.0 / F5 — Périmètre du plan de charge :
   *   • 'current' (défaut) → workload restreint au projet courant.
   *   • 'global'           → workload agrégé cross-projet (fetché à la demande).
   * Persisté en localStorage pour retrouver la même vue à l'ouverture.
   */
  const [workloadScope, setWorkloadScope] = useState<'current' | 'global'>(
    () => (lsGet(LS_WORKLOAD_SCOPE) === 'global' ? 'global' : 'current'),
  )
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
        alert(`Erreur : ${(err as Error).message}`)
      }
    },
    [fetchState],
  )

  /** Reset des données démo. */
  const handleReset = () => {
    if (!confirm('Restaurer les données de démonstration ?')) return
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
   * v2.0 / F2 — Supprime une période d'allocation par son id. 404 silencieux
   * (l'UI se rafraîchit de toute façon via fetchState).
   */
  const handleDeleteMemberAllocation = useCallback(
    (allocationId: string) => {
      if (!confirm('Supprimer cette période d’allocation ?')) return
      mutate('DELETE', `/api/allocations/${encodeURIComponent(allocationId)}`)
    },
    [mutate],
  )

  /**
   * v2.0 / F3 — Ajoute (ou remplace via UPSERT) une absence pour un
   * collaborateur. Le serveur valide la fraction (∈ {0.25, 0.5, 0.75, 1})
   * et renvoie 400 sinon.
   */
  const handleAddAbsence = useCallback(
    (collaboratorId: string, body: { date: string; fraction: number }) => {
      mutate(
        'POST',
        `/api/collaborators/${encodeURIComponent(collaboratorId)}/absences`,
        body,
      )
    },
    [mutate],
  )

  /**
   * v2.0 / F3 — Supprime une absence par (collab, date). 404 silencieux
   * (l'UI se rafraîchit via fetchState).
   */
  const handleDeleteAbsence = useCallback(
    (collaboratorId: string, date: string) => {
      if (!confirm(`Supprimer le congé du ${date} ?`)) return
      mutate(
        'DELETE',
        `/api/collaborators/${encodeURIComponent(collaboratorId)}/absences/${encodeURIComponent(date)}`,
      )
    },
    [mutate],
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
      alert('Capture impossible — voir la console.')
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
            body: JSON.stringify({
              start_date: m.newStart,
              end_date: m.newEnd,
              predecessor_lag: m.predecessor_lag,
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
        alert(`Erreur pendant la replanification : ${(err as Error).message}`)
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
          undefined,
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

  /** Crée un nouveau projet (prompt simple). */
  const handleCreateProject = async () => {
    const name = prompt('Nom du nouveau projet :', 'Nouveau projet')?.trim()
    if (!name) return
    const id = makeId('p')
    await mutate('POST', '/api/projects', { id, name })
    handleSelectProject(id)
  }

  /** Renomme le projet courant (prompt). */
  const handleRenameProject = async () => {
    if (!currentProject) return
    const name = prompt('Nouveau nom :', currentProject.name)?.trim()
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
    const ok = confirm(
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
  const handleDeleteTask = () => {
    if (!editing) return
    if (!confirm(`Supprimer « ${editing.name} » ?`)) return
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
   * v2.0 / F5 — Bascule entre vue plan de charge « projet courant » et
   * « globale ». Persisté en localStorage. Le fetch des global tasks est
   * piloté par un `useEffect` séparé (cf. plus bas).
   */
  const toggleWorkloadScope = () => {
    setWorkloadScope((s) => {
      const next: 'current' | 'global' = s === 'global' ? 'current' : 'global'
      lsSet(LS_WORKLOAD_SCOPE, next)
      return next
    })
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
  const handleOpenReplan = (scope: 'full' | 'partial' = 'full') => {
    if (!state) return
    // v2.0 / F2 — Le replan consomme la capacité quotidienne réelle de chaque
    // collab : on lui passe `member_allocations` du projet courant.
    // v2.0 / F3 — Les absences personnelles (cross-projet) sont également
    // injectées pour que la pondération multiplicative s'applique aussi pendant
    // le replan (sinon le replan replacerait des tâches sur des jours en congé).
    const allocs = state.member_allocations
    const absences = state.collaborator_absences
    const moves =
      scope === 'partial'
        ? replanTasks(
            orderedTasks,
            concernedTaskIds(coherenceIssues, orderedTasks),
            allocs,
            absences,
          )
        : replanTasks(orderedTasks, undefined, allocs, absences)
    if (moves.length === 0) {
      alert(
        scope === 'partial'
          ? 'Aucun déplacement nécessaire — les incohérences ne peuvent pas être résolues sans déverrouiller d’autres tâches (essayez « Replan complet »).'
          : 'Aucune surcharge détectée — rien à replanifier.',
      )
      return
    }
    setReplanPreview(moves)
  }

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

        {/* v1.8 — Sélecteur de projet + actions CRUD */}
        {state && (
          <div className="flex items-center gap-1 pl-2 border-l border-slate-200 min-w-0">
            <select
              className="text-sm border border-slate-300 rounded px-2 py-1 bg-white hover:bg-slate-50 max-w-[10rem] truncate"
              value={state.current_project_id ?? ''}
              onChange={(e) => handleSelectProject(e.target.value)}
              disabled={state.projects.length === 0}
              title="Changer de projet"
            >
              {state.projects.length === 0 ? (
                <option value="">— aucun projet —</option>
              ) : (
                state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))
              )}
            </select>
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
              onClick={handleCreateProject}
              title="Nouveau projet"
            >
              +
            </button>
            <button
              className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleRenameProject}
              disabled={!currentProject}
              title="Renommer le projet"
            >
              ✎
            </button>
            {/* v1.24 — Règle RG-GANTT-1106 : la suppression est autorisée
                même pour le dernier projet. Le bouton n'est désactivé que
                lorsqu'il n'y a aucun projet courant (cas "base vide"). */}
            <button
              className="w-7 h-7 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              onClick={handleDeleteProject}
              disabled={!currentProject}
              title={
                state.projects.length <= 1
                  ? 'Supprimer le projet (base vide après suppression)'
                  : 'Supprimer le projet'
              }
            >
              🗑
            </button>
          </div>
        )}

        {/* Navigation temporelle — icônes seules + tooltips */}
        <div className="flex items-center gap-1 pl-2 border-l border-slate-200 shrink-0">
          <button
            className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(-30)}
            title="Reculer d'un mois"
          >
            «
          </button>
          <button
            className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(-7)}
            title="Reculer d'une semaine"
          >
            ‹
          </button>
          <button
            className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => setWindow(defaultWindow())}
            title="Recentrer sur aujourd'hui"
          >
            ⌂
          </button>
          <button
            className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(7)}
            title="Avancer d'une semaine"
          >
            ›
          </button>
          <button
            className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(30)}
            title="Avancer d'un mois"
          >
            »
          </button>
        </div>

        {/* Zoom — slider plus court, libellé masqué */}
        <div
          className="flex items-center gap-1 pl-2 border-l border-slate-200 shrink-0"
          title="Zoom (largeur d'un jour)"
        >
          <button
            className="w-7 h-7 rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => setDayWidth((v) => clampDayWidth(v - 4))}
            title="Dézoomer"
          >
            −
          </button>
          <input
            type="range"
            min={MIN_DAY_WIDTH}
            max={MAX_DAY_WIDTH}
            value={dayWidth}
            onChange={(e) => setDayWidth(clampDayWidth(Number(e.target.value)))}
            className="w-24"
          />
          <button
            className="w-7 h-7 rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => setDayWidth((v) => clampDayWidth(v + 4))}
            title="Zoomer"
          >
            +
          </button>
        </div>

        {/* Actions globales — alignées à droite, icônes seules */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* v1.17 — Toggle « sous-charges en jaune » : ne s'affiche que
              sur l'onglet Plan de charge (effet visible uniquement sur les
              cellules). Fond jaune pâle quand actif pour rappeler la palette
              qu'il déclenche. */}
          {view === 'workload' && (
            <button
              className={[
                'w-7 h-7 text-sm rounded border border-slate-300',
                highlightUnderload
                  ? 'bg-yellow-200 text-yellow-900 border-yellow-400'
                  : 'hover:bg-slate-100',
              ].join(' ')}
              onClick={toggleHighlightUnderload}
              title={
                highlightUnderload
                  ? 'Masquer la mise en évidence des sous-charges'
                  : 'Mettre en évidence les sous-charges (< 1 j) en jaune'
              }
              aria-pressed={highlightUnderload}
            >
              🟡
            </button>
          )}
          {/* v2.0 / F5 — Toggle scope « projet courant / vue globale ».
              Visible uniquement sur l'onglet Plan de charge. En mode global,
              le bouton affiche un fond bleu pour rappeler que la vue agrège
              toutes les tâches de tous les projets de la base. */}
          {view === 'workload' && (
            <button
              className={[
                'h-7 px-2 text-xs rounded border border-slate-300',
                workloadScope === 'global'
                  ? 'bg-blue-100 text-blue-700 border-blue-300'
                  : 'hover:bg-slate-100',
              ].join(' ')}
              onClick={toggleWorkloadScope}
              title={
                workloadScope === 'global'
                  ? 'Revenir à la vue restreinte au projet courant'
                  : 'Voir la charge agrégée sur TOUS les projets'
              }
              aria-pressed={workloadScope === 'global'}
            >
              {workloadScope === 'global' ? '🌐 Global' : '📁 Courant'}
            </button>
          )}
          {/* v1.16 — Les toggles "nom" et "dates" ne concernent que la vue
              Gantt (rendu des barres). On les masque sur la vue Charge. */}
          {view === 'gantt' && (
            <>
              {/* v1.13 — Toggle d'affichage du nom des tâches dans les barres.
                  ACTIF par défaut : fond bleu pâle quand affiché, neutre quand
                  masqué (T sans fond = "texte masqué"). */}
              <button
                className={[
                  'w-7 h-7 text-xs rounded border border-slate-300',
                  showBarNames
                    ? 'bg-blue-100 text-blue-700 border-blue-300'
                    : 'hover:bg-slate-100',
                ].join(' ')}
                onClick={toggleShowBarNames}
                title={
                  showBarNames
                    ? 'Masquer le nom des tâches dans les barres'
                    : 'Afficher le nom des tâches dans les barres'
                }
                aria-pressed={showBarNames}
              >
                T
              </button>
              {/* v1.11 — Toggle d'affichage des dates de début/fin sur les barres.
                  État actif (showDates=true) souligné par un fond bleu pâle. */}
              <button
                className={[
                  'w-7 h-7 text-sm rounded border border-slate-300',
                  showDates
                    ? 'bg-blue-100 text-blue-700 border-blue-300'
                    : 'hover:bg-slate-100',
                ].join(' ')}
                onClick={toggleShowDates}
                title={
                  showDates
                    ? 'Masquer les dates sur les barres'
                    : 'Afficher les dates de début/fin sur les barres'
                }
                aria-pressed={showDates}
              >
                📅
              </button>
            </>
          )}
          <button
            className="h-7 px-2 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => setCreating(true)}
            title="Nouvelle tâche / jalon / phase"
          >
            + Tâche
          </button>
          {/* v1.18 — Replan : analyse les surcharges et propose un aperçu
              des déplacements ; appliqué seulement après confirmation. */}
          <button
            className="h-7 px-2 text-sm rounded bg-amber-500 text-white hover:bg-amber-600"
            onClick={() => handleOpenReplan('full')}
            title="Replanifier automatiquement les tâches en surcharge"
            disabled={!state}
          >
            🔄 Replan
          </button>
          <button
            className="w-7 h-7 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
            onClick={handleScreenshot}
            title="Capture PNG du Gantt (pour PowerPoint)"
          >
            📷
          </button>
          <button
            className="w-7 h-7 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={handleReset}
            title="Restaurer les données de démonstration"
          >
            ↺
          </button>
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
                globalTasks={globalTasks ?? undefined}
                highlightUnderload={highlightUnderload}
                onShiftWindow={shiftWindow}
              />
            )}
            {view === 'members' && (
              <ProjectMembers
                collaborators={state.collaborators}
                memberIds={state.current_project_members}
                memberAllocations={state.member_allocations}
                projectName={currentProject?.name ?? null}
                projectId={state.current_project_id}
                onAddMember={handleAddProjectMember}
                onAddAllocation={handleAddMemberAllocation}
                onDeleteAllocation={handleDeleteMemberAllocation}
              />
            )}
            {view === 'absences' && (
              <Absences
                collaborators={state.collaborators}
                absences={state.collaborator_absences}
                onAddAbsence={handleAddAbsence}
                onDeleteAbsence={handleDeleteAbsence}
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
        />
      )}
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
  return (
    <div
      className="flex items-center rounded border border-slate-300 overflow-hidden shrink-0"
      role="tablist"
      aria-label="Vue"
    >
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
        title="Vue planning Gantt"
      >
        Gantt
      </button>
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
        title="Vue plan de charge par collaborateur"
      >
        Charge
      </button>
      {/* v2.0 / F1 — Onglet « Affectation projet » : liste les collaborateurs
          membres du projet courant et permet d'en ajouter. */}
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
        title="Affecter les collaborateurs au projet"
      >
        Affectation
      </button>
      {/* v2.0 / F3 — Onglet « Congés » (cross-projet) : saisie des absences
          de chaque collab. L'absence diminue multiplicativement la capacité
          du collab sur tous ses projets simultanément. */}
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
        title="Gérer les absences (congés) — cross-projet"
      >
        Congés
      </button>
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
    <span
      className={`inline-flex items-center justify-center w-7 h-7 text-sm rounded ${cfg.cls}`}
      title={cfg.label}
    >
      {cfg.text}
    </span>
  )
}
