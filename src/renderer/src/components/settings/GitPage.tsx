import { useEffect, useState } from 'react'
import type { BranchPrefixType, Settings } from '../../../../shared/types'
import { api, openSettingsPage } from '../../store'
import { LinkButton, RadioList, Select, TextInput } from '../../ui'
import { Page, resetSettings, Row, saveSettings, Section, ToggleRow, useDraft, useSettings } from './controls'
import { useT } from '../../i18n'
import { ScmAccounts } from './ScmAccounts'

const DEFAULTS = {
  openPrIn: 'github',
  branchPrefixType: 'github',
  autoRenameBranches: true,
  renameWorkspaceWithBranch: true,
  deleteBranchOnArchive: false,
  archiveOnMerge: false,
  automerge: false,
  optionalChecksBlock: false,
  pushAutoSetupRemote: true,
  stackedPrs: false
} satisfies Partial<Settings>

// An example workspace name for the prefix preview.
const EXAMPLE = 'tokyo'

/** Keep a branch prefix to characters git allows in a ref name. */
function sanitizePrefix(value: string): string {
  let next = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\s~^:?*[\\]/g, '')
    .replace(/@\{/g, '')
  while (next.includes('..')) next = next.replace(/\.\./g, '.')
  while (next.includes('//')) next = next.replace(/\/\//g, '/')
  return next.replace(/^[./-]+/, '')
}

/** On blur: end with a separator so the prefix doesn't run into the name. */
function finishPrefix(value: string): string {
  const prefix = sanitizePrefix(value.trim())
  return !prefix || /[/_.-]$/.test(prefix) ? prefix : `${prefix}/`
}

export function GitPage() {
  const settings = useSettings()
  const reset = (key: keyof typeof DEFAULTS) => (settings[key] === DEFAULTS[key] ? undefined : () => void resetSettings([key]))
  const t = useT()

  return (
    <Page title="Git">
      {/* O2: GitHub and GitLab hosts, one row each. */}
      <ScmAccounts />
      <Section title={t('settings.git.section.branches')}>
        <BranchPrefixRow
          onReset={
            settings.branchPrefixType === DEFAULTS.branchPrefixType ? undefined : () => void resetSettings(['branchPrefixType', 'branchPrefix'])
          }
        />
        <ToggleRow
          id="auto-rename-branches"
          label={t('settings.git.autoRename.label')}
          help={t('settings.git.autoRename.help')}
          checked={settings.autoRenameBranches}
          onChange={(autoRenameBranches) => void saveSettings({ autoRenameBranches })}
          onReset={reset('autoRenameBranches')}
        />
        <ToggleRow
          id="rename-workspace-with-branch"
          label={t('settings.git.renameWorkspace.label')}
          help={t('settings.git.renameWorkspace.help')}
          checked={settings.renameWorkspaceWithBranch}
          onChange={(renameWorkspaceWithBranch) => void saveSettings({ renameWorkspaceWithBranch })}
          onReset={reset('renameWorkspaceWithBranch')}
        />
        <ToggleRow
          id="push-auto-setup-remote"
          label={t('settings.git.pushAutoSetupRemote.label')}
          help={t('settings.git.pushAutoSetupRemote.help')}
          checked={settings.pushAutoSetupRemote}
          onChange={(pushAutoSetupRemote) => void saveSettings({ pushAutoSetupRemote })}
          onReset={reset('pushAutoSetupRemote')}
        />
      </Section>

      <Section title={t('settings.git.section.pullRequests')}>
        <Row id="open-pr-in" label={t('settings.git.openPrIn.label')} help={t('settings.git.openPrIn.help')} detail={settings.openPrIn === 'graphite' ? t('settings.git.openPrIn.graphiteNote', { note: t('gitlab.notAvailable') }) : undefined} onReset={reset('openPrIn')}>
          <Select<Settings['openPrIn']>
            label={t('settings.git.openPrIn.label')}
            width={180}
            value={settings.openPrIn}
            options={[
              { value: 'github', label: 'GitHub' },
              { value: 'graphite', label: 'Graphite' }
            ]}
            onChange={(openPrIn) => void saveSettings({ openPrIn })}
          />
        </Row>
        <ToggleRow
          id="automerge"
          label={t('settings.git.automerge.label')}
          help={t('settings.git.automerge.help')}
          checked={settings.automerge}
          onChange={(automerge) => void saveSettings({ automerge })}
          onReset={reset('automerge')}
        />
        <ToggleRow
          id="optional-checks-block"
          label={t('settings.git.optionalChecks.label')}
          help={t('settings.git.optionalChecks.help')}
          checked={settings.optionalChecksBlock}
          onChange={(optionalChecksBlock) => void saveSettings({ optionalChecksBlock })}
          onReset={reset('optionalChecksBlock')}
        />
        <ToggleRow
          id="stacked-prs"
          label={t('settings.git.stackedPrs.label')}
          help={
            <>
              {t.rich('settings.git.stackedPrs.help', { command: <code key="cmd">gh stack</code> })} {t('gitlab.notAvailable')}
            </>
          }
          checked={settings.stackedPrs}
          onChange={(stackedPrs) => void saveSettings({ stackedPrs })}
          onReset={reset('stackedPrs')}
        />
      </Section>

      <Section title={t('settings.git.section.archiving')} description={t('settings.git.section.archivingDesc')}>
        <ToggleRow
          id="delete-branch-on-archive"
          label={t('settings.git.deleteBranchOnArchive.label')}
          help={t('settings.git.deleteBranchOnArchive.help')}
          detail={
            settings.deleteBranchOnArchive ? (
              <span className="set-warn">{t('settings.git.deleteBranchOnArchive.warning')}</span>
            ) : undefined
          }
          checked={settings.deleteBranchOnArchive}
          onChange={(deleteBranchOnArchive) => void saveSettings({ deleteBranchOnArchive })}
          onReset={reset('deleteBranchOnArchive')}
        />
        <ToggleRow
          id="archive-on-merge"
          label={t('settings.git.archiveOnMerge.label')}
          help={t('settings.git.archiveOnMerge.help')}
          checked={settings.archiveOnMerge}
          onChange={(archiveOnMerge) => void saveSettings({ archiveOnMerge })}
          onReset={reset('archiveOnMerge')}
        />
      </Section>
    </Page>
  )
}

function useGithubUser(): { user?: string; checked: boolean } {
  const [state, setState] = useState<{ user?: string; checked: boolean }>({ checked: false })
  useEffect(() => {
    let alive = true
    api.githubStatus().then(
      (status) => {
        if (alive) setState({ user: status.user, checked: true })
      },
      () => {
        if (alive) setState({ checked: true })
      }
    )
    return () => {
      alive = false
    }
  }, [])
  return state
}

function BranchPrefixRow({ onReset }: { onReset?: () => void }) {
  const t = useT()
  const settings = useSettings()
  const github = useGithubUser()
  const type = settings.branchPrefixType
  const draft = useDraft(settings.branchPrefix, (value) => {
    const prefix = finishPrefix(value)
    if (prefix === settings.branchPrefix) return false
    void saveSettings({ branchPrefix: prefix })
  })

  const choose = (next: BranchPrefixType) => {
    if (next !== type) void saveSettings({ branchPrefixType: next })
  }

  return (
    <Row
      id="branch-prefix"
      label={t('settings.git.branchPrefix.label')}
      help={t('settings.git.branchPrefix.help')}
      stacked
      onReset={onReset}
      detail={
        type === 'github' && github.checked && !github.user ? (
          <>
            {t('settings.git.branchPrefix.notSignedIn')}{' '}
            <LinkButton onClick={() => openSettingsPage({ section: 'account', scrollTo: 'github' })}>
              {t('settings.git.branchPrefix.setUpGithub')}
            </LinkButton>
          </>
        ) : undefined
      }
    >
      <RadioList<BranchPrefixType>
        legend={t('settings.git.branchPrefix.label')}
        hideLegend
        name="branch-prefix"
        value={type}
        onChange={choose}
        options={[
          {
            value: 'github',
            label: (
              <>
                {t('settings.git.branchPrefix.githubUsername')} {github.user && <span className="muted">({github.user})</span>}
              </>
            )
          },
          {
            value: 'custom',
            label: t('settings.git.branchPrefix.custom'),
            extra:
              type === 'custom' ? (
                <>
                  <TextInput
                    mono
                    aria-label={t('settings.git.branchPrefix.customLabel')}
                    placeholder={t('settings.git.branchPrefix.placeholder')}
                    spellCheck={false}
                    autoComplete="off"
                    {...draft}
                    onChange={(e) => {
                      e.target.value = sanitizePrefix(e.target.value)
                      draft.onChange(e)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  <span className="set-help">
                    {t.rich('settings.git.branchPrefix.preview', { branch: <code key="branch">{(draft.value ? finishPrefix(draft.value) : '') + EXAMPLE}</code> })}
                  </span>
                </>
              ) : undefined
          },
          { value: 'none', label: t('common.none') }
        ]}
      />
    </Row>
  )
}
