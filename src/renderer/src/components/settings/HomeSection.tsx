// #21 Settings → Appearance → Sidebar & Home: which views are sidebar tabs, board lanes and Home sections, in what
// order; then Board view on Home (off by default), the layout Home opens in, and how long the Done lane keeps
// finished work.
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { DEFAULT_DONE_DAYS, DONE_DAYS_OPTIONS } from '../../../../shared/board'
import type { HomeLayout } from '../../../../shared/types'
import { canShow, DEFAULT_VIEWS, normalizeViews, VIEW_LABEL, type ViewSetting, type ViewSurface } from '../../../../shared/views'
import { useT } from '../../i18n'
import { chooseHomeLayout } from '../HomeBoard'
import { IconButton, Segmented, Select, Switch } from '../../ui'
import { resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'

export function HomeSection() {
  const t = useT()
  const settings = useSettings()
  const doneDays = settings.homeDoneDays || DEFAULT_DONE_DAYS
  return (
    <Section title={t('settings.home.title')} description={t('settings.home.desc')}>
      <ViewsRow />
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

const same = (a: readonly ViewSetting[], b: readonly ViewSetting[]) => JSON.stringify(a) === JSON.stringify(b)

/**
 * One row per view, with a switch for each place it can go and buttons to move it. The board's column shows only
 * while Board view is on. The sidebar keeps a tab and the board a lane: the last one's switch is disabled.
 */
function ViewsRow() {
  const t = useT()
  const settings = useSettings()
  const views = normalizeViews(settings.views)
  const surfaces: ViewSurface[] = settings.homeBoard ? ['tab', 'lane', 'home'] : ['tab', 'home']
  const count = (surface: ViewSurface) => views.filter((v) => v[surface]).length
  const list = useRef<HTMLDivElement>(null)
  // After a move, the button pressed (or its pair, at the end of the list) keeps focus.
  const refocus = useRef<{ id: string; dir: 'up' | 'down' } | null>(null)
  const order = views.map((v) => v.id).join()
  useEffect(() => {
    const want = refocus.current
    if (!want) return
    refocus.current = null
    const row = list.current?.querySelector(`[data-view="${want.id}"]`)
    const button = row?.querySelector<HTMLButtonElement>(`[data-move="${want.dir}"]:not(:disabled)`) ?? row?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)')
    button?.focus()
  }, [order])

  const save = (next: ViewSetting[]) => void saveSettings({ views: next })
  const toggle = (i: number, surface: ViewSurface, on: boolean) => save(views.map((v, j) => (j === i ? { ...v, [surface]: on } : v)))
  const move = (i: number, dir: -1 | 1) => {
    const next = views.slice()
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    refocus.current = { id: views[i].id, dir: dir < 0 ? 'up' : 'down' }
    save(next)
  }
  const columns: Record<ViewSurface, string> = { tab: t('settings.views.col.tab'), lane: t('settings.views.col.lane'), home: t('settings.views.col.home') }

  return (
    <Row
      id="views"
      stacked
      label={t('settings.views.label')}
      help={t('settings.views.help')}
      detail={t(settings.homeBoard ? 'settings.views.keepOne' : 'settings.views.keepOneTab')}
      onReset={same(views, DEFAULT_VIEWS) ? undefined : () => void resetSettings(['views'])}
    >
      <div ref={list} className={`set-views ${surfaces.length === 3 ? 'three' : 'two'}`}>
        {/* The columns' names, for sight; each switch says its view and place itself. */}
        <div className="set-views-row set-views-head" aria-hidden>
          <span />
          {surfaces.map((s) => (
            <span key={s} className="set-help set-views-cell">
              {columns[s]}
            </span>
          ))}
          <span />
        </div>
        {views.map((v, i) => {
          const name = t(VIEW_LABEL[v.id])
          return (
            <div key={v.id} className="set-views-row" data-view={v.id}>
              <div className="set-views-name">
                <div className="set-label">{name}</div>
                <div className="set-help">{t(`settings.views.desc.${v.id}`)}</div>
              </div>
              {surfaces.map((s) => (
                <span key={s} className="set-views-cell">
                  {canShow(v.id, s) && (
                    <Switch
                      label={t('settings.views.switch', { view: name, place: columns[s] })}
                      checked={v[s]}
                      disabled={v[s] && s !== 'home' && count(s) === 1}
                      onChange={(on) => toggle(i, s, on)}
                    />
                  )}
                </span>
              ))}
              <span className="set-views-move">
                <IconButton label={t('settings.views.moveUp', { view: name })} data-move="up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton label={t('settings.views.moveDown', { view: name })} data-move="down" disabled={i === views.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </IconButton>
              </span>
            </div>
          )
        })}
      </div>
    </Row>
  )
}
