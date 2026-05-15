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
import {
  clampDayWidth,
  defaultWindow,
  DEFAULT_DAY_WIDTH,
  makeId,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
  sortTasksHierarchically,
  todayIso,
  windowFromTasks,
} from './lib/utils'
import type { GanttState, Task } from './lib/types'

/** Intervalle (ms) du polling de synchronisation. */
const POLL_INTERVAL = 5000

/** Clé localStorage utilisée pour mémoriser le projet ouvert d'une session à l'autre. */
const LS_CURRENT_PROJECT = 'gantt.currentProjectId'

/** État réseau pour le badge en haut à droite. */
type NetStatus = 'idle' | 'loading' | 'ok' | 'error'

export default function App() {
  /** État serveur (projets + collaborateurs + tâches du projet courant + version). */
  const [state, setState] = useState<GanttState | null>(null)
  /**
   * Id du projet actuellement affiché. Persisté en localStorage pour
   * réouvrir le même projet à la prochaine session. Le serveur fait
   * autorité : si l'id stocké n'existe plus (projet supprimé ailleurs),
   * la réponse `/api/state` renvoie le 1er projet et on se resynchronise.
   */
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(
    () => {
      try {
        return localStorage.getItem(LS_CURRENT_PROJECT)
      } catch {
        return null
      }
    },
  )
  /** Statut réseau pour feedback visuel. */
  const [status, setStatus] = useState<NetStatus>('idle')
  /** Largeur d'un jour en pixels — pilote le zoom. */
  const [dayWidth, setDayWidth] = useState(DEFAULT_DAY_WIDTH)
  /** Bornes du calendrier visible (4 mois par défaut depuis aujourd'hui). */
  const [{ startIso, endIso }, setWindow] = useState(() => defaultWindow())
  /** Tâche en cours d'édition (null = pas de modal). */
  const [editing, setEditing] = useState<Task | null>(null)
  /** true = modal en mode création. */
  const [creating, setCreating] = useState(false)

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
        try {
          localStorage.setItem(LS_CURRENT_PROJECT, data.current_project_id)
        } catch {
          // localStorage indisponible (mode privé strict) → on ignore
        }
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

  /** Sauvegarde du formulaire (création ou édition). */
  const handleSaveTask = (patch: Partial<Task>) => {
    if (editing) {
      mutate('PATCH', `/api/tasks/${editing.id}`, patch)
    } else {
      // v1.8 — Une nouvelle tâche appartient toujours au projet courant.
      mutate('POST', '/api/tasks', {
        id: makeId('t'),
        ...patch,
        project_id: currentProjectId ?? undefined,
      })
    }
    setEditing(null)
    setCreating(false)
  }

  // ---------------------------------------------------------------------------
  // v1.8 — Gestion des projets (création, renommage, suppression, sélection)
  // ---------------------------------------------------------------------------

  /** Change de projet courant et persiste le choix. */
  const handleSelectProject = (id: string) => {
    setCurrentProjectId(id)
    try {
      localStorage.setItem(LS_CURRENT_PROJECT, id)
    } catch {
      // localStorage indisponible — on continue, l'id reste en mémoire.
    }
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

  /** Supprime le projet courant après confirmation. */
  const handleDeleteProject = async () => {
    if (!currentProject || !state) return
    if (state.projects.length <= 1) {
      alert('Impossible de supprimer le dernier projet.')
      return
    }
    const ok = confirm(
      `Supprimer le projet « ${currentProject.name} » et toutes ses tâches ?\n\nCette action est irréversible.`,
    )
    if (!ok) return
    // On bascule sur un autre projet AVANT la suppression pour que le
    // refetch suivant ne reparte pas sur un id invalide.
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
            <button
              className="w-7 h-7 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              onClick={handleDeleteProject}
              disabled={!currentProject || state.projects.length <= 1}
              title={
                state.projects.length <= 1
                  ? 'Impossible de supprimer le dernier projet'
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
          <button
            className="h-7 px-2 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => setCreating(true)}
            title="Nouvelle tâche / jalon / phase"
          >
            + Tâche
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
      {/* GANTT principal                                                   */}
      {/* ---------------------------------------------------------------- */}
      <main className="flex-1 p-4 overflow-auto">
        {state ? (
          <div ref={ganttRef}>
            <GanttChart
              windowStart={startIso}
              windowEnd={endIso}
              dayWidth={dayWidth}
              tasks={orderedTasks}
              collaborators={state.collaborators}
              onTaskClick={setEditing}
              onMoveTask={handleMoveTask}
              onResizeTask={handleResizeTask}
            />
          </div>
        ) : (
          <p className="text-slate-500">Chargement…</p>
        )}
      </main>

      {/* ---------------------------------------------------------------- */}
      {/* MODAL d'édition / création                                       */}
      {/* ---------------------------------------------------------------- */}
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
