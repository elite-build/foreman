// The Tiles layout: several workspaces' chats side by side, so parallel agents can be watched and answered without
// switching. A tile is the workspace's current chat and its composer; Open full size shows the usual workspace view.
import { Maximize2, PanelLeft, PanelRight } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { Triage } from '../../../../shared/triage'
import { workspaceSurfaces } from '../../archivedView'
import { useT } from '../../i18n'
import { modKey, selectWorkspace, setTileCount, setTiles, toggleLeftPanel, useStore, zoomTile } from '../../store'
import { useActiveSessionId } from '../../storeMemo'
import { COMPACT_TILE_WIDTH, placeTile, TILE_COUNTS, tileLayout, tilesShown, type TileCount } from '../../tiles'
import { sidebarOrder, triageAll } from '../../triage'
import { Card, IconButton, Segmented, Spinner, Status } from '../../ui'
import { ChatView } from '../ChatView'
import { DiffBadge, DOT_TONE, useTriageInput } from '../Sidebar'
import './tiles.css'

export function TilesView({ hidden }: { hidden: boolean }) {
  const t = useT()
  const input = useTriageInput()
  const view = useStore((s) => s.sidebarView)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const remembered = useStore((s) => s.tiles)
  const count = useStore((s) => s.tileCount)
  const leftPanelOpen = useStore((s) => s.leftPanelOpen)
  const sidebarSide = useStore((s) => s.snapshot!.settings.sidebarSide ?? 'left')
  const mod = modKey(input.snapshot.platform)
  // Most recently looked at first: a workspace opened from the sidebar replaces the tile looked at least recently.
  const recent = useRef<string[]>([])

  const live = new Set(input.snapshot.workspaces.filter((w) => w.state !== 'archived').map((w) => w.id))
  const order = sidebarOrder(input, view).map((w) => w.id)
  let shown = tilesShown(remembered, order, live, count)
  if (selectedId && live.has(selectedId)) shown = placeTile(shown, selectedId, recent.current, count)
  const triage = new Map<string, Triage>(triageAll(input, null).map((item) => [item.ws.id, item]))

  // Remembered once on screen, so tiles filled from the sidebar keep their places when its order changes.
  const key = shown.join('\n')
  useEffect(() => {
    if (key !== remembered.join('\n')) setTiles(key ? key.split('\n') : [])
  }, [key, remembered])
  useEffect(() => {
    if (selectedId) recent.current = [selectedId, ...recent.current.filter((id) => id !== selectedId)]
  }, [selectedId])

  // Columns follow the room there is: a narrow window or a large zoom stacks the tiles rather than squeezing them.
  const grid = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const hasGrid = shown.length > 0
  useEffect(() => {
    const el = grid.current
    if (!el) return
    // Hidden, the grid measures 0; keep the last real width.
    const observer = new ResizeObserver(() => el.clientWidth > 0 && setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasGrid])
  const layout = tileLayout(shown.length, width)

  const sidebarToggle = !leftPanelOpen && (
    <IconButton label={t('workspaceView.showSidebar', { key: `${mod}B` })} onClick={toggleLeftPanel}>
      {sidebarSide === 'right' ? <PanelRight size={15} /> : <PanelLeft size={15} />}
    </IconButton>
  )

  return (
    <section className="tiles" aria-label={t('tiles.label')} style={{ display: hidden ? 'none' : undefined }}>
      <header className="titlebar drag tiles-head">
        <div className="header-title">
          {sidebarSide === 'left' && sidebarToggle}
          <span className="header-name">{t('tiles.title')}</span>
        </div>
        <div className="header-actions">
          <Segmented<`${TileCount}`>
            small
            label={t('tiles.count')}
            value={`${count}`}
            options={TILE_COUNTS.map((n) => ({ value: `${n}`, label: `${n}` }))}
            onChange={(value) => setTileCount(Number(value) as TileCount)}
          />
          {sidebarSide === 'right' && sidebarToggle}
        </div>
      </header>
      {shown.length === 0 ? (
        <div className="center-empty">
          <p className="muted">{t('tiles.empty')}</p>
        </div>
      ) : (
        <div ref={grid} className="tiles-grid" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}>
          {shown.map((id) => (
            <Tile key={id} workspaceId={id} triage={triage.get(id)} focused={id === selectedId} hidden={hidden} compact={layout.tileWidth < COMPACT_TILE_WIDTH} />
          ))}
        </div>
      )}
    </section>
  )
}

function Tile({ workspaceId, triage, focused, hidden, compact }: { workspaceId: string; triage?: Triage; focused: boolean; hidden: boolean; compact: boolean }) {
  const t = useT()
  const headingId = useId()
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const sessionId = useActiveSessionId(workspaceId)
  const session = useStore((s) => s.snapshot!.sessions.find((x) => x.id === sessionId))
  const running = useStore((s) => s.snapshot!.sessions.some((x) => x.workspaceId === workspaceId && x.status === 'running'))
  if (!ws) return null
  const attention = triage?.bucket === 'attention' && triage.label ? triage : null
  // Clicking or tabbing into a tile looks at it: the sidebar and the shortcuts follow.
  const focus = () => {
    if (!focused) selectWorkspace(workspaceId)
  }

  return (
    // The focused tile's edge and fill say "this one" to the eye; aria-current says it to a screen reader.
    <Card
      as="section"
      interactive
      selected={focused}
      aria-current={focused ? 'true' : undefined}
      stripe={attention ? 'warn' : undefined}
      className="tile"
      aria-labelledby={headingId}
      onFocus={focus}
      onPointerDown={focus}
    >
      <header className="tile-head">
        <div className="header-title">
          {attention ? (
            // A narrow tile keeps its name readable: the status shows its shape, says its word to a screen reader, and
            // has the word as its tooltip.
            <Status tone={DOT_TONE[attention.tone ?? ''] ?? 'warn'} label={attention.label!} compact={compact} title={compact ? attention.label : undefined} />
          ) : (
            running && <Spinner size={13} label={t('workspaceView.tab.running')} />
          )}
          <span className="header-name" id={headingId} role="heading" aria-level={2}>
            {ws.name}
          </span>
          <code className="header-branch">{ws.branch}</code>
        </div>
        <div className="header-actions">
          {ws.diffStat && <DiffBadge additions={ws.diffStat.additions} deletions={ws.diffStat.deletions} />}
          <IconButton label={t('tiles.open', { name: ws.name })} onClick={() => zoomTile(workspaceId)}>
            <Maximize2 size={13} />
          </IconButton>
        </div>
      </header>
      <div className="tile-body">
        {workspaceSurfaces(ws).chats ? (
          session ? (
            <ChatView session={session} workspace={ws} active={focused && !hidden} hidden={hidden} headingLevel={3} />
          ) : (
            <div className="center-empty">
              <p className="muted">{t('tiles.noChat')}</p>
            </div>
          )
        ) : (
          <div className="center-empty">
            {ws.state === 'error' ? (
              <p className="error-text">{ws.error}</p>
            ) : (
              <p className="muted">
                <Spinner size={14} /> {t('workspaceView.creating', { name: ws.name })}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
