// O17: the sidebar's keep-awake chip, and the window's report of the battery
// level (Electron's main process can't read it; Chromium's battery API can).
import { Coffee, Moon } from 'lucide-react'
import { useEffect } from 'react'
import { keepAwakeChip } from '../../../shared/keepAwake'
import { useT } from '../i18n'
import { bridge, openSettingsPage, useStore } from '../store'
import { ChipButton } from '../ui'

/**
 * "Keeping awake · 3 agents · on battery 46%" while agents work with keep-awake on,
 * or "Sleep allowed · battery below 20%" when a cutoff applies. Opens the setting.
 */
export function KeepAwakeChip() {
  const t = useT()
  const status = useStore((s) => s.snapshot!.keepAwake)
  const settings = useStore((s) => s.snapshot!.settings)
  const text = keepAwakeChip(status, settings, t)
  if (!text) return null
  const Icon = status.keepAwake ? Coffee : Moon
  return (
    <div className="awake-strip">
      <ChipButton
        className={`awake-chip ${status.keepAwake ? '' : 'allowed'}`}
        title={t('keepAwake.chip.title')}
        onClick={() => openSettingsPage({ section: 'general', scrollTo: 'keep-awake' })}
      >
        <Icon size={12} aria-hidden />
        <span>{text}</span>
      </ChipButton>
    </div>
  )
}

interface BatteryManager extends EventTarget {
  level: number
}

/** Sends the battery level to main on change and every minute (main forgets a level nobody re-sends). */
export function BatterySync() {
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
    if (typeof nav.getBattery !== 'function') {
      bridge.send.setBattery(null)
      return
    }
    let battery: BatteryManager | null = null
    let live = true
    const report = () => battery && bridge.send.setBattery(Math.round(battery.level * 100))
    const timer = setInterval(report, 60_000)
    nav.getBattery().then(
      (b) => {
        if (!live) return
        battery = b
        b.addEventListener('levelchange', report)
        b.addEventListener('chargingchange', report)
        report()
      },
      () => bridge.send.setBattery(null)
    )
    return () => {
      live = false
      clearInterval(timer)
      battery?.removeEventListener('levelchange', report)
      battery?.removeEventListener('chargingchange', report)
    }
  }, [])
  return null
}
