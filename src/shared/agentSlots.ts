// "Maximum agents running at once" and "Stop waiting for background tasks" (Settings → Advanced): their bounds,
// the choices the window offers, and the check the app and the command line share. 0 means no limit / never.

export const MAX_RUNNING_AGENTS = 64
export const MAX_BACKGROUND_WAIT_MINUTES = 24 * 60

export const RUNNING_AGENT_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16]
export const BACKGROUND_WAIT_CHOICES: readonly number[] = [0, 5, 10, 15, 30, 60, 120]

/** A whole number from 0 to `max`. */
export function isSlotSetting(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max
}

/** The window's choices, with a value set elsewhere (the command line) kept in its place. */
export function choicesWith(choices: readonly number[], value: number): number[] {
  return choices.includes(value) ? [...choices] : [...choices, value].sort((a, b) => a - b)
}
