import { ExternalLink, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlainKey } from '../../../../shared/i18n'
import type { GithubStatus, Settings } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openSettingsPage } from '../../store'
import { Button, LinkButton, Select, Spinner, Status, type StatusTone } from '../../ui'
import { Page, resetSettings, rowDomId, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'
import { LoginTerminal } from './LoginTerminal'

const DEFAULTS = {
  privacyMode: false,
  requireToolApprovals: false,
  codexApprovals: 'always'
} satisfies Partial<Settings>

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow,read:user&description=Foreman'
const GH_INSTALL_URL = 'https://cli.github.com'

const CODEX_HELP: Record<Settings['codexApprovals'], PlainKey> = {
  sandboxed: 'settings.account.codexApprovals.helpSandboxed',
  always: 'settings.account.codexApprovals.helpAlways'
}

export function AccountPage() {
  const t = useT()
  const settings = useSettings()
  const reset = (key: keyof typeof DEFAULTS) => (settings[key] === DEFAULTS[key] ? undefined : () => void resetSettings([key]))

  return (
    <Page title={t('settings.page.account')}>
      <GithubSection />

      <Section title={t('settings.account.privacy')}>
        <ToggleRow
          id="privacy-mode"
          label={t('settings.account.privacyMode')}
          help={t('settings.account.privacyMode.help')}
          checked={settings.privacyMode}
          onChange={(privacyMode) => void saveSettings({ privacyMode })}
          onReset={reset('privacyMode')}
        />
        <ToggleRow
          id="claude-tool-approvals"
          label={t('settings.account.claudeApprovals')}
          help={t('settings.account.claudeApprovals.help')}
          checked={settings.requireToolApprovals}
          onChange={(requireToolApprovals) => void saveSettings({ requireToolApprovals })}
          onReset={reset('requireToolApprovals')}
        />
        <Row id="codex-tool-approvals" label={t('settings.account.codexApprovals')} help={t(CODEX_HELP[settings.codexApprovals])} onReset={reset('codexApprovals')}>
          <Select<Settings['codexApprovals']>
            label={t('settings.account.codexApprovals')}
            width={200}
            value={settings.codexApprovals}
            options={[
              { value: 'always', label: t('settings.account.codexApprovals.always') },
              { value: 'sandboxed', label: t('settings.account.codexApprovals.sandboxed') }
            ]}
            onChange={(codexApprovals) => void saveSettings({ codexApprovals })}
          />
        </Row>
      </Section>
    </Page>
  )
}

function useGithubStatus() {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the latest check may update the panel.
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const next = await api.githubStatus()
      if (id !== request.current) return
      setStatus(next)
      setError(null)
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, loading, error, refresh }
}

function GithubSection() {
  const t = useT()
  const github = useGithubStatus()
  const { status, refresh } = github
  return (
    <Section title="GitHub" description={t('settings.account.github.desc')} plain>
      <div id={rowDomId('github')} className="set-github">
        <GithubStatusPanel {...github} />
        {status && !status.installed ? (
          <div className="set-auth-actions">
            <Button size="sm" onClick={() => void attempt(() => api.openExternal(GH_INSTALL_URL))}>
              {t('settings.account.github.install')} <ExternalLink size={11} aria-hidden />
            </Button>
            <span className="set-help">{t('settings.account.github.thenRefresh')}</span>
          </div>
        ) : status && !status.loggedIn ? (
          <LoginTerminal command="gh-login" commandLabel="gh auth login" buttonLabel={t('settings.account.github.runLogin', { command: 'gh auth login' })} primary onDone={() => void refresh()} />
        ) : null}
        <p className="set-help">
          {t('settings.account.github.integrations')}{' '}
          <LinkButton size="sm" onClick={() => openSettingsPage({ section: 'integrations' })}>
            {t('integrations.repo.openIntegrations')}
          </LinkButton>
        </p>
      </div>
    </Section>
  )
}

function GithubStatusPanel({ status, loading, error, refresh }: ReturnType<typeof useGithubStatus>) {
  const t = useT()
  // No tone while the first check runs: a spinner stands in for the glyph.
  const tone: StatusTone | null = error ? 'error' : !status ? null : status.loggedIn ? 'ok' : status.installed ? 'warn' : 'error'
  const text = error
    ? t('settings.account.github.checkFailed')
    : !status
      ? t('settings.account.github.checking')
      : status.loggedIn
        ? t('gitlab.accounts.connectedAs', { user: status.user ?? '' })
        : (status.detail ?? t('settings.account.github.notConnected'))
  return (
    <div className="set-status set-github-status" aria-busy={loading} aria-live="polite">
      <div className="set-status-head">
        {tone ? (
          <Status tone={tone} label={text} className="set-status-text" />
        ) : (
          <>
            <Spinner size={13} />
            <span className="set-status-text">{text}</span>
          </>
        )}
        <span className="spacer" />
        <Button size="sm" disabled={loading} icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void refresh()}>
          {t('common.refresh')}
        </Button>
      </div>
      {error && <p className="set-status-detail warn">{error}</p>}
    </div>
  )
}
