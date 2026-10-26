// Repository → Actions: what agents are told about Foreman (#2), spotlight testing and the custom instructions sent
// with Review, Create PR, Fix errors, Resolve conflicts and branch naming.
import { ChevronRight, Copy, Eye } from 'lucide-react'
import { useId, useState } from 'react'
import { createPrInstructions, fixErrorsInstructions, resolveConflictsMessage, reviewInstructions } from '../../../../shared/prompts'
import type { PlainKey } from '../../../../shared/i18n'
import type { CustomPrompts, Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { showToast, useStore } from '../../store'
import { Button, Pressable, Tag, TextArea } from '../../ui'
import { RepoToggleRow, Row, Section, useDraft, useRepoSetting } from './controls'
import { Dialog } from './RepoDialog'
import { ForemanForAgents } from './RepoForemanAgents'
import { AutoReviewSetting } from '../AutoReview'

interface PromptDef {
  key: keyof CustomPrompts
  id: string
  title: PlainKey
  // Name of the action, for the preview dialog's title.
  action?: PlainKey
  description: PlainKey
  placeholder?: PlainKey
}

const PROMPTS: PromptDef[] = [
  {
    key: 'codeReview',
    id: 'prompt-code-review',
    title: 'repoSettings.prompts.codeReview.title',
    action: 'repoSettings.prompts.codeReview.action',
    description: 'repoSettings.prompts.codeReview.desc'
  },
  {
    key: 'createPr',
    id: 'prompt-create-pr',
    title: 'repoSettings.prompts.createPr.title',
    action: 'repoSettings.prompts.createPr.action',
    description: 'repoSettings.prompts.createPr.desc'
  },
  {
    key: 'fixErrors',
    id: 'prompt-fix-errors',
    title: 'repoSettings.prompts.fixErrors.title',
    action: 'repoSettings.prompts.fixErrors.action',
    description: 'repoSettings.prompts.fixErrors.desc'
  },
  {
    key: 'resolveConflicts',
    id: 'prompt-resolve-conflicts',
    title: 'repoSettings.prompts.resolveConflicts.title',
    action: 'repoSettings.prompts.resolveConflicts.action',
    description: 'repoSettings.prompts.resolveConflicts.desc'
  },
  {
    key: 'renameBranch',
    id: 'prompt-rename-branch',
    title: 'repoSettings.prompts.renameBranch.title',
    action: 'repoSettings.prompts.renameBranch.action',
    description: 'repoSettings.prompts.renameBranch.desc'
  },
  {
    key: 'general',
    id: 'prompt-general',
    title: 'repoSettings.prompts.general.title',
    description: 'repoSettings.prompts.general.desc',
    placeholder: 'repoSettings.prompts.general.placeholder'
  }
]

const DEFAULT_PLACEHOLDER: PlainKey = 'repoSettings.prompts.placeholder'

export function ActionsTab({ repo }: { repo: Repo }) {
  const t = useT()
  return (
    <>
      {/* #2: what agents are told about Foreman, and what they may ask it to do. */}
      <ForemanForAgents repo={repo} />
      <Section>
        <RepoToggleRow
          repoId={repo.id}
          setting="spotlightTesting"
          id="spotlight-testing"
          label={t('repoSettings.spotlight.label')}
          help={t('repoSettings.spotlight.help')}
        />
        {/* #17: off by default; switching it on opens the consent dialog. */}
        <AutoReviewSetting repoId={repo.id} />
      </Section>
      <Section>
        {PROMPTS.map((def) => (
          <PromptEditor key={def.key} repo={repo} def={def} />
        ))}
      </Section>
    </>
  )
}

function PromptEditor({ repo, def }: { repo: Repo; def: PromptDef }) {
  const t = useT()
  const inputId = useId()
  const s = useRepoSetting(repo.id, `prompts.${def.key}` as const)
  // Opened when search jumps here.
  const jumpedHere = useStore((st) => st.settingsPage?.scrollTo === def.id)
  const [open, setOpen] = useState(jumpedHere)
  const [preview, setPreview] = useState(false)
  const draft = useDraft(s.value, (text) => {
    const next = text.trim()
    if (next === s.value) return false
    void (next || s.inherited !== 'default' ? s.set(next) : s.reset())
  })
  const customized = s.value.trim() !== ''

  return (
    <Row
      id={def.id}
      stacked
      label={
        // DS-TODO(B7): Disclosure keeps its button and panel together; here the toggle is the row's label and the panel is the row's control, so this is a Pressable with aria-expanded.
        <Pressable className="repo-prompt-toggle" aria-expanded={open} aria-controls={inputId} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={`repo-chevron ${open ? 'open' : ''}`} aria-hidden />
          <span className="repo-prompt-title">{t(def.title)}</span>
          {customized && <Tag>{t('repoSettings.prompts.customized')}</Tag>}
        </Pressable>
      }
      help={t(def.description)}
      source={s.sourceInfo}
      onReset={s.source === 'local' ? () => void s.reset() : undefined}
    >
      {open && (
        <div className="repo-prompt-body">
          <TextArea
            id={inputId}
            className="repo-prompt-text"
            mono
            aria-label={t(def.title)}
            autoFocus={!jumpedHere}
            spellCheck={false}
            placeholder={t(def.placeholder ?? DEFAULT_PLACEHOLDER)}
            {...draft}
          />
          {def.action && (
            <div className="repo-prompt-actions">
              <Button size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => setPreview(true)}>
                {t('repoSettings.prompts.preview')}
              </Button>
            </div>
          )}
          {preview && <PromptPreview repo={repo} def={def} custom={draft.value} onClose={() => setPreview(false)} />}
        </div>
      )}
    </Row>
  )
}

// Where the preferences go when they're empty.
const CUSTOM_PLACEHOLDER = '${YOUR_CUSTOM_INSTRUCTIONS}'

// Mirrors the request the main process makes when it names a new chat and branch.
function renameRequest(preferences: string): string {
  return [
    'Write a 2-5 word title for this coding task. It is a topic label, not a progress update:',
    'start with the most distinctive noun and never with words like Fix or Investigate.',
    `The user's naming preferences: ${preferences}`,
    '',
    'Task:',
    '${YOUR_FIRST_MESSAGE}'
  ].join('\n')
}

function previewText(key: keyof CustomPrompts, custom: string, base: string): string {
  const text = custom.trim() || CUSTOM_PLACEHOLDER
  switch (key) {
    case 'codeReview':
      return reviewInstructions({ base, customPrompt: text, hasDiffTool: true })
    case 'createPr':
      return createPrInstructions({ base, draft: false, customPrompt: text, hasDiffTool: true })
    case 'fixErrors':
      return fixErrorsInstructions(text)
    case 'resolveConflicts':
      return resolveConflictsMessage(base, text)
    case 'renameBranch':
      return renameRequest(text)
    case 'general':
      return text
  }
}

function PromptPreview({ repo, def, custom, onClose }: { repo: Repo; def: PromptDef; custom: string; onClose: () => void }) {
  const t = useT()
  const text = previewText(def.key, custom, repo.defaultBranch)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('repoSettings.prompts.copied'))
    } catch {
      showToast(t('repoSettings.prompts.copyFailed'))
    }
  }
  return (
    <Dialog
      title={t('repoSettings.prompts.previewTitle', { action: t(def.action ?? def.title) })}
      width={640}
      onClose={onClose}
      description={
        def.key === 'renameBranch' ? (
          t('repoSettings.prompts.renameDesc')
        ) : (
          <>{t.rich('repoSettings.prompts.previewDesc', { branch: <code key="branch">{repo.defaultBranch}</code> })}</>
        )
      }
      footer={
        <>
          <Button icon={<Copy size={13} />} onClick={() => void copy()}>
            {t('common.copy')}
          </Button>
          <span className="spacer" />
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <pre className="set-code repo-prompt-preview">{text}</pre>
    </Dialog>
  )
}
