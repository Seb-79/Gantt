// =============================================================================
// DIALOGS — Mount point unique pour les modales confirm / prompt
// =============================================================================
// Voir `src/lib/dialogs.ts` pour la motivation et l'API publique.
//
// Ce composant doit être monté UNE SEULE FOIS (à la racine de App). Il
// s'abonne au listener du module `dialogs.ts` et rend la modale demandée.
// Il maintient une PILE LIFO : si un code appelle `askConfirm` pendant
// qu'une modale est déjà ouverte (cas rare mais possible), on empile
// puis on dépile dans l'ordre inverse à la fermeture.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { __setDialogListener, type DialogRequest } from '../lib/dialogs'

/**
 * Composant racine des modales. Doit figurer une seule fois dans l'arbre,
 * idéalement en tout dernier dans `<App>` pour que les éléments aient le
 * temps d'être montés avant le premier `askConfirm` (sinon : fallback
 * `window.confirm` natif, ce qui n'est pas dramatique).
 */
export default function Dialogs() {
  // Pile des requêtes en attente. La dernière (en haut de pile) est celle
  // qu'on affiche. À la fermeture, on dépile et on affiche la précédente.
  const [stack, setStack] = useState<DialogRequest[]>([])

  // Le champ texte pour `prompt`. Reset à chaque nouvelle requête prompt.
  const [promptValue, setPromptValue] = useState('')

  // Ref vers le champ pour focus auto à l'ouverture.
  const inputRef = useRef<HTMLInputElement>(null)

  // Inscription / désinscription du listener.
  useEffect(() => {
    __setDialogListener((req) => {
      setStack((s) => {
        // Si on reçoit un prompt, on synchronise la valeur initiale.
        if (req.kind === 'prompt') setPromptValue(req.defaultValue)
        return [...s, req]
      })
    })
    return () => __setDialogListener(null)
  }, [])

  // Focus + select-all sur le champ de saisie quand un prompt s'ouvre.
  // (Améliore l'ergonomie : l'utilisateur peut taper tout de suite pour
  // écraser la valeur par défaut, ou Tab → Entrée pour valider.)
  const current = stack[stack.length - 1]
  useEffect(() => {
    if (current?.kind === 'prompt') {
      // setTimeout 0 = laisser le navigateur peindre la modale avant
      // d'essayer de focuser (sinon le focus tombe parfois dans le vide).
      const id = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
      return () => clearTimeout(id)
    }
  }, [current])

  if (!current) return null

  /** Dépile la requête courante et lui retourne le résultat. */
  const close = (result: boolean | string | null) => {
    setStack((s) => s.slice(0, -1))
    if (current.kind === 'confirm') current.resolve(result as boolean)
    else current.resolve(result as string | null)
  }

  /** Touche Échap → annulation (équivalent du clic Annuler). */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(current.kind === 'confirm' ? false : null)
    } else if (e.key === 'Enter' && current.kind === 'prompt') {
      // Pour le prompt, Entrée = OK. Pour le confirm, on laisse l'utilisateur
      // cliquer (deux choix bivalents, pas de raccourci ambigu).
      e.preventDefault()
      close(promptValue)
    }
  }

  return (
    <div
      // Backdrop semi-transparent qui couvre tout l'écran. Click ailleurs
      // que sur la carte = annulation (cohérent avec TaskEditor).
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => close(current.kind === 'confirm' ? false : null)}
      // role / aria-modal : signaler le rôle accessibilité.
      role="dialog"
      aria-modal="true"
      onKeyDown={onKeyDown}
    >
      {/* La carte. `stopPropagation` empêche le click intérieur de fermer
          la modale via le backdrop. `min-w-[320px]` garantit qu'elle ne
          rétrécit pas en dessous d'une taille lisible. */}
      <div
        className="bg-white rounded-lg shadow-xl p-5 min-w-[320px] max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Message. `whitespace-pre-line` respecte les \n du texte source
            (utile pour les messages multi-lignes comme « supprimer le projet…
            \n\nC'est le dernier… ») */}
        <p className="text-slate-800 whitespace-pre-line mb-4">
          {current.message}
        </p>

        {/* Champ de saisie : uniquement pour les prompts. */}
        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            type="text"
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            className="w-full border border-slate-300 rounded px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        )}

        {/* Boutons Annuler / OK alignés à droite, à la TaskEditor. */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => close(current.kind === 'confirm' ? false : null)}
            className="px-4 py-2 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() =>
              close(current.kind === 'confirm' ? true : promptValue)
            }
            // Bouton primaire (bordeaux/amber selon thème) — on s'aligne
            // sur la teinte amber utilisée ailleurs pour les actions
            // principales (cf. capture utilisateur).
            className="px-4 py-2 rounded bg-amber-700 hover:bg-amber-800 text-white"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
