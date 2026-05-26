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
  within,
} from '@testing-library/react'
import App from './App'
import type { GanttState } from './lib/types'

/** Construit un état serveur minimal pour les tests. */
function mkState(overrides: Partial<GanttState> = {}): GanttState {
  return {
    version: 1,
    current_project_id: 'p1',
    projects: [
      // v2.3 / RG-GANTT-2100 — project_start_date alignée sur la start_date
      // de la tâche par défaut (2026-06-01) pour que la borne basse globale
      // du Replan n'altère pas les scénarios historiques (= aucun move
      // proposé tant que la tâche démarre à sa date d'origine).
      {
        id: 'p1',
        name: 'Projet 1',
        position: 0,
        project_start_date: '2026-06-01',
      },
      {
        id: 'p2',
        name: 'Projet 2',
        position: 1,
        project_start_date: '2026-06-01',
      },
    ],
    collaborators: [{ id: 'c1', name: 'Alice', color: '#3b82f6', position: 0 }],
    tasks: [
      {
        id: 't1',
        name: 'Tâche 1',
        kind: 'task',
        // v1.23 — 01/05/2026 = Fête du Travail (férié) ; on déplace la
        // tâche par défaut sur une semaine sans férié pour éviter qu'un
        // « Replan » par défaut ne propose un déplacement spurieux.
        start_date: '2026-06-01',
        end_date: '2026-06-05',
        progress: 0,
        collaborator_id: null,
        color: null,
        parent_id: null,
        predecessor_id: null,
        predecessor_lag: 0,
        priority: null,
        not_before_date: null,
        not_later_than_date: null,
        charge_jours: null,
        position: 0,
        project_id: 'p1',
      },
    ],
    // v2.0 / F1 — Ids des collabs membres du projet courant. Par défaut, on
    // déclare le collab 'c1' présent dans le seed des tasks ci-dessus pour
    // que la migration F1 le considère membre (cohérent avec la production).
    current_project_members: ['c1'],
    // v2.0 / F2 — Allocations du projet courant. Par défaut vide ; les tests
    // qui ont besoin de pondération en injectent via `overrides`.
    member_allocations: [],
    // v2.0 / F5 — Allocations cross-projet (capacité totale). Vide par défaut.
    all_member_allocations: [],
    // v2.2 / F5 — Memberships cross-projet (matrice). Vide par défaut.
    all_project_members: [],
    // v2.0 / F3 — Absences cross-projet. Vide par défaut.
    collaborator_absences: [],
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

  it("RG-GANTT-1104 — peuple le sélecteur de projet à partir de l'API", async () => {
    setupFetchMock()
    render(<App />)
    // v2.2 / F3 refondu — Au démarrage on est sur l'onglet Gantt, donc le
    // sélecteur est en mode mono-projet (allowAll=false) : on ne voit QUE
    // les projets, pas l'option « Tous les projets ».
    const trigger = await screen.findByRole('combobox')
    fireEvent.click(trigger)
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.textContent?.trim())).toEqual([
      expect.stringContaining('Projet 1'),
      expect.stringContaining('Projet 2'),
    ])
  })

  it('RG-GANTT-1104 — changer de projet provoque un GET /api/state?project_id=…', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    const trigger = await screen.findByRole('combobox')
    // v2.2 / F3 refondu — Le menu est désormais une liste à sélection unique
    // (radio). On clique simplement sur l'option « Projet 2 » pour déclencher
    // le GET ?project_id=p2.
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /Projet 2/ }))
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'GET' && c.url.includes('project_id=p2'),
        ),
      ).toBe(true)
    })
  })

  it('RG-GANTT-0006 — le polling 5 s déclenche un re-fetch de /api/state', async () => {
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
    // Clic sur le bouton "+ Tâche" (texte exact, pour ne pas matcher les
    // handles de drag-to-link v1.23 dont l'aria-label inclut le nom de la
    // tâche source).
    fireEvent.click(screen.getByRole('button', { name: '+ Tâche' }))
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
  // v2.3 — Le bouton "↺ Restaurer démo" est supprimé (RG-GANTT-2102).
  // Les anciens window.confirm sont remplacés par une modale custom
  // (cf. src/components/Dialogs.tsx) pour les autres confirmations.

  it('boutons de navigation temporelle modifient la fenêtre', async () => {
    setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    // On clique sur les 5 boutons de navigation — l'objectif est de
    // couvrir les branches shiftWindow / defaultWindow, pas la cinématique
    // fine (déjà testée dans utils).
    fireEvent.click(screen.getByLabelText(/Reculer d'un mois/))
    fireEvent.click(screen.getByLabelText(/Reculer d'une semaine/))
    fireEvent.click(screen.getByLabelText(/Recentrer sur aujourd'hui/))
    fireEvent.click(screen.getByLabelText(/Avancer d'une semaine/))
    fireEvent.click(screen.getByLabelText(/Avancer d'un mois/))
  })

  it('boutons de zoom modifient dayWidth (− et +)', async () => {
    setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Dézoomer'))
    fireEvent.click(screen.getByLabelText('Zoomer'))
    // Le slider doit aussi être pilotable.
    const slider = screen.getByRole('slider') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '30' } })
    expect(slider.value).toBe('30')
  })
})

describe('App — gestion des projets', () => {
  // v2.0 — Les boîtes natives sont remplacées par la modale custom
  // (<Dialogs />). Les tests :
  //   • saisissent le nom dans le champ texte de la modale (pour prompt),
  //   • cliquent sur OK / Annuler (pour les deux types).
  // v2.3 / RG-GANTT-2100 + 2101 — Les modales custom remplacent askPrompt.
  // Création : <CreateProjectDialog> (nom + date démarrage).
  // Édition : <ProjectSettingsModal> (nom + date démarrage + checkbox replan).
  it('v2.3 — création : ouvre CreateProjectDialog → POST /api/projects (nom + date)', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Nouveau projet'))
    // La modale s'ouvre avec un champ texte "Nom du projet" + un input date.
    const nameInput = await screen.findByLabelText(/nom du projet/i)
    fireEvent.change(nameInput, { target: { value: 'Mon projet' } })
    const dateInput = screen.getByLabelText(/date de démarrage/i)
    fireEvent.change(dateInput, { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: /créer/i }))
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === 'POST' && c.url === '/api/projects',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(post!.body!)
      expect(body.name).toBe('Mon projet')
      expect(body.project_start_date).toBe('2026-09-01')
    })
  })

  it('v2.3 — création annulée → aucun POST', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Nouveau projet'))
    await screen.findByLabelText(/nom du projet/i)
    fireEvent.click(screen.getByRole('button', { name: /annuler/i }))
    expect(calls.find((c) => c.url === '/api/projects')).toBeUndefined()
  })

  it('v2.3 — paramètres : ouvre ProjectSettingsModal → PATCH /api/projects/:id (nom)', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Renommer le projet'))
    const nameInput = await screen.findByLabelText(/nom du projet/i)
    fireEvent.change(nameInput, { target: { value: 'Projet renommé' } })
    fireEvent.click(screen.getByRole('button', { name: /enregistrer/i }))
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url === '/api/projects/p1',
      )
      expect(patch).toBeTruthy()
      expect(JSON.parse(patch!.body!).name).toBe('Projet renommé')
    })
  })

  it('v2.3 — paramètres : aucune modification → bouton Enregistrer désactivé, pas de PATCH', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Renommer le projet'))
    await screen.findByLabelText(/nom du projet/i)
    // Le bouton "Enregistrer" est désactivé tant qu'aucun champ n'a changé.
    const saveBtn = screen.getByRole('button', { name: /enregistrer/i })
    expect(saveBtn).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /annuler/i }))
    expect(
      calls.find(
        (c) => c.method === 'PATCH' && c.url.startsWith('/api/projects'),
      ),
    ).toBeUndefined()
  })

  it('suppression : confirm() OK → DELETE /api/projects/:id', async () => {
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    fireEvent.click(screen.getByLabelText('Supprimer le projet'))
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === 'DELETE' && c.url === '/api/projects/p1',
      )
      expect(del).toBeTruthy()
    })
  })

  // v1.24 — RG-GANTT-1106 : la suppression du dernier projet est AUTORISÉE.
  // Le bouton reste actif tant qu'un projet est chargé ; le tooltip prévient
  // simplement que la base sera vide après l'opération.
  it('v1.24 / RG-GANTT-1106 — suppression : dernier projet → bouton actif (base vide après)', async () => {
    setupFetchMock(
      mkState({
        projects: [
          {
            id: 'p1',
            name: 'Seul',
            position: 0,
            project_start_date: '2026-05-01',
          },
        ],
      }),
    )
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    const del = screen.getByLabelText(/base vide après suppression/i)
    expect(del).not.toBeDisabled()
  })
})

// =============================================================================
// v1.18 — Tests de non-régression MÉTIER pour le flux « Replan »
// =============================================================================
// Chaque test encode UNE règle du cahier des charges. Le nom doit pouvoir se
// lire comme une phrase métier — si une régression future inverse la règle,
// le test parle français au prochain mainteneur.
//
// Stratégie commune :
//   • on construit un état serveur réaliste (collab + tâches qui se
//     chevauchent ou non),
//   • on clique sur « 🔄 Replan »,
//   • on vérifie soit l'absence de modal (cas sans surcharge), soit le
//     contenu de la modal et la séquence d'appels API.
// =============================================================================

/** Helper : état avec une surcharge Alice exactement comme dans le brief. */
function mkOverloadedState(): GanttState {
  return mkState({
    // v2.3 — projectStartDate aligné sur t1a.start_date pour ne pas que la
    // borne basse globale du Replan tire t1a en arrière.
    projects: [
      {
        id: 'p1',
        name: 'Projet 1',
        position: 0,
        project_start_date: '2026-05-15',
      },
      {
        id: 'p2',
        name: 'Projet 2',
        position: 1,
        project_start_date: '2026-05-15',
      },
    ],
    collaborators: [
      { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
    ],
    tasks: [
      // « Recherche audience » occupe Alice du 15 au 29 mai (11 j ouvrés).
      {
        id: 't1a',
        name: 'Recherche audience',
        kind: 'task',
        start_date: '2026-05-15',
        end_date: '2026-05-29',
        progress: 0,
        collaborator_id: 'alice',
        color: null,
        parent_id: null,
        predecessor_id: null,
        predecessor_lag: 0,
        priority: null,
        not_before_date: null,
        not_later_than_date: null,
        charge_jours: null,
        position: 0,
        project_id: 'p1',
      },
      // « Définir le message » empiète sur la fin de « Recherche audience ».
      {
        id: 't1b',
        name: 'Définir le message',
        kind: 'task',
        start_date: '2026-05-25',
        end_date: '2026-06-05',
        progress: 0,
        collaborator_id: 'alice',
        color: null,
        parent_id: null,
        predecessor_id: null,
        predecessor_lag: 0,
        priority: null,
        not_before_date: null,
        not_later_than_date: null,
        charge_jours: null,
        position: 1,
        project_id: 'p1',
      },
    ],
    // v2.1 / F2.9 — Allocation 100 % couvrant largement la période des tâches,
    // pour que le check d'absorption ne bloque pas la sauvegarde dans les
    // tests de replan (qui doivent valider la cascade, pas le shortfall).
    current_project_members: ['alice'],
    member_allocations: [
      {
        id: 'alloc-alice-p1',
        project_id: 'p1',
        collaborator_id: 'alice',
        start_date: '2020-01-01',
        end_date: '2099-12-31',
        allocation_pct: 100,
      },
    ],
  })
}

describe('App — Replan (non-régression métier)', () => {
  // v2.3 — Fige today à 2026-05-01 pour que la borne basse globale du Replan
  // (MAX(projectStartDate, today, ...)) ne tire pas les fixtures historiques
  // de mai-juin 2026 vers une date plus précoce.
  let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null
  beforeEach(() => {
    // v2.3 — Mocke `Date.now()` SEUL (sans toucher aux timers de Testing
    // Library) pour figer `todayIso()` à mai 2026. La borne basse globale du
    // Replan (RG-GANTT-1903 redéfinie) utilise today : sans ce mock, les
    // fixtures de mai-juin 2026 seraient tirées au today système réel.
    const fixedNow = new Date('2026-05-15T00:00:00.000Z').getTime()
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
  })
  afterEach(() => {
    dateNowSpy?.mockRestore()
  })

  it("sans surcharge : alerte 'Aucune surcharge' et aucune modal n'apparaît", async () => {
    // L'état mkState() ne contient qu'une tâche sans collaborateur → aucune
    // surcharge possible → l'algorithme n'a rien à proposer.
    // F1 — askAlert remplace window.alert : on vérifie l'affichage DOM dans
    // le composant <Dialogs /> plutôt que de spy sur window.alert.
    const { calls } = setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    fireEvent.click(screen.getByRole('button', { name: /^🔄 Replan$/ }))

    await waitFor(() =>
      expect(screen.getByText(/Aucune surcharge/)).toBeInTheDocument(),
    )
    // Aucune modal de replan ouverte (pas de bouton "Appliquer" visible).
    expect(
      screen.queryByRole('button', { name: 'Appliquer' }),
    ).not.toBeInTheDocument()
    // Aucun PATCH parti.
    expect(
      calls.find((c) => c.method === 'PATCH' && c.url.startsWith('/api/tasks')),
    ).toBeUndefined()
  })

  it('scénario du brief : Alice surchargée 25–29 mai → « Définir le message » décalée au 1er juin', async () => {
    // Encodage strict de l'exemple du cahier des charges. Si demain un
    // changement d'algo casse ce cas précis, le test parle de lui-même.
    setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    fireEvent.click(screen.getByRole('button', { name: /^🔄 Replan$/ }))

    // La modal s'ouvre avec « Définir le message » comme seule tâche déplacée.
    // On scope les requêtes à la modal (les libellés apparaissent aussi
    // dans le Gantt à gauche).
    const dialog = await screen.findByRole('dialog', {
      name: /replanification/i,
    })
    expect(
      within(dialog).getByRole('button', { name: 'Appliquer' }),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('Définir le message')).toBeInTheDocument()
    // « Recherche audience » ne doit PAS apparaître DANS LA MODAL (elle ne
    // bouge pas — la replanification ne la liste donc pas).
    expect(
      within(dialog).queryByText('Recherche audience'),
    ).not.toBeInTheDocument()
    // Et la nouvelle date de début doit être le lundi 1er juin (1er jour
    // ouvré après la fin du 29 mai d'Alice).
    expect(within(dialog).getByText(/2026-06-01/)).toBeInTheDocument()
  })

  it('RG-GANTT-0907 — Annuler ferme la modal sans envoyer de PATCH', async () => {
    // Garantit qu'un utilisateur peut prévisualiser SANS engager les
    // modifications. Cf. spec UI « Aperçu puis confirmation ».
    const { calls } = setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    fireEvent.click(screen.getByRole('button', { name: /^🔄 Replan$/ }))
    await waitFor(() => screen.getByRole('button', { name: 'Appliquer' }))

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }))

    expect(
      screen.queryByRole('button', { name: 'Appliquer' }),
    ).not.toBeInTheDocument()
    // Aucun PATCH sur /api/tasks/:id parti.
    expect(
      calls.find((c) => c.method === 'PATCH' && c.url.startsWith('/api/tasks')),
    ).toBeUndefined()
  })

  it('RG-GANTT-0907 — Appliquer envoie 1 PATCH par tâche déplacée avec les nouvelles dates', async () => {
    // Garantit que la confirmation envoie effectivement la replanification
    // au serveur (pas d'oubli silencieux côté handler).
    const { calls } = setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    fireEvent.click(screen.getByRole('button', { name: /^🔄 Replan$/ }))
    await waitFor(() => screen.getByRole('button', { name: 'Appliquer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.method === 'PATCH' && c.url === '/api/tasks/t1b',
      )
      expect(patches).toHaveLength(1)
      const body = JSON.parse(patches[0].body!)
      // 1er juin = lundi suivant la fin du 29 mai d'Alice (vendredi).
      expect(body.start_date).toBe('2026-06-01')
      // v1.23 — Charge préservée : 25/05/2026 est désormais férié (Lundi de
      // Pentecôte) → l'intervalle 25 mai → 5 juin compte 9 j ouvrés (au lieu
      // de 10). Depuis le 1er juin, +9 j ouvrés → jeudi 11 juin.
      expect(body.end_date).toBe('2026-06-11')
    })
    // La tâche qui ne bouge pas ne fait l'objet d'aucun PATCH.
    expect(
      calls.find((c) => c.method === 'PATCH' && c.url === '/api/tasks/t1a'),
    ).toBeUndefined()
  })

  it("après application, l'état est rafraîchi (GET /api/state ré-émis)", async () => {
    // Garantit que la vue reflète le nouvel état serveur après les PATCH —
    // sans ce GET final, l'UI resterait sur les anciennes dates.
    const { calls } = setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    const getStateBefore = calls.filter(
      (c) => c.method === 'GET' && c.url.startsWith('/api/state'),
    ).length

    fireEvent.click(screen.getByRole('button', { name: /^🔄 Replan$/ }))
    await waitFor(() => screen.getByRole('button', { name: 'Appliquer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => {
      const getStateAfter = calls.filter(
        (c) => c.method === 'GET' && c.url.startsWith('/api/state'),
      ).length
      expect(getStateAfter).toBeGreaterThan(getStateBefore)
    })
  })
})

// =============================================================================
// v1.20 — Test de non-régression MÉTIER : repli des phases dans le planning
// =============================================================================

describe('App — repli des phases (v1.20)', () => {
  /** État avec une phase "Pré-prod" contenant 2 tâches enfants. */
  function mkStateWithPhase(): GanttState {
    return mkState({
      tasks: [
        {
          id: 'p1',
          name: 'Pré-prod',
          kind: 'phase',
          start_date: '2026-05-01',
          end_date: '2026-05-10',
          progress: 0,
          collaborator_id: null,
          color: null,
          parent_id: null,
          predecessor_id: null,
          predecessor_lag: 0,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 0,
          project_id: 'p1',
        },
        {
          id: 't1',
          name: 'Tâche enfant A',
          kind: 'task',
          start_date: '2026-05-01',
          end_date: '2026-05-05',
          progress: 0,
          collaborator_id: null,
          color: null,
          parent_id: 'p1',
          predecessor_id: null,
          predecessor_lag: 0,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 1,
          project_id: 'p1',
        },
        {
          id: 't2',
          name: 'Tâche enfant B',
          kind: 'task',
          start_date: '2026-05-06',
          end_date: '2026-05-10',
          progress: 0,
          collaborator_id: null,
          color: null,
          parent_id: 'p1',
          predecessor_id: null,
          predecessor_lag: 0,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 2,
          project_id: 'p1',
        },
      ],
    })
  }

  it("RG-GANTT-0103 / RG-GANTT-0308 — clic sur le chevron d'une phase masque ses enfants dans la liste", async () => {
    // Règle : la phase reste visible (on doit pouvoir la déplier), mais
    // ses enfants disparaissent du panneau gauche ET du planning.
    setupFetchMock(mkStateWithPhase())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    // État initial : les 2 enfants sont visibles.
    expect(
      document.querySelector('[draggable="true"][title="Tâche enfant A"]'),
    ).toBeTruthy()
    expect(
      document.querySelector('[draggable="true"][title="Tâche enfant B"]'),
    ).toBeTruthy()

    // Clic sur le chevron de la phase Pré-prod.
    const chevron = document.querySelector(
      'button[aria-label="Replier"]',
    ) as HTMLElement
    expect(chevron).toBeTruthy()
    fireEvent.click(chevron)

    // Après repli : les enfants ont disparu, la phase est encore là.
    expect(
      document.querySelector('[draggable="true"][title="Tâche enfant A"]'),
    ).toBeNull()
    expect(
      document.querySelector('[draggable="true"][title="Tâche enfant B"]'),
    ).toBeNull()
    expect(
      document.querySelector('[draggable="true"][title="Pré-prod"]'),
    ).toBeTruthy()
    // Et le chevron a basculé en « Déplier ».
    expect(document.querySelector('button[aria-label="Déplier"]')).toBeTruthy()
  })

  it("RG-GANTT-0308 — l'état de repli est persisté en localStorage", async () => {
    setupFetchMock(mkStateWithPhase())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    fireEvent.click(
      document.querySelector('button[aria-label="Replier"]') as HTMLElement,
    )
    const raw = localStorage.getItem('gantt.collapsedPhases')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toEqual(['p1'])
  })
})

// =============================================================================
// v1.21 — Bandeau de cohérence et Replan partiel
// =============================================================================
// Suite de tests dédiée au bandeau d'alerte affiché au-dessus du planning
// quand `checkCoherence` détecte au moins une incohérence, et au flux
// « Replan partiel » qui n'affecte que les tâches en conflit (et leurs
// successeurs), laissant le reste du planning intact.
// =============================================================================

describe("App — bandeau d'incohérence (v1.21)", () => {
  it("RG-GANTT-0806 — n'affiche aucun bandeau quand le projet est cohérent", async () => {
    setupFetchMock()
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))
    expect(screen.queryByTestId('coherence-alert')).not.toBeInTheDocument()
  })

  it('RG-GANTT-0807 — affiche le bandeau quand une surcharge existe + énumère les 2 boutons', async () => {
    setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByTestId('coherence-alert'))
    const alert = screen.getByTestId('coherence-alert')
    // Message lisible mentionnant les deux tâches en conflit.
    expect(
      within(alert).getByText(/Surcharge.*Recherche audience.*Définir/),
    ).toBeInTheDocument()
    // v2.2 — Un seul bouton « Replan complet » (Replan partiel abandonné, RG-GANTT-0905 supprimée).
    expect(
      within(alert).getByRole('button', { name: /Replan complet/ }),
    ).toBeInTheDocument()
  })

  it('RG-GANTT-0807 — "Replan complet" depuis le bandeau ouvre la modal habituelle', async () => {
    setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByTestId('coherence-alert'))
    fireEvent.click(
      within(screen.getByTestId('coherence-alert')).getByRole('button', {
        name: /Replan complet/,
      }),
    )
    await screen.findByRole('dialog', { name: /replanification/i })
    expect(
      screen.getByRole('button', { name: 'Appliquer' }),
    ).toBeInTheDocument()
  })

  // v2.2 — Test "Replan partiel" supprimé : RG-GANTT-0905 abandonnée.
})

// =============================================================================
// v1.22 — Auto-replan après enregistrement d'une tâche
// =============================================================================
// Vérifie que :
//   • cocher la case (par défaut) → un Replan complet est déclenché en
//     cascade derrière le PATCH d'édition (séquence PATCH-edit → GET state
//     → PATCH-replan(s) → GET state),
//   • décocher la case → seul le PATCH d'édition est envoyé, AUCUN replan.
// =============================================================================

describe("App — auto-replan après modification d'une tâche (v1.22)", () => {
  // v2.3 — Fige today à 2026-05-01 pour que les fixtures de mai 2026 ne soient
  // pas tirées par la borne basse globale `today` (RG-GANTT-1903 redéfinie).
  let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null
  beforeEach(() => {
    // v2.3 — Mocke `Date.now()` SEUL (sans toucher aux timers de Testing
    // Library) pour figer `todayIso()` à mai 2026. La borne basse globale du
    // Replan (RG-GANTT-1903 redéfinie) utilise today : sans ce mock, les
    // fixtures de mai-juin 2026 seraient tirées au today système réel.
    const fixedNow = new Date('2026-05-15T00:00:00.000Z').getTime()
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
  })
  afterEach(() => {
    dateNowSpy?.mockRestore()
  })

  // Réutilise le scénario de surcharge Alice (`mkOverloadedState` plus haut)
  // : 2 tâches qui se chevauchent sur le même collab → le PATCH d'édition
  // est suivi d'un PATCH sur la tâche poussée par le Replan automatique.
  it("RG-GANTT-0909 — case cochée par défaut : un Replan suit le PATCH d'édition", async () => {
    const { calls } = setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    // Ouvre l'éditeur pour t1a en cliquant sur la ligne (drag handle).
    const row = document.querySelector(
      '[draggable="true"][title="Recherche audience"]',
    ) as HTMLElement
    fireEvent.click(row)
    await screen.findByRole('heading', { name: /Modifier/ })

    // Case cochée par défaut → simple « Enregistrer ».
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))

    // On attend qu'un PATCH d'auto-replan parte sur t1b (la tâche en surcharge,
    // déplacée par le Replan automatique). Ne pas tester l'URL exacte du
    // PATCH d'édition (peu intéressant ici) — on veut surtout la cascade.
    await waitFor(() => {
      const replanPatches = calls.filter(
        (c) => c.method === 'PATCH' && c.url === '/api/tasks/t1b',
      )
      expect(replanPatches.length).toBeGreaterThan(0)
      const body = JSON.parse(replanPatches[0].body!)
      expect(body.start_date).toBe('2026-06-01')
    })
  })

  it("RG-GANTT-0909 — case décochée : aucun replan, seul le PATCH d'édition part", async () => {
    const { calls } = setupFetchMock(mkOverloadedState())
    render(<App />)
    await waitFor(() => screen.getByRole('combobox'))

    const row = document.querySelector(
      '[draggable="true"][title="Recherche audience"]',
    ) as HTMLElement
    fireEvent.click(row)
    await screen.findByRole('heading', { name: /Modifier/ })

    // Décoche la case.
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Replanifier après enregistrement/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/ }))

    // Donne le temps aux fetch éventuels d'arriver, puis assert NÉGATIF.
    await waitFor(() => {
      expect(
        calls.find((c) => c.method === 'PATCH' && c.url === '/api/tasks/t1a'),
      ).toBeDefined()
    })
    // Aucun PATCH n'est parti sur t1b (= aucun replan déclenché).
    expect(
      calls.find((c) => c.method === 'PATCH' && c.url === '/api/tasks/t1b'),
    ).toBeUndefined()
  })
})

// =============================================================================
// v1.23 — Replan préserve `predecessor_lag` (correctif bug « Test délai »)
// =============================================================================
// Régression remontée v1.22 : modifier le délai d'une tâche à 2 et enregistrer
// avec la case « Replanifier » cochée faisait revenir le lag à 6 — parce que
// `submitReplanMoves` n'envoyait pas le lag, et le serveur l'inférait depuis
// le nouveau gap. Le PATCH du replan doit désormais inclure `predecessor_lag`
// pour que le serveur prenne la branche « lagInPatch=true » et préserve
// l'intention utilisateur.
// =============================================================================

describe('App — Replan préserve predecessor_lag (v1.23)', () => {
  it('RG-GANTT-0908 — chaque PATCH de replan inclut le lag de la tâche déplacée', async () => {
    // Scénario simple : Alice a 2 tâches qui se chevauchent. La 2e a un lag=3
    // (sans prédécesseur pour simplifier, mais le PATCH doit malgré tout
    // transporter la valeur stockée — preuve que `submitReplanMoves` ne
    // tronque rien).
    const state = mkState({
      collaborators: [
        { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
      ],
      tasks: [
        {
          id: 'PRED',
          name: 'Pred',
          kind: 'task',
          start_date: '2026-06-08',
          end_date: '2026-06-12',
          progress: 0,
          collaborator_id: 'alice',
          color: null,
          parent_id: null,
          predecessor_id: null,
          predecessor_lag: 0,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 0,
          project_id: 'p1',
        },
        {
          id: 'SUCC',
          name: 'Succ',
          kind: 'task',
          // Chevauche PRED → replan va pousser SUCC.
          start_date: '2026-06-10',
          end_date: '2026-06-12',
          progress: 0,
          collaborator_id: 'alice',
          color: null,
          parent_id: null,
          predecessor_id: 'PRED',
          // Lag = 3 j ouvrés (= valeur utilisateur, à préserver).
          predecessor_lag: 3,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 1,
          project_id: 'p1',
        },
      ],
    })
    const { calls } = setupFetchMock(state)
    render(<App />)
    await waitFor(() => screen.getByTestId('coherence-alert'))
    fireEvent.click(
      within(screen.getByTestId('coherence-alert')).getByRole('button', {
        name: /Replan complet/,
      }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: /replanification/i,
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url === '/api/tasks/SUCC',
      )
      expect(patch).toBeTruthy()
      const body = JSON.parse(patch!.body!)
      // v1.23 — Le lag stocké est renvoyé tel quel dans le PATCH du replan.
      expect(body.predecessor_lag).toBe(3)
      // Et les dates proposées sont aussi présentes.
      expect(body.start_date).toBeTruthy()
      expect(body.end_date).toBeTruthy()
    })
  })

  // v2.2 / RG-W — Le PATCH du Replan inclut systématiquement `charge_jours`
  // pour empêcher la back-dérivation côté serveur (boucle B1 corrigée).
  // Reprend le setup exact du test voisin (predecessor_lag) qui déclenche déjà
  // un Replan effectif → on ajoute juste l'assertion sur charge_jours.
  it('v2.2 / RG-W — chaque PATCH de replan inclut charge_jours', async () => {
    const state = mkState({
      collaborators: [
        { id: 'alice', name: 'Alice', color: '#3b82f6', position: 0 },
      ],
      tasks: [
        {
          id: 'PRED',
          name: 'Pred',
          kind: 'task',
          start_date: '2026-06-08',
          end_date: '2026-06-12',
          progress: 0,
          collaborator_id: 'alice',
          color: null,
          parent_id: null,
          predecessor_id: null,
          predecessor_lag: 0,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 0,
          project_id: 'p1',
        },
        {
          id: 'SUCC',
          name: 'Succ',
          kind: 'task',
          start_date: '2026-06-10',
          end_date: '2026-06-12',
          progress: 0,
          collaborator_id: 'alice',
          color: null,
          parent_id: null,
          predecessor_id: 'PRED',
          predecessor_lag: 3,
          priority: null,
          not_before_date: null,
          not_later_than_date: null,
          charge_jours: null,
          position: 1,
          project_id: 'p1',
        },
      ],
    })
    const { calls } = setupFetchMock(state)
    render(<App />)
    await waitFor(() => screen.getByTestId('coherence-alert'))
    fireEvent.click(
      within(screen.getByTestId('coherence-alert')).getByRole('button', {
        name: /Replan complet/,
      }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: /replanification/i,
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.method === 'PATCH' && c.url.startsWith('/api/tasks/'),
      )
      expect(patches.length).toBeGreaterThan(0)
      for (const p of patches) {
        const body = JSON.parse(p.body!)
        // RG-W : charge_jours doit être présent (≥ 1, source de vérité préservée).
        expect(body.charge_jours).toBeDefined()
        expect(typeof body.charge_jours).toBe('number')
        expect(body.charge_jours).toBeGreaterThanOrEqual(1)
      }
    })
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
      expect(screen.getByLabelText('Erreur réseau')).toBeInTheDocument()
    })
    // Vérifie que l'erreur a bien été loguée (preuve que le chemin
    // d'erreur a été emprunté), tout en l'isolant du flux stderr.
    expect(errSpy).toHaveBeenCalled()
  })
})
