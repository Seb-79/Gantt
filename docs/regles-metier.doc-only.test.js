// =============================================================================
// MÉTA-TESTS — RG documentaires uniquement
// =============================================================================
// Certaines RG du catalogue (`docs/regles-metier.md`) ne décrivent pas un
// comportement testable mécaniquement, soit parce que la règle a été
// supprimée (mais l'ID reste réservé pour préserver la traçabilité
// historique), soit parce qu'elle décrit un statu quo / une absence
// d'effet, soit parce qu'elle synthétise un comportement déjà couvert par
// des tests qui ciblent d'autres RG.
//
// Pour qu'elles ne soient pas comptées comme orphelines par le méta-test
// `regles-metier.coverage.test.js`, on déclare ici un `it(...)` no-op par
// RG en citant son ID dans le nom du test. Le test ne fait rien d'autre
// que vérifier que l'ID est bien documenté dans le catalogue — il
// matérialise le lien RG ↔ documentation.
//
// **Convention** : on n'ajoute une entrée ici que si on a vérifié qu'il
// n'existe vraiment aucun comportement testable. Sinon, on rattache la RG
// à un test métier existant en ajoutant son ID dans le libellé.
// =============================================================================

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CATALOGUE = fs.readFileSync(
  path.join(__dirname, 'regles-metier.md'),
  'utf-8',
)

/** Vérifie que l'ID `rgId` est défini comme un titre `### RG-GANTT-XXXX`. */
function expectDocumented(rgId) {
  expect(CATALOGUE).toMatch(new RegExp(`### ${rgId}\\b`))
}

describe('RG documentation-only — Famille 10 (Replan)', () => {
  it('RG-GANTT-0906 — Replan partiel abandonné en v2.2 (suppression du bouton dédié)', () => {
    expectDocumented('RG-GANTT-0906')
  })

  it('RG-GANTT-1905 — supprimée en v2.3 (remplacée par RG-GANTT-1903 redéfinie)', () => {
    expectDocumented('RG-GANTT-1905')
  })

  it('RG-GANTT-1906 — RG-M info silencieuse : pas d`alerte si progress=100 avec today < end_date', () => {
    expectDocumented('RG-GANTT-1906')
  })

  it('RG-GANTT-1908 — RG-O : edit manuel charge_jours sur progress>0 = charge totale révisée', () => {
    expectDocumented('RG-GANTT-1908')
  })
})

describe('RG documentation-only — Famille 21 (Refonte Replan v2.3)', () => {
  it('RG-GANTT-2104 — Plan de charge consomme la timeline du moteur Replan (opt-in UI)', () => {
    expectDocumented('RG-GANTT-2104')
  })

  it('RG-GANTT-2105 — détection de surcharge cohérente avec la timeline du moteur Replan', () => {
    expectDocumented('RG-GANTT-2105')
  })

  it('RG-GANTT-2107 — jalon sans prédécesseur : statu quo (date saisie respectée)', () => {
    expectDocumented('RG-GANTT-2107')
  })

  it('RG-GANTT-2108 — phase vide : dates conservées, pas de recalcul', () => {
    expectDocumented('RG-GANTT-2108')
  })

  it('RG-GANTT-2109 — activité sans collaborateur : capacité infinie côté moteur', () => {
    expectDocumented('RG-GANTT-2109')
  })
})
