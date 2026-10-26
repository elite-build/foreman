// Keep the computer awake while agents run (O17): whether to hold off sleep right
// now, and why not. A cutoff only stops Foreman holding the computer awake, so
// normal sleep can happen; it never stops or pauses an agent. Pure, so main
// decides and the renderer words the sidebar chip and Settings' "Now:" line.
import type { TFunction } from './i18n'
import type { Settings } from './types'

/** Electron's powerMonitor thermal states (macOS only). */
export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'

/** What Foreman can read about power right now. `null` means it can't tell on this computer. */
export interface PowerState {
  onBattery: boolean | null
  // 0–100, from Chromium's battery API in the window. Null when no window has reported it.
  batteryPercent: number | null
  // Null where the OS doesn't report it (everything but macOS).
  thermal: ThermalState | null
}

export type KeepAwakeSettings = Pick<
  Settings,
  'keepAwake' | 'keepAwakeBatteryCutoff' | 'keepAwakeBatteryPercent' | 'keepAwakeThermalCutoff' | 'keepAwakeOnlyOnPower'
>

// active: holding the computer awake. off: the setting is off. idle: no agent is working.
// The rest are cutoffs that let it sleep while agents work.
export type KeepAwakeReason = 'active' | 'off' | 'idle' | 'on-battery' | 'low-battery' | 'hot'

export interface KeepAwakeDecision {
  keepAwake: boolean
  reason: KeepAwakeReason
}

/** What main last decided, with what it was decided from (in the snapshot). */
export interface KeepAwakeStatus extends KeepAwakeDecision {
  // Chats with a turn running.
  agents: number
  power: PowerState
}

export const BATTERY_PERCENTS = [10, 15, 20, 25, 30, 40, 50] as const
export const DEFAULT_BATTERY_PERCENT = 20

/** A stored threshold as a whole percent from 5 to 95 (20 if it isn't a number). */
export function batteryThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BATTERY_PERCENT
  return Math.min(95, Math.max(5, Math.round(value)))
}

/** The machine is hot: macOS reports serious or critical thermal pressure. */
export function isHot(thermal: ThermalState | null): boolean {
  return thermal === 'serious' || thermal === 'critical'
}

/**
 * Keep awake only while the setting is on and an agent is working, unless a cutoff
 * applies. A signal Foreman can't read never trips a cutoff: an unknown battery
 * level isn't "low", and an unknown power source isn't "on battery".
 */
export function decideKeepAwake(agents: number, settings: KeepAwakeSettings, power: PowerState): KeepAwakeDecision {
  if (!settings.keepAwake) return { keepAwake: false, reason: 'off' }
  if (agents <= 0) return { keepAwake: false, reason: 'idle' }
  if (settings.keepAwakeOnlyOnPower && power.onBattery === true) return { keepAwake: false, reason: 'on-battery' }
  if (
    settings.keepAwakeBatteryCutoff &&
    power.onBattery === true &&
    power.batteryPercent !== null &&
    power.batteryPercent < batteryThreshold(settings.keepAwakeBatteryPercent)
  ) {
    return { keepAwake: false, reason: 'low-battery' }
  }
  if (settings.keepAwakeThermalCutoff && isHot(power.thermal)) return { keepAwake: false, reason: 'hot' }
  return { keepAwake: true, reason: 'active' }
}

const CUTOFFS: readonly KeepAwakeReason[] = ['on-battery', 'low-battery', 'hot']

export function isCutoff(reason: KeepAwakeReason): boolean {
  return CUTOFFS.includes(reason)
}

// ---- wording ----

/** G4 O17: the notification when a cutoff lets the computer sleep while agents run. */
export function keepAwakeCutoffNotice(reason: KeepAwakeReason, agents: number, settings: KeepAwakeSettings, t: TFunction): { title: string; body: string } {
  return { title: t('keepAwake.notify.title'), body: t('keepAwake.notify.body', { reason: cutoffText(reason, settings, t), agents: t('keepAwake.agents', { count: agents }) }) }
}

function cutoffText(reason: KeepAwakeReason, settings: KeepAwakeSettings, t: TFunction): string {
  if (reason === 'low-battery') return t('keepAwake.reason.lowBattery', { percent: batteryThreshold(settings.keepAwakeBatteryPercent) })
  if (reason === 'hot') return t('keepAwake.reason.hot')
  return t('keepAwake.reason.onBattery')
}

/**
 * The sidebar chip, shown only while agents work with the setting on:
 * "Keeping awake · 3 agents · on battery 46%" or "Sleep allowed · battery below 20%".
 */
export function keepAwakeChip(status: KeepAwakeStatus, settings: KeepAwakeSettings, t: TFunction): string | null {
  if (status.reason === 'off' || status.reason === 'idle' || status.agents <= 0) return null
  if (!status.keepAwake) return t('keepAwake.chip.sleep', { reason: cutoffText(status.reason, settings, t) })
  const { onBattery, batteryPercent } = status.power
  const power =
    onBattery === true
      ? batteryPercent === null
        ? t('keepAwake.power.battery')
        : t('keepAwake.power.batteryPercent', { percent: Math.round(batteryPercent) })
      : onBattery === false
        ? t('keepAwake.power.ac')
        : null
  const agents = t('keepAwake.agents', { count: status.agents })
  return power ? t('keepAwake.chip.active', { agents, power }) : t('keepAwake.chip.activeNoPower', { agents })
}

/** Settings' "Now:" line: what it's doing, the power source and, where readable, thermal pressure. */
export function keepAwakeNow(status: KeepAwakeStatus, settings: KeepAwakeSettings, t: TFunction): string {
  const head =
    status.reason === 'off'
      ? t('keepAwake.now.off')
      : status.reason === 'idle'
        ? t('keepAwake.now.idle')
        : status.keepAwake
          ? t('keepAwake.now.active', { agents: t('keepAwake.agents', { count: status.agents }) })
          : t('keepAwake.now.sleep', { reason: cutoffText(status.reason, settings, t) })
  const { onBattery, batteryPercent, thermal } = status.power
  const parts = [head]
  if (onBattery === true) {
    parts.push(batteryPercent === null ? t('keepAwake.power.batteryUnknown') : t('keepAwake.power.batteryNow', { percent: Math.round(batteryPercent) }))
  } else if (onBattery === false) parts.push(t('keepAwake.power.ac'))
  else parts.push(t('keepAwake.power.unknown'))
  if (thermal !== null) parts.push(t('keepAwake.thermal', { level: t(THERMAL_KEYS[thermal]) }))
  return parts.join(' · ')
}

const THERMAL_KEYS = {
  unknown: 'keepAwake.thermal.unknown',
  nominal: 'keepAwake.thermal.nominal',
  fair: 'keepAwake.thermal.fair',
  serious: 'keepAwake.thermal.serious',
  critical: 'keepAwake.thermal.critical'
} as const satisfies Record<ThermalState, string>
