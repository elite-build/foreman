// O21: drag a folder over the window (anywhere but the composer, which attaches files) or drop
// one on Foreman's icon, then confirm to add it as a repository. Nothing is added until Add.
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Folder, FolderPlus, FolderTree, Info } from 'lucide-react'
import type { DroppedFolder } from '../../../shared/types'
import { addDroppedRepositories, api, attempt, bridge, openAddRepoDialog, openMakeRepo, showRepoHome, showToast } from '../store'
import { t as tNow, useT } from '../i18n'
import { Button, Dialog, LinkButton } from '../ui'
import { dropPlan, mightBeFolder, OWN_DROP_SELECTOR, type DropPlan } from './dropPlan'
import './dropFolder.css'

/** The composer takes its own drops (attachments), and so does a terminal pane (G3), so the overlay stays out of their way. */
function inComposer(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(OWN_DROP_SELECTOR))
}

export function DropFolder() {
  const [dragging, setDragging] = useState(false)
  const [plan, setPlan] = useState<DropPlan | null>(null)

  useEffect(() => {
    // Ask main what each path is; a drop of only files gets a message instead of the dialog.
    const confirm = async (paths: string[]) => {
      if (!paths.length) return
      const found = await attempt(() => api.classifyFolders(paths))
      if (!found) return
      const next = dropPlan(found)
      if (!next.shown.length) return showToast(tNow('drop.notFolder', { count: next.skipped }), 'error')
      setPlan(next)
    }
    const takeLaunchFolders = async () => {
      const paths = await attempt(() => api.takeLaunchFolders())
      if (paths) await confirm(paths)
    }
    void takeLaunchFolders()
    const off = bridge.onEvent((event) => {
      if (event.type === 'launch-folders') void takeLaunchFolders()
    })

    // dragover repeats while the pointer is over the window, even holding still, so the
    // overlay goes once it stops (dragged out, Esc, or dropped somewhere else).
    let timer: ReturnType<typeof setTimeout> | null = null
    const hide = () => {
      if (timer) clearTimeout(timer)
      timer = null
      setDragging(false)
    }
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || inComposer(e.target) || !mightBeFolder(e.dataTransfer?.items)) return hide()
      e.preventDefault()
      // Shown as "Link": the folder is used where it is, never copied.
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link'
      setDragging(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(hide, 300)
    }
    const onDragLeave = (e: DragEvent) => {
      // Left the window, not just moved between elements.
      if (!e.relatedTarget) hide()
    }
    const onDrop = (e: DragEvent) => {
      hide()
      if (e.defaultPrevented || inComposer(e.target) || !mightBeFolder(e.dataTransfer?.items)) return
      e.preventDefault()
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => bridge.pathForFile(f)).filter(Boolean)
      void confirm(paths)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      off()
      if (timer) clearTimeout(timer)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <>
      {dragging && <DropOverlay />}
      {plan && <AddDroppedDialog plan={plan} onClose={() => setPlan(null)} />}
    </>
  )
}

/** Full-window while a folder is dragged over. pointer-events: none, so drops still reach what's underneath. */
function DropOverlay() {
  const t = useT()
  return (
    <div className="drop-overlay" role="presentation">
      <div className="drop-zone">
        <div className="drop-icon">
          <FolderPlus size={34} aria-hidden />
        </div>
        <div className="drop-title">{t('drop.overlay.title')}</div>
        <div className="drop-note">{t('drop.overlay.note')}</div>
      </div>
    </div>
  )
}

function AddDroppedDialog({ plan, onClose }: { plan: DropPlan; onClose: () => void }) {
  const t = useT()
  const [adding, setAdding] = useState(false)
  const count = plan.addable.length
  const add = async () => {
    if (adding || !count) return
    setAdding(true)
    const added = await addDroppedRepositories(plan.addable)
    setAdding(false)
    if (!added) return
    if (added > 1) showToast(t('drop.addedMany', { count: added }))
    onClose()
  }
  const close = () => !adding && onClose()
  return (
    <Dialog
      title={t('drop.title', { count: Math.max(1, plan.shown.length) })}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={adding}>
            {t('drop.cancel')}
          </Button>
          <Button variant="primary" autoFocus={count > 0} onClick={() => void add()} disabled={adding || !count}>
            {adding ? t('drop.adding') : t('drop.add', { count: Math.max(1, count) })}
          </Button>
        </>
      }
    >
      <div className="ad-list">
        {plan.shown.map((folder) => (
          <FolderCard key={folder.path} folder={folder} onClose={onClose} />
        ))}
      </div>
      {plan.skipped > 0 && <p className="faint small ad-note">{t('drop.skipped', { count: plan.skipped })}</p>}
      {count > 0 && <p className="faint small ad-note">{t('drop.stays')}</p>}
    </Dialog>
  )
}

function FolderCard({ folder, onClose }: { folder: DroppedFolder; onClose: () => void }) {
  const t = useT()
  const mono = (text: string, key?: string) => <span key={key} className="mono">{text}</span>
  return (
    <div className="ad-item">
      <div className="ad-folder">
        <Folder size={24} className="ad-folder-icon" aria-hidden />
        <div className="ad-folder-text">
          <div className="ad-name">{folder.name}</div>
          <div className="mono ad-path">{folder.path}</div>
        </div>
      </div>
      <div className="ad-facts">
        {folder.kind === 'repo' && (
          <>
            <div className="ad-fact">
              <CircleCheck size={14} className="ok" aria-hidden />
              <span>
                <b>{t('drop.repoFound')}</b>
                <span className="faint">
                  {' · '}
                  {folder.branch ? t.rich('drop.onBranch', { branch: mono(folder.branch, 'branch') }) : t('drop.noBranch')}
                  {' · '}
                  {folder.origin ? t.rich('drop.origin', { origin: mono(folder.origin, 'origin') }) : t('drop.noOrigin')}
                </span>
              </span>
            </div>
            {folder.root && folder.root !== folder.path && (
              <div className="ad-fact">
                <Info size={14} className="faint" aria-hidden />
                <span>{t.rich('drop.topFolder', { root: mono(folder.root, 'root') })}</span>
              </div>
            )}
            {folder.workspacesDir && (
              <div className="ad-fact">
                <FolderTree size={14} className="faint" aria-hidden />
                <span>
                  {t('drop.workspacesGo')}
                  <br />
                  {mono(folder.workspacesDir)}
                </span>
              </div>
            )}
          </>
        )}
        {folder.kind === 'added' && (
          <div className="ad-fact">
            <Info size={14} className="faint" aria-hidden />
            <span>
              <b>{t('drop.added')}</b>
              {folder.repoId && (
                <>
                  {' · '}
                  <LinkButton
                    onClick={() => {
                      onClose()
                      showRepoHome(folder.repoId!)
                    }}
                  >
                    {t('drop.openIt')}
                  </LinkButton>
                </>
              )}
            </span>
          </div>
        )}
        {folder.kind === 'not-git' && (
          <div className="ad-fact">
            <CircleAlert size={14} className="warn" aria-hidden />
            <span>
              <b>{t('drop.notGit')}</b>
              <span className="faint"> · {t('drop.notGitHint')}</span>{' '}
              <LinkButton
                onClick={() => {
                  onClose()
                  openMakeRepo(folder.path)
                }}
              >
                {t('drop.makeRepo')}
              </LinkButton>
              {' · '}
              <LinkButton
                onClick={() => {
                  onClose()
                  openAddRepoDialog('quick-start')
                }}
              >
                {t('drop.openQuickStart')}
              </LinkButton>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
