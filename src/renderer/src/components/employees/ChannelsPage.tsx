// Every channel of an organization on one page (docs/ai-employees.md §15), its archived ones too, which the sidebar
// leaves out: search, a filter (going, closed, archived), New channel (the organization's channel with "@Priya " in
// its box), and per row its state, when it last moved, its files and the ⋯ menu. Ticking rows archives or deletes
// several at once. The organization's own channel is listed first and can't be ticked: every organization keeps it.
import { useEffect, useState } from 'react'
import { timeAgo } from '../../../../shared/i18n/time'
import { isArchived, projectLive, type Project } from '../../../../shared/projects'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, showToast, useStore } from '../../store'
import { ActionRow, Button, Callout, Card, Checkbox, Field, Segmented, Spinner, Status, TextInput } from '../../ui'
import { ChannelMenu, DeleteChannelsDialog } from './ChannelActions'
import { isWorking, useOrgRuns } from './ProjectLive'
import { channelName, orgChannelSlug, projectChannel, projectsPulse, projectStatus } from './projectWords'
import './employees.css'

type Filter = 'all' | 'going' | 'closed' | 'archived'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ChannelsPage({ orgId }: { orgId: string }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees)
  // Read them all again when a listed one moves, or after something done here (an archived one isn't in the snapshot).
  const pulse = useStore((s) => projectsPulse(s.snapshot!.projects?.[orgId]))
  const runs = useOrgRuns(orgId)
  const [round, setRound] = useState(0)
  const reload = () => setRound((n) => n + 1)
  const [all, setAll] = useState<Project[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api.listChannels(orgId).then(
      (list) => {
        if (!live) return
        setAll(list)
        setError('')
        setPicked((was) => new Set([...was].filter((id) => list.some((p) => p.id === id))))
      },
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
  }, [orgId, pulse, round])

  if (!organization) return null
  const pm = roster?.find((e) => e.id === organization.programManagerId)
  const pmName = pm?.name || t('projects.pmDefault')
  const now = Date.now()
  const kind = (p: Project): Exclude<Filter, 'all'> => (p.phase !== 'closed' ? 'going' : isArchived(p, now) ? 'archived' : 'closed')
  const counts = { all: all?.length ?? 0, going: 0, closed: 0, archived: 0 }
  for (const p of all ?? []) counts[kind(p)]++
  const words = query.trim().toLowerCase()
  const shown = (all ?? []).filter((p) => (filter === 'all' || kind(p) === filter) && (!words || `${projectChannel(p)} ${p.title}`.toLowerCase().includes(words)))
  const chosen = (all ?? []).filter((p) => picked.has(p.id))
  const canArchive = chosen.length > 0 && chosen.every((p) => kind(p) === 'closed')
  const pick = (id: string, on: boolean) => setPicked((was) => (on ? new Set([...was, id]) : new Set([...was].filter((x) => x !== id))))
  const archiveChosen = () => {
    setBusy(true)
    void attempt(async () => {
      for (const p of chosen) await api.archiveProject(p.id, true)
      showToast(t('projects.archive.doneMany', { count: chosen.length }))
      setPicked(new Set())
      reload()
    }).finally(() => setBusy(false))
  }
  const orgChannel = channelName(orgChannelSlug(organization.name))

  return (
    <div className="channels-page">
      <div className="team-page-head">
        <div className="project-head-who">
          <h2 className="employee-name">{t('projects.heading')}</h2>
          <span className="employee-faint">{t('projects.all.about', { organization: organization.name })}</span>
        </div>
        {pm && (
          <div className="employee-card-actions">
            <Button variant="primary" onClick={() => openEmployees({ orgId, page: 'channel', mention: Date.now() })}>
              {t('projects.all.new')}
            </Button>
          </div>
        )}
      </div>
      <div className="channels-bar">
        <Field label={t('projects.all.search')} hideLabel className="channels-search">
          {(control) => <TextInput {...control} type="search" placeholder={t('projects.all.search')} value={query} onChange={(e) => setQuery(e.target.value)} />}
        </Field>
        <Segmented
          label={t('projects.all.filter')}
          value={filter}
          onChange={setFilter}
          options={(['all', 'going', 'closed', 'archived'] as const).map((f) => ({ value: f, label: t(`projects.all.filter.${f}`, { count: counts[f] }) }))}
        />
      </div>
      {chosen.length > 0 && (
        <Card className="channels-selection" role="group" aria-label={t('projects.all.selection', { count: chosen.length })}>
          <span className="employee-subheading">{t('projects.all.selection', { count: chosen.length })}</span>
          <span className="channels-selection-end">
            <Button size="sm" onClick={() => setPicked(new Set())}>
              {t('projects.all.clear')}
            </Button>
            {canArchive && (
              <Button size="sm" disabled={busy} onClick={archiveChosen}>
                {t('projects.all.archive', { count: chosen.length })}
              </Button>
            )}
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
              {t('projects.all.delete', { count: chosen.length })}
            </Button>
          </span>
        </Card>
      )}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      {all === null && !error ? (
        <div className="employees-loading" role="status">
          <Spinner size={13} /> <span>{t('common.loading')}</span>
        </div>
      ) : (
        <ul className="channels-list" aria-label={t('projects.listLabel', { organization: organization.name })}>
          {filter === 'all' && !words && (
            <li className="channels-item">
              <span className="channels-check" />
              <ActionRow card className="channels-row" primaryProps={{ className: 'channels-row-main' }} onPress={() => openEmployees({ orgId, page: 'channel' })}>
                <span className="channels-row-name">
                  <span className="employee-subheading">{orgChannel}</span>
                  <span className="employee-faint">{t('projects.all.orgKept')}</span>
                </span>
              </ActionRow>
            </li>
          )}
          {shown.map((p) => {
            const name = projectChannel(p)
            const status = projectStatus(p, t, pmName)
            const archived = kind(p) === 'archived'
            const files = Object.keys(p.artifacts).length
            return (
              <li key={p.id} className="channels-item">
                <Checkbox className="channels-check" aria-label={t('projects.all.pick', { channel: name })} checked={picked.has(p.id)} onChange={(e) => pick(p.id, e.target.checked)} />
                <ActionRow card className="channels-row" primaryProps={{ className: 'channels-row-main', title: p.title }} onPress={() => openEmployees({ orgId, page: 'project', id: p.id })} actions={<ChannelMenu project={p} onChanged={reload} />}>
                  <span className="channels-row-name">
                    <span className="employee-subheading">{name}</span>
                    <span className="employee-faint">{p.title}</span>
                  </span>
                  <span className="channels-row-state">{archived ? <Status tone="off" label={t('projects.all.archived')} /> : <Status tone={status.tone} busy={isWorking(projectLive(p, runs))} label={status.label} />}</span>
                  <span className="channels-row-meta employee-faint">{timeAgo(p.closedAt ?? p.updatedAt, t.locale)}</span>
                  <span className="channels-row-meta employee-faint">{t('projects.all.files', { count: files })}</span>
                </ActionRow>
              </li>
            )
          })}
          {shown.length === 0 && (filter !== 'all' || words) && <li className="team-empty">{t('projects.all.none')}</li>}
        </ul>
      )}
      {deleting && (
        <DeleteChannelsDialog
          projects={chosen}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setPicked(new Set())
            reload()
          }}
        />
      )}
    </div>
  )
}
