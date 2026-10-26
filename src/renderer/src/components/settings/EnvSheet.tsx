// Side sheets for Settings → Environment: add, edit and view a variable.
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { ENV_NAME, parseDotenv, type EnvPair } from '../../../../shared/envfile'
import type { PlainKey, TFunction } from '../../../../shared/i18n'
import type { EnvChange, EnvScope, EnvVarRow } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, Callout, Field, IconButton, LinkButton, Sheet as UiSheet, TextArea, TextInput } from '../../ui'
import { flashSaved, MaskedValue } from './controls'
import { SubmitHint, useModEnter } from './RepoDialog'

/** The variables Settings documents, in display order (spec §3.5). */
export const DOCUMENTED_ENV_VARS: { key: string; description: PlainKey }[] = [
  { key: 'HTTP_PROXY', description: 'settings.env.doc.httpProxy' },
  { key: 'HTTPS_PROXY', description: 'settings.env.doc.httpsProxy' },
  { key: 'NO_PROXY', description: 'settings.env.doc.noProxy' },
  { key: 'ANTHROPIC_API_KEY', description: 'settings.env.doc.anthropicApiKey' },
  { key: 'ANTHROPIC_BASE_URL', description: 'settings.env.doc.anthropicBaseUrl' },
  { key: 'ANTHROPIC_AUTH_TOKEN', description: 'settings.env.doc.anthropicAuthToken' },
  { key: 'CLAUDE_CODE_USE_BEDROCK', description: 'settings.env.doc.useBedrock' },
  { key: 'AWS_REGION', description: 'settings.env.doc.awsRegion' },
  { key: 'AWS_PROFILE', description: 'settings.env.doc.awsProfile' },
  { key: 'CLAUDE_CODE_USE_VERTEX', description: 'settings.env.doc.useVertex' },
  { key: 'ANTHROPIC_VERTEX_PROJECT_ID', description: 'settings.env.doc.vertexProject' },
  { key: 'GOOGLE_APPLICATION_CREDENTIALS', description: 'settings.env.doc.googleCredentials' },
  { key: 'CODEX_API_KEY', description: 'settings.env.doc.codexApiKey' },
  { key: 'CURSOR_API_KEY', description: 'settings.env.doc.cursorApiKey' },
  { key: 'OPENAI_BASE_URL', description: 'settings.env.doc.openaiBaseUrl' },
  { key: 'AI_GATEWAY_API_KEY', description: 'settings.env.doc.aiGatewayKey' },
  { key: 'OPENAI_ORG', description: 'settings.env.doc.openaiOrg' },
  { key: 'OPENAI_PROJECT', description: 'settings.env.doc.openaiProject' }
]

export const documentedDescription = (key: string, t: TFunction): string | undefined => {
  const description = DOCUMENTED_ENV_VARS.find((d) => d.key === key)?.description
  return description && t(description)
}

// Set by Foreman for every workspace; a value saved here would be replaced.
const WORKSPACE_VARS = ['WORKSPACE_ID', 'WORKSPACE_NAME', 'WORKSPACE_PATH', 'ROOT_PATH', 'DEFAULT_BRANCH', 'PORT'].flatMap((n) => [
  `FOREMAN_${n}`,
  `SWITCHYARD_${n}`
])

function reservedMessage(keys: string[], t: TFunction): string | null {
  const reserved = keys.filter((k) => WORKSPACE_VARS.includes(k))
  if (!reserved.length) return null
  return t('settings.env.reserved', { count: reserved.length, names: reserved.join(', ') })
}

export const fileName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// ---- sheet frame ----

interface SheetProps {
  title: string
  description?: ReactNode
  onClose: () => void
  onSubmit?: () => void
  footer: ReactNode
  children: ReactNode
}

/** A panel that slides over the settings content from the right (the design system's Sheet, with this page's Mod+Enter). */
function Sheet({ title, description, onClose, onSubmit, footer, children }: SheetProps) {
  const t = useT()
  useModEnter(onSubmit)
  // Inside the settings view it covers the page but not the title bar.
  const container = document.querySelector('.settings-view')
  return (
    <UiSheet title={title} description={description} onClose={onClose} closeLabel={t('common.close')} footer={footer} container={container} layerClassName={container ? 'env-sheet-layer' : undefined}>
      {children}
    </UiSheet>
  )
}

function SaveButtons({ onCancel, onSave, disabled, saving }: { onCancel: () => void; onSave: () => void; disabled?: boolean; saving?: boolean }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  return (
    <>
      <Button onClick={onCancel}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={disabled || saving} onClick={onSave}>
        {saving ? t('common.saving') : t('common.save')} <SubmitHint platform={platform} />
      </Button>
    </>
  )
}

// ---- add ----

interface AddSheetProps {
  scope: EnvScope
  // Names already set in this scope.
  existing: Set<string>
  // Prefilled name, e.g. a documented variable or an inherited one being overridden.
  presetKey?: string
  lockKey?: boolean
  onClose: () => void
  onSaved: () => void
}

export function AddVariableSheet({ scope, existing, presetKey, lockKey, onClose, onSaved }: AddSheetProps) {
  const t = useT()
  const [name, setName] = useState(presetKey ?? '')
  const [value, setValue] = useState('')
  // Several pasted KEY=VALUE pairs replace the two fields with a list.
  const [pairs, setPairs] = useState<EnvPair[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const keys = pairs ? pairs.map((p) => p.key) : [name.trim()]
  const reserved = reservedMessage(keys, t)
  const documented = !pairs && presetKey ? documentedDescription(presetKey, t) : undefined

  const onPaste = (text: string): boolean => {
    if (!text.includes('=')) return false
    const parsed = parseDotenv(text, { multiline: true })
    if (!parsed.pairs.length && !parsed.invalid.length) return false
    const invalid = parsed.invalid.length ? `${t('settings.env.invalidNames', { names: parsed.invalid.join(', ') })} ${t('settings.env.nameRule')}` : null
    // Later lines win, as in an env file.
    const unique = [...new Map(parsed.pairs.map((p) => [p.key, p])).values()]
    if (unique.length === 1 && !invalid) {
      setName(unique[0].key)
      setValue(unique[0].value)
      setPairs(null)
      setError(null)
    } else if (unique.length) {
      setPairs(unique)
      setError(invalid)
    } else {
      setError(invalid)
    }
    return true
  }

  const validate = (): EnvChange[] | string => {
    if (pairs) {
      const taken = pairs.filter((p) => existing.has(p.key)).map((p) => p.key)
      if (taken.length) return t('settings.env.taken', { count: taken.length, names: taken.join(', ') })
      return pairs.map((p) => ({ key: p.key, value: p.value }))
    }
    const key = name.trim()
    if (!key) return t('settings.env.nameRequired')
    if (!ENV_NAME.test(key)) return t('settings.env.nameRule')
    if (existing.has(key)) return t('settings.env.exists')
    return [{ key, value }]
  }

  const save = async () => {
    if (saving || reserved) return
    const changes = validate()
    if (typeof changes === 'string') return setError(changes)
    setSaving(true)
    const saved = await attempt(async () => (await api.setEnvVars(scope, changes), true))
    setSaving(false)
    if (!saved) return
    flashSaved()
    onSaved()
    onClose()
  }

  const several = Boolean(pairs && pairs.length > 1)
  return (
    <Sheet
      title={several ? t('settings.env.addSeveral') : t('settings.env.add')}
      description={
        documented ??
        (pairs ? t('settings.env.detected', { count: pairs.length }) : t('settings.env.pasteHint'))
      }
      onClose={onClose}
      onSubmit={() => void save()}
      footer={<SaveButtons onCancel={onClose} onSave={() => void save()} saving={saving} disabled={Boolean(reserved)} />}
    >
      {pairs ? (
        <div className="env-field">
          <div className="env-field-label">
            <span>{t('settings.env.variables')}</span>
            <LinkButton
              size="sm"
              onClick={() => {
                setPairs(null)
                setError(null)
              }}
            >
              {t('settings.env.clear')}
            </LinkButton>
          </div>
          <div className="env-pasted">
            {pairs.map((p) => (
              <div key={p.key} className={`env-pasted-row ${existing.has(p.key) ? 'taken' : ''}`}>
                <span className="mono env-pasted-key">{p.key}</span>
                <span className="mono env-pasted-value" title={p.value}>
                  {p.value || <span className="faint">{t('settings.env.emptyValue')}</span>}
                </span>
                <IconButton
                  label={t('settings.env.removeVar', { name: p.key })}
                  onClick={() => {
                    const rest = pairs.filter((x) => x.key !== p.key)
                    setError(null)
                    if (rest.length === 1) {
                      setName(rest[0].key)
                      setValue(rest[0].value)
                      setPairs(null)
                    } else setPairs(rest.length ? rest : null)
                  }}
                >
                  <X size={13} />
                </IconButton>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <Field className="env-field" label={t('repoSettings.field.name')}>
            {(control) => (
              <TextInput
                {...control}
                mono
                placeholder="MY_VARIABLE"
                autoFocus={!presetKey}
                disabled={lockKey}
                spellCheck={false}
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setError(null)
                }}
                onPaste={(e) => {
                  if (onPaste(e.clipboardData.getData('text'))) e.preventDefault()
                }}
              />
            )}
          </Field>
          <Field className="env-field" label={t('settings.env.value')}>
            {(control) => <TextArea {...control} mono className="env-value-input" autoFocus={Boolean(presetKey)} spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
        </>
      )}
      {reserved && <Callout tone="warn">{reserved}</Callout>}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
    </Sheet>
  )
}

// ---- edit ----

interface EditSheetProps {
  scope: EnvScope
  row: EnvVarRow
  existing: Set<string>
  onClose: () => void
  onSaved: () => void
}

export function EditVariableSheet({ scope, row, existing, onClose, onSaved }: EditSheetProps) {
  const t = useT()
  const documented = documentedDescription(row.key, t)
  // Values from an env file are overridden, not renamed.
  const fromFile = row.origin === 'file'
  const [name, setName] = useState(row.key)
  const [value, setValue] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    api
      .revealEnvVar(scope, row.key, 'own')
      .then((v) => live && setValue(v ?? ''))
      .catch(() => live && setError(t('settings.env.loadValueFailed')))
    return () => {
      live = false
    }
  }, [scope, row.key])

  const key = name.trim()
  const reserved = key !== row.key ? reservedMessage([key], t) : null

  const save = async () => {
    if (saving || value === null || reserved) return
    if (!key) return setError(t('settings.env.nameRequired'))
    if (!ENV_NAME.test(key)) return setError(t('settings.env.nameRuleFull'))
    if (key !== row.key && existing.has(key)) return setError(t('settings.env.exists'))
    setSaving(true)
    const change: EnvChange = { key, value, previousKey: key !== row.key ? row.key : undefined }
    const saved = await attempt(async () => (await api.setEnvVars(scope, [change]), true))
    setSaving(false)
    if (!saved) return
    flashSaved()
    onSaved()
    onClose()
  }

  return (
    <Sheet
      title={t('settings.env.editTitle')}
      description={
        fromFile
          ? row.file ? t('settings.env.fromFile', { file: row.file }) : t('settings.env.fromFileUnnamed')
          : (documented ?? t('settings.env.nameChars'))
      }
      onClose={onClose}
      onSubmit={() => void save()}
      footer={<SaveButtons onCancel={onClose} onSave={() => void save()} saving={saving} disabled={value === null || Boolean(reserved)} />}
    >
      <Field className="env-field" label={t('repoSettings.field.name')}>
        {(control) => (
          <TextInput
            {...control}
            mono
            placeholder="MY_VARIABLE"
            disabled={Boolean(documented) || fromFile}
            spellCheck={false}
            autoComplete="off"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        )}
      </Field>
      <Field className="env-field" label={t('settings.env.value')}>
        {(control) => (
          <TextArea
            {...control}
            mono
            className="env-value-input"
            autoFocus
            spellCheck={false}
            disabled={value === null}
            placeholder={value === null ? t('common.loading') : t('settings.env.emptyValueHint')}
            value={value ?? ''}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      {reserved && <Callout tone="warn">{reserved}</Callout>}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
    </Sheet>
  )
}

// ---- view (read-only rows on repository pages) ----

interface ViewSheetProps {
  scope: EnvScope
  row: EnvVarRow
  layer: 'shared' | 'inherited'
  onClose: () => void
  // Start adding a repository value with the same name.
  onOverride?: () => void
}

export function ViewVariableSheet({ scope, row, layer, onClose, onOverride }: ViewSheetProps) {
  const t = useT()
  const documented = documentedDescription(row.key, t)
  const from =
    row.origin === 'file'
      ? row.file ? t('settings.env.origin.file', { file: row.file }) : t('settings.env.origin.fileUnnamed')
      : layer === 'shared'
        ? row.file ? t('settings.env.origin.shared', { file: row.file }) : t('settings.env.origin.sharedDefault')
        : t('settings.env.origin.user')
  return (
    <Sheet
      title={t('settings.env.viewTitle')}
      description={documented ?? from}
      onClose={onClose}
      footer={
        <>
          {onOverride && !row.overridden && (
            <Button onClick={onOverride}>{t('settings.env.override')}</Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <Field className="env-field" label={t('repoSettings.field.name')}>
        {(control) => <TextInput {...control} mono readOnly value={row.key} />}
      </Field>
      <div className="env-field">
        <div className="env-field-label">{t('settings.env.value')}</div>
        <MaskedValue label={row.key} reveal={() => api.revealEnvVar(scope, row.key, layer)} />
      </div>
      {documented && <p className="env-note">{from}.</p>}
      <p className="env-note">
        {row.overridden
          ? t('settings.env.overriddenNote')
          : t('settings.env.overrideHint')}
      </p>
    </Sheet>
  )
}
