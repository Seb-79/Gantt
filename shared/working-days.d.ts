// =============================================================================
// Déclarations TypeScript pour shared/working-days.js
// =============================================================================
// Module partagé front (TS via Vite) ↔ serveur (Node ESM). Le fichier source
// est en plain JS pour pouvoir être consommé identiquement des deux côtés ;
// ce .d.ts apporte le typage côté front.
// =============================================================================

export function isWeekendIso(iso: string): boolean

export function easterSunday(year: number): { month: number; day: number }

export function frenchHolidaysOf(year: number): Set<string>

export function isFrenchHolidayIso(iso: string): boolean

export function isNonWorkingDayIso(iso: string): boolean

export function addDaysIso(iso: string, days: number): string

export function snapForwardToWorkingDayIso(iso: string): string

export function snapBackwardToWorkingDayIso(iso: string): string

export function workingDaysBetweenIso(start: string, end: string): number

export function addWorkingDaysIso(start: string, charge: number): string

export function computeSuccessorStartIso(predEnd: string, lag: number): string
