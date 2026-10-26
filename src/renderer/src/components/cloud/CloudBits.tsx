// A remote workspace in the window: its glyph in the sidebar and on Home,
// the status word under its name, the header pill with its provider and Wake / Sleep / Restart / Open on
// <provider>, the banner while it starts, wakes, sleeps or was cut off at the session limit, and the band
// over a read-only terminal.
import { Archive, Cloud, ExternalLink, Moon, Play, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cloudSettings, providerLabel } from '../../../../shared/cloud'
import { isSandboxService } from '../../../../shared/integrations'
import type { CloudPreflight, Repo, Workspace } from '../../../../shared/types'
import { cloudDot, cloudStatusWord, runningCloud, sandboxConnection, sessionCap, type CloudStatusWord } from '../../cloudView'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, openArchiveDialog, showToast, useStore } from '../../store'
import { Button, Callout, MenuButton, MenuItem, MenuSeparator, Spinner, Status, type StatusTone } from '../../ui'
import './cloud.css'

// A polled status is asked for again this often while the workspace is on screen (PLAN §5: every 30 s).
const POLL_MS = 30_000

export function useTurnRunning(workspaceId: string): boolean {
  return useStore((s) => s.snapshot!.sessions.some((x) => x.workspaceId === workspaceId && x.status === 'running'))
}

// The shape and colour beside a sandbox's status word (cloudView's dot colours as Status tones).
const DOT_TONE: Record<ReturnType<typeof cloudDot>, StatusTone> = { '': 'off', green: 'ok', blue: 'info', amber: 'warn', red: 'error' }

/** The Status tone for a sandbox's status (the shape and colour beside its word). */
export const cloudTone = (status: Parameters<typeof cloudDot>[0]): StatusTone => DOT_TONE[cloudDot(status)]

export const statusText = (t: RendererT, word: CloudStatusWord): string => t(`cloud.status.${word}`)

/** "45-minute" or "24-hour": a provider's session cap as the chat says it ('' without one). */
export function useLimitLabel(maxSessionMs: number | undefined): string {
  const t = useT()
  if (!maxSessionMs) return ''
  const cap = sessionCap({ maxSessionMs, maxVcpus: 0, maxConcurrent: 0 })
  return cap.hours !== undefined ? t('cloud.limit.hours', { hours: cap.hours }) : t('cloud.limit.minutes', { minutes: cap.minutes })
}

/** The page of the workspace's connection on its provider (Vercel's team), where its sandboxes are listed. */
function useProviderUrl(ws: Pick<Workspace, 'cloud'>): string | undefined {
  return useStore((s) => (ws.cloud ? sandboxConnection(s.snapshot!.integrations.connections, ws.cloud.provider, ws.cloud.connectionId)?.identity?.url : undefined))
}

/** A string that changes when a sandbox connection is added, removed, made default, edited or needs attention (a stable selector). */
export function useSandboxConnectionsKey(): string {
  return useStore((s) =>
    s.snapshot!.integrations.connections
      .filter((c) => isSandboxService(c.service))
      .map((c) => `${c.id}:${c.rev}:${c.isDefault ? 1 : 0}:${c.problem ?? ''}`)
      .join(',')
  )
}

/**
 * Main's view of a repository's provider and whether a remote workspace can be made now (Api.cloudPreflight): its
 * limits and capabilities come from the provider, not the connection. Asked again when what it depends on changes.
 */
export function useRepoProvider(repo: Repo | undefined): CloudPreflight | null {
  const connections = useSandboxConnectionsKey()
  const holding = useStore((s) => runningCloud(s.snapshot!.workspaces).length)
  const [answer, setAnswer] = useState<CloudPreflight | null>(null)
  const id = repo?.id
  const key = repo ? JSON.stringify([repo.cloud?.enabled, repo.cloud?.provider, repo.cloud?.connectionId, repo.cloud?.build?.id, repo.cloud?.build?.status]) : ''
  useEffect(() => {
    if (!id) {
      setAnswer(null)
      return
    }
    let live = true
    void api.cloudPreflight(id).then(
      (a) => live && setAnswer(a),
      () => live && setAnswer(null)
    )
    return () => {
      live = false
    }
  }, [id, key, connections, holding])
  return answer
}

/** The cloud glyph for a cloud workspace's row; nothing for a local one. */
export function CloudGlyph({ ws, size = 13 }: { ws: Pick<Workspace, 'cloud'>; size?: number }) {
  const t = useT()
  if (!ws.cloud) return null
  return <Cloud size={size} className="cloud-glyph" aria-label={t('cloud.glyph')} />
}

/** "● working", "● asleep", "● session limit": leads a cloud workspace's sub-line in the sidebar. */
export function CloudSub({ ws }: { ws: Workspace }) {
  const t = useT()
  const turnRunning = useTurnRunning(ws.id)
  if (!ws.cloud || ws.state === 'archived') return null
  const word = cloudStatusWord(ws.cloud.status, turnRunning)
  const dot = cloudDot(ws.cloud.status)
  return (
    <Status className="ws-cloud" tone={DOT_TONE[dot]} label={statusText(t, word)} title={t('cloud.statusTitle', { status: statusText(t, word) })} />
  )
}

/** Wake, sleep or restart a workspace's sandbox; errors become toasts (the limit's own message lists what's running). */
export async function cloudAction(kind: 'wake' | 'sleep' | 'restart', ws: Pick<Workspace, 'id' | 'name'>, t?: RendererT): Promise<boolean> {
  const done = await attempt(() => (kind === 'wake' ? api.cloudWake(ws.id) : kind === 'sleep' ? api.cloudSleep(ws.id) : api.cloudRestart(ws.id)))
  if (done && kind === 'sleep' && t) showToast(t('cloud.action.slept', { name: ws.name }))
  return Boolean(done)
}

/** Ask the provider for the sandbox's status every 30 s while the workspace is on screen, and once when it appears. */
export function useCloudStatusPoll(ws: Workspace | undefined, active: boolean): void {
  const id = ws?.cloud && ws.state !== 'archived' ? ws.id : null
  useEffect(() => {
    if (!id || !active) return
    const poll = () => void api.cloudStatus(id).catch(() => undefined)
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [id, active])
}

/**
 * PLAN §5 "wake on open": opening a sleeping cloud workspace wakes its sandbox, once per opening, so the waking
 * banner shows and then the files. Settings → Cloud workspaces can turn it off. Only `sleeping`: a sandbox that
 * stopped at the session limit, isn't answering or is gone keeps its banner and manual action. Quiet on failure:
 * at the running limit it stays asleep, and the banner's Wake says why.
 */
export function useWakeOnOpen(ws: Workspace | undefined, active: boolean): void {
  const enabled = useStore((s) => cloudSettings(s.snapshot!.settings).wakeOnOpen)
  const id = ws?.cloud && ws.state !== 'archived' && ws.state !== 'creating' ? ws.id : null
  const asleep = ws?.cloud?.status === 'sleeping'
  const woken = useRef<string | null>(null)
  useEffect(() => {
    if (!active || !id) {
      woken.current = null
      return
    }
    if (!enabled || !asleep || woken.current === id) return
    woken.current = id
    void api.cloudWake(id).catch(() => undefined)
  }, [id, active, enabled, asleep])
}

/** The header's cloud pill, next to the state pill: the status, and a menu of what can be done to the sandbox. */
export function CloudPill({ ws }: { ws: Workspace }) {
  const t = useT()
  const turnRunning = useTurnRunning(ws.id)
  const url = useProviderUrl(ws)
  const [busy, setBusy] = useState(false)
  if (!ws.cloud) return null
  const status = ws.cloud.status
  const word = cloudStatusWord(status, turnRunning)
  const run = (kind: 'wake' | 'sleep' | 'restart') => {
    setBusy(true)
    void cloudAction(kind, ws, t).finally(() => setBusy(false))
  }
  const awake = status === 'running' || status === 'waking' || status === 'creating'
  const reachable = status !== 'gone' && status !== 'archived'
  const provider = providerLabel(ws.cloud.provider)
  const working = busy || status === 'waking' || status === 'creating'
  return (
    <MenuButton
      look="chip"
      pill
      label={t('cloud.header.menu')}
      aria-label={`${t('cloud.header.menu')}: ${statusText(t, word)}`}
      title={t('cloud.statusTitle', { status: statusText(t, word) })}
      trigger={
        <>
          <Cloud size={11} aria-hidden /> {provider} ·{' '}
          {working ? (
            <>
              <Spinner size={11} /> {statusText(t, word)}
            </>
          ) : (
            <Status tone={cloudTone(status)} label={statusText(t, word)} />
          )}
        </>
      }
    >
      {!awake && reachable && (
        <MenuItem icon={<Play size={13} />} onSelect={() => run('wake')}>
          {t('cloud.action.wake')}
        </MenuItem>
      )}
      {status === 'running' && (
        <MenuItem icon={<Moon size={13} />} onSelect={() => run('sleep')}>
          {t('cloud.action.sleep')}
        </MenuItem>
      )}
      {reachable && (
        <MenuItem icon={<RotateCw size={13} />} onSelect={() => run('restart')}>
          {t('cloud.action.restart')}
        </MenuItem>
      )}
      {url && (
        <>
          <MenuSeparator />
          <MenuItem icon={<ExternalLink size={13} />} onSelect={() => void attempt(() => api.openExternal(url))}>
            {t('cloud.action.openProvider', { provider })}
          </MenuItem>
        </>
      )}
      {/* The header's Open menu (which has Archive) needs a folder here, so Archive lives here for a cloud workspace. */}
      <MenuSeparator />
      <MenuItem variant="danger" icon={<Archive size={13} />} onSelect={() => openArchiveDialog(ws.id)}>
        {t('workspaceView.archive')}
      </MenuItem>
    </MenuButton>
  )
}

/** The latest chat in the workspace whose turn was cut off, else the latest that ended at all. */
function interruptedSession(workspaceId: string, sessions: { id: string; workspaceId: string; closedAt?: string; lastTurn?: { outcome: string; endedAt: string } }[]): string | undefined {
  const own = sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt && s.lastTurn).sort((a, b) => b.lastTurn!.endedAt.localeCompare(a.lastTurn!.endedAt))
  return (own.find((s) => s.lastTurn!.outcome === 'interrupted') ?? own[0])?.id
}

/** Under the header, like the hand-off banner: while the sandbox starts or wakes, sleeps, was capped, or is in trouble. */
export function CloudBanner({ ws }: { ws: Workspace }) {
  const t = useT()
  const limit = useLimitLabel(ws.cloud?.maxSessionMs)
  const sessionId = useStore((s) => (ws.cloud?.status === 'capped' ? interruptedSession(ws.id, s.snapshot!.sessions) : undefined))
  const [busy, setBusy] = useState(false)
  if (!ws.cloud || ws.state === 'archived') return null
  const act = (action: () => Promise<unknown>) => {
    setBusy(true)
    void attempt(action).finally(() => setBusy(false))
  }
  const button = (label: string, action: () => Promise<unknown>) => (
    <Button size="sm" disabled={busy} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => act(action)}>
      {label}
    </Button>
  )
  // The provider's name leads: "Vercel · The sandbox is asleep."
  const label = <strong>{providerLabel(ws.cloud.provider)}</strong>
  // A turn still runs in the sandbox, but the connection to it was lost: Reconnect picks it up again.
  if (ws.cloud.disconnected && ws.cloud.status === 'running') {
    return (
      <Callout banner tone="warn" role="status" actions={button(t('cloud.action.reconnect'), () => api.cloudReattach(ws.id))}>
        {label} · {t('cloud.banner.lost')}
      </Callout>
    )
  }
  switch (ws.cloud.status) {
    case 'creating':
    case 'waking':
      return (
        <Callout banner role="status">
          <Spinner size={13} /> {label} · {ws.cloud.status === 'creating' ? t('cloud.banner.creating') : t('cloud.banner.waking')}
        </Callout>
      )
    case 'sleeping':
      return (
        <Callout banner role="status" actions={button(t('cloud.action.wake'), () => api.cloudWake(ws.id))}>
          <Moon size={13} aria-hidden /> {label} · {t('cloud.banner.asleep')}
        </Callout>
      )
    case 'capped':
      return (
        <Callout
          banner
          tone="warn"
          role="status"
          actions={button(t('common.continue'), () => (sessionId ? api.cloudContinue(sessionId) : api.cloudWake(ws.id)))}
        >
          {label} · {limit ? t('cloud.banner.capped', { limit }) : t('cloud.banner.cappedNoLimit')}
        </Callout>
      )
    case 'unresponsive':
      return (
        <Callout banner tone="warn" role="status" actions={button(t('cloud.action.restart'), () => api.cloudRestart(ws.id))}>
          {label} · {t('cloud.banner.unresponsive')}
        </Callout>
      )
    case 'failed':
    case 'gone':
      return (
        <Callout
          banner
          tone="error"
          role="status"
          actions={ws.cloud.status === 'failed' ? button(t('cloud.action.restart'), () => api.cloudRestart(ws.id)) : undefined}
        >
          {label} · {ws.cloud.status === 'gone' ? t('cloud.banner.gone') : t('cloud.banner.failed', { error: ws.cloud.error ?? ws.error ?? '' })}
        </Callout>
      )
    default:
      return null
  }
}

/** Over a cloud terminal that went read-only (PLAN §8): why, and Wake, which starts a new shell under the old output. */
export function CloudTerminalBand({ workspaceId, reason }: { workspaceId: string; reason?: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  // Stopped at the session limit: Continue picks the cut-off chat up (and wakes the sandbox), as the banner offers.
  const sessionId = useStore((s) => {
    const ws = s.snapshot!.workspaces.find((w) => w.id === workspaceId)
    return ws?.cloud?.status === 'capped' ? interruptedSession(workspaceId, s.snapshot!.sessions) : undefined
  })
  const act = (action: () => Promise<unknown>) => {
    setBusy(true)
    void attempt(action).finally(() => setBusy(false))
  }
  return (
    <Callout
      banner
      role="status"
      className="cloud-term-band"
      actions={
        <>
          {sessionId && (
            <Button size="sm" disabled={busy} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => act(() => api.cloudContinue(sessionId))}>
              {t('common.continue')}
            </Button>
          )}
          <Button size="sm" disabled={busy} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => act(() => api.cloudWake(workspaceId))}>
            {t('cloud.action.wake')}
          </Button>
        </>
      }
    >
      <Moon size={13} aria-hidden /> {reason ?? t('cloud.banner.asleep')}
    </Callout>
  )
}
