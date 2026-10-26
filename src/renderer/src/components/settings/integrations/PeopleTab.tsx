// People: which Slack person each GitHub reviewer is, per Slack workspace, confirmed by the user.
// Reviewer DMs only go to people listed here. Kept on this Mac; never in a git backup.
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ConnectionView } from '../../../../../shared/integrations'
import { useT } from '../../../i18n'
import { api, attempt, useStore } from '../../../store'
import { Button, Field, IconButton, Select, TextInput } from '../../../ui'
import { flashSaved } from '../controls'
import { PersonPicker } from './AddConnectionDialog'

export function PeopleTab() {
  const t = useT()
  const all = useStore((s) => s.snapshot!.integrations.connections)
  const connections = all.filter((c) => c.service === 'slack')
  const people = useStore((s) => s.snapshot!.integrations.people)
  const [adding, setAdding] = useState(false)
  if (!connections.length) return <p className="int-empty">{t('integrations.rules.noSlack')}</p>
  const workspaceName = (teamId: string) => connections.find((c) => c.identity?.orgId === teamId)?.name ?? teamId
  return (
    <div className="int-people">
      <div className="int-row">
        <span className="set-help grow">{t('integrations.people.help')}</span>
        <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
          {t('integrations.people.add')}
        </Button>
      </div>
      {adding && <AddPerson connections={connections} onDone={() => setAdding(false)} />}
      {people.length > 0 && (
        <table className="int-table">
          <thead>
            <tr>
              <th>{t('integrations.people.github')}</th>
              <th>{t('integrations.people.slack')}</th>
              {connections.length > 1 && <th>{t('integrations.people.workspace')}</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={`${p.githubLogin}:${p.slackTeamId}`}>
                <td className="mono">@{p.githubLogin}</td>
                <td>{p.slackName}</td>
                {connections.length > 1 && <td>{workspaceName(p.slackTeamId)}</td>}
                <td className="int-table-act">
                  <IconButton label={t('integrations.people.remove', { login: p.githubLogin })} onClick={() => void attempt(() => api.unlinkPerson(p.githubLogin, p.slackTeamId)).then(flashSaved)}>
                    <Trash2 size={13} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!people.length && !adding && <p className="int-empty">{t('integrations.people.none')}</p>}
    </div>
  )
}

/** One GitHub login ↔ one Slack person. `login` pre-fills it (the Ask first card's "Match…"). */
export function AddPerson({ connections, login: initial, onDone }: { connections: ConnectionView[]; login?: string; onDone: () => void }) {
  const t = useT()
  const [connectionId, setConnectionId] = useState(connections[0]?.id)
  const [login, setLogin] = useState(initial ?? '')
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null)
  const connection = connections.find((c) => c.id === connectionId)
  const save = async () => {
    if (!connection?.identity?.orgId || !person || !login.trim()) return
    const ok = await attempt(async () => (await api.linkPerson({ githubLogin: login.trim().replace(/^@/, ''), slackTeamId: connection.identity!.orgId!, slackUserId: person.id, slackName: person.name }), true))
    if (ok) {
      flashSaved()
      onDone()
    }
  }
  return (
    <div className="int-add-person">
      <Field label={t('integrations.people.github')}>
        {(c) => <TextInput {...c} mono autoFocus={!initial} value={login} placeholder="octocat" onChange={(e) => setLogin(e.target.value)} />}
      </Field>
      {connections.length > 1 && (
        <Field label={t('integrations.people.workspace')}>
          {(c) => (
            <Select
              {...c}
              value={connectionId ?? ''}
              options={connections.map((x) => ({ value: x.id, label: x.name }))}
              onChange={(id) => {
                setConnectionId(id)
                setPerson(null)
              }}
            />
          )}
        </Field>
      )}
      <div className="field">
        <span className="int-label">{t('integrations.people.slack')}</span>
        {connection && <PersonPicker connectionId={connection.id} value={person} onChange={setPerson} />}
        <span className="set-help">{t('integrations.people.emailHint')}</span>
      </div>
      <div className="int-row">
        <span className="grow" />
        <Button size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={!person || !login.trim()} onClick={() => void save()}>
          {t('integrations.people.save')}
        </Button>
      </div>
    </div>
  )
}
