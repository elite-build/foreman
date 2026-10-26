import { X } from 'lucide-react'
import { DEFAULT_PROMPT_TEMPLATES, SETUP_REPO_TEMPLATE_ID } from '../../../shared/promptTemplates'
import { offerSetupHint } from '../../../shared/setupHint'
import type { Session, Workspace } from '../../../shared/types'
import { api, attempt, fillComposer, useStore } from '../store'
import { useT } from '../i18n'
import { Button, Callout, IconButton } from '../ui'

/**
 * One dismissible hint on a repo's first workspace when it has no .foreman/settings.toml. "Set up this repo" only
 * puts the built-in prompt in the composer: nothing is sent, and what the agent proposes arrives as a diff to review.
 */
export function SetupHint({ workspace, session }: { workspace: Workspace; session?: Session }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === workspace.repoId))
  const resolved = useStore((s) => s.snapshot!.repoSettings[workspace.repoId])
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const template = useStore((s) => s.snapshot!.settings.promptTemplates.find((t) => t.id === SETUP_REPO_TEMPLATE_ID)) ?? DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SETUP_REPO_TEMPLATE_ID)!
  if (!offerSetupHint(repo, resolved, workspaces, workspace) || !session) return null
  const dismiss = () => void attempt(() => api.updateRepo(workspace.repoId, { setupHintDismissed: true }))
  return (
    <Callout
      banner
      className="setup-hint"
      actions={
        <>
          <Button
            size="sm"
            onClick={() => {
              fillComposer(workspace.id, session.id, template.body, template.id)
              dismiss()
            }}
          >
            {t('setupHint.action')}
          </Button>
          <IconButton label={t('common.dismiss')} onClick={dismiss}>
            <X size={13} />
          </IconButton>
        </>
      }
    >
      {t.rich('setupHint.text', { repo: <strong key="repo">{repo!.name}</strong>, file: <code key="file">.foreman/settings.toml</code> })}
    </Callout>
  )
}
