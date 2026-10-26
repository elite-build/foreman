// Home's Integrations rows: Slack messages waiting for Send or Skip (Ask first), connections that
// need attention, and a newly added repository's "use the same as its siblings" suggestion.
import { CircleAlert, Pencil, Plug, Send } from 'lucide-react'
import { useState } from 'react'
import type { SlackDelivery } from '../../../shared/integrations'
import { useT } from '../i18n'
import { api, attempt, openSettingsPage, showToast, useStore } from '../store'
import { Button, LinkButton, TextArea } from '../ui'
import { AddPerson } from './settings/integrations/PeopleTab'
import { ServiceMark } from './settings/integrations/ServiceMark'
import './settings/integrations/integrations.css'

export function IntegrationsHome({ repoId }: { repoId?: string }) {
  const t = useT()
  const allAsks = useStore((s) => s.snapshot!.slackAsks)
  const asks = allAsks.filter((d) => !repoId || d.repoId === repoId)
  const integrations = useStore((s) => s.snapshot!.integrations)
  const repos = useStore((s) => s.snapshot!.repos)
  const problems = integrations.connections.filter((c) => c.problem && c.usedBy > 0)
  const suggestions = Object.entries(integrations.suggestions).filter(([id]) => !repoId || id === repoId)
  if (!asks.length && !problems.length && !suggestions.length) return null
  return (
    <>
      {suggestions.map(([id, s]) => {
        const repo = repos.find((r) => r.id === id)
        if (!repo) return null
        const names = Object.values(s.services).map((cid) => integrations.connections.find((c) => c.id === cid)?.name).filter(Boolean).join(', ')
        return (
          <div key={id} className="int-suggest">
            <Plug size={14} />
            <span className="grow">{t('integrations.home.suggest', { repo: repo.name, owner: s.owner, names })}</span>
            <Button size="sm" variant="primary" onClick={() => void attempt(() => api.acceptIntegrationSuggestion(id))}>
              {t('integrations.suggest.use')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.setRepoIntegrationOptions(id, { dismissSuggestion: true }))}>
              {t('integrations.suggest.notNow')}
            </Button>
          </div>
        )
      })}
      {problems.length > 0 && (
        <section className="home-card">
          <header className="home-card-head">
            <span className="home-card-title">{t('integrations.home.problems')}</span>
            <span className="home-card-hint">{problems.length}</span>
          </header>
          {problems.map((c) => (
            <div key={c.id} className="int-home-row">
              <CircleAlert size={14} className="int-home-bad" />
              <span className="grow">
                <b>{c.name}</b> · {c.problem} · {t('integrations.card.usedBy', { count: c.usedBy })}
              </span>
              <Button size="sm" onClick={() => openSettingsPage({ section: 'integrations' })}>
                {t('integrations.repo.openIntegrations')}
              </Button>
            </div>
          ))}
        </section>
      )}
      {asks.length > 0 && (
        <section className="home-card">
          <header className="home-card-head">
            <span className="home-card-title">{t('integrations.home.asks')}</span>
            <span className="home-card-hint">{asks.length}</span>
          </header>
          {asks.map((d) => (
            <AskRow key={d.id} delivery={d} />
          ))}
        </section>
      )}
    </>
  )
}

function AskRow({ delivery: d }: { delivery: SlackDelivery }) {
  const t = useT()
  const connection = useStore((s) => s.snapshot!.integrations.connections.find((c) => c.id === d.connectionId))
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(d.text)
  const [matching, setMatching] = useState(false)
  const [busy, setBusy] = useState(false)
  const answer = async (action: 'send' | 'skip') => {
    setBusy(true)
    const ok = await attempt(async () => (await api.answerSlackAsk(d.id, action, editing ? text : undefined), true))
    setBusy(false)
    if (ok && action === 'send') showToast(t('integrations.home.sent', { to: d.recipientName }))
  }
  return (
    <div className="int-ask">
      <div className="int-ask-kind">
        <ServiceMark service="slack" size={16} /> {t('integrations.home.askKind', { connection: connection?.name ?? 'Slack' })}
      </div>
      <div className="int-ask-title">
        {d.unmatched ? t('integrations.home.askUnmatched', { login: d.unmatched, what: d.title }) : t('integrations.home.askTitle', { to: d.recipientName, what: d.title })}
      </div>
      {editing ? (
        <TextArea rows={3} value={text} aria-label={t('integrations.home.edit')} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="int-preview">
          <div className="int-preview-who">{t('integrations.rules.previewFrom')}</div>
          <div>{d.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}</div>
        </div>
      )}
      {matching && connection && (
        <AddPerson connections={[connection]} login={d.unmatched} onDone={() => setMatching(false)} />
      )}
      <div className="int-row">
        {d.unmatched && !matching && (
          <Button size="sm" onClick={() => setMatching(true)}>
            {t('integrations.home.match', { login: d.unmatched })}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={busy} icon={<Send size={12} />} onClick={() => void answer('send')}>
          {d.unmatched ? t('integrations.home.sendMatched') : t('integrations.home.send', { to: d.recipientName })}
        </Button>
        {!editing && (
          <Button size="sm" icon={<Pencil size={12} />} onClick={() => setEditing(true)}>
            {t('integrations.home.edit')}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer('skip')}>
          {t('integrations.home.skip')}
        </Button>
        {d.url && (
          <LinkButton size="sm" onClick={() => void attempt(() => api.openExternal(d.url!))}>
            {t('integrations.home.open')}
          </LinkButton>
        )}
      </div>
    </div>
  )
}
