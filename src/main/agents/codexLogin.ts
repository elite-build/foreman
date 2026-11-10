// Managed ChatGPT sign-in for Codex: `codex app-server` runs the OAuth flow (`account/login/start` hands back a URL to open in
// the browser, `account/login/completed` says how it went), so Settings can offer one button instead of a terminal.
import { CodexAppServer, type AppServerFactory, type AppServerLaunch } from './codexAppServer'

export type CodexSignInResult = { ok: true } | { ok: false; error: string; cancelled?: boolean; timedOut?: boolean }

export interface CodexSignIn {
  /** Settles once: signed in, failed, cancelled or timed out. The app-server is gone by then. */
  done: Promise<CodexSignInResult>
  /** Abandons the sign-in (the browser tab stays, but its code no longer works). A no-op once settled. */
  cancel(): void
}

/** What the browser flow can take before Foreman gives up (the user may be signing up, or finding a password). */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000
// Cancelling asks the CLI to free its local callback port; killing the process does the same if it doesn't answer.
const CANCEL_GRACE_MS = 1500

interface LoginStarted {
  type: string
  loginId?: string
  authUrl?: string
}

interface LoginCompleted {
  loginId: string | null
  success: boolean
  error: string | null
}

/**
 * Starts the ChatGPT sign-in. `openUrl` opens the sign-in page in the user's browser. `start` is how the app-server is
 * launched, so tests can use a fake with no process.
 */
export function startCodexSignIn(
  launch: AppServerLaunch,
  openUrl: (url: string) => Promise<void> | void,
  start: AppServerFactory = CodexAppServer.start,
  timeoutMs = SIGN_IN_TIMEOUT_MS
): CodexSignIn {
  let server: ReturnType<AppServerFactory> | undefined
  let loginId: string | undefined
  let settled = false
  let timer: NodeJS.Timeout | undefined
  // A completion that arrives before the start reply names its login (it can't be told apart until then).
  const early: LoginCompleted[] = []
  let resolveDone!: (result: CodexSignInResult) => void
  const done = new Promise<CodexSignInResult>((resolve) => {
    resolveDone = resolve
  })

  const finish = async (result: CodexSignInResult, cancelRemote: boolean): Promise<void> => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (server && !server.exited) {
      if (cancelRemote && loginId) {
        let grace: NodeJS.Timeout | undefined
        const gone = new Promise<void>((resolve) => {
          grace = setTimeout(resolve, CANCEL_GRACE_MS)
        })
        await Promise.race([server.request('account/login/cancel', { loginId }).then(() => undefined, () => undefined), gone])
        if (grace) clearTimeout(grace)
      }
      server.close()
    }
    resolveDone(result)
  }

  const completed = (note: LoginCompleted): void => {
    if (note.loginId !== loginId) return
    void finish(note.success ? { ok: true } : { ok: false, error: note.error?.trim() || 'Sign-in failed' }, false)
  }

  timer = setTimeout(() => void finish({ ok: false, error: 'Timed out waiting for the browser sign-in', timedOut: true }, true), timeoutMs)
  timer.unref?.()

  void (async () => {
    try {
      server = start(launch)
      server.onNotification((method, params) => {
        if (method !== 'account/login/completed') return
        if (loginId === undefined) early.push(params as LoginCompleted)
        else completed(params as LoginCompleted)
      })
      server.onExit((_code, stderrTail) => {
        const detail = stderrTail.trim()
        void finish({ ok: false, error: detail ? `Codex stopped before the sign-in finished: ${detail}` : 'Codex stopped before the sign-in finished' }, false)
      })
      await server.initialize()
      if (settled) return
      const started = await server.request<LoginStarted>('account/login/start', { type: 'chatgpt' })
      if (settled) return
      if (started.type !== 'chatgpt' || !started.loginId || !started.authUrl) throw new Error('Codex did not return a sign-in link')
      loginId = started.loginId
      await openUrl(started.authUrl)
      for (const note of early.splice(0)) completed(note)
    } catch (err) {
      await finish({ ok: false, error: err instanceof Error ? err.message : String(err) }, true)
    }
  })()

  return {
    done,
    cancel: () => void finish({ ok: false, error: 'Sign-in cancelled', cancelled: true }, true)
  }
}
