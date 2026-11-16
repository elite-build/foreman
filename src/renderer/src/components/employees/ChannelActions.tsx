// What the person can do to a project's channel (docs/ai-employees.md §15): rename it (only the name shown changes; its
// folder in the memory repository keeps its slug), archive it once closed or restore it, and delete it (what is going is
// stopped first; its files in the memory repository stay unless asked, its workspace's branch always). One menu for the
// sidebar's rows, the channel's header and the Channels page, and the two dialogs it opens. The organization's own
// channel has none of this: every organization keeps it.
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { channelNameProblem, channelSlug, isArchived, type Project } from '../../../../shared/projects'
import { useT } from '../../i18n'
import { api, attempt, showToast, useStore } from '../../store'
import { Button, Callout, Checkbox, Dialog, Field, MenuButton, MenuItem, MenuSeparator, TextInput } from '../../ui'
import { orgChannelSlug, projectChannel } from './projectWords'

/** The ⋯ menu of one project's channel, with the dialogs it opens. `look` follows where it sits. */
/** `onChanged` runs after a rename, archive, restore or delete, for views that read channels the snapshot doesn't carry. */
export function ChannelMenu({ project, look = 'icon', onChanged, onDeleted }: { project: Project; look?: 'icon' | 'button'; onChanged?: () => void; onDeleted?: () => void }) {
  const t = useT()
  const [open, setOpen] = useState<'rename' | 'delete' | null>(null)
  const name = projectChannel(project)
  const archived = isArchived(project, Date.now())
  const archive = (to: boolean) =>
    void attempt(async () => {
      await api.archiveProject(project.id, to)
      showToast(t(to ? 'projects.archive.done' : 'projects.archive.restored', { channel: name }))
      onChanged?.()
    })
  return (
    <>
      <MenuButton look={look} label={t('projects.menu.label', { channel: name })} trigger={look === 'icon' ? <MoreHorizontal size={14} /> : t('projects.menu.more')} placement="bottom-end" portal>
        <MenuItem icon={<Pencil size={14} />} onSelect={() => setOpen('rename')}>
          {t('projects.menu.rename')}
        </MenuItem>
        {project.phase === 'closed' &&
          (archived ? (
            <MenuItem icon={<ArchiveRestore size={14} />} onSelect={() => archive(false)}>
              {t('projects.menu.restore')}
            </MenuItem>
          ) : (
            <MenuItem icon={<Archive size={14} />} onSelect={() => archive(true)}>
              {t('projects.menu.archive')}
            </MenuItem>
          ))}
        <MenuSeparator />
        <MenuItem variant="danger" icon={<Trash2 size={14} />} onSelect={() => setOpen('delete')}>
          {t('projects.menu.delete')}
        </MenuItem>
      </MenuButton>
      {open === 'rename' && <RenameChannelDialog project={project} onClose={() => setOpen(null)} onRenamed={onChanged} />}
      {open === 'delete' && (
        <DeleteChannelsDialog
          projects={[project]}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            onChanged?.()
            onDeleted?.()
          }}
        />
      )}
    </>
  )
}

/** Rename a project's channel: lowercase letters, numbers and dashes, not another channel's name. */
export function RenameChannelDialog({ project, onClose, onRenamed }: { project: Project; onClose: () => void; onRenamed?: () => void }) {
  const t = useT()
  const orgName = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === project.orgId)?.name)
  const listed = useStore((s) => s.snapshot!.projects?.[project.orgId])
  const taken = [...(listed ?? []).filter((p) => p.id !== project.id).flatMap((p) => [p.slug, channelSlug(p)]), ...(orgName ? [orgChannelSlug(orgName)] : [])]
  const [name, setName] = useState(channelSlug(project))
  const [busy, setBusy] = useState(false)
  const clean = name.trim().replace(/^#/, '')
  const problem = clean === channelSlug(project) ? null : channelNameProblem(clean, taken)
  const error = problem === 'form' ? t('projects.rename.form') : problem === 'long' ? t('projects.rename.long') : problem === 'taken' ? t('projects.rename.taken', { channel: `#${clean}` }) : undefined
  const close = () => !busy && onClose()
  const save = () => {
    if (problem || busy) return
    if (clean === channelSlug(project)) return onClose()
    setBusy(true)
    void attempt(async () => {
      await api.renameProject(project.id, clean)
      showToast(t('projects.rename.done', { channel: `#${clean}` }))
      onClose()
      onRenamed?.()
    }).finally(() => setBusy(false))
  }
  return (
    <Dialog
      title={t('projects.rename.title', { channel: projectChannel(project) })}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={Boolean(problem) || busy} onClick={save}>
            {t('common.rename')}
          </Button>
        </>
      }
    >
      <Field label={t('projects.rename.label')} description={t('projects.rename.help', { folder: project.slug })} error={error}>
        {(control) => (
          <TextInput
            {...control}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              save()
            }}
          />
        )}
      </Field>
    </Dialog>
  )
}

/** Delete one or more projects' channels: those going are stopped first; their files stay unless the box is ticked. */
export function DeleteChannelsDialog({ projects, onClose, onDeleted }: { projects: readonly Project[]; onClose: () => void; onDeleted?: () => void }) {
  const t = useT()
  const memory = useStore((s) => {
    const org = s.snapshot!.organizations?.find((o) => o.id === projects[0]?.orgId)
    return s.snapshot!.repos.find((r) => r.id === org?.memoryRepoId)?.name ?? ''
  })
  const [removeFiles, setRemoveFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const count = projects.length
  const going = projects.filter((p) => p.phase !== 'closed').length
  const close = () => !busy && onClose()
  const remove = () => {
    if (busy) return
    setBusy(true)
    void attempt(async () => {
      for (const p of projects) await api.deleteProject(p.id, { removeFiles })
      showToast(count === 1 ? t('projects.delete.done', { channel: projectChannel(projects[0]) }) : t('projects.delete.doneMany', { count }))
      onClose()
      onDeleted?.()
    }).finally(() => setBusy(false))
  }
  return (
    <Dialog
      title={count === 1 ? t('projects.delete.title', { channel: projectChannel(projects[0]) }) : t('projects.delete.titleMany', { count })}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {going ? t('projects.delete.stopAndDelete') : count === 1 ? t('projects.delete.go') : t('projects.delete.goMany', { count })}
          </Button>
        </>
      }
    >
      <p className="channel-dialog-text">{t('projects.delete.body', { count })}</p>
      {going > 0 && <Callout tone="warn">{count === 1 ? t('projects.delete.going') : t('projects.delete.goingMany', { count: going })}</Callout>}
      <Checkbox checked={removeFiles} onChange={(e) => setRemoveFiles(e.target.checked)}>
        {t('projects.delete.files', { memory, count })}
      </Checkbox>
      <p className="channel-dialog-text employee-faint">{removeFiles ? t('projects.delete.filesGo') : t('projects.delete.filesStay', { memory })}</p>
      <p className="channel-dialog-text employee-faint">{t('projects.delete.branch', { count })}</p>
    </Dialog>
  )
}
