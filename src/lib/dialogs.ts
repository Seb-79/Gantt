// =============================================================================
// DIALOGS — Remplacement des boîtes natives window.prompt / window.confirm
// =============================================================================
// Pourquoi ?
//   Les boîtes natives du navigateur affichent l'en-tête « localhost:5174
//   indique » qu'on ne peut pas masquer. Visuellement c'est moche et ça
//   « casse » l'identité de l'app. Ce module remplace les appels natifs
//   par des modales custom alignées sur le style de TaskEditor.
//
// Architecture (singleton, sans prop-drilling ni Context React) :
//   1. Le composant `<Dialogs />` (cf. src/components/Dialogs.tsx) est
//      monté UNE SEULE FOIS à la racine de l'app. Au mount, il s'enregistre
//      auprès de ce module via `__setDialogListener`.
//   2. N'importe quel code (callbacks, hooks, classes) peut alors appeler
//      `askConfirm(message)` ou `askPrompt(message, default)` et `await`
//      le résultat — exactement comme un `confirm()` ou `prompt()` natif,
//      sauf que le résultat est dans une Promise.
//   3. Si aucun listener n'est enregistré (tests Node, init avant mount),
//      on retombe automatiquement sur les boîtes natives — pas de
//      régression de comportement.
//
// Avantage par rapport à un Context React :
//   • API utilisable HORS d'un composant (callbacks `useCallback`, etc.).
//   • Pas besoin de modifier les signatures des fonctions appelantes.
//   • Tests : on peut stubber `__setDialogListener` directement.
// =============================================================================

/** Demande affichée par l'app et que le composant `<Dialogs />` doit rendre. */
export type DialogRequest =
  | {
      kind: 'confirm'
      message: string
      resolve: (ok: boolean) => void
    }
  | {
      kind: 'prompt'
      message: string
      defaultValue: string
      resolve: (value: string | null) => void
    }
  | {
      kind: 'alert'
      message: string
      resolve: () => void
    }

/** Le composant Dialogs s'enregistre ici. `null` = aucun listener actif. */
let listener: ((req: DialogRequest) => void) | null = null

/**
 * Enregistre (ou désenregistre avec `null`) le listener qui prendra en
 * charge le rendu des dialogs. Appelée par `<Dialogs />` au mount /
 * unmount. Exportée volontairement avec un préfixe `__` pour signaler
 * qu'elle est un détail d'implémentation interne.
 */
export function __setDialogListener(
  fn: ((req: DialogRequest) => void) | null,
): void {
  listener = fn
}

/**
 * Boîte de confirmation. Équivalent custom de `window.confirm(message)`.
 *
 * @param message — Question à afficher (peut contenir des sauts de ligne).
 * @returns Promise<boolean> — `true` si l'utilisateur clique OK, `false`
 *   s'il clique Annuler ou ferme la modale (touche Échap, clic backdrop).
 *
 * Fallback : si aucun `<Dialogs />` n'est monté (tests, SSR, init précoce),
 * on délègue au `window.confirm` natif pour préserver le comportement.
 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) {
      // Fallback navigateur — typiquement les tests Node n'ont pas de
      // window non plus, mais ici on est dans une route forcément liée
      // au DOM (les callbacks viennent d'interactions UI).
      if (typeof window !== 'undefined' && typeof window.confirm === 'function')
        resolve(window.confirm(message))
      else resolve(false)
      return
    }
    listener({ kind: 'confirm', message, resolve })
  })
}

/**
 * Boîte de saisie. Équivalent custom de `window.prompt(message, default)`.
 *
 * @param message — Étiquette du champ de saisie.
 * @param defaultValue — Valeur préremplie (vide par défaut).
 * @returns Promise<string | null> — La chaîne saisie (non trimée), ou
 *   `null` si l'utilisateur annule. Comportement aligné sur l'API native.
 *
 * Fallback : voir `askConfirm`.
 */
export function askPrompt(
  message: string,
  defaultValue: string = '',
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!listener) {
      if (typeof window !== 'undefined' && typeof window.prompt === 'function')
        resolve(window.prompt(message, defaultValue))
      else resolve(null)
      return
    }
    listener({ kind: 'prompt', message, defaultValue, resolve })
  })
}

/**
 * Boîte d'information. Équivalent custom de `window.alert(message)`.
 * Évite l'en-tête « localhost:5174 indique » des alerts natifs.
 *
 * @param message — Texte à afficher (peut contenir des sauts de ligne).
 * @returns Promise<void> — Résout dès que l'utilisateur ferme la modale
 *   (clic OK, touche Échap, ou clic backdrop). Aucune valeur de retour.
 *
 * Fallback : voir `askConfirm`.
 */
export function askAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (!listener) {
      if (typeof window !== 'undefined' && typeof window.alert === 'function')
        window.alert(message)
      resolve()
      return
    }
    listener({ kind: 'alert', message, resolve })
  })
}
