import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiffScope, WorkspaceDiff } from '../../../shared/types'
import { api, bridge, getState, showError, useWindowVisible } from '../store'

/** After a tool that may have changed files finishes, the diff is read again this long after (once per burst of edits). */
export const DIFF_SETTLE_MS = 1000
/** While an agent works, the diff is also read this often, for changes no event tells of (a script, a terminal). */
export const DIFF_SAFETY_POLL_MS = 30_000
// Coming back to the window reads it again soon (an editor may have saved meanwhile).
const DIFF_FOCUS_MS = 250

// Tools that only read files: their results can't change the diff. Any other (Edit, Write, Bash, a subagent) may have.
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion'])
const mayChangeFiles = (name: string) => !READ_ONLY_TOOLS.has(name) && !name.startsWith('mcp__foreman__')

export function useWorkspaceDiff(workspaceId: string, running: boolean, enabled: boolean, scope: DiffScope, commits: string[] = []) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const again = useRef(false)
  // Minimized: nothing reads the diff; it reads again when the window comes back.
  const visible = useWindowVisible()
  const commitKey = commits.join(',')
  // What to read: the selection as it is now, so a read already under way reads the new one next, not its own again.
  const latest = useRef({ workspaceId, scope, commits, key: '' })
  latest.current = { workspaceId, scope, commits, key: `${workspaceId}\n${scope}\n${commitKey}` }

  const refresh = useCallback(async () => {
    // Asked again while reading: read once more after, so a change made meanwhile isn't missed.
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    setLoading(true)
    try {
      do {
        again.current = false
        const asked = latest.current
        try {
          const read = await api.getDiff(asked.workspaceId, asked.scope, asked.commits.length ? asked.commits : undefined)
          // The scope or commits changed while it was read: it is another selection's diff, so read the new one instead.
          if (asked.key !== latest.current.key) again.current = true
          else setDiff(read)
        } catch (err) {
          if (asked.key !== latest.current.key) again.current = true
          else throw err
        }
      } while (again.current)
    } catch (err) {
      showError(err)
    } finally {
      busy.current = false
      again.current = false
      setLoading(false)
    }
    // A new selection is a new refresh, so the effect below reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, scope, commitKey])

  // Read when shown and when the agent starts or finishes; while it works, shortly after each of its tools that may
  // have changed files (the working tree's scopes only), with a slow safety read; and on coming back to the window.
  useEffect(() => {
    if (!enabled || !visible) return
    void refresh()
    let soon: ReturnType<typeof setTimeout> | undefined
    // Not pushed back by later calls, so a stream of edits still shows every second or so.
    const readSoon = (ms: number) => {
      soon ??= setTimeout(() => {
        soon = undefined
        void refresh()
      }, ms)
    }
    const workingTree = scope === 'all' || scope === 'uncommitted'
    const off = bridge.onEvent((event) => {
      if (!workingTree || event.type !== 'chat-item' || event.item.kind !== 'tool' || event.item.status === 'running' || !mayChangeFiles(event.item.name)) return
      if (getState().snapshot?.sessions.find((s) => s.id === event.sessionId)?.workspaceId === workspaceId) readSoon(DIFF_SETTLE_MS)
    })
    const back = () => document.visibilityState === 'visible' && readSoon(DIFF_FOCUS_MS)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    const poll = running ? setInterval(() => void refresh(), DIFF_SAFETY_POLL_MS) : undefined
    return () => {
      off()
      clearTimeout(soon)
      clearInterval(poll)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [enabled, visible, running, refresh, scope, workspaceId])

  return { diff, loading, refresh }
}
