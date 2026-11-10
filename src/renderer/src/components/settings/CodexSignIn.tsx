// Settings → Agents → Codex: sign in with ChatGPT in the browser. The main process runs Codex's own login flow and opens
// the sign-in page; this shows that it is waiting and how it ended. The terminal (`codex login`) stays as the fallback.
import { LogIn } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { api } from '../../store'
import { Button, Callout, Spinner } from '../../ui'

interface CodexSignInProps {
  // Already connected: the button then says "Sign in again" and isn't the primary action.
  connected: boolean
  // Called once a sign-in succeeds (refresh the status here).
  onSignedIn: () => void
}

export function CodexSignIn({ connected, onSignedIn }: CodexSignInProps) {
  const t = useT()
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const start = async () => {
    setError(null)
    setWaiting(true)
    try {
      const result = await api.codexSignIn()
      if (result.ok) onSignedIn()
      else if (!result.cancelled && mounted.current) setError(result.error || t('agentSettings.codex.signInFailed'))
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setWaiting(false)
    }
  }

  return (
    <>
      <div className="set-auth-actions">
        {waiting ? (
          <>
            <Spinner size={13} label={t('agentSettings.codex.signInWaiting')} />
            <Button size="sm" onClick={() => void api.codexSignInCancel()}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant={connected ? 'default' : 'primary'} icon={<LogIn size={13} />} onClick={() => void start()}>
              {connected ? t('agentCatalog.agent.signInAgain') : t('agentSettings.codex.signInChatgpt')}
            </Button>
            <span className="set-help">{t('agentSettings.codex.signInHelp')}</span>
          </>
        )}
      </div>
      {error && <Callout tone="error" role="alert">{t('agentSettings.codex.signInError', { error })}</Callout>}
    </>
  )
}
