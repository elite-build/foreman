// Building blocks shared by the settings pages. Every control saves as soon
// as it changes; text fields save when they lose focus. The controls themselves
// (Switch, Segmented, Select, Tabs, ...) are the design system's: import them from ui/.
import { Check, MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import type { PlainKey } from '../../../../shared/i18n'
import type { CustomPrompts, RepoPatch, RepoSettingKey, RepoSettings, RepoSettingsPatch, Settings, SettingSource } from '../../../../shared/types'
import { t as tNow, useT } from '../../i18n'
import { api, attempt, openSettingsPage, showToast, useStore } from '../../store'
import { LinkButton, MaskedValue as UiMaskedValue, MenuButton, MenuItem, Switch, TextArea, TextInput, useField, type FieldControlProps, type MaskedValueProps as UiMaskedValueProps } from '../../ui'

// ---- saving ----

const savedListeners = new Set<() => void>()

/** Flash the "Saved" hint in the settings header. */
export function flashSaved(): void {
  for (const listener of savedListeners) listener()
}

export async function saveSettings(patch: Partial<Settings>): Promise<boolean> {
  const saved = await attempt(() => api.updateSettings(patch))
  if (saved) flashSaved()
  return Boolean(saved)
}

export async function saveRepo(id: string, patch: RepoPatch): Promise<boolean> {
  const saved = await attempt(() => api.updateRepo(id, patch))
  if (saved) flashSaved()
  return Boolean(saved)
}

export async function saveRepoSettings(repoId: string, patch: RepoSettingsPatch): Promise<boolean> {
  const saved = await attempt(async () => (await api.updateRepoSettings(repoId, patch), true))
  if (saved) flashSaved()
  return Boolean(saved)
}

export async function resetSettings(keys: (keyof Settings)[]): Promise<boolean> {
  const saved = await attempt(() => api.resetSettings(keys))
  if (saved) flashSaved()
  return Boolean(saved)
}

export function useSettings(): Settings {
  return useStore((s) => s.snapshot!.settings)
}

// ---- repository settings: layered values ----

type RepoValue<K extends RepoSettingKey> = K extends `prompts.${keyof CustomPrompts}` ? string : K extends keyof RepoSettings ? RepoSettings[K] : never

/**
 * One repo setting with its layers: the effective value, where it came from,
 * a setter (writes this Mac's override) and a reset (back to the inherited value).
 */
export function useRepoSetting<K extends RepoSettingKey>(repoId: string, key: K) {
  const resolved = useStore((s) => s.snapshot!.repoSettings[repoId])
  const isPrompt = key.startsWith('prompts.')
  const promptKey = key.slice('prompts.'.length) as keyof CustomPrompts
  const value = (isPrompt ? resolved.values.prompts[promptKey] : resolved.values[key as keyof RepoSettings]) as RepoValue<K>
  const source: SettingSource = resolved.sources[key] ?? 'default'
  const inherited: SettingSource = resolved.inherited[key] ?? 'default'
  const patch = (next: unknown): RepoSettingsPatch => (isPrompt ? { prompts: { [promptKey]: next as string | null } } : { [key]: next })
  return {
    value,
    source,
    inherited,
    sharedFile: resolved.sharedFile,
    set: (next: RepoValue<K>) => saveRepoSettings(repoId, patch(next)),
    reset: () => saveRepoSettings(repoId, patch(null)),
    // Shown next to the row title.
    sourceInfo: repoSourceInfo(repoId, source, inherited, resolved.sharedFile)
  }
}

// Whole sentences per layer, so translators can reorder them.
const OVERRIDING: Record<SettingSource, PlainKey> = {
  local: 'settings.source.overridingLocal',
  shared: 'settings.source.overridingShared',
  user: 'settings.source.overridingUser',
  default: 'settings.source.overridingDefault'
}
const SET_BY: Record<'shared' | 'user', PlainKey> = {
  shared: 'settings.source.setByShared',
  user: 'settings.source.setByUser'
}

/** "Overriding your repo's settings.toml" / "Set by your user settings", or nothing for defaults. */
export function repoSourceInfo(repoId: string, source: SettingSource, inherited: SettingSource, sharedFile?: string): SourceInfo | undefined {
  const open = (layer: SettingSource) =>
    layer === 'shared'
      ? () => void attempt(() => api.openRepoSettingsFile(repoId))
      : layer === 'user'
        ? () => openSettingsPage({ section: 'git' })
        : undefined
  if (source === 'local') {
    if (inherited === 'default') return undefined
    return { text: tNow(OVERRIDING[inherited]), title: inherited === 'shared' ? sharedFile : undefined, onClick: open(inherited) }
  }
  if (source === 'shared' || source === 'user') return { text: tNow(SET_BY[source]), title: source === 'shared' ? sharedFile : undefined, onClick: open(source) }
  return undefined
}

export function SavedHint() {
  const t = useT()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const listener = () => {
      setVisible(true)
      clearTimeout(timer)
      timer = setTimeout(() => setVisible(false), 1600)
    }
    savedListeners.add(listener)
    return () => {
      savedListeners.delete(listener)
      clearTimeout(timer)
    }
  }, [])
  return (
    <span className={`set-saved ${visible ? 'visible' : ''}`} aria-live="polite">
      {visible && (
        <>
          <Check size={12} /> {t('settings.saved')}
        </>
      )}
    </span>
  )
}

// ---- layout ----

export function Page({ title, description, children }: { title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-page">
      <h1>{title}</h1>
      {description && <p className="set-page-desc">{description}</p>}
      {children}
    </div>
  )
}

interface SectionProps {
  title?: string
  description?: ReactNode
  // Skip the bordered card (for content that brings its own cards).
  plain?: boolean
  children: ReactNode
}

export function Section({ title, description, plain, children }: SectionProps) {
  return (
    <section className="set-section">
      {title && <h2>{title}</h2>}
      {description && <p className="set-section-desc">{description}</p>}
      {plain ? children : <div className="set-card">{children}</div>}
    </section>
  )
}

/** Where a value comes from, shown beside a row's title. */
export interface SourceInfo {
  text: string
  title?: string
  onClick?: () => void
}

export interface RowProps {
  label: ReactNode
  help?: ReactNode
  // The control(s). A function receives the field binding (id, aria-describedby): spread it on the control so the row's
  // label and help name it. Plain nodes keep working with `htmlFor`.
  children?: ReactNode | ((control: FieldControlProps) => ReactNode)
  // Put the control under the label, full width (inputs, text areas).
  stacked?: boolean
  disabled?: boolean
  htmlFor?: string
  // Search target: the id of this row's entry in settings/registry.ts.
  id?: string
  source?: SourceInfo
  // Offers "Reset" in the row's ⋯ menu.
  onReset?: () => void
  // Extra line under the help text (e.g. a warning).
  detail?: ReactNode
  // Full-width content under the label and control, inside the row (sub-options).
  below?: ReactNode
}

function RowActions({ onReset }: { onReset: () => void }) {
  const t = useT()
  return (
    <div className="set-row-actions">
      <MenuButton label={t('settings.rowActions')} look="icon" trigger={<MoreHorizontal size={14} aria-hidden />}>
        <MenuItem onSelect={onReset}>{t('common.reset')}</MenuItem>
      </MenuButton>
    </div>
  )
}

/** Row id → DOM id, for search's scroll-to. */
export const rowDomId = (id: string) => `setting-${id}`

export function Row({ label, help, children, stacked, disabled, htmlFor, id, source, onReset, detail, below }: RowProps) {
  const field = useField({ description: Boolean(help) })
  const bound = typeof children === 'function'
  const detailId = `${field.id}-detail`
  // The detail line (often why the row is disabled) is read with the help.
  const describedBy = [field.controlProps['aria-describedby'], detail && detailId].filter(Boolean).join(' ')
  const control: FieldControlProps = { ...field.controlProps, ...(describedBy && { 'aria-describedby': describedBy }) }
  return (
    <div id={id ? rowDomId(id) : undefined} className={`set-row ${stacked ? 'stacked' : ''} ${disabled ? 'disabled' : ''}`}>
      <div className="set-row-text">
        <div className="set-label-line">
          {bound || htmlFor ? (
            <label className="set-label" htmlFor={bound ? field.id : htmlFor}>
              {label}
            </label>
          ) : (
            <div className="set-label">{label}</div>
          )}
          {source &&
            (source.onClick ? (
              <LinkButton size="sm" className="set-source-link" title={source.title} onClick={source.onClick}>
                {source.text}
              </LinkButton>
            ) : (
              <span className="set-source" title={source.title}>
                {source.text}
              </span>
            ))}
          {onReset && <RowActions onReset={onReset} />}
        </div>
        {help && (
          <div className="set-help" {...field.descriptionProps}>
            {help}
          </div>
        )}
        {detail && (
          <div className="set-detail" id={detailId}>
            {detail}
          </div>
        )}
      </div>
      {children && <div className="set-control">{typeof children === 'function' ? children(control) : children}</div>}
      {below && <div className="set-row-below">{below}</div>}
    </div>
  )
}

// ---- controls ----

export function ToggleRow({
  label,
  help,
  checked,
  onChange,
  disabled,
  title,
  ...row
}: Pick<RowProps, 'id' | 'source' | 'onReset' | 'detail' | 'below'> & { label: ReactNode; help?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <Row label={label} help={help} disabled={disabled} {...row}>
      {(control) => <Switch {...control} checked={checked} onChange={onChange} disabled={disabled} title={title} />}
    </Row>
  )
}

/** A toggle bound to a layered repo setting (boolean keys). */
export function RepoToggleRow({
  repoId,
  setting,
  ...props
}: { repoId: string; setting: Extract<RepoSettingKey, 'autoRunAfterSetup' | 'checksAfterTurn' | 'warnBaseMoved' | 'suggestFollowups' | 'spotlightTesting' | 'deleteBranchOnArchive' | 'archiveOnMerge' | 'pushAutoSetupRemote' | 'workInRepoFolder' | 'removeDockerContainers' | 'removeDockerExtras' | 'teachAgents' | 'agentsMayStart'> } & Omit<
  Parameters<typeof ToggleRow>[0],
  'checked' | 'onChange' | 'source' | 'onReset'
>) {
  const s = useRepoSetting(repoId, setting)
  return (
    <ToggleRow
      {...props}
      checked={s.value as boolean}
      onChange={(next) => void s.set(next as never)}
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void s.reset() : undefined}
    />
  )
}

// ---- secrets ----

/**
 * A secret shown masked ("••••••••abcd" when a hint is known): the design system's MaskedValue with Foreman's text. The
 * eye reveals it, clicking the value copies it; edit and remove buttons appear when given. Values are fetched from the
 * main process only when revealed or copied.
 */
export function MaskedValue({ label, ...rest }: Omit<UiMaskedValueProps, 'labels' | 'onCopy'>) {
  const t = useT()
  return (
    <UiMaskedValue
      {...rest}
      label={label}
      labels={{
        copy: t('settings.masked.copy', { label }),
        reveal: t('settings.masked.reveal', { label }),
        hide: t('settings.masked.hide', { label }),
        edit: t('settings.masked.edit', { label }),
        remove: t('settings.masked.remove', { label })
      }}
      onCopy={(ok) => showToast(t(ok ? 'settings.masked.copied' : 'settings.masked.copyFailed', { label }))}
    />
  )
}

// Return false to reject the text and put the saved value back.
type Commit = (next: string) => void | false

/**
 * Local text draft that commits on blur, and on unmount if still edited
 * (closing settings or switching pages mid-edit doesn't lose the text).
 */
export function useDraft(value: string, commit: Commit) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const latest = useRef({ draft, value, commit })
  latest.current = { draft, value, commit }

  // Pick up outside changes unless the user is mid-edit.
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  useEffect(
    () => () => {
      const current = latest.current
      if (current.draft !== current.value) current.commit(current.draft)
    },
    []
  )

  return {
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onFocus: () => {
      focused.current = true
    },
    onBlur: () => {
      focused.current = false
      const current = latest.current
      if (current.draft !== current.value && current.commit(current.draft) === false) setDraft(current.value)
    }
  }
}

interface TextRowProps extends Pick<RowProps, 'id' | 'source' | 'onReset' | 'detail'> {
  label: ReactNode
  help?: ReactNode
  value: string
  onCommit: Commit
  placeholder?: string
  mono?: boolean
  // Full-width input under the label instead of a compact one beside it.
  wide?: boolean
  // Extra controls after the input (e.g. a Choose… button).
  after?: ReactNode
}

export function TextRow({ label, help, value, onCommit, placeholder, mono, wide, after, ...row }: TextRowProps) {
  const draft = useDraft(value, onCommit)
  return (
    <Row label={label} help={help} stacked={wide} {...row}>
      {(control) => (
        <>
          <TextInput
            {...control}
            {...draft}
            mono={mono}
            className={wide ? 'set-field-wide' : undefined}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()}
          />
          {after}
        </>
      )}
    </Row>
  )
}

export function TextAreaRow({
  label,
  help,
  value,
  onCommit,
  placeholder,
  rows = 3,
  mono = true,
  ...row
}: Omit<TextRowProps, 'wide' | 'after'> & { rows?: number }) {
  const draft = useDraft(value, onCommit)
  return (
    <Row label={label} help={help} stacked {...row}>
      {(control) => <TextArea {...control} {...draft} className="set-field-wide" mono={mono} rows={rows} spellCheck={!mono} placeholder={placeholder} />}
    </Row>
  )
}
