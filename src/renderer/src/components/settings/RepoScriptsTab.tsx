// Repository → Scripts: setup and archive scripts, run scripts, run mode.
import { Eye, EyeOff, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Repo, RunScript } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, Checkbox, Field, IconButton, LinkButton, Segmented, Tag, TextArea, TextInput } from '../../ui'
import { repoSourceInfo, RepoToggleRow, Row, saveRepoSettings, Section, useRepoSetting } from './controls'
import { Dialog, SubmitHint } from './RepoDialog'
import { Checks } from './RepoChecks'
import { lucideIcon } from './RepoIcon'
import { SetupRetryRow, SetupStepsRow } from './RepoSetupSteps'
import { DockerCleanupRow, DockerExtrasRow } from './RepoDockerCleanup'

export function ScriptsTab({ repo }: { repo: Repo }) {
  const t = useT()
  const sharedFile = useStore((s) => s.snapshot!.repoSettings[repo.id]?.sharedFile)
  return (
    <>
      <Section>
        <SetupStepsRow repoId={repo.id} />
        <SetupRetryRow repoId={repo.id} />
        {/* G3 · O19: the archive script as ordered steps too, with the same editor. */}
        <SetupStepsRow repoId={repo.id} kind="archive" />
        <DockerCleanupRow repoId={repo.id} />
        <DockerExtrasRow repoId={repo.id} />
      </Section>
      <Section>
        <RunScripts repo={repo} />
        <RunModeRow repoId={repo.id} />
      </Section>
      <Section>
        <Checks repo={repo} />
        <RepoToggleRow
          repoId={repo.id}
          setting="checksAfterTurn"
          id="repo-checks-after-turn"
          label={t('repoSettings.checksAfterTurn.label')}
          help={t('repoSettings.checksAfterTurn.help')}
        />
      </Section>
      <p className="repo-footnote">
        {t.rich('repoSettings.scripts.share', {
          link: (
            <LinkButton key="link" onClick={() => void attempt(() => api.openRepoSettingsFile(repo.id))}>
              {t('repoSettings.scripts.openFile', { file: settingsFileName(repo.rootPath, sharedFile) })}
            </LinkButton>
          )
        })}
      </p>
    </>
  )
}

/** The committed settings file relative to the repo, for links. */
export function settingsFileName(rootPath: string, sharedFile?: string): string {
  if (sharedFile && sharedFile.startsWith(rootPath)) return sharedFile.slice(rootPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return '.foreman/settings.toml'
}

function RunModeRow({ repoId }: { repoId: string }) {
  const t = useT()
  const s = useRepoSetting(repoId, 'runMode')
  return (
    <Row
      id="run-mode"
      label={t('repoSettings.runMode.label')}
      help={t('repoSettings.runMode.help')}
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void s.reset() : undefined}
    >
      <Segmented<'exclusive' | 'concurrent'>
        label={t('repoSettings.runMode.label')}
        value={s.value}
        options={[
          { value: 'exclusive', label: t('repoSettings.runMode.exclusive'), title: t('repoSettings.runMode.exclusiveTitle') },
          { value: 'concurrent', label: t('repoSettings.runMode.concurrent'), title: t('repoSettings.runMode.concurrentTitle') }
        ]}
        onChange={(mode) => void s.set(mode)}
      />
    </Row>
  )
}

// ---- run scripts ----

export const RUN_SCRIPT_ICONS = ['Play', 'SquareTerminal', 'FlaskConical', 'Bug', 'Server', 'Globe', 'Package', 'Hammer', 'Rocket', 'TestTube'] as const

// A local entry that replaces one from settings.toml (set when settings are resolved, if known).
const overridesShared = (script: RunScript): boolean => (script as RunScript & { overrides?: boolean }).overrides === true

/** A run script as stored in this computer's layer. */
function toLocal(script: RunScript): RunScript {
  const { source: _source, ...rest } = script as RunScript & { overrides?: boolean }
  delete rest.overrides
  if (!rest.default) delete rest.default
  if (!rest.hidden) delete rest.hidden
  if (!rest.previewUrl?.trim()) delete rest.previewUrl
  return rest
}

function uniqueName(scripts: RunScript[]): string {
  const taken = new Set(scripts.map((s) => s.name))
  if (!taken.has('run')) return 'run'
  let n = 2
  while (taken.has(`run ${n}`)) n++
  return `run ${n}`
}

const firstLine = (text: string) => {
  const lines = text.trim().split('\n')
  return lines.length > 1 ? `${lines[0]} …` : lines[0]
}

function RunScripts({ repo }: { repo: Repo }) {
  const t = useT()
  const resolved = useStore((s) => s.snapshot!.repoSettings[repo.id])
  const scripts = resolved.values.runScripts
  // undefined: closed; null: adding.
  const [editing, setEditing] = useState<RunScript | null | undefined>(undefined)

  return (
    <div>
      <Row id="run-scripts" label={t('repoSettings.runScripts.label')} help={t('repoSettings.runScripts.help')}>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing(null)}>
          {t('common.add')}
        </Button>
      </Row>
      <div className="repo-run-list">
        {scripts.length === 0 ? (
          <p className="repo-empty">{t('repoSettings.runScripts.empty')}</p>
        ) : (
          scripts.map((script) => {
            const Icon = lucideIcon(script.icon) ?? Play
            const source =
              script.source === 'shared'
                ? repoSourceInfo(repo.id, 'shared', 'default', resolved.sharedFile)
                : overridesShared(script)
                  ? repoSourceInfo(repo.id, 'local', 'shared', resolved.sharedFile)
                  : undefined
            return (
              <div key={script.name} className={`repo-run-card ${script.hidden ? 'hidden' : ''}`}>
                <span className="repo-run-icon">
                  <Icon size={15} />
                </span>
                <div className="repo-run-text">
                  <div className="repo-run-title">
                    <span className="repo-run-name">{script.name}</span>
                    {script.default && !script.hidden && <Tag tone="accent">{t('common.default')}</Tag>}
                    {script.hidden && <Tag>{t('repoSettings.runScripts.hidden')}</Tag>}
                    {source &&
                      (source.onClick ? (
                        <LinkButton size="sm" className="set-source-link" title={source.title} onClick={source.onClick}>
                          {source.text}
                        </LinkButton>
                      ) : (
                        <span className="set-source">{source.text}</span>
                      ))}
                  </div>
                  <code className="repo-run-command" title={script.command}>
                    {firstLine(script.command)}
                  </code>
                </div>
                <Button size="sm" onClick={() => setEditing(script)}>
                  {t('common.edit')}
                </Button>
              </div>
            )
          })
        )}
      </div>
      {editing !== undefined && <RunScriptDialog repo={repo} script={editing ?? undefined} scripts={scripts} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function RunScriptDialog({ repo, script, scripts, onClose }: { repo: Repo; script?: RunScript; scripts: RunScript[]; onClose: () => void }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const shared = script?.source === 'shared'
  const override = script ? overridesShared(script) : false
  const [icon, setIcon] = useState(script ? (lucideIcon(script.icon) ? normalizeIcon(script.icon) : 'Play') : 'Play')
  const [name, setName] = useState(script?.name ?? uniqueName(scripts))
  const [command, setCommand] = useState(script?.command ?? '')
  const [isDefault, setIsDefault] = useState(script ? Boolean(script.default) : scripts.length === 0)
  const [hidden, setHidden] = useState(Boolean(script?.hidden))
  const [previewUrl, setPreviewUrl] = useState(script?.previewUrl ?? '')
  const [busy, setBusy] = useState(false)

  const cleanName = name.trim().replace(/\s+/g, ' ')
  const nameError = !cleanName
    ? t('repoSettings.runScript.nameEmpty')
    : scripts.some((s) => s.name === cleanName && s.name !== script?.name)
      ? t('repoSettings.runScript.nameTaken', { name: cleanName })
      : null
  const changed =
    !script ||
    icon !== normalizeIcon(script.icon) ||
    cleanName !== script.name ||
    command !== script.command ||
    isDefault !== Boolean(script.default) ||
    hidden !== Boolean(script.hidden) ||
    previewUrl.trim() !== (script.previewUrl ?? '')
  const valid = !nameError && command.trim() !== ''

  // Only this computer's entries are written; shared ones are overridden by name.
  const local = (repo.local.runScripts ?? []).map(toLocal)

  const write = async (next: RunScript[]) => {
    setBusy(true)
    const saved = await saveRepoSettings(repo.id, { runScripts: next.length ? next : null })
    setBusy(false)
    if (saved) onClose()
  }

  const save = () => {
    if (!valid || !changed || busy) return
    const entry: RunScript = toLocal({ name: cleanName, command: command.replace(/\s+$/, ''), icon, default: isDefault, hidden, previewUrl: previewUrl.trim() })
    let next = local.filter((s) => s.name !== script?.name && s.name !== cleanName)
    if (isDefault) next = next.map((s) => toLocal({ ...s, default: false }))
    // Keep an edited entry where it was.
    const at = local.findIndex((s) => s.name === script?.name)
    if (at >= 0) next.splice(Math.min(at, next.length), 0, entry)
    else next.push(entry)
    void write(next)
  }

  const removeLocal = () => {
    if (!script || busy) return
    void write(local.filter((s) => s.name !== script.name))
  }

  const canHide = Boolean(script)
  return (
    <Dialog
      title={script ? t('repoSettings.runScript.editTitle') : t('repoSettings.runScript.addTitle')}
      onClose={onClose}
      onSubmit={save}
      width={520}
      footer={
        <>
          {canHide && (
            <IconButton label={hidden ? t('repoSettings.runScript.show') : t('repoSettings.runScript.hide')} pressed={hidden} onClick={() => setHidden(!hidden)}>
              {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          )}
          {script && !shared && override && (
            <Button size="sm" title={t('repoSettings.resetToShared')} icon={<RotateCcw size={13} />} disabled={busy} onClick={removeLocal}>
              {t('common.reset')}
            </Button>
          )}
          {script && !shared && !override && (
            <IconButton tone="danger" label={t('repoSettings.runScript.delete')} disabled={busy} onClick={removeLocal}>
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
      <div className="repo-field">
        <span className="repo-field-label" aria-hidden="true">
          {t('repoSettings.icon.label')}
        </span>
        <Segmented
          plain
          small
          className="repo-run-icons"
          label={t('repoSettings.icon.label')}
          value={icon}
          onChange={setIcon}
          options={RUN_SCRIPT_ICONS.map((option) => {
            const Icon = lucideIcon(option)!
            return { value: option, title: option, label: <Icon size={15} aria-hidden /> }
          })}
        />
      </div>
      <Field label={t('repoSettings.field.name')} error={nameError}>
        {(control) => (
          <TextInput
            {...control}
            className="repo-field-input"
            placeholder={t('repoSettings.runScript.namePlaceholder')}
            autoFocus={!script}
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
      <Field
        label={t('setupSteps.command')}
        description={t.rich('repoSettings.runScript.commandHelp', { variable: <code key="v">{platform === 'win32' ? '%FOREMAN_PORT%' : '$FOREMAN_PORT'}</code> })}
      >
        {(control) => (
          <TextArea
            {...control}
            className="repo-script repo-field-input"
            mono
            autoFocus={Boolean(script)}
            rows={Math.min(14, Math.max(4, command.split('\n').length + 1))}
            spellCheck={false}
            placeholder={platform === 'win32' ? 'npm run dev -- --port %FOREMAN_PORT%' : 'npm run dev -- --port $FOREMAN_PORT'}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        )}
      </Field>
      <Field
        label={
          <>
            {t('repoSettings.runScript.previewUrl')} <span className="muted">· {t('repoSettings.field.optional')}</span>
          </>
        }
        description={t('repoSettings.runScript.previewHelp')}
      >
        {(control) => (
          <TextInput
            {...control}
            className="repo-field-input"
            mono
            placeholder="http://localhost:$FOREMAN_PORT"
            spellCheck={false}
            autoComplete="off"
            value={previewUrl}
            onChange={(e) => setPreviewUrl(e.target.value)}
          />
        )}
      </Field>
      <Checkbox className="repo-check" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)}>
        {t('common.default')} <span className="muted">· {t('repoSettings.runScript.defaultHint')}</span>
      </Checkbox>
      {shared && !override && <p className="repo-field-help">{t('repoSettings.sharedSaveNote')}</p>}
    </Dialog>
  )
}

/** Stored names may be kebab-case (from settings.toml); the picker uses PascalCase. */
function normalizeIcon(name: string): string {
  return RUN_SCRIPT_ICONS.find((option) => lucideIcon(option) === lucideIcon(name)) ?? name
}
