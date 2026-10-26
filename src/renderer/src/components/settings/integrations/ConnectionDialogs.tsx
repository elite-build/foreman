// "Use in repositories…", Rename and Remove for a connection.
import { useEffect, useMemo, useState } from 'react'
import { remoteOwner, suggestedRepos, type ConnectionView } from '../../../../../shared/integrations'
import { useT } from '../../../i18n'
import { api, attempt, showToast, useStore } from '../../../store'
import { Button, Checkbox, Dialog, Field, Spinner, TextInput } from '../../../ui'
import { flashSaved } from '../controls'

/**
 * The "these are my work repositories" action: each ticked repository chooses this connection
 * explicitly (visible in its Integrations tab); unticking one that chose it puts it back on the
 * default. Repositories whose remotes share an owner with ones already using it start ticked.
 */
export function UseInReposDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const integrations = useStore((s) => s.snapshot!.integrations)
  const defaults = useMemo(() => Object.fromEntries(integrations.connections.filter((c) => c.isDefault).map((c) => [c.service, c.id])), [integrations])
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(suggestedRepos(repos, connection, defaults)))
  const [busy, setBusy] = useState(false)
  const nameOf = (id: string | undefined) => integrations.connections.find((c) => c.id === id)?.name
  const current = (repo: (typeof repos)[number]) => {
    const choice = repo.integrations?.services?.[connection.service]
    if (choice === 'off') return t('integrations.repo.off')
    if (choice) return nameOf(choice) ?? t('integrations.repo.removed')
    const d = nameOf(defaults[connection.service])
    return d ? t('integrations.repo.defaultIs', { name: d }) : t('integrations.repo.defaultNone')
  }
  // Grouped by GitHub owner, most-used owners first, so "everything under appsmithorg" is one glance.
  const groups = useMemo(() => {
    const map = new Map<string, typeof repos>()
    for (const r of repos) {
      const owner = remoteOwner(r.remoteUrl) ?? ''
      map.set(owner, [...(map.get(owner) ?? []), r])
    }
    return [...map.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : b[1].length - a[1].length))
  }, [repos])
  const changes = repos.filter((r) => ticked.has(r.id) !== (r.integrations?.services?.[connection.service] === connection.id)).length
  const apply = async () => {
    setBusy(true)
    const ok = await attempt(async () => { await api.applyConnectionToRepos(connection.id, [...ticked]); return true })
    setBusy(false)
    if (ok !== undefined) {
      flashSaved()
      showToast(t('integrations.useIn.done', { name: connection.name, count: ticked.size }))
      onClose()
    }
  }
  const toggle = (id: string) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <Dialog
      title={t('integrations.useIn.title', { name: connection.name })}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <span className="set-help int-encrypted">{t('integrations.useIn.nextTurn')}</span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !changes} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void apply()}>
            {t('integrations.useIn.apply', { count: changes })}
          </Button>
        </>
      }
    >
      <p className="set-help">{t('integrations.useIn.help')}</p>
      <div className="int-repo-list">
        {groups.map(([owner, list]) => (
          <div key={owner || '-'} className="int-repo-group">
            <div className="int-repo-owner">{owner ? t('integrations.useIn.under', { owner }) : t('integrations.useIn.other')}</div>
            {list.map((r) => {
              const on = ticked.has(r.id)
              const chosen = r.integrations?.services?.[connection.service] === connection.id
              return (
                <div key={r.id} className="int-repo-row">
                  <Checkbox className="int-repo-name" checked={on} onChange={() => toggle(r.id)}>
                    {r.name}
                  </Checkbox>
                  <span className="int-repo-now">{chosen ? t('integrations.useIn.already') : on ? t('integrations.useIn.change', { from: current(r), to: connection.name }) : current(r)}</span>
                </div>
              )
            })}
          </div>
        ))}
        {!repos.length && <p className="muted">{t('integrations.useIn.noRepos')}</p>}
      </div>
    </Dialog>
  )
}

export function RenameDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState(connection.name)
  const save = async () => {
    if (!name.trim()) return
    const r = await attempt(() => api.updateConnection(connection.id, { name: name.trim() }))
    if (r?.ok) {
      flashSaved()
      onClose()
    }
  }
  return (
    <Dialog
      title={t('integrations.rename.title')}
      className="int-modal--small"
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('integrations.add.name')} hideLabel>
        {(c) => <TextInput {...c} className="wide" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />}
      </Field>
    </Dialog>
  )
}

/** Lists what uses the connection first: repositories that chose it lose the service until they pick another. */
export function RemoveDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const t = useT()
  const [impact, setImpact] = useState<{ repos: string[]; isDefault: boolean; rules: number } | null>(null)
  useEffect(() => {
    void api.connectionRemovalImpact(connection.id).then(setImpact, () => setImpact({ repos: [], isDefault: false, rules: 0 }))
  }, [connection.id])
  const remove = async () => {
    if ((await attempt(async () => (await api.removeConnection(connection.id), true))) !== undefined) {
      flashSaved()
      showToast(t('integrations.remove.done', { name: connection.name }))
      onClose()
    }
  }
  return (
    <Dialog
      title={t('integrations.remove.title', { name: connection.name })}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={impact === null} onClick={() => void remove()}>
            {t('integrations.remove.confirm')}
          </Button>
        </>
      }
    >
      {impact === null ? (
        <Spinner label={t('common.loading')} />
      ) : (
        <div className="int-form">
          {impact.repos.length > 0 && (
            <div>
              <p>{t('integrations.remove.repos', { count: impact.repos.length })}</p>
              <ul className="int-impact">
                {impact.repos.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {impact.isDefault && <p>{t('integrations.remove.default')}</p>}
          {impact.rules > 0 && <p>{t('integrations.remove.rules', { count: impact.rules })}</p>}
          {!impact.repos.length && !impact.isDefault && !impact.rules && <p>{t('integrations.remove.unused')}</p>}
          <p className="set-help">{t('integrations.remove.noFallback')}</p>
        </div>
      )}
    </Dialog>
  )
}
