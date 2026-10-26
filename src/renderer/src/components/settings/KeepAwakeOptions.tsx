// O17: the cutoffs under Settings → General → "Keep the computer awake while
// agents run", and a "Now:" line saying what keep-awake is doing and why.
import { BatteryMedium } from 'lucide-react'
import { BATTERY_PERCENTS, batteryThreshold, keepAwakeNow } from '../../../../shared/keepAwake'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Checkbox, Select } from '../../ui'
import { saveSettings, useSettings } from './controls'

export function KeepAwakeOptions() {
  const t = useT()
  const settings = useSettings()
  const status = useStore((s) => s.snapshot!.keepAwake)
  const platform = useStore((s) => s.snapshot!.platform)
  // Electron reads thermal pressure on macOS only.
  const thermalAvailable = platform === 'darwin'
  const percent = batteryThreshold(settings.keepAwakeBatteryPercent)
  const percents = BATTERY_PERCENTS.includes(percent as never) ? [...BATTERY_PERCENTS] : [...BATTERY_PERCENTS, percent].sort((a, b) => a - b)
  // "Only while on power" makes the battery level moot.
  const batteryMoot = settings.keepAwakeOnlyOnPower

  return (
    <div className="awake-subs" title={t('settings.general.keepAwake.cutoffNote')}>
      <Checkbox className="awake-sub" checked={settings.keepAwakeBatteryCutoff} disabled={batteryMoot} onChange={(e) => void saveSettings({ keepAwakeBatteryCutoff: e.target.checked })}>
        {t.rich('settings.general.keepAwake.battery', {
          level: (
            <Select<string>
              key="level"
              label={t('settings.general.keepAwake.batteryLevel')}
              value={String(percent)}
              disabled={batteryMoot || !settings.keepAwakeBatteryCutoff}
              options={percents.map((p) => ({ value: String(p), label: `${p}%` }))}
              onChange={(value) => void saveSettings({ keepAwakeBatteryPercent: Number(value) })}
            />
          )
        })}
      </Checkbox>
      <Checkbox
        className="awake-sub"
        checked={thermalAvailable && settings.keepAwakeThermalCutoff}
        disabled={!thermalAvailable}
        onChange={(e) => void saveSettings({ keepAwakeThermalCutoff: e.target.checked })}
      >
        {t('settings.general.keepAwake.hot')} <span className="faint">{t('settings.general.keepAwake.hotHint')}</span>
        {!thermalAvailable && (
          <span className="faint">
            {' · '}
            {platform === 'win32' ? t('settings.general.keepAwake.unavailableWindows') : t('settings.general.keepAwake.unavailable')}
          </span>
        )}
      </Checkbox>
      <Checkbox className="awake-sub" checked={settings.keepAwakeOnlyOnPower} onChange={(e) => void saveSettings({ keepAwakeOnlyOnPower: e.target.checked })}>
        {t('settings.general.keepAwake.onlyOnPower')}
      </Checkbox>
      <div className="awake-now" aria-live="polite">
        <BatteryMedium size={13} aria-hidden />
        {keepAwakeNow(status, settings, t)}
      </div>
    </div>
  )
}
