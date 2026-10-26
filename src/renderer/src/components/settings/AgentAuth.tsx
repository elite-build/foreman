// Building blocks for the Agents page: the sign-in cards, the API key field,
// the executable path row and the config file row.
import { ArrowUpRight, FolderOpen, KeyRound, Lock, SquareTerminal, X } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { agentAuthMode, catalogAgent } from '../../../../shared/agentCatalog'
import type { AgentAuthMode, AgentKeyName, Settings } from '../../../../shared/types'
import { useAgentCatalog } from '../../agentCatalog'
import { useT } from '../../i18n'
import { api, attempt, getState, openSettingsPage, showToast, useStore } from '../../store'
import { Button, Callout, Field, Glyph, IconButton, LinkButton, RadioCards, Spinner, TextInput } from '../../ui'
import { MaskedValue, Row, saveSettings, useDraft, useSettings } from './controls'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A link that opens in the browser, marked with ↗. `button` and `primary` draw it as a small button instead. */
export function ExternalLink({ href, children, look = 'link' }: { href: string; children: ReactNode; look?: 'link' | 'button' | 'primary' }) {
  const open = () => void attempt(() => api.openExternal(href))
  const arrow = <ArrowUpRight size={12} className="ag-link-arrow" aria-hidden />
  if (look === 'link') {
    return (
      <LinkButton underline className="ag-link" onClick={open}>
        {children}
        {arrow}
      </LinkButton>
    )
  }
  return (
    <Button size="sm" variant={look === 'primary' ? 'primary' : 'default'} onClick={open}>
      {children}
      {arrow}
    </Button>
  )
}

/** A link to another settings page. */
export function EnvironmentLink({ children }: { children?: ReactNode }) {
  const t = useT()
  return <LinkButton underline className="ag-link" onClick={() => openSettingsPage({ section: 'environment' })}>{children ?? t('agentSettings.environmentLink')}</LinkButton>
}

// ---- sign-in mode ----

const AGENT_KEY: Record<'claude' | 'codex', AgentKeyName> = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY' }

/**
 * The agent's sign-in mode, switched optimistically: the new card shows at
 * once and goes back if saving fails. For Claude and Codex, picking API key
 * with no key saved copies one from the user's shell, if there is one; other
 * agents (#22) import only when you click Import.
 */
export function useAuthMode(agent: string) {
  const t = useT()
  const settings = useSettings()
  const saved = agentAuthMode(agent, settings)
  const [pending, setPending] = useState<AgentAuthMode | null>(null)
  const mode = pending ?? saved

  const select = async (next: AgentAuthMode) => {
    if (next === mode) return
    setPending(next)
    const patch: Partial<Settings> =
      agent === 'claude'
        ? { claudeAuth: next }
        : agent === 'codex'
          ? { codexAuth: next }
          : { agentPrefs: { ...settings.agentPrefs, [agent]: { ...settings.agentPrefs?.[agent], auth: next } } }
    const ok = await saveSettings(patch)
    setPending(null)
    if (!ok || next !== 'apiKey' || (agent !== 'claude' && agent !== 'codex')) return
    const key = AGENT_KEY[agent]
    // Never replace a key the user already saved.
    if (getState().snapshot?.agentKeys[key] !== undefined) return
    const imported = await api.importKeyFromShell(key).catch(() => false)
    if (imported) showToast(t('agentCatalog.key.imported', { name: key }))
  }

  return { mode, saved, select }
}

export interface AuthOption {
  value: AgentAuthMode
  label: string
  description: string
}

const AUTH_ICONS: Record<AgentAuthMode, ReactNode> = {
  cli: <SquareTerminal size={16} />,
  apiKey: <KeyRound size={16} />
}

/** Two big cards, Login and API key; the selected one has a check mark. */
export function AuthCards({ value, options, onChange }: { value: AgentAuthMode; options: AuthOption[]; onChange: (mode: AgentAuthMode) => void }) {
  const t = useT()
  return (
    <RadioCards<AgentAuthMode>
      legend={t('agentCatalog.agent.auth')}
      hideLegend
      value={value}
      onChange={onChange}
      options={options.map((option) => ({ value: option.value, label: option.label, description: option.description, icon: AUTH_ICONS[option.value] }))}
    />
  )
}

// ---- API key ----

interface ApiKeyFieldProps {
  // #22: the agent the key belongs to; it's stored for that agent alone.
  agent: string
  label: string
  keyUrl?: string
}

/**
 * An agent's own API key, stored encrypted and passed only to that agent in
 * API-key mode (#22). A saved key is shown masked; its value is fetched only to
 * reveal or copy it. While none is saved, a key of the same name in the shell
 * can be imported; import never replaces a saved key.
 */
export function ApiKeyField({ agent, label, keyUrl }: ApiKeyFieldProps) {
  const t = useT()
  const hint = useStore((s) => s.snapshot!.agentKeyHints?.[agent])
  const saved = hint !== undefined
  const catalog = useAgentCatalog()
  const shellVar = catalog.view?.shellKeys[agent]
  const name = catalogAgent(agent)?.name ?? agent
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    const key = value.trim()
    if (!key || busy) return
    setBusy(true)
    try {
      await api.setAgentKey(agent, key)
      setValue('')
      setEditing(false)
      showToast(t('agentSettings.key.saved'))
    } catch (err) {
      showToast(t('agentSettings.key.saveFailed', { label, error: message(err) }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await api.setAgentKey(agent, null)
      showToast(t('agentSettings.key.removed'))
    } catch (err) {
      showToast(t('agentSettings.key.removeFailed', { label, error: message(err) }))
    }
  }

  const importKey = async () => {
    const imported = await api.importAgentKey(agent).catch(() => false)
    showToast(imported ? t('agentCatalog.key.imported', { name: shellVar ?? label }) : t('agentCatalog.key.notImported'))
  }

  const note = (
    <p className="ag-key-note">
      <Lock size={11} /> {t('agentCatalog.key.note', { agent: name })}
    </p>
  )

  if (saved && !editing) {
    return (
      <div className="ag-key">
        <MaskedValue label={label} hint={hint} reveal={() => api.revealAgentKey(agent)} onEdit={() => setEditing(true)} onRemove={remove} />
        {note}
      </div>
    )
  }

  return (
    <div className="ag-key">
      {!saved && shellVar && (
        <Callout tone="info" actions={<Button size="sm" onClick={() => void importKey()}>{t('agentCatalog.key.import')}</Button>}>
          {t.rich('agentCatalog.key.foundInShell', { name: <code key="v">{shellVar}</code> })}
        </Callout>
      )}
      <Field label={label}>
        {(control) => (
          <form className="ag-key-form" onSubmit={(e) => void save(e)}>
            <TextInput
              {...control}
              type="password"
              mono
              placeholder={label}
              autoComplete="new-password"
              spellCheck={false}
              autoFocus={editing}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && editing) {
                  e.preventDefault()
                  setEditing(false)
                  setValue('')
                }
              }}
            />
            <Button size="sm" variant="primary" icon={busy ? <Spinner size={12} /> : undefined} disabled={!value.trim() || busy} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </form>
        )}
      </Field>
      <div className="ag-key-actions">
        {saved && (
          <LinkButton
            size="sm"
            onClick={() => {
              setEditing(false)
              setValue('')
            }}
          >
            {t('common.cancel')}
          </LinkButton>
        )}
        {keyUrl && <ExternalLink href={keyUrl}>{t('agentSettings.getKey')}</ExternalLink>}
      </div>
      {note}
    </div>
  )
}

// ---- executable path ----

const binaryCache = new Map<string, Promise<string | null>>()

/** Where `which <name>` finds the binary, or null. Asked once per session. */
export function useSystemBinary(name: 'claude' | 'codex' | 'opencode'): string | null {
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let lookup = binaryCache.get(name)
    if (!lookup) {
      lookup = api.whichBinary(name).catch(() => null)
      binaryCache.set(name, lookup)
    }
    void lookup.then((found) => live && setPath(found))
    return () => {
      live = false
    }
  }, [name])
  return path
}

type PathSetting = 'claudeExecutablePath' | 'codexExecutablePath' | 'opencodeExecutablePath'

interface ExecutablePathRowProps {
  setting: PathSetting
  binary: 'claude' | 'codex' | 'opencode'
  // e.g. "Claude Code"
  name: string
  help?: ReactNode
  // Shown when no system binary is found.
  placeholder?: string
  // What an empty value means, for the reset tooltip.
  fallback?: string
}

/** A custom executable for an agent, with browse, reset and "Use system …". */
export function ExecutablePathRow({ setting, binary, name, help, placeholder, fallback }: ExecutablePathRowProps) {
  const t = useT()
  const settings = useSettings()
  const value = settings[setting]
  const system = useSystemBinary(binary)
  const save = (next: string) => void saveSettings({ [setting]: next.trim() } as Partial<Settings>)
  const draft = useDraft(value, save)
  const resetLabel = fallback ? t('agentSettings.path.resetTo', { fallback }) : t('agentSettings.path.resetToBundled', { name })

  const browse = async () => {
    const picked = await attempt(() => api.pickPath({ kind: 'file', title: t('agentSettings.path.pickTitle', { name }), defaultPath: value || system || undefined }))
    if (picked) save(picked)
  }

  return (
    <Row
      label={t('agentCatalog.agent.pathLabel', { agent: name })}
      help={help ?? t('agentSettings.path.help', { name })}
      stacked
      detail={
        value && (
          <span className="ag-warn">
            <Glyph name="warn" /> {t('agentSettings.path.warning')}
          </span>
        )
      }
    >
      {(control) => (
        <div className="ag-path">
          <div className="ag-path-input">
            <TextInput
              {...control}
              {...draft}
              mono
              spellCheck={false}
              autoComplete="off"
              placeholder={system ?? placeholder ?? t('agentSettings.path.bundled')}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            {value && (
              <IconButton label={resetLabel} onClick={() => save('')}>
                <X size={13} />
              </IconButton>
            )}
            <IconButton label={t('agentCatalog.agent.pathBrowse')} onClick={() => void browse()}>
              <FolderOpen size={13} />
            </IconButton>
          </div>
          {system && !value && (
            <Button size="sm" title={system} onClick={() => save(system)}>
              {t('agentSettings.path.useSystem', { name })}
            </Button>
          )}
        </div>
      )}
    </Row>
  )
}

// ---- config file ----

/** A config file in the home folder, e.g. ~/.claude/settings.json, with Open. */
export function ConfigFileRow({ label, segments }: { label: string; segments: string[] }) {
  const t = useT()
  const home = useStore((s) => s.snapshot!.homeDir)
  const platform = useStore((s) => s.snapshot!.platform)
  const sep = platform === 'win32' ? '\\' : '/'
  const full = [home.replace(/[\\/]+$/, ''), ...segments].join(sep)
  return (
    <Row label={label} help={<span className="mono ag-config-path" title={full}>{`~/${segments.join('/')}`}</span>}>
      <Button size="sm" onClick={() => void attempt(() => api.openInEditor(full))}>
        {t('common.open')}
      </Button>
    </Row>
  )
}
