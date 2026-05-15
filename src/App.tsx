// =============================================================================
// APP — Gantt v1
// =============================================================================
// Composant racine :
//   • Charge l'état depuis l'API au mount, puis polling 5 s
//   • Gère le zoom (largeur d'un jour en px)
//   • Gère la fenêtre temporelle (4 mois par défaut)
//   • Permet création / édition / suppression de tâches via TaskEditor
//   • Bouton "Capture d'écran PNG" via html-to-image (téléchargement direct)
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
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
} from './lib/utils'
import type { GanttState, Task } from './lib/types'

/** Intervalle (ms) du polling de synchronisation. */
const POLL_INTERVAL = 5000

/** État réseau pour le badge en haut à droite. */
type NetStatus = 'idle' | 'loading' | 'ok' | 'error'

export default function App() {
  /** État serveur (collaborateurs + tâches + version). */
  const [state, setState] = useState<GanttState | null>(null)
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
   * Récupère l'état complet depuis l'API. Met à jour status + state.
   */
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: GanttState = await res.json()
      setState((prev) => {
        // Évite un re-render inutile si la version n'a pas bougé.
        if (prev && prev.version === data.version) return prev
        return data
      })
      setStatus('ok')
    } catch (err) {
      console.error('[fetchState]', err)
      setStatus('error')
    }
  }, [])

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
          const txt = await res.text()
          throw new Error(`HTTP ${res.status} — ${txt}`)
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
      mutate('POST', '/api/tasks', { id: makeId('t'), ...patch })
    }
    setEditing(null)
    setCreating(false)
  }

  /** Suppression de la tâche en cours d'édition. */
  const handleDeleteTask = () => {
    if (!editing) return
    if (!confirm(`Supprimer « ${editing.name} » ?`)) return
    mutate('DELETE', `/api/tasks/${editing.id}`)
    setEditing(null)
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
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-slate-800">📊 Gantt</h1>

        <div className="flex items-center gap-1 ml-4">
          <button
            className="px-2 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(-30)}
            title="Reculer d'un mois"
          >
            « mois
          </button>
          <button
            className="px-2 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(-7)}
            title="Reculer d'une semaine"
          >
            ‹ sem
          </button>
          <button
            className="px-2 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => setWindow(defaultWindow())}
            title="Recentrer sur aujourd'hui"
          >
            Aujourd'hui
          </button>
          <button
            className="px-2 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(7)}
            title="Avancer d'une semaine"
          >
            sem ›
          </button>
          <button
            className="px-2 py-1 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => shiftWindow(30)}
            title="Avancer d'un mois"
          >
            mois »
          </button>
        </div>

        <div className="flex items-center gap-2 ml-2">
          <span className="text-xs text-slate-600">Zoom</span>
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
          />
          <button
            className="w-7 h-7 rounded border border-slate-300 hover:bg-slate-100"
            onClick={() => setDayWidth((v) => clampDayWidth(v + 4))}
            title="Zoomer"
          >
            +
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => setCreating(true)}
          >
            + Nouvelle tâche
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
            onClick={handleScreenshot}
            title="Télécharge un PNG du Gantt pour PowerPoint"
          >
            📷 Capture PNG
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-100"
            onClick={handleReset}
          >
            Reset démo
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
              tasks={state.tasks}
              collaborators={state.collaborators}
              onTaskClick={setEditing}
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
              ? { start_date: startIso, kind: 'task', progress: 0 }
              : undefined
          }
          collaborators={state.collaborators}
          tasks={state.tasks}
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

/** Petit badge de statut réseau (en haut à droite). */
function StatusBadge({ status }: { status: NetStatus }) {
  const cfg = {
    idle: { text: '…', cls: 'bg-slate-200 text-slate-600' },
    loading: { text: '⟳ Sauvegarde…', cls: 'bg-amber-100 text-amber-700' },
    ok: { text: '✓ Synchronisé', cls: 'bg-emerald-100 text-emerald-700' },
    error: { text: '✕ Erreur', cls: 'bg-red-100 text-red-700' },
  }[status]
  return (
    <span className={`text-xs px-2 py-1 rounded ${cfg.cls}`} title={status}>
      {cfg.text}
    </span>
  )
}
