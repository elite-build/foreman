// Settings › Quick and the sidebar gear's popover: one ordered list of tiles (shared/quickTiles.ts), each a setting
// people change often, drawn with the control its own page uses and saved the same way. The gear shows the first
// GEAR_TILES; the page shows them all and is where they are chosen and ordered. Mock 08 in the settings-home mocks.
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Coffee,
  Cpu,
  EyeOff,
  GitPullRequest,
  Languages,
  ListChecks,
  Plug,
  Plus,
  Settings,
  SunMoon,
  X,
  ZoomIn,
  type LucideIcon
} from 'lucide-react'
import { Fragment, useState } from 'react'
import { instancesFor } from '../../../../shared/agentInstances'
import type { PlainKey } from '../../../../shared/i18n'
import { GEAR_TILES, hiddenQuickTiles, moveQuickTile, QUICK_TILES, type QuickTile } from '../../../../shared/quickTiles'
import type { ThemeSetting } from '../../../../shared/types'
import { useT } from '../../i18n'
import { shortcutHint } from '../../shortcuts'
import { openSettingsPage, setQuickTiles, useStore, type SettingsPage } from '../../store'
import { Button, Card, IconButton, Kbd, LinkButton, MenuButton, MenuItem, Popover, Segmented, Select, Status, Switch } from '../../ui'
import { ServiceMark } from './integrations/ServiceMark'
import { ZOOM_OPTIONS } from './AppearancePage'
import { Page, saveSettings, useSettings } from './controls'
import { LanguagePicker, saveNotifications } from './GeneralPage'
import { CompactChooser } from './ModelsPage'
import './quick.css'

interface TileDef {
  icon: LucideIcon
  title: PlainKey
  // Where the setting lives: the tile's "Open in Settings" goes there and flashes the row.
  page: SettingsPage
  // Takes two columns on the page and the whole width in the popover.
  wide?: boolean
}

const TILES: Record<QuickTile, TileDef> = {
  'new-chats': { icon: Cpu, title: 'quick.tile.newChats', page: { section: 'models', part: 'loadout', scrollTo: 'loadout' }, wide: true },
  theme: { icon: SunMoon, title: 'settings.appearance.theme', page: { section: 'appearance', scrollTo: 'theme' } },
  zoom: { icon: ZoomIn, title: 'settings.appearance.zoom', page: { section: 'appearance', scrollTo: 'zoom' } },
  notifications: { icon: Bell, title: 'settings.general.notifications.label', page: { section: 'general', scrollTo: 'notifications' } },
  'plan-first': { icon: ListChecks, title: 'quick.tile.planFirst', page: { section: 'models', scrollTo: 'default-plan-mode' } },
  'review-model': { icon: GitPullRequest, title: 'settings.row.reviewModel', page: { section: 'models', scrollTo: 'review-model' } },
  'keep-awake': { icon: Coffee, title: 'quick.tile.keepAwake', page: { section: 'general', scrollTo: 'keep-awake' } },
  'privacy-mode': { icon: EyeOff, title: 'settings.account.privacyMode', page: { section: 'account', scrollTo: 'privacy-mode' } },
  connections: { icon: Plug, title: 'integrations.connections.title', page: { section: 'integrations', part: 'connections' } },
  language: { icon: Languages, title: 'settings.language.label', page: { section: 'general', scrollTo: 'language' } }
}

// "Choose tiles" in the gear's popover opens the page already choosing.
let chooseOnOpen = false

/** Settings › Quick, choosing tiles straight away when `choose`. */
export function openQuickPage(choose = false): void {
  chooseOnOpen = choose
  openSettingsPage({ section: 'quick' })
}

/** The control of one tile, saving as its page does. `inPopover`: pickers inside it draw their panels in <body>. */
function TileControl({ id, inPopover }: { id: QuickTile; inPopover: boolean }) {
  const t = useT()
  const settings = useSettings()
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  switch (id) {
    case 'new-chats': {
      const [first, ...rest] = settings.loadouts
      const accounts = first ? instancesFor(settings.agentInstances, first.agent) : []
      return (
        <div className="qt-row">
          {first && <CompactChooser portal={inPopover} label={t('quick.tile.newChats')} value={first} onChange={(next) => void saveSettings({ loadouts: [next, ...rest] })} />}
          {first && accounts.length > 0 && (
            <Select
              label={t('quick.tile.account')}
              value={first.instance ?? ''}
              options={[{ value: '', label: t('agentAccounts.default') }, ...accounts.map((a) => ({ value: a.id, label: a.label }))]}
              onChange={(instance) => void saveSettings({ loadouts: [{ ...first, instance: instance || undefined }, ...rest] })}
            />
          )}
        </div>
      )
    }
    case 'theme':
      return (
        <Segmented<ThemeSetting>
          small
          className="qt-fit"
          label={t('settings.appearance.theme')}
          value={settings.theme}
          options={[
            { value: 'light', label: t('settings.appearance.theme.light') },
            { value: 'dark', label: t('settings.appearance.theme.dark') },
            { value: 'system', label: t('settings.appearance.theme.system') }
          ]}
          onChange={(theme) => void saveSettings({ theme })}
        />
      )
    case 'zoom':
      return <Select className="qt-fit" label={t('settings.appearance.zoom')} value={settings.zoom.toFixed(1)} options={ZOOM_OPTIONS} onChange={(value) => void saveSettings({ zoom: Number(value) })} />
    case 'notifications':
      return <SwitchLine text={t('quick.tile.notifications.desc')} label={t('settings.general.notifications.label')} checked={settings.notifications} onChange={(on) => void saveNotifications(on)} />
    case 'plan-first':
      return <SwitchLine text={t('quick.tile.planFirst.desc')} label={t('settings.row.defaultPlanMode')} checked={settings.defaultPlanMode} onChange={(defaultPlanMode) => void saveSettings({ defaultPlanMode })} />
    case 'review-model':
      return <CompactChooser portal={inPopover} label={t('settings.row.reviewModel')} value={settings.reviewModel} onChange={(reviewModel) => void saveSettings({ reviewModel })} />
    case 'keep-awake':
      return <SwitchLine text={t('quick.tile.keepAwake.desc')} label={t('settings.general.keepAwake.label')} checked={settings.keepAwake} onChange={(keepAwake) => void saveSettings({ keepAwake })} />
    case 'privacy-mode':
      return <SwitchLine text={t('quick.tile.privacyMode.desc')} label={t('settings.account.privacyMode')} checked={settings.privacyMode} onChange={(privacyMode) => void saveSettings({ privacyMode })} />
    case 'connections':
      return connections.length ? (
        <ul className="qt-connections">
          {connections.slice(0, 4).map((c) => (
            <li key={c.id}>
              <ServiceMark service={c.service} size={16} />
              <span className="qt-name">{c.name}</span>
              <Status compact={!c.problem} tone={c.problem ? 'warn' : 'ok'} label={c.problem ? t('integrations.card.needsAttention') : t('quick.tile.connections.ok')} />
            </li>
          ))}
        </ul>
      ) : (
        <span className="faint small">{t('quick.tile.connections.none')}</span>
      )
    case 'language':
      return <LanguagePicker portal={inPopover} value={settings.language} onChange={(language) => void saveSettings({ language })} />
  }
}

/** A switch with a line saying what it does. */
function SwitchLine({ text, label, checked, onChange }: { text: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="qt-switch">
      <span className="faint small">{text}</span>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

interface TileProps {
  id: QuickTile
  inPopover?: boolean
  // Choosing tiles: move and remove buttons in the tile's head.
  choosing?: { index: number; count: number }
  // Leaves the popover before going to a page.
  onLeave?: () => void
}

function Tile({ id, inPopover = false, choosing, onLeave }: TileProps) {
  const t = useT()
  const tiles = useStore((s) => s.quickTiles)
  const def = TILES[id]
  const title = t(def.title)
  const Icon = def.icon
  return (
    <Card size="sm" className={def.wide ? 'qt-tile qt-tile--wide' : 'qt-tile'} role="group" aria-label={title}>
      <div className="qt-head">
        <Icon size={14} className="faint" aria-hidden />
        <span className="qt-title">{title}</span>
        {choosing ? (
          <span className="qt-tools">
            <IconButton label={t('quick.choose.earlier', { tile: title })} disabled={choosing.index === 0} onClick={() => setQuickTiles(moveQuickTile(tiles, id, -1))}>
              <ArrowLeft size={13} />
            </IconButton>
            <IconButton label={t('quick.choose.later', { tile: title })} disabled={choosing.index === choosing.count - 1} onClick={() => setQuickTiles(moveQuickTile(tiles, id, 1))}>
              <ArrowRight size={13} />
            </IconButton>
            <IconButton label={t('quick.choose.remove', { tile: title })} onClick={() => setQuickTiles(tiles.filter((x) => x !== id))}>
              <X size={13} />
            </IconButton>
          </span>
        ) : (
          <span className="qt-tools">
            <IconButton
              label={t('quick.tile.open', { tile: title })}
              onClick={() => {
                onLeave?.()
                openSettingsPage(def.page)
              }}
            >
              <ArrowUpRight size={13} />
            </IconButton>
          </span>
        )}
      </div>
      <TileControl id={id} inPopover={inPopover} />
    </Card>
  )
}

/** Settings › Quick: every tile, and choosing which and in what order. */
export function QuickPage() {
  const t = useT()
  const tiles = useStore((s) => s.quickTiles)
  const [choosing, setChoosing] = useState(() => {
    const now = chooseOnOpen
    chooseOnOpen = false
    return now
  })
  const hidden = hiddenQuickTiles(tiles)
  return (
    <Page title={t('quick.title')} description={t('quick.lead', { count: GEAR_TILES })}>
      <div className="qt-bar">
        <Button size="sm" variant={choosing ? 'primary' : 'default'} onClick={() => setChoosing(!choosing)}>
          {choosing ? t('quick.choose.done') : t('quick.choose.start')}
        </Button>
        {choosing && hidden.length > 0 && (
          <MenuButton small label={t('quick.choose.add')} trigger={<><Plus size={13} aria-hidden /> {t('quick.choose.add')}</>}>
            {hidden.map((id) => (
              <MenuItem key={id} onSelect={() => setQuickTiles([...tiles, id])}>
                {t(TILES[id].title)}
              </MenuItem>
            ))}
          </MenuButton>
        )}
        {choosing && (
          <LinkButton onClick={() => setQuickTiles([...QUICK_TILES])} className="qt-bar-end">
            {t('quick.choose.reset')}
          </LinkButton>
        )}
      </div>
      {tiles.length ? (
        <div className="qt-grid">
          {tiles.map((id, index) => (
            <Fragment key={id}>
              {choosing && index === GEAR_TILES && (
                <p className="qt-cut faint small" role="separator">
                  {t('quick.choose.cut', { count: GEAR_TILES })}
                </p>
              )}
              <Tile id={id} choosing={choosing ? { index, count: tiles.length } : undefined} />
            </Fragment>
          ))}
        </div>
      ) : (
        <p className="faint">{t('quick.empty')}</p>
      )}
    </Page>
  )
}

/** The sidebar rail's gear: the first tiles in a popover over your work, and the way into Settings. */
export function QuickSettingsButton() {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const tiles = useStore((s) => s.quickTiles)
  const [open, setOpen] = useState(false)
  const shown = tiles.slice(0, GEAR_TILES)
  const keys = shortcutHint('settings.toggle', platform)
  const leave = (go: () => void) => () => {
    setOpen(false)
    go()
  }
  return (
    <Popover
      portal
      open={open}
      onOpenChange={setOpen}
      label={t('quick.title')}
      side="top"
      align="start"
      panelClassName="qt-pop"
      trigger={(popover) => (
        <IconButton {...popover} label={t('sidebar.rail.quick')} data-tour="settings">
          <Settings size={15} />
        </IconButton>
      )}
    >
      <div className="qt-pop-head">
        <span className="qt-pop-title">{t('quick.title')}</span>
        <Button size="sm" onClick={leave(() => openSettingsPage({ section: 'quick' }))}>
          {t('quick.pop.allSettings')}
          {keys && <Kbd>{keys}</Kbd>}
        </Button>
      </div>
      <div className="qt-pop-body">
        {shown.length ? (
          <div className="qt-grid qt-grid--pop">
            {shown.map((id) => (
              <Tile key={id} id={id} inPopover onLeave={() => setOpen(false)} />
            ))}
          </div>
        ) : (
          <p className="faint small">{t('quick.empty')}</p>
        )}
      </div>
      <div className="qt-pop-foot faint small">
        <span>{t('quick.pop.count', { shown: shown.length, total: tiles.length })}</span>
        <span className="qt-pop-links">
          {tiles.length > shown.length && <LinkButton onClick={leave(() => openQuickPage())}>{t('quick.pop.showAll', { count: tiles.length })}</LinkButton>}
          <LinkButton onClick={leave(() => openQuickPage(true))}>{t('quick.choose.start')}</LinkButton>
        </span>
      </div>
    </Popover>
  )
}
