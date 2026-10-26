// Holds the computer awake while agents work (O17), unless a cutoff applies.
// Core feeds it the running-agent count and settings; the host reads power
// (Electron's powerMonitor) and the window reports the battery level.
import { decideKeepAwake, isCutoff, type KeepAwakeReason, type KeepAwakeSettings, type KeepAwakeStatus, type PowerState } from '../shared/keepAwake'

// A battery level no window has re-sent for this long is unknown again (the
// window re-sends it every minute; with no window there's nobody to ask).
export const BATTERY_STALE_MS = 5 * 60_000

export type PowerReading = Pick<PowerState, 'onBattery' | 'thermal'>

export class KeepAwake {
  private battery: { percent: number | null; at: number } | null = null
  private held = false
  // G4 O17: cutoffs already notified while agents kept working; cleared when they stop (or the setting goes off).
  private notified = new Set<KeepAwakeReason>()
  private notice: KeepAwakeReason | null = null
  status: KeepAwakeStatus = { keepAwake: false, reason: 'off', agents: 0, power: { onBattery: null, batteryPercent: null, thermal: null } }

  constructor(
    private hold: (on: boolean) => void,
    private readPower: () => PowerReading,
    private now: () => number = Date.now
  ) {}

  /** From the window: 0–100, or null when it has no battery API. Out-of-range values count as unknown. */
  setBattery(percent: unknown): void {
    const valid = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
    this.battery = { percent: valid ? percent : null, at: this.now() }
  }

  private power(): PowerState {
    let reading: PowerReading
    try {
      reading = this.readPower()
    } catch {
      reading = { onBattery: null, thermal: null }
    }
    const fresh = this.battery && this.now() - this.battery.at <= BATTERY_STALE_MS
    return { onBattery: reading.onBattery, thermal: reading.thermal, batteryPercent: fresh ? this.battery!.percent : null }
  }

  /** Decide again and hold or release sleep to match. True when the status changed. */
  update(agents: number, settings: KeepAwakeSettings): boolean {
    const power = this.power()
    const decision = decideKeepAwake(agents, settings, power)
    if (decision.keepAwake !== this.held) {
      this.held = decision.keepAwake
      this.hold(decision.keepAwake)
    }
    // A cutoff that lets the computer sleep while agents run is told once (per cutoff, until the agents stop).
    if (decision.reason === 'idle' || decision.reason === 'off') this.notified.clear()
    else if (isCutoff(decision.reason) && !this.notified.has(decision.reason)) {
      this.notified.add(decision.reason)
      this.notice = decision.reason
    }
    const next: KeepAwakeStatus = { ...decision, agents, power }
    const changed = JSON.stringify(next) !== JSON.stringify(this.status)
    this.status = next
    return changed
  }

  /** The cutoff that just started letting the computer sleep while agents run, once; null otherwise. */
  takeCutoffNotice(): KeepAwakeReason | null {
    const notice = this.notice
    this.notice = null
    return notice
  }
}
