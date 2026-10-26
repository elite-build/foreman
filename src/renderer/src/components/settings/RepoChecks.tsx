// Repository → Scripts: the checks "Run checks" runs, and Repository → Git: sensitive paths.
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { CheckCommand, Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Button, Field, IconButton, LinkButton, TextArea, TextInput } from '../../ui'
import { repoSourceInfo, Row, saveRepoSettings, useDraft, useRepoSetting } from './controls'
import { Dialog, SubmitHint } from './RepoDialog'

/** A check as stored in this computer's layer. */
function toLocal(check: CheckCommand): CheckCommand {
  return { name: check.name, command: check.command }
}

export function Checks({ repo }: { repo: Repo }) {
  const t = useT()
  const resolved = useStore((s) => s.snapshot!.repoSettings[repo.id])
  const checks = resolved.values.checks
  // undefined: closed; null: adding.
  const [editing, setEditing] = useState<CheckCommand | null | undefined>(undefined)
  return (
    <div>
      <Row id="repo-checks" label={t('repoSettings.checks.label')} help={t('repoSettings.checks.help')}>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing(null)}>
          {t('common.add')}
        </Button>
      </Row>
      <div className="repo-run-list">
        {checks.length === 0 ? (
          <p className="repo-empty">{t('repoSettings.checks.empty')}</p>
        ) : (
          checks.map((check) => {
            const source =
              check.source === 'shared'
                ? repoSourceInfo(repo.id, 'shared', 'default', resolved.sharedFile)
                : check.overrides
                  ? repoSourceInfo(repo.id, 'local', 'shared', resolved.sharedFile)
                  : undefined
            return (
              <div key={check.name} className="repo-run-card">
                <div className="repo-run-text">
                  <div className="repo-run-title">
                    <span className="repo-run-name">{check.name}</span>
                    {source &&
                      (source.onClick ? (
                        <LinkButton size="sm" className="set-source-link" title={source.title} onClick={source.onClick}>
                          {source.text}
                        </LinkButton>
                      ) : (
                        <span className="set-source">{source.text}</span>
                      ))}
                  </div>
                  <code className="repo-run-command" title={check.command}>
                    {check.command.split('\n')[0]}
                  </code>
                </div>
                <Button size="sm" onClick={() => setEditing(check)}>
                  {t('common.edit')}
                </Button>
              </div>
            )
          })
        )}
      </div>
      {editing !== undefined && <CheckDialog repo={repo} check={editing ?? undefined} checks={checks} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function CheckDialog({ repo, check, checks, onClose }: { repo: Repo; check?: CheckCommand; checks: CheckCommand[]; onClose: () => void }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const shared = check?.source === 'shared'
  const override = Boolean(check?.overrides)
  const [name, setName] = useState(check?.name ?? '')
  const [command, setCommand] = useState(check?.command ?? '')
  const [busy, setBusy] = useState(false)
  const cleanName = name.trim().replace(/\s+/g, ' ')
  const nameError = !cleanName ? null : checks.some((c) => c.name === cleanName && c.name !== check?.name) ? t('repoSettings.check.nameTaken', { name: cleanName }) : null
  const valid = Boolean(cleanName) && !nameError && command.trim() !== ''
  const changed = !check || cleanName !== check.name || command !== check.command
  const local = (repo.local.checks ?? []).map(toLocal)

  const write = async (next: CheckCommand[]) => {
    setBusy(true)
    const saved = await saveRepoSettings(repo.id, { checks: next.length ? next : null })
    setBusy(false)
    if (saved) onClose()
  }
  const save = () => {
    if (!valid || !changed || busy) return
    const entry = toLocal({ name: cleanName, command: command.replace(/\s+$/, '') })
    const next = local.filter((c) => c.name !== check?.name && c.name !== cleanName)
    const at = local.findIndex((c) => c.name === check?.name)
    if (at >= 0) next.splice(Math.min(at, next.length), 0, entry)
    else next.push(entry)
    void write(next)
  }
  const removeLocal = () => {
    if (check && !busy) void write(local.filter((c) => c.name !== check.name))
  }
  return (
    <Dialog
      title={check ? t('repoSettings.check.editTitle') : t('repoSettings.check.addTitle')}
      onClose={onClose}
      onSubmit={save}
      width={520}
      footer={
        <>
          {check && !shared && override && (
            <Button size="sm" title={t('repoSettings.resetToShared')} icon={<RotateCcw size={13} />} disabled={busy} onClick={removeLocal}>
              {t('common.reset')}
            </Button>
          )}
          {check && !shared && !override && (
            <IconButton tone="danger" label={t('repoSettings.check.delete')} disabled={busy} onClick={removeLocal}>
              <Trash2 size={14} />
            </IconButton>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid || !changed || busy} onClick={save}>
            {t('common.save')} <SubmitHint platform={platform} />
          </Button>
        </>
      }
    >
      <Field label={t('repoSettings.field.name')} error={nameError}>
        {(control) => (
          <TextInput
            {...control}
            className="repo-field-input"
            placeholder="test"
            autoFocus={!check}
            // Overrides are matched by name.
            disabled={shared || override}
            title={shared || override ? t('repoSettings.definedInShared') : undefined}
            spellCheck={false}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('setupSteps.command')} description={t('repoSettings.check.commandHelp')}>
        {(control) => (
          <TextArea
            {...control}
            className="repo-script repo-field-input"
            mono
            autoFocus={Boolean(check)}
            rows={Math.min(10, Math.max(3, command.split('\n').length + 1))}
            spellCheck={false}
            placeholder="npm test"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        )}
      </Field>
      {shared && !override && <p className="repo-field-help">{t('repoSettings.sharedSaveNote')}</p>}
    </Dialog>
  )
}

export const SENSITIVE_SUGGESTIONS = ['**/migrations/**', 'package-lock.json', '.env*']

const toPatterns = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

export function SensitivePathsRow({ repo }: { repo: Repo }) {
  const t = useT()
  const s = useRepoSetting(repo.id, 'sensitivePaths')
  const text = s.value.join('\n')
  const draft = useDraft(text, (next) => {
    const patterns = toPatterns(next)
    if (patterns.join('\n') === text) return false
    // Clearing a list nothing else sets just removes this computer's copy.
    void (patterns.length || s.inherited !== 'default' ? s.set(patterns) : s.reset())
  })
  const current = toPatterns(draft.value)
  const missing = SENSITIVE_SUGGESTIONS.filter((p) => !current.includes(p))
  return (
    <Row
      id="sensitive-paths"
      label={t('repoSettings.sensitive.label')}
      stacked
      help={t('repoSettings.sensitive.help')}
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void s.reset() : undefined}
    >
      {(control) => (
        <>
          <TextArea
            {...control}
            {...draft}
            className="set-field-wide repo-script"
            mono
            rows={Math.min(10, Math.max(3, draft.value.split('\n').length + 1))}
            spellCheck={false}
            placeholder={t('repoSettings.sensitive.placeholder')}
          />
          {missing.length > 0 && (
            <p className="repo-field-help">
              {t('repoSettings.sensitive.suggested')}{' '}
              {missing.map((pattern) => (
                <LinkButton key={pattern} size="sm" mono onClick={() => void s.set([...s.value, pattern])}>
                  {pattern}
                </LinkButton>
              ))}
            </p>
          )}
        </>
      )}
    </Row>
  )
}
