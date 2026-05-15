// =============================================================================
// SETUP global Vitest pour les tests de composants React (v1.8)
// =============================================================================
// Ce fichier est chargé via `setupFiles` dans vite.config.ts AVANT chaque
// fichier de test. Il :
//   • Importe les matchers `jest-dom` (toBeInTheDocument, toHaveClass, …),
//     disponibles ensuite sur tous les `expect(...)` de tests jsdom.
//   • Force un cleanup après chaque test pour ne pas voir l'arbre d'un test
//     précédent (Vitest le fait par défaut depuis RTL v13, mais on l'explicite
//     pour rester robuste si la config change).
// Les tests `node` (DAL, API supertest) ne touchent pas au DOM : importer
// jest-dom est sans effet pour eux.
// =============================================================================

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
