import { ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { hasNote, noteStanding, NOTE_MAX_CHARS } from '../../../shared/note'
import type { Session, Workspace } from '../../../shared/types'
import { api, attempt, showToast } from '../store'
import { FieldModeToggle, RichField, useFieldMode } from './MarkdownField'
import { useT } from '../i18n'
import { Button, LinkButton, Tag, TextArea } from '../ui'

/**
 * The workspace note: guidance you write once for every tab. Saving only records a revision; it reaches a chat
 * when a new tab includes it or you press "Send updated note to this tab".
 */
export function NoteBar({ workspace, session, readOnly }: { workspace: Workspace; session?: Session; readOnly?: boolean }) {
  const note = workspace.note
  const t = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note?.text ?? '')
  // G4 O15: the note can be edited Rich too (the choice is shared with prompt templates).
  const [fieldMode, setFieldMode] = useFieldMode()
  // A save from elsewhere (or an import) shows up unless this editor has unsaved changes.
  useEffect(() => {
    if (!open) setDraft(note?.text ?? '')
  }, [note?.text, open])

  // Archived and read-only (#13): the note shows as written, if there is one; nothing edits or sends it.
  if (readOnly) {
    if (!hasNote(note)) return null
    return (
      <div className="note-bar collapsed">
        <span className="lbl">
          <Pencil size={12} /> {t('noteBar.label')} <Tag>{t('noteBar.revision', { revision: note!.revision })}</Tag>
        </span>
        <span className="txt">{note!.text}</span>
      </div>
    )
  }

  const standing = session ? noteStanding(note, session) : 'none'
  const save = async () => {
    if (draft === (note?.text ?? '')) return setOpen(false)
    if (await attempt(async () => (await api.saveNote(workspace.id, draft), true))) {
      setOpen(false)
      showToast(t('noteBar.saved'))
    }
  }
  const send = async () => {
    if (session) await attempt(() => api.sendNote(session.id))
  }

  return (
    <div className={`note-bar ${open ? '' : 'collapsed'}`}>
      <LinkButton className="lbl" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? t('noteBar.collapse') : t('noteBar.expand')}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Pencil size={12} /> {t('noteBar.label')} {hasNote(note) && <Tag>{t('noteBar.revision', { revision: note!.revision })}</Tag>}
      </LinkButton>
      {open ? (
        <div className="note-edit">
          {fieldMode === 'rich' ? (
            <RichField
              value={draft}
              saved={note?.text ?? ''}
              label={t('noteBar.label')}
              onChange={(next) => setDraft(next.slice(0, NOTE_MAX_CHARS))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
                else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
              }}
            />
          ) : (
            <TextArea
              className="note-edit-text"
              autoFocus
              aria-label={t('noteBar.label')}
              rows={5}
              maxLength={NOTE_MAX_CHARS}
              value={draft}
              placeholder={t('noteBar.placeholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false)
                else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
              }}
            />
          )}
          <div className="note-actions">
            <Button size="sm" variant="primary" onClick={() => void save()}>
              {t('common.save')}
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <span className="faint small">{t('noteBar.savingSendsNothing')}</span>
            <span className="spacer" />
            <FieldModeToggle value={fieldMode} onChange={setFieldMode} />
          </div>
        </div>
      ) : (
        <span className="txt" onClick={() => setOpen(true)}>
          {hasNote(note) ? note!.text : t('noteBar.empty')}
        </span>
      )}
      {!open && standing === 'stale' && (
        <LinkButton className="note-send" onClick={() => void send()}>
          {t('noteBar.sendUpdated')}
        </LinkButton>
      )}
    </div>
  )
}
