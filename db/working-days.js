// =============================================================================
// HELPERS « JOURS OUVRÉS » — côté serveur (ré-export depuis shared/)
// =============================================================================
// v2.0 / Refacto (b) — Ces helpers vivent désormais dans `shared/working-days.js`
// (module partagé front ↔ serveur). Ce fichier conserve les **alias historiques
// avec le suffixe `Server`** pour ne pas casser les call-sites existants dans
// le DAL (db/index.js, db/migrations.js, db/capacity.js).
//
// Une seule source de vérité pour les fériés FR, l'arithmétique de date et
// la définition d'un jour ouvré. Si la liste des fériés évolue (ex. férié
// exceptionnel décrété pour une année donnée), c'est un seul fichier à modifier.
// =============================================================================

import {
  addDaysIso,
  addWorkingDaysIso,
  computeSuccessorStartIso,
  easterSunday,
  frenchHolidaysOf,
  isFrenchHolidayIso,
  isNonWorkingDayIso,
  isWeekendIso,
  snapForwardToWorkingDayIso,
  workingDaysBetweenIso,
} from '../shared/working-days.js'

// Alias historiques (suffixe `Server`) pour rétro-compat des imports dans le DAL.
// Les noms sans suffixe (depuis shared/) sont privilégiés pour les nouveaux call-sites.
export const isWeekendIsoServer = isWeekendIso
export const easterSundayServer = easterSunday
export const frenchHolidaysOfServer = frenchHolidaysOf
export const addDaysIsoServer = addDaysIso
export const snapForwardToWorkingDayServer = snapForwardToWorkingDayIso
export const workingDaysBetweenServer = workingDaysBetweenIso
export const addWorkingDaysServer = addWorkingDaysIso
export const computeSuccessorStart = computeSuccessorStartIso

// Aliases sans renommage : ces noms sont déjà cohérents et utilisés en l'état.
export { isFrenchHolidayIso, isNonWorkingDayIso }
