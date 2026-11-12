// #130: Settings → Agents → Claude Code, Codex and Cursor: the agent's other accounts ("Claude work" beside the default
// sign-in), each with its own config folder, sign-in, key, binary and launch flags, and the rule for moving a chat from
// one account to another. Main checks and saves every field (saveAgentInstance).
import { FolderOpen, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { catalogAgent, loginCommandLabel } from '../../../../shared/agentCatalog'
import { AGENTS } from '../../../../shared/agents'
import { DEFAULT_MOVE_RULE, INSTANCE_FIELDS, instancesFor, joinArgs, splitArgs, type AgentInstance, type InstanceAgent, type MoveRule } from '../../../../shared/agentInstances'
import type { AgentAuthMode } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, showToast, useStore } from '../../store'
import { Button, Callout, Field, IconButton, Select, Spinner, Status, Tag, TextInput } from '../../ui'
import { AgentDialog } from './AgentDialog'
import { ApiKeyField, AuthCards, authOptions } from './AgentAuth'
import { AgentStatusBlock, statusView, useAgentStatus } from './AgentStatusCard'
import { LoginTerminal } from './LoginTerminal'
import { Row, saveSettings, Section, useSettings } from './controls'

/** The Accounts section: the default account, the others, Add account, and the moving rule. */
export function AgentAccounts({ agent }: { agent: InstanceAgent }) {
  const t = useT()
  const settings = useSettings()
  const accounts = instancesFor(settings.agentInstances, agent)
  // null: closed; 'new': adding one; otherwise the id of the account being edited.
  const [editing, setEditing] = useState<string | null>(null)
  const name = AGENTS[agent].label
  const rule = settings.agentPrefs?.[agent]?.moveChats ?? DEFAULT_MOVE_RULE

  const remove = async (account: AgentInstance) => {
    if (!window.confirm(t('agentAccounts.removeConfirm', { label: account.label }))) return
    try {
      await api.removeAgentInstance(account.id)
      showToast(t('agentAccounts.removed', { label: account.label }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  const setRule = (moveChats: MoveRule) => void saveSettings({ agentPrefs: { ...settings.agentPrefs, [agent]: { ...settings.agentPrefs?.[agent], moveChats } } })

  return (
    <Section title={t('agentAccounts.title')} description={t('agentAccounts.description', { agent: name })}>
      <Row id={`agent-accounts-${agent}`} label={t('agentAccounts.default')} help={t('agentAccounts.defaultHelp')} />
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} onEdit={() => setEditing(account.id)} onRemove={() => void remove(account)} />
      ))}
      <div className="set-pad">
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing('new')}>
          {t('agentAccounts.add')}
        </Button>
      </div>
      {accounts.length > 0 && (
        <Row label={t('agentAccounts.rule.label')} help={t('agentAccounts.rule.help')}>
          {(control) => (
            <Select<MoveRule>
              {...control}
              label={t('agentAccounts.rule.label')}
              width={260}
              value={rule}
              options={[
                { value: 'never', label: t('agentAccounts.rule.never') },
                { value: 'as-text', label: t('agentAccounts.rule.asText') }
              ]}
              onChange={setRule}
            />
          )}
        </Row>
      )}
      {editing && <AccountDialog agent={agent} id={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onCreated={(id) => setEditing(id)} />}
    </Section>
  )
}

/** One account: its name, where it keeps its sign-in, whether it's connected, Edit and Remove. */
function AccountRow({ account, onEdit, onRemove }: { account: AgentInstance; onEdit: () => void; onRemove: () => void }) {
  const t = useT()
  const hint = useStore((s) => s.snapshot!.instanceKeyHints?.[account.id])
  const state = useAgentStatus(account.agent, [account.auth, account.home ?? '', account.path ?? '', hint ?? ''].join('\n'), false, account.id)
  const view = statusView(account.agent, state, account.auth, hint !== undefined, t)
  const where = account.home ?? (INSTANCE_FIELDS[account.agent].homeEnv ? t('agentAccounts.sharedFolder') : t('agentAccounts.keyOnly'))
  return (
    <Row
      label={account.label}
      help={<span className="mono ag-config-path" title={where}>{where}</span>}
      detail={
        <span className="ag-account-facts">
          <Tag>{account.auth === 'apiKey' ? t('agentCatalog.method.apiKey') : t('agentCatalog.method.login')}</Tag>
          {view ? <Status tone={view.connected ? 'ok' : 'error'} label={view.message} /> : <span className="faint small">{t('agentSettings.status.checking')}</span>}
        </span>
      }
    >
      <div className="ag-account-actions">
        <Button size="sm" onClick={onEdit}>
          {t('agentAccounts.edit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('agentAccounts.remove')}
        </Button>
      </div>
    </Row>
  )
}

interface Draft {
  label: string
  auth: AgentAuthMode
  home: string
  path: string
  args: string
}

const draftOf = (account: AgentInstance | undefined, agent: InstanceAgent): Draft => ({
  label: account?.label ?? '',
  auth: account?.auth ?? (INSTANCE_FIELDS[agent].login ? 'cli' : 'apiKey'),
  home: account?.home ?? '',
  path: account?.path ?? '',
  args: account?.args ? joinArgs(account.args) : ''
})

/**
 * Add or edit an account. The details save together; once the account exists, its sign-in follows: a Login terminal
 * in its config folder, or its own API key.
 */
function AccountDialog({ agent, id, onClose, onCreated }: { agent: InstanceAgent; id?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT()
  const settings = useSettings()
  const account = id ? settings.agentInstances.find((i) => i.id === id) : undefined
  const fields = INSTANCE_FIELDS[agent]
  const name = AGENTS[agent].label
  const [draft, setDraft] = useState<Draft>(() => draftOf(account, agent))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(account, agent))

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy || !draft.label.trim()) return
    setBusy(true)
    setError(null)
    try {
      const saved = await api.saveAgentInstance({
        ...(account ? { id: account.id } : {}),
        agent,
        label: draft.label,
        auth: draft.auth,
        ...(draft.home.trim() ? { home: draft.home.trim() } : {}),
        ...(draft.path.trim() ? { path: draft.path.trim() } : {}),
        ...(fields.args && draft.args.trim() ? { args: splitArgs(draft.args) } : {})
      })
      setDraft(draftOf(saved, agent))
      showToast(t('agentAccounts.saved', { label: saved.label }))
      if (!account) onCreated(saved.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const browse = async (kind: 'directory' | 'file') => {
    const title = kind === 'directory' ? t('agentAccounts.home.pick') : t('agentSettings.path.pickTitle', { name })
    const picked = await attempt(() => api.pickPath({ kind, title, defaultPath: (kind === 'directory' ? draft.home : draft.path) || undefined }))
    if (picked) set(kind === 'directory' ? { home: picked } : { path: picked })
  }

  return (
    <AgentDialog
      title={account ? t('agentAccounts.editTitle', { label: account.label }) : t('agentAccounts.addTitle', { agent: name })}
      description={t('agentAccounts.dialogDesc', { agent: name })}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            {account && !changed ? t('common.done') : t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !draft.label.trim() || (Boolean(account) && !changed)} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {account ? t('common.save') : t('agentAccounts.create')}
          </Button>
        </>
      }
    >
      <form className="ag-account-form" onSubmit={(e) => void save(e)}>
        {error && <Callout tone="error">{error}</Callout>}
        <Field label={t('agentAccounts.label')} description={t('agentAccounts.label.help')}>
          {(control) => <TextInput {...control} autoFocus={!account} maxLength={40} placeholder={t('agentAccounts.label.placeholder')} value={draft.label} onChange={(e) => set({ label: e.target.value })} />}
        </Field>
        {fields.login && <AuthCards value={draft.auth} options={authOptions(agent, t)} onChange={(auth) => set({ auth })} />}
        {fields.homeEnv ? (
          <Field label={t('agentAccounts.home')} description={t('agentAccounts.home.help', { variable: fields.homeEnv, folder: `~/${fields.defaultHome}` })}>
            {(control) => (
              <div className="ag-path-input">
                <TextInput {...control} mono spellCheck={false} autoComplete="off" placeholder={`~/${fields.defaultHome}-work`} value={draft.home} onChange={(e) => set({ home: e.target.value })} />
                <IconButton label={t('agentAccounts.home.pick')} onClick={() => void browse('directory')}>
                  <FolderOpen size={13} />
                </IconButton>
              </div>
            )}
          </Field>
        ) : (
          <Callout tone="info">{t('agentAccounts.keyOnly.help', { agent: name })}</Callout>
        )}
        {fields.homeEnv && !draft.home.trim() && draft.auth === 'cli' && <Callout tone="warn">{t('agentAccounts.home.shared', { agent: name })}</Callout>}
        {fields.path && (
          <Field label={t('agentCatalog.agent.pathLabel', { agent: name })} description={t('agentAccounts.path.help')}>
            {(control) => (
              <div className="ag-path-input">
                <TextInput {...control} mono spellCheck={false} autoComplete="off" placeholder={t('agentAccounts.path.placeholder')} value={draft.path} onChange={(e) => set({ path: e.target.value })} />
                <IconButton label={t('agentCatalog.agent.pathBrowse')} onClick={() => void browse('file')}>
                  <FolderOpen size={13} />
                </IconButton>
              </div>
            )}
          </Field>
        )}
        {fields.args && (
          <Field label={t('agentAccounts.args')} description={t('agentAccounts.args.help')}>
            {(control) => <TextInput {...control} mono spellCheck={false} autoComplete="off" placeholder="--debug" value={draft.args} onChange={(e) => set({ args: e.target.value })} />}
          </Field>
        )}
      </form>
      {account && <AccountSignIn account={account} />}
    </AgentDialog>
  )
}

/** A saved account's sign-in: whether it's connected, and its Login terminal or API key. */
function AccountSignIn({ account }: { account: AgentInstance }) {
  const t = useT()
  const hint = useStore((s) => s.snapshot!.instanceKeyHints?.[account.id])
  const state = useAgentStatus(account.agent, [account.auth, account.home ?? '', account.path ?? '', hint ?? ''].join('\n'), false, account.id)
  const view = statusView(account.agent, state, account.auth, hint !== undefined, t)
  return (
    <div className="ag-account-signin">
      <h3>{t('agentAccounts.signIn', { label: account.label })}</h3>
      <AgentStatusBlock agent={account.agent} state={state} view={view} />
      {account.auth === 'apiKey' ? (
        <ApiKeyField agent={account.agent} instanceId={account.id} label={t('agentCatalog.agent.keyLabel', { agent: catalogAgent(account.agent)?.auth.apiKey?.provider ?? account.agent })} />
      ) : (
        <LoginTerminal
          command={`login-instance:${account.id}`}
          commandLabel={loginCommandLabel(catalogAgent(account.agent)!) ?? ''}
          buttonLabel={view?.connected ? t('agentCatalog.agent.signInAgain') : t('agentCatalog.signin.signIn')}
          primary={view !== null && !view.connected}
          onDone={() => void state.refresh()}
        />
      )}
    </div>
  )
}
