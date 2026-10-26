// Repository → Scripts & checks: "When archiving, remove Docker containers started for this
// workspace" (O18). Shows the compose label to add and, from docker ps, the labelled containers
// a chosen workspace has right now. Docker missing or stopped is said plainly, never an error.
import { Box, Check, Copy, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { composeSnippet, DOCKER_LABEL, type DockerListing } from '../../../../shared/docker'
import { formatDateTime } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { api, showToast, useStore } from '../../store'
import { Button, Select, Spinner } from '../../ui'
import { RepoToggleRow } from './controls'

export function DockerCleanupRow({ repoId }: { repoId: string }) {
  const t = useT()
  const on = useStore((s) => s.snapshot!.repoSettings[repoId]?.values.removeDockerContainers)
  return (
    <RepoToggleRow
      repoId={repoId}
      setting="removeDockerContainers"
      id="repo-docker-cleanup"
      label={t('docker.settings.label')}
      help={t('docker.settings.help', { label: `${DOCKER_LABEL}=<id>` })}
      below={on ? <DockerCleanupDetails repoId={repoId} /> : undefined}
    />
  )
}

/** G3 · O18: also remove the containers' anonymous volumes and the networks they leave unused. Off by default; shown with cleanup on. */
export function DockerExtrasRow({ repoId }: { repoId: string }) {
  const t = useT()
  const on = useStore((s) => s.snapshot!.repoSettings[repoId]?.values.removeDockerContainers)
  if (!on) return null
  return <RepoToggleRow repoId={repoId} setting="removeDockerExtras" id="repo-docker-extras" label={t('docker.extras.label')} help={t('docker.extras.help')} />
}

function DockerCleanupDetails({ repoId }: { repoId: string }) {
  const t = useT()
  const allWorkspaces = useStore((s) => s.snapshot!.workspaces)
  const workspaces = allWorkspaces.filter((w) => w.repoId === repoId && w.state !== 'archived')
  const selected = useStore((s) => s.selectedWorkspaceId)
  const [picked, setPicked] = useState<string | null>(null)
  // The chosen workspace, else the current one if it's in this repo, else the first.
  const wsId = (picked && workspaces.some((w) => w.id === picked) ? picked : null) ?? workspaces.find((w) => w.id === selected)?.id ?? workspaces[0]?.id
  const ws = workspaces.find((w) => w.id === wsId)
  const [listing, setListing] = useState<DockerListing | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)
  const snippet = composeSnippet()

  const refresh = useCallback(async () => {
    if (!wsId) return
    setChecking(true)
    try {
      setListing(await api.dockerContainers(wsId))
    } catch (err) {
      setListing({ status: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
    setCheckedAt(new Date())
    setChecking(false)
  }, [wsId])
  useEffect(() => {
    setListing(null)
    void refresh()
  }, [refresh])

  const copy = () =>
    void navigator.clipboard.writeText(snippet).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => showToast(t('docker.settings.copyFailed'), 'error')
    )

  return (
    <div className="docker-cleanup">
      <div>
        <div className="docker-label">
          {t('docker.settings.snippet')} <span className="faint">· {t('docker.settings.snippetHint')}</span>
        </div>
        <div className="docker-code-wrap">
          <pre className="set-code docker-code">{snippet}</pre>
          <Button size="sm" variant="ghost" className="docker-copy" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={copy}>
            {copied ? t('docker.settings.copied') : t('docker.settings.copy')}
          </Button>
        </div>
      </div>
      {!ws ? (
        <p className="faint small">{t('docker.settings.noWorkspaces')}</p>
      ) : (
        <div>
          <div className="docker-label docker-label-row">
            <span>
              {listing?.status === 'ok'
                ? t('docker.settings.found', { count: listing.containers.length, name: ws.name })
                : listing?.status === 'not-running'
                  ? t('docker.settings.notRunning')
                  : listing?.status === 'missing'
                    ? t('docker.settings.missing')
                    : listing?.status === 'error'
                      ? t('docker.settings.error', { detail: listing.detail })
                      : t('docker.settings.checking')}
            </span>
            {workspaces.length > 1 && (
              <Select<string>
                label={t('docker.settings.workspace')}
                width={160}
                value={ws.id}
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                onChange={setPicked}
              />
            )}
          </div>
          <div className="docker-list">
            {listing?.status === 'ok' &&
              listing.containers.map((c) => (
                <div key={c.id} className="docker-row">
                  <Box size={13} />
                  <span className="docker-name">{c.name}</span>
                  <span className="docker-image">{c.image}</span>
                  <span className="docker-status">{c.status}</span>
                </div>
              ))}
            <div className="docker-foot">
              <span>{checkedAt ? t.rich('docker.settings.checked', { cmd: <code key="c">docker ps</code>, time: formatDateTime(checkedAt, t.locale, { timeStyle: 'medium' }) }) : t('docker.settings.checking')}</span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" disabled={checking} icon={checking ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void refresh()}>
                {t('docker.settings.refresh')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
