// =============================================================================
// COMPOSANT PredecessorPicker — Gantt v1.22
// =============================================================================
// Sélecteur multi-prédécesseurs lisible : remplace le `<select>` mono-pred
// historique de TaskEditor. Affiche :
//   • une rangée de CHIPS pour chaque prédécesseur déjà sélectionné, avec
//     son lag (jours ouvrés) éditable inline et un bouton ✕ pour le retirer ;
//   • un bouton « + Ajouter un prédécesseur » qui ouvre un POPOVER ;
//   • dans le popover, un champ de recherche et l'ARBRE complet du projet
//     (phases incluses, indentées). Les phases sont affichées GRISÉES et
//     non-cliquables ; idem pour la tâche elle-même et ses descendants
//     (anti-cycle) et pour les prédécesseurs déjà sélectionnés.
//
// Le composant ne décide rien : il appelle `onChange(list)` à chaque mutation
// et c'est au parent (TaskEditor) d'aligner la date de début si nécessaire
// (cf. `computeMaxStartFromPredecessors`).
// =============================================================================

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { descendantIds, flattenTaskTree } from '../lib/utils'
import type { Task } from '../lib/types'

/** Entrée de la liste de prédécesseurs : id de la tâche + son lag (j ouvrés). */
export interface PredecessorEntry {
  id: string
  lag: number
}

interface Props {
  /** Tâche éditée (null = création — anti-cycle réduit à l'auto-référence). */
  task: Task | null
  /** Toutes les tâches du projet courant (incl. phases). */
  allTasks: Task[]
  /** Liste actuelle des prédécesseurs sélectionnés (vide = aucun). */
  value: PredecessorEntry[]
  /** Callback de mise à jour. Reçoit la NOUVELLE liste complète. */
  onChange: (next: PredecessorEntry[]) => void
}

/**
 * v1.22 — Picker arborescent multi-prédécesseurs.
 *
 * @param task      Tâche éditée (null en mode création).
 * @param allTasks  Toutes les tâches du projet pour construire l'arbre.
 * @param value     Liste actuelle des prédécesseurs.
 * @param onChange  Callback de mise à jour.
 */
export default function PredecessorPicker({
  task,
  allTasks,
  value,
  onChange,
}: Props) {
  /** Popover ouvert / fermé. */
  const [open, setOpen] = useState(false)
  /** Recherche dans l'arbre (insensible à la casse, sur le nom de la tâche). */
  const [query, setQuery] = useState('')
  /** Ref sur le conteneur principal pour gérer le clic à l'extérieur. */
  const rootRef = useRef<HTMLDivElement>(null)
  /** v2.1 / F2 — Ref sur le bouton « + Ajouter » pour calculer la position
   *  du popover (qui vit désormais dans un portail React document.body). */
  const anchorRef = useRef<HTMLButtonElement>(null)
  /** v2.1 / F2 — Ref sur le contenu du popover (rendu en portail). Sert au
   *  listener mousedown extérieur pour ne pas fermer en cliquant dedans. */
  const popoverRef = useRef<HTMLDivElement>(null)
  /** v2.1 / F2 — Position absolue (viewport) du popover + hauteur max
   *  calculée dynamiquement. `placeAbove` indique si on ouvre vers le haut
   *  (peu de place en bas et plus de place en haut). */
  const [popoverPos, setPopoverPos] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 288,
    placeAbove: false,
  })

  /**
   * Ids interdits comme prédécesseur : la tâche elle-même et ses descendants
   * (anti-cycle direct + indirect via parent_id). En création, seul l'id
   * (futur) de la tâche éditée serait à exclure, mais il n'existe pas
   * encore → l'ensemble est vide.
   */
  const banned = useMemo(() => {
    if (!task) return new Set<string>()
    const s = descendantIds(task.id, allTasks)
    s.add(task.id)
    return s
  }, [task, allTasks])

  /** Liste hiérarchique aplatie (préserve l'ordre `position` à chaque niveau). */
  const rows = useMemo(() => flattenTaskTree(allTasks), [allTasks])

  /** Index id → tâche pour résoudre noms et types rapidement. */
  const byId = useMemo(() => {
    const m = new Map<string, Task>()
    for (const t of allTasks) m.set(t.id, t)
    return m
  }, [allTasks])

  /** Ids déjà sélectionnés (set pour lookup O(1) dans le rendu de l'arbre). */
  const selectedIds = useMemo(() => new Set(value.map((p) => p.id)), [value])

  /** Filtre l'arbre par la recherche (match case-insensitive sur le nom). */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      const t = byId.get(r.id)
      return t ? t.name.toLowerCase().includes(q) : false
    })
  }, [rows, query, byId])

  // -- Mutation de la liste --------------------------------------------------

  /** Ajoute un prédécesseur à la liste (lag par défaut = 0). */
  function addPredecessor(id: string) {
    if (selectedIds.has(id)) return
    onChange([...value, { id, lag: 0 }])
  }

  /** Retire un prédécesseur. */
  function removePredecessor(id: string) {
    onChange(value.filter((p) => p.id !== id))
  }

  /** Modifie le lag d'un prédécesseur existant. */
  function updateLag(id: string, raw: string) {
    const n = Math.max(0, Math.floor(Number(raw) || 0))
    onChange(value.map((p) => (p.id === id ? { ...p, lag: n } : p)))
  }

  // -- Fermeture au clic extérieur + Escape ---------------------------------

  useEffect(() => {
    if (!open) return
    function onDocPointer(e: MouseEvent) {
      // v2.1 / F2 — Le popover est désormais dans un portail (document.body),
      // donc PAS un descendant de rootRef. On vérifie en plus popoverRef pour
      // ne pas fermer en cliquant à l'intérieur du popover.
      const target = e.target as Node
      const inRoot = rootRef.current?.contains(target) ?? false
      const inPopover = popoverRef.current?.contains(target) ?? false
      if (!inRoot && !inPopover) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // -- v2.1 / F2 — Position du popover (calculée depuis l'ancre) -------------
  //
  // Le popover vit dans un portail document.body : il échappe à l'`overflow`
  // de la modale parente (TaskEditor) qui le coupait avant. On le positionne
  // en `fixed` juste sous le bouton « + Ajouter », largeur = largeur de la
  // rangée de chips parente pour rester aligné visuellement.
  useLayoutEffect(() => {
    if (!open) return
    function updatePos() {
      const anchor = anchorRef.current
      const root = rootRef.current
      if (!anchor || !root) return
      const aRect = anchor.getBoundingClientRect()
      const rRect = root.getBoundingClientRect()
      // v2.1 / F2 — Placement intelligent : si pas assez de place en bas
      // (cas typique d'une modale qui descend bas) et plus de place au-dessus,
      // on ouvre vers le HAUT. La hauteur max est ajustée à la place dispo
      // moins 16 px de marge avec le bord de l'écran.
      const SAFE_MARGIN = 16
      const PREFERRED_HEIGHT = 288 // max-h-72 par défaut
      const vh = window.innerHeight
      const spaceBelow = vh - aRect.bottom - SAFE_MARGIN
      const spaceAbove = aRect.top - SAFE_MARGIN
      const placeAbove =
        spaceBelow < PREFERRED_HEIGHT && spaceAbove > spaceBelow
      const maxHeight = Math.max(
        160, // minimum lisible
        Math.min(PREFERRED_HEIGHT, placeAbove ? spaceAbove : spaceBelow),
      )
      setPopoverPos({
        top: placeAbove
          ? Math.max(SAFE_MARGIN, aRect.top - maxHeight - 4)
          : aRect.bottom + 4,
        left: rRect.left, // aligné sur la rangée de chips
        width: rRect.width,
        maxHeight,
        placeAbove,
      })
    }
    updatePos()
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true) // capture pour scrolls internes
    return () => {
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [open])

  // -- Rendu -----------------------------------------------------------------

  /**
   * Détermine si une ligne de l'arbre est interdite à la sélection, et
   * fournit un libellé d'aide à afficher en tooltip.
   * Extrait pour éviter un ternaire imbriqué dans le JSX.
   */
  function disabledReason(rowId: string): string | null {
    const t = byId.get(rowId)
    if (!t) return 'Tâche introuvable'
    if (t.kind === 'phase') return 'Une phase ne peut pas être prédécesseur'
    if (banned.has(rowId))
      return 'Créerait un cycle (tâche elle-même ou descendant)'
    if (selectedIds.has(rowId)) return 'Déjà sélectionné'
    return null
  }

  return (
    <div ref={rootRef} className="relative">
      {/* -- Chips des prédécesseurs sélectionnés -------------------------- */}
      {/* v2.5 — Harmonisation avec l'ajout d'un collaborateur : les chips
          FLOTTENT (pas de cadre englobant), forme arrondie identique à
          `CollabChip`. La chip reste plus riche : elle conserve l'éditeur de
          délai (« + 0 j ») et le ✕. Pas de texte « Aucun prédécesseur » quand
          la liste est vide (la zone est simplement absente, comme pour les
          collaborateurs). */}
      {value.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {value.map((p) => {
            const t = byId.get(p.id)
            if (!t) return null
            return (
              <span
                key={p.id}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 border border-slate-300 pl-2 pr-1 py-0.5 text-xs"
              >
                <span className="font-medium" title={`Tâche : ${t.name}`}>
                  {t.kind === 'milestone' ? '◆ ' : ''}
                  {t.name}
                </span>
                <label
                  className="flex items-center gap-0.5 text-slate-500"
                  title="Délai (jours ouvrés) entre la fin du prédécesseur et le début de cette tâche."
                >
                  <span className="text-[10px]">+</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={p.lag}
                    onChange={(e) => updateLag(p.id, e.target.value)}
                    className="w-10 border border-slate-300 rounded px-1 py-0 text-xs"
                    aria-label={`Délai du prédécesseur ${t.name}`}
                  />
                  <span className="text-[10px]">j</span>
                </label>
                <button
                  type="button"
                  onClick={() => removePredecessor(p.id)}
                  className="ml-0.5 text-slate-500 hover:text-red-600 leading-none"
                  aria-label={`Retirer le prédécesseur ${t.name}`}
                  title="Retirer ce prédécesseur"
                >
                  ✕
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* -- Déclencheur : sosie du <select> « — ajouter — » -------------- */}
      {/* v2.5 — Même contrôle visuel que le select d'ajout d'un collaborateur
          (bordure + chevron, pleine largeur). En l'ouvrant, le popover ci-dessous
          affiche la recherche + l'arbre indenté. */}
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Ajouter un prédécesseur"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between border border-slate-300 rounded px-2 py-1 text-xs text-slate-500 bg-white"
        title="Ouvrir l'arbre pour ajouter un prédécesseur"
      >
        <span>— ajouter —</span>
        <span className="text-slate-400" aria-hidden>
          ▾
        </span>
      </button>

      {/* -- Popover de l'arbre ------------------------------------------- */}
      {/* v2.1 / F2 — Rendu via createPortal sur document.body avec position
          fixed. Évite que le popover ne soit coupé par l'overflow-y-auto de
          la modale TaskEditor. Position calculée dans useLayoutEffect. */}
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[60] overflow-auto bg-white border border-slate-300 rounded shadow-lg"
            style={{
              top: popoverPos.top,
              left: popoverPos.left,
              width: popoverPos.width,
              maxHeight: popoverPos.maxHeight,
            }}
          >
            <div className="sticky top-0 bg-white border-b border-slate-200 p-1.5">
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher une tâche…"
                className="w-full text-xs border border-slate-300 rounded px-2 py-1"
              />
            </div>
            <ul className="py-1">
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-xs text-slate-400 italic">
                  Aucun résultat.
                </li>
              )}
              {filtered.map((row) => {
                const t = byId.get(row.id)
                if (!t) return null
                const reason = disabledReason(row.id)
                const disabled = reason !== null
                return (
                  <li
                    key={row.id}
                    className={
                      disabled
                        ? 'px-2 py-1 text-xs text-slate-300 cursor-not-allowed select-none'
                        : 'px-2 py-1 text-xs cursor-pointer hover:bg-blue-50'
                    }
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    onClick={
                      disabled
                        ? undefined
                        : () => {
                            addPredecessor(row.id)
                            // Popover laissé ouvert : permet d'ajouter
                            // plusieurs prédécesseurs sans rouvrir à chaque fois.
                          }
                    }
                    title={reason ?? `Ajouter « ${t.name} »`}
                    aria-disabled={disabled}
                    data-task-id={row.id}
                  >
                    {t.kind === 'phase' && '🗂️ '}
                    {t.kind === 'milestone' && '◆ '}
                    {t.name}
                    {selectedIds.has(row.id) && (
                      <span className="ml-1 text-green-600">✓</span>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="sticky bottom-0 bg-white border-t border-slate-200 p-1.5 text-right">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs text-slate-600 hover:underline px-2 py-0.5"
              >
                Fermer
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
