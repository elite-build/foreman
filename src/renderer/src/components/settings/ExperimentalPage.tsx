import type { Settings } from '../../../../shared/types'
import { useT } from '../../i18n'
import { openSettingsPage, useStore } from '../../store'
import { LinkButton } from '../../ui'
import { Page, resetSettings, saveSettings, Section, ToggleRow, useSettings } from './controls'

const DEFAULTS = {
  autoPermissionMode: false,
  autoRunAfterSetup: false,
  forkToNewTab: true,
  showResourceUsage: false
} satisfies Partial<Settings>

export function ExperimentalPage() {
  const t = useT()
  const settings = useSettings()
  const mac = useStore((s) => s.snapshot!.platform) === 'darwin'
  const reset = (key: keyof typeof DEFAULTS) => (settings[key] === DEFAULTS[key] ? undefined : () => void resetSettings([key]))

  return (
    <Page title={t('settings.page.experimental')} description={t('settings.experimental.desc')}>
      <Section>
        <ToggleRow
          id="auto-permission-mode"
          label={t('settings.experimental.autoPermission.label')}
          help={t('settings.experimental.autoPermission.help')}
          detail={
            settings.requireToolApprovals
              ? undefined
              : t.rich('settings.experimental.autoPermission.detail', {
                  account: (
                    <LinkButton key="account" onClick={() => openSettingsPage({ section: 'account', scrollTo: 'claude-tool-approvals' })}>
                      {t('settings.page.account')}
                    </LinkButton>
                  )
                })
          }
          checked={settings.autoPermissionMode}
          disabled={!settings.requireToolApprovals}
          onChange={(autoPermissionMode) => void saveSettings({ autoPermissionMode })}
          onReset={reset('autoPermissionMode')}
        />
        <ToggleRow
          id="auto-run-after-setup"
          label={t('settings.experimental.autoRun.label')}
          help={t('settings.experimental.autoRun.help')}
          detail={t('settings.experimental.autoRun.detail')}
          checked={settings.autoRunAfterSetup}
          onChange={(autoRunAfterSetup) => void saveSettings({ autoRunAfterSetup })}
          onReset={reset('autoRunAfterSetup')}
        />
        <ToggleRow
          id="fork-to-new-tab"
          label={t('settings.experimental.fork.label')}
          help={t('settings.experimental.fork.help', { keys: mac ? '⌘⌥↵' : 'Ctrl+Alt+Enter' })}
          checked={settings.forkToNewTab}
          onChange={(forkToNewTab) => void saveSettings({ forkToNewTab })}
          onReset={reset('forkToNewTab')}
        />
        <ToggleRow
          id="show-resource-usage"
          label={t('settings.experimental.resourceUsage.label')}
          help={t('settings.experimental.resourceUsage.help')}
          checked={settings.showResourceUsage}
          onChange={(showResourceUsage) => void saveSettings({ showResourceUsage })}
          onReset={reset('showResourceUsage')}
        />
      </Section>
    </Page>
  )
}
