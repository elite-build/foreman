// Export… and Import…: moving one workspace between machines as a .foreman file.
// Export is a backup (encrypted) or a share of chats you reviewed. Import stages the
// file in quarantine, previews it, and creates a history-only workspace; activating
// it is a separate step.
import { useEffect, useId, useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { formatDateTime } from '../../../shared/i18n/time'
import { importLabel, NATIVE_RESUME_NOTE, TAB_MODE_LABEL, type ExportInfo, type ExportMode, type ImportPreview, type TabMode } from '../../../shared/portable'
import { bundleSummary } from '../../../shared/worktreeBundle'
import { useT } from '../i18n'
import { api, attempt, closePortDialog, selectWorkspace, showToast, useStore } from '../store'
import { Button, Callout, Checkbox, Dialog, Field, Segmented, Select, TextInput } from '../ui'

export function ExportDialog({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const [info, setInfo] = useState<ExportInfo | null>(null)
  const [mode, setMode] = useState<ExportMode>('backup')
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const [toolOutput, setToolOutput] = useState(false)
  const [attachments, setAttachments] = useState(true)
  const [comments, setComments] = useState(true)
  // Branch + uncommitted work: on in Backup, off in Selected share.
  const [bundleShare, setBundleShare] = useState(false)
  const [bundleBackup, setBundleBackup] = useState(true)
  const [copyFiles, setCopyFiles] = useState(false)
  const [transcripts, setTranscripts] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void attempt(() => api.exportInfo(workspaceId)).then((next) => {
      if (!next) return
      setInfo(next)
      setChosen(Object.fromEntries(next.chats.map((c) => [c.id, !c.closed])))
    })
  }, [workspaceId])
  if (!ws) return null

  const picked = info?.chats.filter((c) => chosen[c.id]) ?? []
  const mismatch = mode === 'backup' && Boolean(again) && passphrase !== again
  const ready = mode === 'backup' ? passphrase.length >= 8 && passphrase === again : picked.length > 0

  const run = async () => {
    setError('')
    const outPath = await api.pickPath({ title: t('portDialogs.export.saveTitle'), kind: 'save', defaultPath: `${ws.name}.foreman` })
    if (!outPath) return
    setBusy(true)
    try {
      const done = await api.exportWorkspace(workspaceId, {
        mode,
        passphrase: mode === 'backup' ? passphrase : undefined,
        sessionIds: mode === 'share' ? picked.map((c) => c.id) : undefined,
        includeToolOutput: toolOutput,
        includeAttachments: attachments,
        includeComments: comments,
        includeWorktree: info?.worktree.available ? (mode === 'backup' ? bundleBackup : bundleShare) : false,
        includeCopyFiles: copyFiles,
        includeTranscripts: transcripts,
        outPath
      })
      const extra = [done.worktree?.message, done.transcriptsSkipped.length ? t('portDialogs.export.noTranscript', { chats: done.transcriptsSkipped.map((x) => `${x.title} (${x.reason})`).join(', ') }) : ''].filter(Boolean).join(' ')
      showToast(`${t('portDialogs.export.done', { name: ws.name, path: done.path })}${extra ? ` ${extra}` : ''}`)
      closePortDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('portDialogs.export.title', { name: ws.name })}
      onClose={closePortDialog}
      size="lg"
      className="dlg port-dialog"
      footer={
        <>
          <span className="faint small dlg-start">
            <code>
              foreman export {ws.name}
              {mode === 'share' ? ' --share' : ''}
            </code>
          </span>
          <Button onClick={closePortDialog}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void run()}>
            {t('portDialogs.export.go', { file: `${ws.name}.foreman` })}
          </Button>
        </>
      }
    >
      <Segmented
        plain
        small
        className="port-seg"
        label={t('portDialogs.export.kind')}
        value={mode}
        options={[
          { value: 'backup', label: t('portDialogs.export.backup') },
          { value: 'share', label: t('portDialogs.export.share') }
        ]}
        onChange={setMode}
      />
      {mode === 'backup' ? (
        <>
          <p className="muted small">{t('portDialogs.export.backupHelp')}</p>
          <Field label={t('portDialogs.export.passphrase')}>
            {(control) => <TextInput {...control} className="dlg-fill" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={t('portDialogs.export.passphrasePlaceholder')} autoFocus />}
          </Field>
          <Field label={t('portDialogs.export.again')} error={mismatch ? t('portDialogs.export.mismatch') : undefined}>
            {(control) => <TextInput {...control} className="dlg-fill" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />}
          </Field>
        </>
      ) : (
        <>
          <p className="muted small">{t('portDialogs.export.shareHelp')}</p>
          <div className="port-chats" role="group" aria-label={t('portDialogs.export.chats')}>
            {info?.chats.map((c) => (
              <Checkbox key={c.id} className="port-chat" checked={Boolean(chosen[c.id])} onChange={(e) => setChosen({ ...chosen, [c.id]: e.target.checked })}>
                <span className="port-chat-title">{c.title}</span>{' '}
                <span className="faint small">
                  {c.agent} · {t('portDialogs.chat.messages', { count: c.messages })} · {t('portDialogs.chat.toolCalls', { count: c.toolCalls })}
                  {c.attachments ? ` · ${t('portDialogs.chat.files', { count: c.attachments })}` : ''}
                  {c.closed ? ` · ${t('portDialogs.chat.closed')}` : ''}
                </span>
              </Checkbox>
            ))}
          </div>
          <Checkbox checked={toolOutput} onChange={(e) => setToolOutput(e.target.checked)}>
            {t('portDialogs.export.toolOutput')}
          </Checkbox>
          <Checkbox checked={transcripts} onChange={(e) => setTranscripts(e.target.checked)}>
            {t('portDialogs.export.transcripts')}
          </Checkbox>
          <Checkbox checked={attachments} onChange={(e) => setAttachments(e.target.checked)}>
            {t('portDialogs.export.attachments')}
          </Checkbox>
          <Checkbox checked={comments} onChange={(e) => setComments(e.target.checked)}>
            {info ? t('portDialogs.export.commentsCount', { count: info.comments }) : t('portDialogs.export.comments')}
          </Checkbox>
        </>
      )}
      {info && (
        <div className="port-bundle">
          <Checkbox
            disabled={!info.worktree.available}
            checked={info.worktree.available && (mode === 'backup' ? bundleBackup : bundleShare)}
            onChange={(e) => (mode === 'backup' ? setBundleBackup(e.target.checked) : setBundleShare(e.target.checked))}
          >
            {t('portDialogs.export.bundle')}
          </Checkbox>
          {!info.worktree.available ? (
            <small className="faint">{info.worktree.reason}</small>
          ) : (
            (mode === 'backup' ? bundleBackup : bundleShare) && (
              <>
                <small className="faint">{t('portDialogs.export.bundleHelp')}</small>
                {info.worktree.copyFiles > 0 && (
                  <Checkbox checked={copyFiles} onChange={(e) => setCopyFiles(e.target.checked)}>
                    {t('portDialogs.export.copyFiles', { count: info.worktree.copyFiles })}
                  </Checkbox>
                )}
              </>
            )
          )}
        </div>
      )}
      <p className="faint small">
        {info?.variables ? `${t('portDialogs.export.variables', { count: info.variables })} ` : ''}
        {t('portDialogs.export.notExported')}
      </p>
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
    </Dialog>
  )
}

const TAB_MODES: TabMode[] = ['history', 'fresh']

export function ImportDialog() {
  const t = useT()
  const uid = useId()
  const snapshot = useStore((s) => s.snapshot!)
  const [file, setFile] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [needsPassphrase, setNeedsPassphrase] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [repoId, setRepoId] = useState('')
  const [asCopy, setAsCopy] = useState(false)
  const [tabs, setTabs] = useState<Record<string, TabMode>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const staged = useRef<string | null>(null)

  // Leaving the dialog drops the quarantine folder, imported or not.
  useEffect(
    () => () => {
      if (staged.current) void api.discardImport(staged.current).catch(() => undefined)
    },
    []
  )

  const stage = async (path: string, pass?: string) => {
    setError('')
    setBusy(true)
    try {
      if (staged.current) await api.discardImport(staged.current).catch(() => undefined)
      staged.current = null
      const result = await api.stageImport(path, pass)
      if (result.kind === 'needs-passphrase') {
        setNeedsPassphrase(true)
        return
      }
      setNeedsPassphrase(false)
      staged.current = result.preview.stageId
      setPreview(result.preview)
      setRepoId('')
      setAsCopy(false)
      setTabs({})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    const picked = await api.pickPath({ title: t('portDialogs.import.pickTitle'), kind: 'file' })
    if (!picked) return
    setFile(picked)
    setPassphrase('')
    setPreview(null)
    await stage(picked)
  }

  const run = async () => {
    if (!preview || !repoId) return
    setBusy(true)
    try {
      const ws = await api.importStaged(preview.stageId, { repoId, asCopy, tabs })
      staged.current = null
      showToast(t('portDialogs.import.done', { name: ws.name }))
      closePortDialog()
      selectWorkspace(ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const option = preview?.repos.find((o) => o.repoId === repoId)
  const blocked = Boolean(preview?.duplicate) && !asCopy
  const errorNote = error && (
    <Callout tone="error" role="alert">
      {error}
    </Callout>
  )

  return (
    <Dialog
      title={preview ? t('portDialogs.import.title', { name: preview.workspace.name }) : t('portDialogs.import.titleEmpty')}
      onClose={closePortDialog}
      size="lg"
      className="dlg port-dialog"
      headerExtra={preview ? <span className="faint small">{t('portDialogs.import.quarantined')}</span> : undefined}
      footer={
        !preview ? (
          <>
            <span className="faint small dlg-start">
              <code>foreman import file.foreman</code>
            </span>
            <Button onClick={closePortDialog}>{t('common.cancel')}</Button>
            {needsPassphrase ? (
              <Button variant="primary" disabled={!passphrase || busy} onClick={() => void stage(file, passphrase)}>
                {t('common.open')}
              </Button>
            ) : (
              <Button variant="primary" icon={<FileUp size={13} />} disabled={busy} onClick={() => void choose()}>
                {t('portDialogs.import.chooseFile')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={closePortDialog}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!repoId || blocked || busy} onClick={() => void run()} title={t('portDialogs.import.goTitle')}>
              {importLabel(preview.tabs.map((tab) => tabs[tab.sessionId] ?? 'history'), t)}
            </Button>
          </>
        )
      }
    >
      {!preview && (
        <>
          <p className="muted small">{t.rich('portDialogs.import.help', { file: <code>.foreman</code> })}</p>
          {needsPassphrase && (
            <Field label={t('portDialogs.import.passphrase')}>
              {(control) => (
                <TextInput
                  {...control}
                  className="dlg-fill"
                  type="password"
                  value={passphrase}
                  autoFocus
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && passphrase && void stage(file, passphrase)}
                />
              )}
            </Field>
          )}
          {errorNote}
        </>
      )}
      {preview && (
        <>
          <Callout tone="ok" role="status">
            {t.rich(preview.mode === 'share' ? 'portDialogs.import.verifiedShare' : 'portDialogs.import.verifiedBackup', { version: preview.version, machine: <b>{preview.sourceMachine}</b>, date: formatDateTime(preview.exportedAt, t.locale) })}
          </Callout>
          {preview.duplicate && (
            <Callout
              tone="warn"
              actions={
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      closePortDialog()
                      selectWorkspace(preview.duplicate!.workspaceId)
                    }}
                  >
                    {t('portDialogs.import.openExisting')}
                  </Button>
                  <Checkbox checked={asCopy} onChange={(e) => setAsCopy(e.target.checked)}>
                    {t('portDialogs.import.asCopy')}
                  </Checkbox>
                </>
              }
            >
              {t.rich('portDialogs.import.duplicate', { name: <b>{preview.duplicate.name}</b> })}
            </Callout>
          )}

          <Field label={t('portDialogs.import.repository')} description={t('portDialogs.import.youConfirm', { repo: `${preview.repo.name}${preview.repo.remoteUrl ? ` · ${preview.repo.remoteUrl}` : ''}` })}>
            {(control) => (
              <Select
                {...control}
                className="dlg-fill"
                value={repoId}
                onChange={setRepoId}
                options={[
                  { value: '', label: t('portDialogs.import.chooseRepo') },
                  ...snapshot.repos.map((r) => {
                    const o = preview.repos.find((x) => x.repoId === r.id)
                    return {
                      value: r.id,
                      label: o?.reasons.length
                        ? t('portDialogs.import.suggested', { name: r.name, why: o.reasons.length > 1 ? t('portDialogs.import.reason.both') : o.reasons[0] === 'remote' ? t('portDialogs.import.reason.remote') : t('portDialogs.import.reason.rootCommit') })
                        : r.name
                    }
                  })
                ]}
              />
            )}
          </Field>
          {preview.worktree && (
            <div className="muted small">
              <p>{t('portDialogs.import.carries', { summary: bundleSummary(preview.worktree, t) })}</p>
              {preview.worktree.notes.map((n, i) => (
                <p key={i} className="faint">
                  {n.text}
                </p>
              ))}
              {option?.bundle && !option.bundle.ok && <p className="error-text">{option.bundle.error}</p>}
            </div>
          )}
          {option && (
            <p className="muted small">
              {preview.worktree
                ? option.bundle?.ok === false
                  ? t('portDialogs.import.bundleUnusable', { repo: option.name })
                  : option.branchExists ? t('portDialogs.import.branchWithFileExists', { branch: preview.workspace.branch }) : t('portDialogs.import.branchWithFile')
                : option.branchExists
                ? t('portDialogs.import.branchExists', { branch: preview.workspace.branch, repo: option.name })
                : t('portDialogs.import.branchMissing', { branch: preview.workspace.branch, repo: option.name })}
            </p>
          )}

          <table className="port-tabs">
            <thead>
              <tr>
                <th>{t('portDialogs.import.tab')}</th>
                <th id={`${uid}-becomes`}>{t('portDialogs.import.becomes')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.tabs.map((tab, i) => (
                <tr key={tab.sessionId}>
                  <td>
                    <span id={`${uid}-tab-${i}`}>{tab.title}</span> <span className="faint small">{tab.agent} · {t('portDialogs.chat.messages', { count: tab.messages })}</span>
                  </td>
                  <td>
                    <Select<TabMode>
                      aria-labelledby={`${uid}-tab-${i} ${uid}-becomes`}
                      value={tabs[tab.sessionId] ?? 'history'}
                      onChange={(mode) => setTabs({ ...tabs, [tab.sessionId]: mode })}
                      options={[
                        ...TAB_MODES.map((m) => ({ value: m, label: t(TAB_MODE_LABEL[m]) })),
                        { value: 'native' as const, disabled: !tab.nativeResume, label: tab.nativeResume ? t(TAB_MODE_LABEL.native) : t('portDialogs.import.nativeOff', { mode: t(TAB_MODE_LABEL.native), note: tab.nativeNote ?? t(NATIVE_RESUME_NOTE) }) }
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small">{t('portDialogs.import.modesHelp')}</p>

          {preview.missingAttachments.length > 0 && <p className="error-text small">{t('portDialogs.import.missingAttachments', { names: preview.missingAttachments.join(', ') })}</p>}
          {preview.variablesToSet > 0 && <p className="small">{t('portDialogs.import.variablesToSet', { count: preview.variablesToSet, names: preview.variables.map((v) => v.name).join(', ') })}</p>}
          {errorNote}
        </>
      )}
    </Dialog>
  )
}
