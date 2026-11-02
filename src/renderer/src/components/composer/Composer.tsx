import { frozenReason } from '../../../../shared/transfer'
import { ArrowDown, ArrowUp, Check, ClipboardList, MessageSquareQuote, Users, Copy, CornerDownLeft, File as FileIcon, FileText, Image, Lock, Paperclip, Pencil, Send, Square, SquareTerminal, Trash2, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { AGENTS, modelInfo, nextEffort, supportsPlan } from '../../../../shared/agents'
import { compareBlockFor } from '../../../../shared/compare'
import { effectiveMode, oppositeMode, receiptText, type FollowUpMode } from '../../../../shared/delivery'
import { pendingComments } from '../../../../shared/context'
import { insertTemplate, templateAfterEdit } from '../../../../shared/promptTemplates'
import { queueMoveKey, shortTurnId } from '../../../../shared/queueEdit'
import { templateById } from '../../../../shared/repoTemplates'
import { composeMessage, editSnippet, snippetAttachmentName, snippetAttachmentText, snippetIsTooLong, TERMINAL_SNIPPET_MAX_CHARS, type TerminalSnippet } from '../../../../shared/terminalSnippet'
import type { ApprovalRequest, Attachment, PromptTemplate, QueueChangeResult, QueuedMessage, QueueMove, Session, SlashCommandInfo, Workspace } from '../../../../shared/types'
import { api, attempt, bridge, modKey, newChatWithTemplate, onUiCommand, openCompareDialog, openMcpStatus, requestOpenFile, sendUiCommand, showError, showToast, takeComposerFill, toggleRightPanel, useStore, type EditedFrom } from '../../store'
import { useT } from '../../i18n'
import { useStoreMemo } from '../../storeMemo'
import { ActionRow, Button, Callout, ChipButton, IconButton, Kbd, LinkButton, Listbox, Tag, TextArea } from '../../ui'
import { AgentPicker } from './AgentPicker'
import { ContextWheel } from './ContextWheel'
import { newChatHint } from '../../../../shared/startModel'
import { TemplatePicker } from './TemplatePicker'
import { TerminalDraft } from './TerminalDraft'
import { WorkspaceToolsChip } from '../WorkspaceIntegrations'
import { isMixed, planControl } from '../../../../shared/switchAgent'

const LONG_PASTE = 5000
const fileCache = new Map<string, { at: number; files: string[] }>()

async function workspaceFiles(workspaceId: string): Promise<string[]> {
  const cached = fileCache.get(workspaceId)
  if (cached && Date.now() - cached.at < 30_000) return cached.files
  const files = await api.listFiles(workspaceId)
  fileCache.set(workspaceId, { at: Date.now(), files })
  return files
}

/** Subsequence match, preferring hits in the file name and shorter paths. */
function rankFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  if (!q) return files.slice(0, 30)
  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    let at = 0
    for (const ch of q) {
      at = lower.indexOf(ch, at)
      if (at === -1) break
      at++
    }
    if (at === -1) continue
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = (name.includes(q) ? 0 : lower.includes(q) ? 100 : 200) + file.length
    scored.push({ file, score })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, 30).map((s) => s.file)
}

type Menu = { kind: '@' | '/'; query: string; start: number; index: number }

/** Why the queue couldn't take an edit, so it was kept as a draft instead. */
type KeptReason = Extract<QueueChangeResult, { ok: false }>['reason']

/** A queued message's edit that the queue refused: its text, with the message's attachments and template. */
interface KeptEdit {
  text: string
  attachments: Attachment[]
  templateId?: string
  reason: KeptReason
}

function menuAt(text: string, cursor: number): Omit<Menu, 'index'> | null {
  const before = text.slice(0, cursor)
  const slash = /^\/(\S*)$/.exec(before)
  if (slash) return { kind: '/', query: slash[1], start: 0 }
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: '@', query: at[2], start: before.length - at[2].length - 1 }
  return null
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void }) {
  const t = useT()
  const Icon = attachment.kind === 'image' ? Image : attachment.kind === 'text' ? FileText : FileIcon
  return (
    <span className="attachment-chip" title={attachment.path}>
      <Icon size={12} />
      <span>{attachment.name}</span>
      {onRemove && (
        <IconButton label={t('composer.attachment.remove', { name: attachment.name })} onClick={onRemove}>
          <X size={11} />
        </IconButton>
      )}
    </span>
  )
}

export { AttachmentChip }

export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  let binary = ''
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** "Pasted text.txt", then "Pasted text 2.txt", … skipping names already used. */
function pastedTextName(taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'Pasted text.txt' : `Pasted text ${n}.txt`
    if (!taken.has(name)) return name
  }
}

export function Composer({
  session,
  workspace,
  active,
  hasHistory,
  pendingPlan
}: {
  session: Session
  workspace: Workspace
  active: boolean
  hasHistory: boolean
  pendingPlan?: Extract<ApprovalRequest, { kind: 'plan' }>
}) {
  const settings = useStore((s) => s.snapshot!.settings)
  const repoTemplates = useStore((s) => s.snapshot!.repoTemplates)
  const platform = useStore((s) => s.snapshot!.platform)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Terminal selections waiting as draft blocks; they go in front of the text when it's sent.
  const [snippets, setSnippets] = useState<TerminalSnippet[]>([])
  const t = useT()
  // "Don't include": the pending review comments stay out of the next message only.
  const [skipComments, setSkipComments] = useState(false)
  const allComments = useStore((s) => s.snapshot!.comments)
  const pendingReview = pendingComments(allComments, workspace.id)
  // For naming pasted text while earlier pastes are still being saved.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const pendingPasteNames = useRef(new Set<string>())
  const [focused, setFocused] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [menuItems, setMenuItems] = useState<{ value: string; label: string; detail?: string }[]>([])
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [dragging, setDragging] = useState(false)
  // Overrides the follow-up setting for the next message only.
  const [override, setOverride] = useState<FollowUpMode | null>(null)
  // The template last inserted. Kept through edits, including filling its placeholders, until the
  // draft is cleared, sent or another template goes in; it is how the answer finds its follow-up.
  const [templateId, setTemplateId] = useState<string | undefined>()
  // An edit of a queued message that already started (or went): kept in the draft, with what the draft held before.
  const [kept, setKept] = useState<{ reason: KeptReason; prior: { text: string; attachments: Attachment[]; templateId?: string } } | null>(null)
  // #16: the draft is a message being edited and resent (from Edit and resend), until it's sent or discarded.
  const [edited, setEdited] = useState<EditedFrom | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const suggestionsId = useId()
  const running = session.status === 'running'
  const agent = AGENTS[session.agent]
  // O1: controls follow the tab's agent; in a chat that switched agents, a Plan chip the agent lacks stays greyed.
  // Scanned again only when this chat's log changes, not on every store event.
  const mixed = useStoreMemo((s) => [s.chats[session.id]], ([chat]) => isMixed(chat ?? []))
  // G1: an ACP agent that declared a plan session mode gets the Plan chip.
  const modes = useStore((s) => s.snapshot?.catalog.agents[session.agent]?.modes)
  const plan = planControl(session.agent, { planMode: session.planMode, readOnly: session.readOnly, mixed, modes })
  const mod = modKey(platform)
  const isMac = platform === 'darwin'
  const held = workspace.state === 'setup-failed' && workspace.heldMessage?.sessionId === session.id
  const canSteer = agent.supportsSteering
  const followUp = effectiveMode(settings.followUpMode, override, canSteer)
  const historyOnly = workspace.state === 'history'
  // A tab imported as history stays read-only even once the workspace is active.
  const tabHistory = session.importedMode === 'history'
  const disabled = workspace.state === 'creating' || workspace.state === 'error' || historyOnly || tabHistory || Boolean(frozenReason(workspace))

  // Text sent here from elsewhere (a sensitive-files alert's "Tell agent…"), or a terminal selection.
  const fill = useStore((s) => s.composerFill)
  useEffect(() => {
    if (fill?.sessionId !== session.id) return
    const incoming = takeComposerFill(session.id)
    if (incoming === null) return
    if (incoming.text) setText((current) => (current.trim() ? `${current}\n\n${incoming.text}` : incoming.text))
    if (incoming.templateId) setTemplateId(incoming.templateId)
    if (incoming.attachments) setAttachments((current) => [...current, ...incoming.attachments!].slice(0, 20))
    if (incoming.snippet) void addSnippet(incoming.snippet)
    if (incoming.edited) setEdited(incoming.edited)
    requestAnimationFrame(() => input.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, session.id])

  // Keyboard shortcuts routed to the visible chat only.
  useEffect(
    () =>
      onUiCommand((command, workspaceId) => {
        if (!active || workspaceId !== workspace.id) return
        if (command === 'focus-composer') input.current?.focus()
        else if (command === 'clear-composer') {
          setText('')
          setSnippets([])
          setKept(null)
          setEdited(null)
        }
        else if (command === 'toggle-picker') setPickerOpen((o) => !o)
        else if (command === 'toggle-templates' && !disabled) setTemplatesOpen((o) => !o)
        else if (command === 'cycle-effort') {
          const effort = nextEffort(modelInfo(session.agent, session.model), session.effort)
          if (effort) void attempt(() => api.updateSession(session.id, { effort }))
        } else if (command === 'toggle-fast') {
          if (modelInfo(session.agent, session.model).supportsFast) {
            void attempt(() => api.updateSession(session.id, { fastMode: !session.fastMode }))
          }
        } else if (command === 'toggle-plan') togglePlan()
        else if (command === 'attach') void pickAttachments()
        else if (command === 'cancel' && running) void attempt(() => api.cancel(session.id))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, workspace.id, session, running, disabled]
  )

  // Grow with the content up to a limit.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 280)}px`
  }, [text])

  // The caret after an accepted suggestion, placed as its text is committed. A frame later, keys typed in between
  // would already be in the box, and moving the caret back would put the next ones in front of them.
  const caretAfterCommit = useRef<number | null>(null)
  useLayoutEffect(() => {
    const position = caretAfterCommit.current
    if (position === null) return
    caretAfterCommit.current = null
    input.current?.setSelectionRange(position, position)
    input.current?.focus()
  })

  // Fill the @ / / menu.
  useEffect(() => {
    if (!menu) return
    let cancelled = false
    if (menu.kind === '/') {
      const q = menu.query.toLowerCase()
      setMenuItems(
        commands
          .filter((c) => c.name.toLowerCase().includes(q))
          .slice(0, 30)
          .map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, detail: c.description }))
      )
    } else {
      void workspaceFiles(workspace.id).then((files) => {
        if (!cancelled) setMenuItems(rankFiles(files, menu.query).map((f) => ({ value: `@${f} `, label: f })))
      })
    }
    return () => {
      cancelled = true
    }
  }, [menu, commands, workspace.id])

  const togglePlan = () => {
    if (!supportsPlan(session.agent, modes)) return showError(t('composer.plan.unavailable'))
    void attempt(() => api.updateSession(session.id, { planMode: !session.planMode }))
  }

  const addAttachments = (added: Attachment[] | undefined) => {
    if (added?.length) setAttachments((current) => [...current, ...added].slice(0, 20))
  }

  /** A terminal selection: a draft block, or over the cap a text attachment (like a long paste). */
  const addSnippet = async (snippet: TerminalSnippet) => {
    if (!snippetIsTooLong(snippet)) {
      setSnippets((current) => [...current, snippet])
      return
    }
    const name = snippetAttachmentName(snippet.source, new Set([...attachmentsRef.current.map((a) => a.name), ...pendingPasteNames.current]))
    pendingPasteNames.current.add(name)
    const added = await attempt(() => api.attachData(workspace.id, name, toBase64(new TextEncoder().encode(snippetAttachmentText(snippet)))))
    pendingPasteNames.current.delete(name)
    if (added) {
      attachmentsRef.current = [...attachmentsRef.current, added]
      addAttachments([added])
      showToast(t('terminalChat.attached', { max: TERMINAL_SNIPPET_MAX_CHARS.toLocaleString(t.locale) }))
    }
  }

  const pickAttachments = async () => {
    const paths = await attempt(() => api.pickFiles())
    if (paths?.length) addAttachments(await attempt(() => api.attachFiles(workspace.id, paths)))
  }

  const updateMenu = (value: string, cursor: number) => {
    const found = menuAt(value, cursor)
    if (found?.kind === '/' && commands.length === 0) void api.slashCommands(session.id).then(setCommands).catch(() => undefined)
    setMenu(found ? { ...found, index: 0 } : null)
  }

  const applyMenuItem = (value: string) => {
    if (!menu) return
    const cursor = input.current?.selectionStart ?? text.length
    if (menu.kind === '/' && value === '/mcp-status ' && !text.slice(cursor).trim()) {
      // A UI command: open it straight away.
      setText('')
      setTemplateId(undefined)
      setMenu(null)
      openMcpStatus(session.id)
      return
    }
    const next = text.slice(0, menu.start) + value + text.slice(cursor)
    setText(next)
    setMenu(null)
    caretAfterCommit.current = menu.start + value.length
  }

  /** Insert a template at the cursor, selecting its first {{placeholder}}. */
  const applyTemplate = (template: PromptTemplate) => {
    const el = input.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const next = insertTemplate(text, start, end, template.body)
    setText(next.text)
    setTemplateId(template.id)
    setMenu(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(...next.selection)
    })
  }

  /** A repo command or skill: its /name goes in the draft at the cursor. It is never sent from here. */
  const insertCommand = (command: string) => {
    const el = input.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const next = insertTemplate(text, start, end, command)
    setText(next.text)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(...next.selection)
    })
  }

  const send = async (mode?: 'queue' | 'steer') => {
    const typed = text.trim()
    // Terminal blocks go first, each as a fenced block under its label line, then what was typed.
    // G4: a block trimmed down to nothing goes nowhere.
    const message = composeMessage(snippets.filter((s) => s.text.trim()), typed)
    if (disabled || (!message && !attachments.length)) return
    if (message === '/mcp-status' && !attachments.length) {
      // Opens a dialog; nothing goes to the agent.
      setText('')
      setTemplateId(undefined)
      setMenu(null)
      if (!agent.builtinCommands.some((c) => c.name === 'mcp-status')) return showError(t('composer.mcpStatus.unavailable', { agent: agent.label }))
      openMcpStatus(session.id)
      return
    }
    if (pendingPlan) {
      // Text typed while a plan waits is feedback on that plan.
      setText('')
      setSnippets([])
      setTemplateId(undefined)
      await attempt(() => api.respondApproval(pendingPlan.id, { kind: 'plan', approve: false, feedback: message }))
      return
    }
    const sending = attachments
    const sendingSnippets = snippets
    const fromTemplate = templateId
    setText('')
    setTemplateId(undefined)
    setAttachments([])
    setSnippets([])
    setMenu(null)
    const skipping = skipComments
    // The chip applies to this one message.
    const disposition = await attempt(() =>
      api.sendMessage(session.id, message, { attachments: sending, mode: mode ?? (running ? followUp : undefined), templateId: fromTemplate, skipComments: skipping || undefined })
    )
    if (disposition === undefined) {
      // A failed send keeps the draft, its attachments, terminal blocks and where it came from.
      setText(typed)
      setTemplateId(fromTemplate)
      setAttachments(sending)
      setSnippets(sendingSnippets)
      return
    }
    setOverride(null)
    setSkipComments(false)
    setKept(null)
    setEdited(null)
    const receipt = receiptText(disposition, t)
    if (receipt) showToast(receipt)
  }

  /** The queue refused an edit: it goes into the draft (after anything already typed) with Queue / Steer / Discard. */
  const keepEdit = (edit: KeptEdit) => {
    setKept({ reason: edit.reason, prior: { text, attachments, templateId } })
    setText((current) => (current.trim() ? `${current}\n\n${edit.text}` : edit.text))
    setAttachments((current) => [...current, ...edit.attachments.filter((a) => !current.some((c) => c.path === a.path))].slice(0, 20))
    setTemplateId((id) => id ?? edit.templateId)
    requestAnimationFrame(() => input.current?.focus())
  }

  const discardKept = () => {
    if (!kept) return
    setText(kept.prior.text)
    setAttachments(kept.prior.attachments)
    setTemplateId(kept.prior.templateId)
    setKept(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const modDown = isMac ? e.metaKey : e.ctrlKey
    if (menu && menuItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setMenu({ ...menu, index: (menu.index + delta + menuItems.length) % menuItems.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyMenuItem(menuItems[menu.index]?.value ?? '')
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
        return
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      togglePlan()
      return
    }
    if (e.key === 'Enter' && modDown && e.shiftKey && pendingPlan) {
      e.preventDefault()
      if (text.trim()) void send()
      else void attempt(() => api.respondApproval(pendingPlan.id, { kind: 'plan', approve: true }))
      return
    }
    if (e.key === 'Enter') {
      const sendsOnEnter = settings.messageSendKey === 'enter'
      const plainEnter = !e.shiftKey && !modDown && !e.altKey
      if (sendsOnEnter && plainEnter) {
        e.preventDefault()
        void send()
      } else if (modDown && !e.shiftKey) {
        // Enter-mode: ⌘↵ sends with the opposite follow-up. ⌘↵-mode: ⌘↵ sends.
        e.preventDefault()
        void send(sendsOnEnter && running && canSteer ? oppositeMode(followUp) : undefined)
      } else if (!sendsOnEnter && e.altKey && running && canSteer) {
        e.preventDefault()
        void send(oppositeMode(followUp))
      }
      return
    }
    if (e.key === 'Escape' && running) {
      e.preventDefault()
      void attempt(() => api.cancel(session.id))
    }
  }

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files]
    if (files.length) {
      e.preventDefault()
      for (const file of files.slice(0, 10)) {
        const path = bridge.pathForFile(file)
        if (path) addAttachments(await attempt(() => api.attachFiles(workspace.id, [path])))
        else {
          const name = file.name || `pasted-${Date.now()}.png`
          const data = toBase64(await file.arrayBuffer())
          const added = await attempt(() => api.attachData(workspace.id, name, data))
          if (added) addAttachments([added])
        }
      }
      return
    }
    const pasted = e.clipboardData.getData('text/plain')
    if (settings.autoConvertLongText && pasted.length > LONG_PASTE) {
      e.preventDefault()
      const name = pastedTextName(new Set([...attachmentsRef.current.map((a) => a.name), ...pendingPasteNames.current]))
      pendingPasteNames.current.add(name)
      const added = await attempt(() => api.attachData(workspace.id, name, toBase64(new TextEncoder().encode(pasted))))
      pendingPasteNames.current.delete(name)
      if (added) {
        // Visible to the next paste before React re-renders.
        attachmentsRef.current = [...attachmentsRef.current, added]
        addAttachments([added])
        showToast(t('composer.pastedAttachment'))
      }
    }
  }

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter(Boolean)
    if (paths.length) addAttachments(await attempt(() => api.attachFiles(workspace.id, paths)))
  }

  // A template with a start model, inserted here, only adds text: offer a chat that starts on that model instead.
  const draftTemplate = text.trim() ? templateById(settings.promptTemplates, repoTemplates, templateId) : undefined
  const newChatLabel = newChatHint(draftTemplate, session, t)
  const sendsQueue = running && followUp === 'queue'
  const hasDraft = Boolean(text.trim() || attachments.length || snippets.length)
  const stopIsPrimary = running && !hasDraft
  // Clearing the draft by hand leaves nothing to choose about.
  useEffect(() => {
    if (kept && !hasDraft) setKept(null)
  }, [kept, hasDraft])
  const placeholder = tabHistory && !historyOnly
    ? t('composer.placeholder.importedHistory')
    : historyOnly
    ? t('composer.placeholder.historyOnly')
    : pendingPlan
    ? t('composer.placeholder.plan')
    : running
      ? followUp === 'steer'
        ? t('composer.placeholder.steer')
        : t('composer.placeholder.queue')
      : t('composer.placeholder.ask', { agent: agent.label })

  return (
    <div className="composer">
      {held && <HeldBanner workspaceId={workspace.id} />}
      {tabHistory && !historyOnly && (
        <div className="intake-line" role="status">
          <span>{t('composer.importedHistory')}</span>
        </div>
      )}
      {historyOnly && (
        <div className="intake-line" role="status">
          <span>{t('composer.historyOnly')}</span>
        </div>
      )}
      {pendingReview.length > 0 && !(running && followUp === 'steer') && (
        <div className="pending-comments" role="status">
          {skipComments ? (
            <>
              <span>{t('composer.comments.skipped', { count: pendingReview.length })}</span>
              <LinkButton size="sm" onClick={() => setSkipComments(false)}>
                {t('composer.comments.include')}
              </LinkButton>
            </>
          ) : (
            <>
              <span>{t('composer.comments.pending', { count: pendingReview.length })}</span>
              <span className="faint">·</span>
              <LinkButton size="sm" onClick={() => requestOpenFile(workspace.id, pendingReview[0].file, pendingReview[0].line)}>
                {t('common.show')}
              </LinkButton>
              <span className="faint">·</span>
              <LinkButton size="sm" onClick={() => setSkipComments(true)} title={t('composer.comments.skipTitle')}>
                {t('composer.comments.skip')}
              </LinkButton>
            </>
          )}
        </div>
      )}
      <QueuedList session={session} isMac={isMac} mod={mod} onKept={keepEdit} />
      {kept && (
        <Callout
          tone="info"
          role="status"
          className="composer-notice"
          actions={
            <>
              <LinkButton size="sm" onClick={discardKept}>
                {t('queue.kept.discard')}
              </LinkButton>
              {running && canSteer && (
                <Button size="sm" onClick={() => void send('steer')}>
                  {t('queue.kept.steer')}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => void send('queue')}>
                {running ? t('queue.kept.queue') : t('queue.kept.send')}
              </Button>
            </>
          }
        >
          {t(kept.reason === 'started' ? 'queue.kept.started' : kept.reason === 'removed' ? 'queue.kept.removed' : 'queue.kept.changed')}
        </Callout>
      )}
      {edited && (
        <Callout
          role="status"
          className="composer-notice"
          actions={
            <>
              <LinkButton size="sm" title={t('editResend.composer.showOriginalTitle')} onClick={() => setText(edited.original)}>
                {t('editResend.composer.showOriginal')}
              </LinkButton>
              <LinkButton
                size="sm"
                onClick={() => {
                  setText('')
                  setEdited(null)
                }}
              >
                {t('editResend.composer.discard')}
              </LinkButton>
            </>
          }
        >
          <Pencil size={13} aria-hidden className="composer-notice-icon" />
          {edited.from ? t('editResend.composer.from', { title: edited.from }) : t('editResend.composer.fromUntitled')}
        </Callout>
      )}
      {pendingPlan && <PlanBar request={pendingPlan} sessionId={session.id} mod={mod} />}
      {draftTemplate && newChatLabel && (
        <div className="composer-newchat">
          <LinkButton size="sm" onClick={() => void newChatWithTemplate(workspace.id, draftTemplate)}>
            {newChatLabel}
          </LinkButton>
        </div>
      )}
      <div
        className={`composer-box ${focused ? 'focused' : ''} ${session.planMode ? 'plan' : ''} ${dragging ? 'dragging' : ''}`}
        onClick={() => input.current?.focus()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void onDrop(e)}
      >
        {snippets.map((snippet) => (
          <TerminalDraft
            key={snippet.id}
            snippet={snippet}
            onRemove={() => setSnippets((current) => current.filter((s) => s.id !== snippet.id))}
            onEdit={(value) => setSnippets((current) => current.map((s) => (s.id === snippet.id ? editSnippet(s, value) : s)))}
          />
        ))}
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((a, n) => (
              <AttachmentChip key={a.path} attachment={a} onRemove={() => setAttachments(attachments.filter((_, k) => k !== n))} />
            ))}
          </div>
        )}
        {menu && menuItems.length > 0 && (
          // Focus stays in the textarea: the list is its popup, driven by the keys in onKeyDown.
          <div className="mention-menu" onMouseDown={(e) => e.preventDefault()}>
            <Listbox
              id={suggestionsId}
              label={t('composer.suggestions.label')}
              focusable={false}
              mono
              options={menuItems.map((item) => ({ value: item.value, label: item.label, description: item.detail }))}
              activeIndex={menu.index}
              onActiveChange={(index) => setMenu({ ...menu, index })}
              onChange={applyMenuItem}
            />
          </div>
        )}
        <TextArea
          bare
          ref={input}
          rows={2}
          aria-label={t('composer.input.label')}
          aria-controls={menu && menuItems.length > 0 ? suggestionsId : undefined}
          aria-activedescendant={menu && menuItems.length > 0 ? `${suggestionsId}-${menu.index}` : undefined}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setMenu(null)
          }}
          onChange={(e) => {
            setText(e.target.value)
            setTemplateId((id) => templateAfterEdit(id, e.target.value))
            updateMenu(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
        />
        {!focused && !text && !snippets.length && <span className="composer-focus-hint">{t('composer.focusHint', { key: `${mod}L` })}</span>}
        <div className="composer-toolbar" onClick={(e) => e.stopPropagation()}>
          <AgentPicker session={session} hasHistory={hasHistory} open={pickerOpen} onOpenChange={setPickerOpen} />
          {plan === 'unavailable' ? (
            <ChipButton disabled title={t('switchAgent.composer.noPlan', { agent: agent.label })}>
              <ClipboardList size={13} /> {t('composer.plan.chip')}
            </ChipButton>
          ) : plan !== 'hidden' && (
            <ChipButton
              pressed={Boolean(session.planMode)}
              onClick={togglePlan}
              disabled={session.readOnly}
              title={session.readOnly ? t('readOnlyOpinion.composer.planLocked') : t('composer.plan.title', { key: '⇧Tab' })}
            >
              <ClipboardList size={13} /> {t('composer.plan.chip')}
            </ChipButton>
          )}
          {session.readOnly && (
            <Tag title={t(session.agent === 'claude' ? 'readOnlyOpinion.enforced.claude' : 'readOnlyOpinion.enforced.codex')}>
              <Lock size={12} /> {t('readOnlyOpinion.chip')}
            </Tag>
          )}
          {settings.requireToolApprovals && session.autoAcceptEdits && (
            <ChipButton
              pressed
              title={t('composer.autoAccept.title')}
              onClick={() => void attempt(() => api.updateSession(session.id, { autoAcceptEdits: false }))}
            >
              <Pencil size={12} /> {t('composer.autoAccept.label')} <X size={11} />
            </ChipButton>
          )}
          <IconButton label={t('composer.attach.title', { key: `${mod}U` })} onClick={() => void pickAttachments()}>
            <Paperclip size={14} />
          </IconButton>
          <WorkspaceToolsChip workspace={workspace} agent={session.agent} />
          {!disabled && (
            <TemplatePicker open={templatesOpen} onOpenChange={setTemplatesOpen} repoId={workspace.repoId} session={session} onPickCommand={insertCommand} onPick={applyTemplate} title={t('composer.templates.title', { key: `${mod}J` })} />
          )}
          {!disabled && <AlsoTry workspace={workspace} session={session} text={text} />}
          {running && !pendingPlan && <SendModeChip mode={followUp} canSteer={canSteer} sendsOnEnter={settings.messageSendKey === 'enter'} isMac={isMac} mod={mod} onToggle={() => setOverride(oppositeMode(followUp))} />}
          <span className="spacer" />
          {session.contextUsage && <ContextWheel usage={session.contextUsage} />}
          {running && !stopIsPrimary && (
            <LinkButton size="sm" onClick={() => void attempt(() => api.cancel(session.id))}>
              {t('common.stop')}
            </LinkButton>
          )}
          <IconButton
            variant="primary"
            onClick={() => (stopIsPrimary ? void attempt(() => api.cancel(session.id)) : void send())}
            disabled={!stopIsPrimary && (disabled || !hasDraft)}
            label={stopIsPrimary ? t('composer.send.stopTitle') : pendingPlan ? t('composer.send.planFeedbackTitle') : sendsQueue ? t('composer.send.queue') : t('composer.send.send')}
          >
            {stopIsPrimary ? <Square size={12} fill="currentColor" /> : sendsQueue ? <CornerDownLeft size={14} /> : pendingPlan ? <Send size={13} /> : <ArrowUp size={15} />}
          </IconButton>
        </div>
      </div>
    </div>
  )
}

/** Setup failed, so the first message is held, unsent. */
function HeldBanner({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const panelOpen = useStore((s) => s.rightPanelOpen)
  return (
    <Callout
      tone="warn"
      role="status"
      className="composer-notice"
      actions={
        <>
          <LinkButton
            size="sm"
            onClick={() => {
              if (!panelOpen) toggleRightPanel()
              sendUiCommand('show-setup-log', workspaceId)
            }}
          >
            {t('composer.held.showLog')}
          </LinkButton>
          <Button size="sm" variant="primary" onClick={() => void attempt(() => api.startHeldMessage(workspaceId))}>
            {t('composer.held.start')}
          </Button>
        </>
      }
    >
      {t('composer.held.failed')}
    </Callout>
  )
}

/** While a turn runs: how this message goes (Steer or Queue), and the key for the other. */
function SendModeChip({ mode, canSteer, sendsOnEnter, isMac, mod, onToggle }: {
  mode: FollowUpMode
  canSteer: boolean
  sendsOnEnter: boolean
  isMac: boolean
  mod: string
  onToggle: () => void
}) {
  const t = useT()
  if (!canSteer) return <Tag title={t('composer.mode.cantSteer')}>{t('composer.mode.queue')}</Tag>
  const other = oppositeMode(mode)
  const key = sendsOnEnter ? `${mod}↵` : isMac ? '⌥↵' : 'Alt+Enter'
  const label = (m: FollowUpMode) => (m === 'steer' ? t('composer.mode.steer') : t('composer.mode.queue'))
  return (
    <>
      <ChipButton onClick={onToggle} title={mode === 'steer' ? t('composer.mode.steerTitle') : t('composer.mode.queueTitle')}>
        {label(mode)}
      </ChipButton>
      <span className="faint small">{t(other === 'steer' ? 'composer.mode.keyToSteer' : 'composer.mode.keyToQueue', { key })}</span>
    </>
  )
}

/**
 * The queue above the composer, a labelled list of rows. Each row shows its place; ↑/↓ (or ⌥↑/⌥↓ with focus anywhere in
 * the row) move it, and Edit opens it right where it is. Saving keeps the message's turn id, so `foreman wait` on it
 * still answers. Both are checked against the queue revision in the main process; an edit it refuses (the message
 * already started) is handed to the composer as a draft rather than lost.
 */
type QueueAction = 'up' | 'down' | 'send' | 'edit' | 'delete'

function QueuedList({ session, isMac, mod, onKept }: { session: Session; isMac: boolean; mod: string; onKept: (edit: KeptEdit) => void }) {
  const t = useT()
  const queue = session.queue
  // The first message waits for an agent slot ("Maximum agents running at once"), not for this tab's agent.
  const maxAgents = useStore((s) => s.snapshot?.settings.maxRunningAgents ?? 0)
  // The message being edited as it was when Edit was pressed, the queue revision then, and the text so far.
  const [editing, setEditing] = useState<{ message: QueuedMessage; revision: number; text: string; attachments: Attachment[] } | null>(null)
  const saving = useRef(false)
  const rows = useRef(new Map<string, HTMLElement>())
  const upKey = isMac ? '⌥↑' : 'Alt+↑'
  const downKey = isMac ? '⌥↓' : 'Alt+↓'
  // G2 (#15): diff selection comments waiting for this tab. They wait in core, not in this queue, and go when the tab is
  // free (checked against the file first), so they're listed after it without places or moves.
  const allComments = useStore((s) => s.snapshot!.comments)
  const waiting = allComments.filter((c) => c.state === 'queued' && c.sessionId === session.id && c.selection)

  // Focus goes back to a button of the row (a re-ordered row can lose it, and a closed editor takes its own with it).
  // Only if it was lost or is still in the row: focus that moved on before this frame stays where it went.
  const focusRow = (id: string, prefer: QueueAction[]) =>
    requestAnimationFrame(() => {
      const row = rows.current.get(id)
      const current = document.activeElement
      if (current && current !== document.body && !row?.contains(current)) return
      for (const action of prefer) {
        const button = row?.querySelector<HTMLButtonElement>(`[data-queue-action="${action}"]`)
        if (button && !button.disabled) return button.focus()
      }
    })

  const closeEditor = (id: string) => {
    setEditing(null)
    focusRow(id, ['edit'])
  }

  const save = async () => {
    if (!editing || saving.current) return
    saving.current = true
    const { message, revision, text, attachments } = editing
    const result = await attempt(() => api.editQueued(session.id, message.id, text, revision, attachments))
    saving.current = false
    // A refused save (empty, a /command) leaves the editor open with its error shown.
    if (!result) return
    closeEditor(message.id)
    if (!result.ok) onKept({ text, attachments, templateId: message.templateId, reason: result.reason })
  }

  // G4 #12: attachments can be added or removed while editing; they're saved with the text.
  const attachMore = async () => {
    const paths = await attempt(() => api.pickFiles())
    if (!paths?.length) return
    const added = await attempt(() => api.attachFiles(session.workspaceId, paths))
    if (!added?.length) return
    setEditing((current) => (current ? { ...current, attachments: [...current.attachments, ...added.filter((a) => !current.attachments.some((c) => c.path === a.path))].slice(0, 20) } : current))
  }

  // The message left the queue while open (dispatch took it, or it was deleted elsewhere): the main process says
  // which, and a changed text is kept as a draft. Unchanged, there is nothing to keep.
  const open = Boolean(editing && queue.some((m) => m.id === editing.message.id))
  useEffect(() => {
    if (!editing || open) return
    if (editing.text === editing.message.text && editing.attachments === editing.message.attachments) setEditing(null)
    else void save()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const move = async (id: string, direction: QueueMove, focus: QueueAction) => {
    const result = await attempt(() => api.moveQueued(session.id, id, direction, session.queueRevision ?? 0))
    if (result && !result.ok) showToast(result.reason === 'stale' ? t('queue.stale') : t('queue.gone'))
    focusRow(id, [focus, direction, direction === 'up' ? 'down' : 'up', 'send'])
  }

  // Stays mounted while the queue is empty, so an edit whose message was just taken is still kept.
  if (!queue.length && !waiting.length) return null
  const rowRef = (id: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el)
    else rows.current.delete(id)
  }
  return (
    <div className="queued">
      <div className="queued-head faint small">
        <span>{session.waitingForSlot ? t('queue.head.slot', { max: maxAgents }) : t('queue.head')}</span>
        {queue.length > 1 && (
          <span className="queued-keys">{t.rich('queue.moveKeys', { up: <Kbd key="up">{upKey}</Kbd>, down: <Kbd key="down">{downKey}</Kbd> })}</span>
        )}
      </div>
      <ul className="queued-list" role="list" aria-label={t('queue.label')}>
        {queue.map((message, n) => {
          if (editing?.message.id === message.id) {
            const empty = !editing.text.trim() && !editing.attachments.length
            return (
              <li key={message.id}>
                <ActionRow
                  ref={rowRef(message.id)}
                  className="queued-row"
                  editor={
                    <>
                      <div className="queued-edit-top">
                        <span className="pos">{n + 1}</span>
                        {message.via === 'cli' ? (
                          <>
                            <Tag tone="outline">
                              <SquareTerminal size={10} />
                              {t('queue.cliTag')}
                            </Tag>
                            <span className="faint small">{t.rich('queue.editingCli', { command: <code key="command">foreman send</code> })}</span>
                          </>
                        ) : (
                          <span className="faint small">{t('queue.editing')}</span>
                        )}
                      </div>
                      <TextArea
                        rows={Math.min(8, Math.max(3, editing.text.split('\n').length))}
                        aria-label={t('queue.editLabel')}
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return
                          if (e.key === 'Escape') {
                            // Cancel leaves the queued message exactly as it was.
                            e.preventDefault()
                            e.stopPropagation()
                            closeEditor(message.id)
                          } else if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
                            e.preventDefault()
                            if (!empty) void save()
                          }
                        }}
                      />
                      <div className="attachment-row queued-edit-files">
                        {editing.attachments.map((a) => (
                          <AttachmentChip
                            key={a.path}
                            attachment={a}
                            onRemove={() => setEditing({ ...editing, attachments: editing.attachments.filter((x) => x.path !== a.path) })}
                          />
                        ))}
                        <LinkButton size="sm" onClick={() => void attachMore()} disabled={editing.attachments.length >= 20}>
                          <Paperclip size={11} /> {t('queue.attach')}
                        </LinkButton>
                      </div>
                      <div className="queued-edit-foot">
                        {message.turnId && (
                          <span className="keep">
                            <Check size={12} />
                            <span>{t.rich('queue.turnKept', { id: <code key="id">{shortTurnId(message.turnId)}</code>, command: <code key="command">foreman wait</code> })}</span>
                          </span>
                        )}
                        <span className="spacer" />
                        <Button size="sm" variant="ghost" onClick={() => closeEditor(message.id)}>
                          {t('queue.cancel')}
                        </Button>
                        <Button size="sm" variant="primary" disabled={empty} title={empty ? t('queue.emptyEdit') : undefined} onClick={() => void save()}>
                          {t('queue.save')} <Kbd>{mod}↵</Kbd>
                        </Button>
                      </div>
                    </>
                  }
                />
              </li>
            )
          }
          return (
            <li key={message.id}>
              <ActionRow
                ref={rowRef(message.id)}
                className="queued-row"
                onKeyDown={(e) => {
                  // Alt+↑ / Alt+↓ with focus on any control of the row.
                  const direction = queueMoveKey(e)
                  if (!direction) return
                  e.preventDefault()
                  const from = (e.target as HTMLElement).closest<HTMLElement>('[data-queue-action]')?.dataset.queueAction as QueueAction | undefined
                  if (direction === 'up' ? n > 0 : n < queue.length - 1) void move(message.id, direction, from ?? direction)
                }}
                actions={
                  <>
                    <IconButton data-queue-action="up" disabled={n === 0} label={t('queue.moveUp', { key: upKey })} onClick={() => void move(message.id, 'up', 'up')}>
                      <ArrowUp size={13} />
                    </IconButton>
                    <IconButton data-queue-action="down" disabled={n === queue.length - 1} label={t('queue.moveDown', { key: downKey })} onClick={() => void move(message.id, 'down', 'down')}>
                      <ArrowDown size={13} />
                    </IconButton>
                    <IconButton data-queue-action="send" label={t('queue.sendNow')} onClick={() => void attempt(() => api.steerQueued(session.id, message.id))}>
                      <CornerDownLeft size={13} />
                    </IconButton>
                    <IconButton
                      data-queue-action="edit"
                      label={t('queue.edit')}
                      onClick={() => setEditing({ message, revision: session.queueRevision ?? 0, text: message.text, attachments: message.attachments })}
                    >
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton data-queue-action="delete" label={t('queue.delete')} onClick={() => void attempt(() => api.removeQueued(session.id, message.id))}>
                      <Trash2 size={13} />
                    </IconButton>
                  </>
                }
              >
                <span className="pos">{n + 1}</span>
                <span className="queued-text">{message.text || t('queue.attachments', { count: message.attachments.length })}</span>
              </ActionRow>
            </li>
          )
        })}
        {waiting.map((c) => (
          <li key={c.id}>
            <ActionRow
              className="queued-row selection"
              actions={
                <IconButton label={t('queue.delete')} onClick={() => void attempt(() => api.deleteComment(c.id))}>
                  <Trash2 size={13} />
                </IconButton>
              }
            >
              <span className="pos" aria-hidden>
                <MessageSquareQuote size={12} />
              </span>
              <span className="queued-text">
                <Tag tone="outline">{t('queue.selectionTag')}</Tag> {c.body}
                <span className="faint">
                  {' · '}
                  {c.file}:{c.selection!.start === c.selection!.end ? c.selection!.start : `${c.selection!.start}–${c.selection!.end}`}
                </span>
              </span>
              <span className="faint small queued-selection-note">{t('queue.selectionNote')}</span>
            </ActionRow>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PlanBar({ request, sessionId, mod }: { request: Extract<ApprovalRequest, { kind: 'plan' }>; sessionId: string; mod: string }) {
  const t = useT()
  const respond = (handOff: boolean) =>
    void attempt(() => api.respondApproval(request.id, { kind: 'plan', approve: !handOff, handOff }))
  return (
    <div className="plan-bar">
      <ClipboardList size={14} />
      <span>{t('composer.planBar.ready')}</span>
      <span className="spacer" />
      <Button size="sm" icon={<Copy size={12} />} onClick={() => void navigator.clipboard.writeText(request.plan)}>
        {t('common.copy')}
      </Button>
      <Button size="sm" title={t('composer.planBar.handOffTitle')} onClick={() => respond(true)} data-session={sessionId}>
        {t('composer.planBar.handOff')}
      </Button>
      <Button size="sm" variant="primary" title={t('composer.planBar.approveTitle', { key: `${mod}⇧↵` })} onClick={() => respond(false)}>
        {t('composer.planBar.approve')} <Kbd>{mod}⇧↵</Kbd>
      </Button>
    </div>
  )
}

/** "Also try with…": the same prompt in sibling workspaces with other models. Needs every tab idle, and says why when it can't. */
function AlsoTry({ workspace, session, text }: { workspace: Workspace; session: Session; text: string }) {
  const t = useT()
  const reason = useStoreMemo((s) => [workspace, s.snapshot!.sessions, t], ([ws, sessions, tr]) => compareBlockFor(ws, sessions, tr))
  return (
    <LinkButton
      size="sm"
      disabled={Boolean(reason)}
      title={reason ?? t('composer.alsoTry.title')}
      onClick={() => openCompareDialog({ workspaceId: workspace.id, sessionId: session.id, prompt: text })}
    >
      <Users size={12} /> {t('composer.alsoTry.label')}
    </LinkButton>
  )
}
