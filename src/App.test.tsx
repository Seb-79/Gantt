// @vitest-environment jsdom
// =============================================================================
// TESTS — App (composant racine, smoke tests)
// =============================================================================
// On simule l'API en mockant globalement `fetch`. Vitest fournit `vi.fn()` /
// `vi.spyOn()`. On vérifie :
//   • Le 1er rendu affiche "Chargement…" puis bascule sur le Gantt
//   • Le sélecteur de projet liste les projets retournés par /api/state
//   • Le polling déclenche un re-fetch (en avançant les timers vitest)
//   • L'ouverture du modal "nouvelle tâche" puis sa sauvegarde fait un POST
//   • Le changement de projet refetche /api/state avec le bon project_id
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
  cleanup,
} from '@testing-library/react'
import App from './App'
import type { GanttState } from './lib/types'

/** Construit un état serveur minimal pour les tests. */
function mkState(overrides: Partial<GanttState> = {}): GanttState {
  return {
    version: 1,
    current_project_id: 'p1',
    projects: [
      { id: 'p1', name: 'Projet 1', position: 0 },
      { id: 'p2', name: 'Projet 2', position: 1 },
    ],
    collaborators: [{ id: 'c1', name: 'Alice', color: '#3b82f6', position: 0 }],
    tasks: [
      {
        id: 't1',
        name: 'Tâche 1',
        kind: 'task',
        start_date: '2026-05-01',
        end_date: '2026-05-05',
        progress: 0,
        collaborator_id: null,
        color: null,
        parent_id: null,
        predecessor_id: null,
        predecessor_lag: 0,
        position: 0,
        project_id: 'p1',
      },
    ],
    ...overrides,
  }
}

/** Mock global de fetch : enregistre les appels et renvoie ce qu'on lui dit. */
function setupFetchMock(initial: GanttState = mkState()) {
  /** Historique pour assertions. */
  const calls: Array<{ url: string; method: string; body?: string }> = []
  /** Le state courant que le mock renvoie sur GET /api/state. */
  let currentState: GanttState = initial

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({
      url,
      method,
      body: init?.body ? String(init.body) : undefined,
    })

    // GET /api/state (avec ou sans ?project_id=)
    if (method === 'GET' && url.startsWith('/api/state')) {
      const m = url.match(/project_id=([^&]+)/)
      if (m) {
        const pid = decodeURIComponent(m[1])
        const proj = currentState.projects.find((p) => p.id === pid)
        currentState = {
          ...currentState,
          current_project_id: proj
            ? pid
            : (currentState.projects[0]?.id ?? null),
        }
      }
      return new Response(JSON.stringify(currentState), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // Toutes les mutations renvoient un succès minimal ; le test peut
    // intercaler une assertion sur le body au besoin.
    return new Response(JSON.stringify({ version: ++currentState.version }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  vi.stubGlobal('fetch', mock)
  return { calls, mock, setState: (s: GanttState) => (currentState = s) }
}

beforeEach(() => {
  // localStorage propre entre chaque test (l'app le lit au démarrage).
  localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  // v1.17 — Démonter EXPLICITEMENT avant de retirer le stub de `fetch`.
  // Sans cela, le `cleanup()` global de `setup.ts` (registré en premier
  // donc exécuté en dernier dans l'ordre LIFO de vitest) tourne après
  // `vi.unstubAllGlobals()` : le composant est encore monté avec un
  // polling actif, la 2e requête de `fetchState` déclenchée par la
  // mise à jour de `currentProjectId` tombe sur le vrai `undici.fetch`
  // (qui n'accepte pas les URLs relatives) et pollue le stderr avec un
  // `Failed to parse URL`. Démonter d'abord stoppe l'effet React et son
  // setInterval avant le détachement du mock.
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('App — smoke', () => {
  it('affiche "Chargement…" puis charge l\'état serveur', async () => {
    setupFetchMock()
    render(<App />)
    expect(screen.getByText(/Chargement/)).toBeInTheDocument()
    // Après résolution du fetch, la tâche apparaît dans la colonne gauche.
    await waitFor(() => {
      expect(
        document.querySelector('[draggable="true"][title="Tâche 1"]'),
      ).toBeTruthy()
    })
  })

  it("peuple le sélecteur de projet à partir de l'API", async () => {
    setupFetchMock()
    render(<App />)
    await waitFor(() => {
      // Le select affiche les 2 projets renvoyés par le mock.
      const opts = screen.getAllByRole('option')
      expect(opts.map((o) => o.textContent)).toEqual(['Projet 1', 'Projet 2'])
    })
  })

  it('changer de projet provoque un GET /api/state?project_id=…', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    // Bascule sur Projet 2 → un nouveau GET est émis avec le bon param.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } })
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'GET' && c.url.includes('project_id=p2'),
        ),
      ).toBe(true)
    })
  })

  it('le polling 5 s déclenche un re-fetch de /api/state', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    const before = calls.filter(
      (c) => c.method === 'GET' && c.url.startsWith('/api/state'),
    ).length
    // Avance les timers de 5 s → l'intervalle de polling se déclenche.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    const after = calls.filter(
      (c) => c.method === 'GET' && c.url.startsWith('/api/state'),
    ).length
    expect(after).toBeGreaterThan(before)
  })

  it("création d'une tâche : POST /api/tasks avec project_id du projet courant", async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    // Clic sur le bouton "+ Tâche".
    fireEvent.click(screen.getByRole('button', { name: /Tâche/ }))
    // Renseigne le nom et sauve.
    fireEvent.change(screen.getByLabelText(/Nom/), {
      target: { value: 'Nouvelle' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url === '/api/tasks',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(post!.body!)
      expect(body.name).toBe('Nouvelle')
      expect(body.project_id).toBe('p1')
    })
  })
})

describe("App — barre d'outils", () => {
  it('Reset démo : confirm() OK → POST /api/reset', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle(/Restaurer les données/))
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url === '/api/reset'),
      ).toBe(true),
    )
  })

  it('Reset démo : confirm() annulé → aucun POST', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle(/Restaurer les données/))
    expect(calls.find((c) => c.url === '/api/reset')).toBeUndefined()
  })

  it('boutons de navigation temporelle modifient la fenêtre', async () => {
    setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    // On clique sur les 5 boutons de navigation — l'objectif est de
    // couvrir les branches shiftWindow / defaultWindow, pas la cinématique
    // fine (déjà testée dans utils).
    fireEvent.click(screen.getByTitle(/Reculer d'un mois/))
    fireEvent.click(screen.getByTitle(/Reculer d'une semaine/))
    fireEvent.click(screen.getByTitle(/Recentrer sur aujourd'hui/))
    fireEvent.click(screen.getByTitle(/Avancer d'une semaine/))
    fireEvent.click(screen.getByTitle(/Avancer d'un mois/))
  })

  it('boutons de zoom modifient dayWidth (− et +)', async () => {
    setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle('Dézoomer'))
    fireEvent.click(screen.getByTitle('Zoomer'))
    // Le slider doit aussi être pilotable.
    const slider = screen.getByRole('slider') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '30' } })
    expect(slider.value).toBe('30')
  })
})

describe('App — gestion des projets', () => {
  it('création : prompt() → POST /api/projects + bascule sur le nouveau', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'prompt').mockReturnValue('Mon projet')
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle('Nouveau projet'))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url === '/api/projects',
      )
      expect(post).toBeTruthy()
      expect(JSON.parse(post!.body!).name).toBe('Mon projet')
    })
  })

  it('création annulée (prompt vide) → aucun POST', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'prompt').mockReturnValue('')
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle('Nouveau projet'))
    expect(calls.find((c) => c.url === '/api/projects')).toBeUndefined()
  })

  it('renommage : prompt() → PATCH /api/projects/:id', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'prompt').mockReturnValue('Projet renommé')
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle('Renommer le projet'))
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url === '/api/projects/p1',
      )
      expect(patch).toBeTruthy()
      expect(JSON.parse(patch!.body!).name).toBe('Projet renommé')
    })
  })

  it('renommage : prompt identique → pas de PATCH', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'prompt').mockReturnValue('Projet 1')
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle('Renommer le projet'))
    expect(
      calls.find(
        (c) => c.method === 'PATCH' && c.url.startsWith('/api/projects'),
      ),
    ).toBeUndefined()
  })

  it('suppression : confirm() OK → DELETE /api/projects/:id', async () => {
    const { calls } = setupFetchMock()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByTitle('Supprimer le projet'))
    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === 'DELETE' && c.url === '/api/projects/p1',
      )
      expect(del).toBeTruthy()
    })
  })

  it('suppression : dernier projet → bouton désactivé', async () => {
    setupFetchMock(
      mkState({ projects: [{ id: 'p1', name: 'Seul', position: 0 }] }),
    )
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    const del = screen.getByTitle(/Impossible de supprimer le dernier projet/)
    expect(del).toBeDisabled()
  })
})

describe('App — robustesse réseau', () => {
  it('erreur HTTP sur /api/state → status passe à error sans crash', async () => {
    // v1.17 — Le composant log volontairement l'erreur via console.error.
    // On le silence le temps du test pour ne pas polluer le stderr de la
    // suite (l'erreur reste assertée via le badge "Erreur réseau").
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', failing)
    render(<App />)
    // Le composant ne crashe pas ; le badge passe en mode erreur (✕).
    await waitFor(() => {
      expect(screen.getByTitle('Erreur réseau')).toBeInTheDocument()
    })
    // Vérifie que l'erreur a bien été loguée (preuve que le chemin
    // d'erreur a été emprunté), tout en l'isolant du flux stderr.
    expect(errSpy).toHaveBeenCalled()
  })
})
