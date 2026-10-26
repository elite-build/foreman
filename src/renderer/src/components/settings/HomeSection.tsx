// #21 Settings → Appearance → Home: Board view on Home (off by default), the layout
// Home opens in, and how long the Done lane keeps finished work.
import { DEFAULT_DONE_DAYS, DONE_DAYS_OPTIONS } from '../../../../shared/board'
import type { HomeLayout } from '../../../../shared/types'
import { useT } from '../../i18n'
import { chooseHomeLayout } from '../HomeBoard'
import { Segmented, Select } from '../../ui'
import { resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'

export function HomeSection() {
  const t = useT()
  const settings = useSettings()
  const doneDays = settings.homeDoneDays || DEFAULT_DONE_DAYS
  return (
    <Section title={t('settings.home.title')} description={t('settings.home.desc')}>
      <ToggleRow
        id="home-board"
        label={t('settings.home.board.label')}
        help={t('settings.home.board.help')}
        detail={t('settings.home.board.detail')}
        checked={Boolean(settings.homeBoard)}
        onChange={(homeBoard) => void saveSettings({ homeBoard })}
        onReset={settings.homeBoard ? () => void resetSettings(['homeBoard']) : undefined}
      />
      {settings.homeBoard && (
        <>
          <Row
            id="home-layout"
            label={t('settings.home.layout.label')}
            help={t('settings.home.layout.help')}
            onReset={settings.homeLayout !== 'list' ? () => void resetSettings(['homeLayout']).then(() => chooseHomeLayout(null)) : undefined}
          >
            <Segmented<HomeLayout>
              label={t('settings.home.layout.label')}
              value={settings.homeLayout ?? 'list'}
              options={[
                { value: 'list', label: t('home.board.list') },
                { value: 'board', label: t('home.board.board') }
              ]}
              onChange={(homeLayout) => {
                // A new default applies now too, replacing this run's pick on Home.
                chooseHomeLayout(null)
                void saveSettings({ homeLayout })
              }}
            />
          </Row>
          <Row
            id="home-done-days"
            label={t('settings.home.doneDays.label')}
            help={t('settings.home.doneDays.help')}
            onReset={doneDays !== DEFAULT_DONE_DAYS ? () => void resetSettings(['homeDoneDays']) : undefined}
          >
            <Select
              label={t('settings.home.doneDays.label')}
              width={140}
              value={String(doneDays)}
              options={DONE_DAYS_OPTIONS.map((n) => ({ value: String(n), label: t('settings.home.doneDays.option', { count: n }) }))}
              onChange={(value) => void saveSettings({ homeDoneDays: Number(value) })}
            />
          </Row>
        </>
      )}
    </Section>
  )
}
