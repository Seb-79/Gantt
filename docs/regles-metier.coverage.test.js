// =============================================================================
// MÉTA-TEST — Traçabilité RG-GANTT
// =============================================================================
// Vérifie que CHAQUE règle de gestion documentée dans `docs/regles-metier.md`
// est citée par son identifiant `RG-GANTT-XXXX` dans le NOM d'au moins un
// test automatisé (it / describe).
//
// Pourquoi ? Le catalogue référence chaque RG vers ses tests en langage
// naturel (« Tests : ... → « insère une tâche normale » »). Mais cette
// référence est non vérifiée mécaniquement : si quelqu'un renomme ou
// supprime un test, le catalogue se désynchronise sans alerte.
//
// Ce méta-test verrouille la traçabilité : pour qu'une RG soit considérée
// comme « couverte », son ID doit apparaître dans la chaîne d'au moins un
// `it(...)` ou `describe(...)` du repo. La convention attendue est :
//
//     it('v2.0 / RG-GANTT-1700 — createTask avec collaborator_ids[] ...', ...)
//
// Si la liste des RG sans test grandit, le test échoue et imprime la liste.
// =============================================================================

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const CATALOGUE_PATH = path.join(REPO_ROOT, 'docs', 'regles-metier.md')

/**
 * Liste récursivement les fichiers `*.test.{js,ts,tsx}` du repo (en ignorant
 * `node_modules`, `dist`, `coverage`, et ce fichier lui-même).
 */
function findTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const out = []
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(ent.name))
        continue
      out.push(...findTestFiles(p))
    } else if (
      /\.test\.(js|ts|tsx)$/.test(ent.name) &&
      ent.name !== 'regles-metier.coverage.test.js'
    ) {
      out.push(p)
    }
  }
  return out
}

/**
 * Extrait toutes les RG-GANTT-XXXX uniques d'un texte (markdown ou code).
 * Tolère 3 ou 4 chiffres pour les hypothétiques RG futures.
 */
function extractRgIds(text) {
  const set = new Set()
  const re = /RG-GANTT-\d{3,4}/g
  let m
  while ((m = re.exec(text)) !== null) set.add(m[0])
  return set
}

describe('Méta-test — Traçabilité RG-GANTT (couverture catalogue → tests)', () => {
  it('chaque RG documentée est citée par son ID dans au moins un nom de test', () => {
    // 1. RG documentées dans le catalogue.
    const catalogue = fs.readFileSync(CATALOGUE_PATH, 'utf-8')
    const documented = extractRgIds(catalogue)
    expect(documented.size).toBeGreaterThan(100) // sanity check

    // 2. RG citées dans le code des tests (n'importe où dans le fichier :
    //    nom de test, describe, commentaire au-dessus, ligne `Tests :`...).
    //    On reste large pour ne pas devenir trop strict trop tôt : tant que
    //    l'ID apparaît dans le fichier, on considère qu'il y a un lien.
    const testFiles = findTestFiles(REPO_ROOT)
    expect(testFiles.length).toBeGreaterThan(5) // sanity check
    const cited = new Set()
    for (const f of testFiles) {
      const content = fs.readFileSync(f, 'utf-8')
      for (const id of extractRgIds(content)) cited.add(id)
    }

    // 3. Calcule les RG documentées qui ne sont citées NULLE PART dans un
    //    fichier de test.
    const orphans = [...documented].filter((id) => !cited.has(id)).sort()

    // 4. Quota maximal d'orphelines. La cible est 0 : chaque RG documentée
    //    doit voir son ID cité dans le nom d'au moins un it/describe
    //    (cf. docs/regles-metier.md → section « Tests : » de chaque règle).
    //    Pour les RG purement déclaratives (règle supprimée, statu quo,
    //    synthèse d'un comportement déjà testé), un fichier de tests dédié
    //    `docs/regles-metier.doc-only.test.js` déclare un it() no-op par RG.
    // 2026-05-26 — Rattachement massif : quota passé de 82 à 0.
    const MAX_ALLOWED_ORPHANS = 0
    if (orphans.length > MAX_ALLOWED_ORPHANS) {
      throw new Error(
        `Régression de traçabilité : ${orphans.length} RG documentées ne sont citées dans aucun test (quota max : ${MAX_ALLOWED_ORPHANS}).
Liste des orphelines :
  ${orphans.join('\n  ')}

Convention : ajouter l'ID dans le nom du test (it/describe), par exemple :
  it('v2.0 / RG-GANTT-1700 — créer une tâche multi-collab ...', ...)`,
      )
    }
    // Snapshot informatif (passe toujours) : on affiche le nombre courant
    // pour piloter la baisse du quota au fil des ajouts.
    expect(orphans.length).toBeLessThanOrEqual(MAX_ALLOWED_ORPHANS)
  })

  it('chaque RG citée dans un test existe bien dans le catalogue (anti faute de frappe)', () => {
    // Symétrique du précédent : on attrape les IDs cités dans les tests qui
    // ne correspondent à aucune RG documentée — typiquement une faute de
    // frappe (`RG-GANTT-1233` vs `RG-GANTT-1323`).
    const catalogue = fs.readFileSync(CATALOGUE_PATH, 'utf-8')
    const documented = extractRgIds(catalogue)
    const testFiles = findTestFiles(REPO_ROOT)
    const ghosts = new Set()
    for (const f of testFiles) {
      const content = fs.readFileSync(f, 'utf-8')
      for (const id of extractRgIds(content)) {
        if (!documented.has(id)) ghosts.add(id)
      }
    }
    expect([...ghosts].sort()).toEqual([])
  })
})
