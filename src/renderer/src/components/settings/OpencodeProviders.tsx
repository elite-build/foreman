// OpenCode → Providers: API keys for the providers OpenCode can reach.
import { Check, Eye, EyeOff } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import type { PlainKey } from '../../../../shared/i18n'
import { PROVIDER_KEYS, type ProviderKeyInfo } from '../../../../shared/providers'
import type { AgentKeyName, OpencodeProvider } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, openSettingsPage, showToast, useStore } from '../../store'
import { Button, Card, Disclosure, IconButton, LinkButton, Spinner, TextInput } from '../../ui'
import { SearchField } from '../agents/catalogShared'
import { AgentDialog } from './AgentDialog'
import { ExternalLink } from './AgentAuth'

export type ProviderSource = 'saved' | 'shell' | 'environment' | null

/** Where a provider's key comes from, if anywhere. */
export function providerSource(
  envVar: string,
  providers: OpencodeProvider[] | null,
  agentKeys: Partial<Record<AgentKeyName, string>>
): ProviderSource {
  const state = providers?.find((p) => p.envVar === envVar)
  if (state?.saved) return 'saved'
  // #22: Claude, Codex and Cursor keys are each agent's own now and no longer reach OpenCode.
  void agentKeys
  if (state?.detected) return 'shell'
  return null
}

const SOURCE_TEXT: Record<Exclude<ProviderSource, 'saved' | null>, PlainKey> = {
  shell: 'agentCatalog.keys.foundInShell',
  environment: 'opencode.source.environment'
}

interface ProvidersDialogProps {
  providers: OpencodeProvider[] | null
  onChanged: () => Promise<void>
  onClose: () => void
}

export function ProvidersDialog({ providers, onChanged, onClose }: ProvidersDialogProps) {
  const t = useT()
  const agentKeys = useStore((s) => s.snapshot!.agentKeys)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const q = query.trim().toLowerCase()

  const source = (p: ProviderKeyInfo) => providerSource(p.envVar, providers, agentKeys)
  // Providers configured when the dialog opened go first. The order stays
  // put while it's open, so a row doesn't jump away after saving its key.
  const firstConfigured = useRef<Set<string> | null>(null)
  if (providers && !firstConfigured.current) firstConfigured.current = new Set(PROVIDER_KEYS.filter((p) => source(p)).map((p) => p.envVar))
  const first = firstConfigured.current ?? new Set<string>()
  const matching = PROVIDER_KEYS.filter((p) => !q || p.label.toLowerCase().includes(q) || p.envVar.toLowerCase().includes(q))
  const shown = q || showAll ? matching : matching.filter((p) => p.popular || source(p))
  const sorted = [...shown].sort((a, b) => Number(first.has(b.envVar)) - Number(first.has(a.envVar)))

  return (
    <AgentDialog
      title={t('opencode.providers.label')}
      description={t('opencode.providersDialog.description')}
      onClose={onClose}
      toolbar={<SearchField className="ag-search" autoFocus aria-label={t('agentCatalog.keys.search')} placeholder={t('agentCatalog.keys.search')} value={query} onChange={(e) => setQuery(e.target.value)} />}
      footer={
        <>
          <span className="ag-dialog-note">
            {t.rich('opencode.providersDialog.note', {
              link: (
                <LinkButton
                  key="env"
                  onClick={() => {
                    onClose()
                    openSettingsPage({ section: 'environment' })
                  }}
                >
                  {t('agentSettings.environmentLink')}
                </LinkButton>
              )
            })}
          </span>
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      {!providers && (
        <div className="ag-empty">
          <Spinner size={14} /> {t('opencode.providersDialog.loading')}
        </div>
      )}
      {providers && sorted.length === 0 && <div className="ag-empty">{t('opencode.providersDialog.none')}</div>}
      {providers && sorted.length > 0 && (
        <Card size="sm" className="ag-prov-list">
          {sorted.map((p) => (
            <ProviderRow
              key={p.envVar}
              info={p}
              source={source(p)}
              open={expanded === p.envVar}
              onToggle={() => setExpanded(expanded === p.envVar ? null : p.envVar)}
              onChanged={onChanged}
            />
          ))}
        </Card>
      )}
      {providers && !q && (
        <LinkButton size="sm" className="ag-prov-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? t('opencode.providersDialog.fewer') : t('opencode.providersDialog.all', { count: PROVIDER_KEYS.length })}
        </LinkButton>
      )}
    </AgentDialog>
  )
}

interface ProviderRowProps {
  info: ProviderKeyInfo
  source: ProviderSource
  open: boolean
  onToggle: () => void
  onChanged: () => Promise<void>
}

function ProviderRow({ info, source, open, onToggle, onChanged }: ProviderRowProps) {
  const t = useT()
  const saved = source === 'saved'
  return (
    // The wrapper carries the hairline between providers; the Disclosure inside keeps its own look.
    <div className="ag-prov">
      <Disclosure
        className="ag-prov-disclosure"
        open={open}
        onOpenChange={onToggle}
        label={
          <>
            <span className="ag-prov-label">{info.label}</span>
            {saved && <Check size={13} className="ag-ok" role="img" aria-label={t('agentSettings.key.saved')} />}
            <span className="spacer" />
            {source && source !== 'saved' && <span className="ag-prov-source">{t(SOURCE_TEXT[source])}</span>}
          </>
        }
      >
        {open && <ProviderKeyForm info={info} saved={saved} onChanged={onChanged} />}
      </Disclosure>
    </div>
  )
}

function ProviderKeyForm({ info, saved, onChanged }: { info: ProviderKeyInfo; saved: boolean; onChanged: () => Promise<void> }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)

  const run = async (kind: 'save' | 'remove', next: string | null) => {
    setBusy(kind)
    try {
      await api.setProviderKey(info.envVar, next)
      setValue('')
      showToast(kind === 'save' ? t('agentSettings.key.saved') : t('agentSettings.key.removed'))
      await onChanged()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      showToast(kind === 'save' ? t('opencode.key.saveFailed', { provider: info.label, error }) : t('opencode.key.removeFailed', { provider: info.label, error }))
    } finally {
      setBusy(null)
    }
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const key = value.trim()
    if (key && !busy) void run('save', key)
  }

  return (
    <div className="ag-prov-body">
      <form className="ag-key-form" onSubmit={submit}>
        <div className="ag-secret">
          <TextInput
            type={visible ? 'text' : 'password'}
            mono
            aria-label={t('agentCatalog.agent.keyLabel', { agent: info.label })}
            placeholder={saved ? t('opencode.key.replace', { envVar: info.envVar }) : info.envVar}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <IconButton label={visible ? t('opencode.key.hide') : t('opencode.key.reveal')} onClick={() => setVisible(!visible)}>
            {visible ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        </div>
        <Button size="sm" variant="primary" icon={busy === 'save' ? <Spinner size={12} /> : undefined} disabled={!value.trim() || busy !== null} onClick={() => submit()}>
          {t('common.save')}
        </Button>
        {saved && (
          <Button size="sm" icon={busy === 'remove' ? <Spinner size={12} /> : undefined} disabled={busy !== null} onClick={() => void run('remove', null)}>
            {t('common.remove')}
          </Button>
        )}
      </form>
      {info.keyUrl && (
        <div className="ag-key-actions">
          <ExternalLink href={info.keyUrl}>{t('opencode.key.get')}</ExternalLink>
        </div>
      )}
    </div>
  )
}
