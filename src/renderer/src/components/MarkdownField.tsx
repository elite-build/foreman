// G4 O15: Rich mode for short Markdown fields (a prompt template's text, the workspace note): the file viewer's
// block-preserving Rich editor on the field's text, and a Rich / Source switch remembered for these fields
// (Source by default, as in the file viewer). Only the blocks you edit are rewritten.
import { useSyncExternalStore, type FocusEvent, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import { Segmented } from '../ui'
import { RichMarkdown, type MarkdownEditorMode } from './RichMarkdown'
import './files.css'

const KEY = 'foreman:markdownFieldMode'
const listeners = new Set<() => void>()

function read(): MarkdownEditorMode {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '""') === 'rich' ? 'rich' : 'source'
  } catch {
    return 'source'
  }
}

let mode: MarkdownEditorMode | null = null

/** The Rich / Source choice for Markdown fields, shared by every field and kept across launches. */
export function useFieldMode(): [MarkdownEditorMode, (next: MarkdownEditorMode) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (mode ??= read())
  )
  const set = (next: MarkdownEditorMode) => {
    mode = next
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Not remembered; it still switches.
    }
    for (const listener of listeners) listener()
  }
  return [value, set]
}

/** The small Rich / Source switch (the file viewer's labels). */
export function FieldModeToggle({ value, onChange }: { value: MarkdownEditorMode; onChange: (next: MarkdownEditorMode) => void }) {
  const t = useT()
  return (
    <Segmented
      small
      className="field-mode"
      label={t('files.md.mode')}
      value={value}
      onChange={onChange}
      options={(['rich', 'source'] as const).map((m) => ({
        value: m,
        label: t(m === 'rich' ? 'files.md.rich' : 'files.md.source'),
        title: t(m === 'rich' ? 'files.md.richTitle' : 'files.md.sourceTitle')
      }))}
    />
  )
}

/**
 * The Rich editor on a field: `value` is the text being edited, `saved` what's stored (for the edited marks).
 * Focus and key events bubble to the caller, so a field's own Esc / ⌘↵ and save-on-blur still work.
 */
export function RichField({
  value,
  saved,
  onChange,
  label,
  onFocus,
  onBlur,
  onKeyDown
}: {
  value: string
  saved: string
  onChange: (next: string) => void
  label: string
  onFocus?: () => void
  onBlur?: (e: FocusEvent<HTMLDivElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div className="rich-field" role="group" aria-label={label} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
      <RichMarkdown draft={value} saved={saved} onChange={onChange} compact />
    </div>
  )
}
