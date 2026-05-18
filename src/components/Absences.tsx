// =============================================================================
// COMPOSANT Absences — Gantt v2.0 / F3
// =============================================================================
// Onglet « Congés » (cross-projet) : pour chaque collaborateur, liste ses
// jours d'absence et permet d'en ajouter / supprimer.
//
// Règles métier v2.0 / F3 :
//   • RG-GANTT-1400 : une absence est portée par un collaborateur, à une
//     date donnée, avec une fraction non-travaillée (0.25, 0.5, 0.75 ou 1).
//   • RG-GANTT-1401 : l'absence est cross-projet — elle réduit la capacité
//     du collab sur TOUS ses projets ce jour-là, simultanément.
//   • RG-GANTT-1402 : la lecture est multiplicative — capacité réelle =
//     allocation_pct × (1 − fraction). Exemple : Paul à 50 % sur un projet
//     pose une demi-journée d'absence → capacité du jour = 50 % × 0,5 = 25 %.
//   • RG-GANTT-1403 : une seule absence par (collab, date) ; saisir une
//     nouvelle fraction sur une date déjà occupée écrase l'ancienne (UPSERT).
//
// L'onglet est indépendant du projet sélectionné : on voit toujours tous
// les collabs et leurs absences passées + futures.
// =============================================================================

import { useMemo, useState } from 'react'
import type { Collaborator, CollaboratorAbsence } from '../lib/types'

interface Props {
  /** Tous les collaborateurs connus (un bloc par collab). */
  collaborators: Collaborator[]
  /** Toutes les absences (cross-projet). */
  absences: CollaboratorAbsence[]
  /** Callback d'ajout (POST API → refresh /api/state). */
  onAddAbsence: (
    collaboratorId: string,
    body: { date: string; fraction: number },
  ) => void
  /** Callback de suppression par (collab, date). */
  onDeleteAbsence: (collaboratorId: string, date: string) => void
}

/** Libellé lisible pour une fraction d'absence. */
function formatFraction(f: number): string {
  if (f === 1) return 'journée'
  if (f === 0.75) return '¾ journée'
  if (f === 0.5) return '½ journée'
  if (f === 0.25) return '¼ journée'
  return `${f * 100} %`
}

/**
 * Vue « Congés » cross-projet. 100 % présentationnel : reçoit les données +
 * délègue les mutations au parent (qui gère API + refetch).
 */
export default function Absences({
  collaborators,
  absences,
  onAddAbsence,
  onDeleteAbsence,
}: Props) {
  /**
   * Absences groupées par collaborateur (Map id → tableau trié par date).
   */
  const byCollab = useMemo(() => {
    const m = new Map<string, CollaboratorAbsence[]>()
    for (const a of absences) {
      const arr = m.get(a.collaborator_id) || []
      arr.push(a)
      m.set(a.collaborator_id, arr)
    }
    for (const arr of m.values()) {
      arr.sort((x, y) => x.date.localeCompare(y.date))
    }
    return m
  }, [absences])

  // Collabs triés par position (cohérent avec partout ailleurs).
  const sortedCollabs = useMemo(
    () => [...collaborators].sort((a, b) => a.position - b.position),
    [collaborators],
  )

  if (sortedCollabs.length === 0) {
    return (
      <div className="p-6 text-slate-500 text-sm">
        Aucun collaborateur. Créez-en un dans la barre du haut pour pouvoir
        saisir des congés.
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Congés</h2>
        <p className="text-sm text-slate-600">
          Saisie des absences de chaque collaborateur (cross-projet). Une
          absence diminue multiplicativement la capacité du collab sur tous ses
          projets le jour concerné.
        </p>
      </header>

      <ul className="space-y-3">
        {sortedCollabs.map((c) => (
          <CollabAbsencesRow
            key={c.id}
            collab={c}
            absences={byCollab.get(c.id) || []}
            onAdd={(body) => onAddAbsence(c.id, body)}
            onDelete={(date) => onDeleteAbsence(c.id, date)}
          />
        ))}
      </ul>
    </div>
  )
}

/**
 * v2.0 / F3 — Bloc d'un collaborateur : pastille de couleur + nom + liste
 * de ses jours d'absence + mini-formulaire d'ajout (date + fraction).
 *
 * Extrait dans son propre composant pour limiter la complexité de `Absences`
 * (chaque bloc porte son propre état de formulaire).
 */
function CollabAbsencesRow({
  collab,
  absences,
  onAdd,
  onDelete,
}: {
  collab: Collaborator
  absences: CollaboratorAbsence[]
  onAdd: (body: { date: string; fraction: number }) => void
  onDelete: (date: string) => void
}) {
  const [date, setDate] = useState<string>('')
  const [fraction, setFraction] = useState<number>(1)
  const [open, setOpen] = useState<boolean>(false)

  /** Soumission du mini-formulaire d'ajout d'une absence. */
  function submit() {
    if (!date) return
    onAdd({ date, fraction })
    setDate('')
    setFraction(1)
    setOpen(false)
  }

  return (
    <li className="border border-slate-200 rounded p-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-3 h-3 rounded-full border border-slate-300"
          style={{ backgroundColor: collab.color }}
          aria-hidden
        />
        <span className="text-sm font-medium flex-1">{collab.name}</span>
        <span className="text-xs text-slate-500">
          {absences.length} absence{absences.length > 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
        >
          {open ? 'Annuler' : '+ Absence'}
        </button>
      </div>

      {absences.length > 0 && (
        <ul className="mt-2 space-y-1">
          {absences.map((a) => (
            <li
              key={a.date}
              className="flex items-center gap-2 text-xs text-slate-700 pl-5"
            >
              <span className="font-mono">{a.date}</span>
              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                {formatFraction(a.fraction)}
              </span>
              <button
                type="button"
                onClick={() => onDelete(a.date)}
                className="text-red-600 hover:text-red-700 ml-auto"
                title="Supprimer cette absence"
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 pl-5 flex flex-wrap items-end gap-2">
          <label className="block text-xs">
            <span className="text-slate-600">Date</span>
            <input
              type="date"
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1 text-xs"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-600">Durée</span>
            <select
              className="mt-0.5 block border border-slate-300 rounded px-2 py-1 text-xs"
              value={fraction}
              onChange={(e) => setFraction(Number(e.target.value))}
            >
              <option value={0.25}>¼ journée</option>
              <option value={0.5}>½ journée</option>
              <option value={0.75}>¾ journée</option>
              <option value={1}>Journée complète</option>
            </select>
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={!date}
            className="px-3 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            Ajouter
          </button>
        </div>
      )}
    </li>
  )
}
