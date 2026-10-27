// Every searchable setting. Pages give each row `id={…}` from here so search
// can scroll to it; repository rows are repeated for each repo. Shared so the
// assistant (main) can search and point at the same rows.
import type { AgentKind } from './agents'
import type { PlainKey } from './i18n'

export type PersonalSection = 'general' | 'account' | 'integrations' | 'appearance' | 'accessibility' | 'models' | 'git' | 'environment' | 'experimental' | 'advanced' | 'usage' | 'data' | 'cloud'
export type RepoSection = 'git' | 'environment' | 'integrations' | 'scripts' | 'cloud' | 'actions' | 'misc'

export interface SettingEntry {
  id: string
  // English; search matches it in every language.
  title: string
  // The translated title shown in the menu and search results (O13; rows without one stay English).
  titleKey?: PlainKey
  // English, like `title`; search matches it in every language.
  description?: string
  // The translated description: the menu row's tooltip, and matched by search.
  descriptionKey?: PlainKey
  keywords?: string[]
  // Where it lives.
  // #22: `agent` may also be one of the Agents pages ('catalog', 'signin', 'keys') or any catalog agent.
  page: { section: PersonalSection } | { section: 'agents'; agent: AgentKind | string } | { section: 'repo'; tab: RepoSection }
  // Only on macOS.
  mac?: boolean
  // Only on Windows (O4).
  windows?: boolean
}

// Keys: t() them at render time.
export const PAGE_LABELS: Record<PersonalSection | 'agents', PlainKey> = {
  general: 'settings.general.title',
  account: 'settings.page.account',
  integrations: 'settings.page.integrations',
  appearance: 'settings.appearance.title',
  accessibility: 'settings.page.accessibility',
  models: 'settings.page.models',
  git: 'settings.page.git',
  agents: 'agentCatalog.page.title',
  environment: 'settings.page.environment',
  experimental: 'settings.page.experimental',
  advanced: 'settings.page.advanced',
  usage: 'settings.page.usage',
  data: 'settings.page.data',
  // Remote (cloud) workspaces.
  cloud: 'settings.page.cloud'
}

export type SettingsCategory = 'general' | 'appearance' | 'accessibility' | 'agents' | 'account' | 'integrations' | 'git' | 'environment' | 'data' | 'advanced' | 'cloud'

/**
 * The tabs across the top of Settings. A tab shows its pages one after another; the first
 * page is where the tab opens. Prompt templates live in Automations and phone pairing on
 * the sidebar's phone pill, not here.
 */
export const CATEGORIES: { id: SettingsCategory; label: PlainKey; pages: (PersonalSection | 'agents')[] }[] = [
  { id: 'general', label: 'settings.general.title', pages: ['general'] },
  { id: 'appearance', label: 'settings.appearance.title', pages: ['appearance'] },
  { id: 'accessibility', label: 'settings.page.accessibility', pages: ['accessibility'] },
  { id: 'agents', label: 'settings.category.agents', pages: ['agents', 'models'] },
  // Remote workspaces sit beside the agents they run.
  { id: 'cloud', label: 'settings.page.cloud', pages: ['cloud'] },
  { id: 'account', label: 'settings.category.account', pages: ['account'] },
  { id: 'integrations', label: 'settings.page.integrations', pages: ['integrations'] },
  { id: 'git', label: 'settings.page.git', pages: ['git'] },
  { id: 'environment', label: 'settings.page.environment', pages: ['environment'] },
  { id: 'data', label: 'settings.category.data', pages: ['data', 'usage'] },
  { id: 'advanced', label: 'settings.page.advanced', pages: ['advanced', 'experimental'] }
]

export function categoryOf(section: PersonalSection | 'agents'): SettingsCategory {
  return CATEGORIES.find((c) => c.pages.includes(section))!.id
}

export const REPO_TAB_LABELS: Record<RepoSection, PlainKey> = {
  git: 'settings.page.git',
  environment: 'settings.page.environment',
  integrations: 'settings.page.integrations',
  scripts: 'settings.repoTab.scripts',
  cloud: 'settings.repoTab.cloud',
  actions: 'settings.repoTab.actions',
  misc: 'settings.repoTab.misc'
}

// Extra words that find a page itself.
export const PAGE_KEYWORDS: Record<PersonalSection | 'agents' | RepoSection, string[]> = {
  general: ['preferences', 'config', 'notifications', 'sound', 'send', 'language'],
  account: ['user', 'profile', 'login', 'sign in', 'github', 'privacy'],
  integrations: ['linear', 'slack', 'github', 'token', 'api key', 'mcp', 'accounts', 'connections', 'work', 'personal', 'notifications', 'dm', 'reviewers'],
  appearance: ['theme', 'colors', 'display', 'dark', 'light', 'font', 'layout', 'panes'],
  accessibility: ['low vision', 'screen reader', 'text size', 'font size', 'motion', 'animation', 'nvda', 'voiceover', 'a11y'],
  models: ['thinking', 'plan', 'fast', 'loadout', 'effort'],
  git: ['branch', 'version', 'control', 'commit', 'pull request'],
  agents: ['harness', 'api', 'key', 'claude', 'codex', 'cursor', 'opencode', 'sign in'],
  environment: ['env', 'vars', 'env vars', 'variables', 'secrets', 'path', 'proxy'],
  experimental: ['beta', 'labs', 'features'],
  advanced: ['storage', 'folder', 'terminal', 'cli', 'command line'],
  usage: ['cost', 'spend', 'turns', 'time', 'minutes', 'model', 'repo', 'billing'],
  data: ['database', 'sqlite', 'backup', 'storage', 'history', 'clear', 'legacy', 'icloud', 'dropbox'],
  scripts: ['setup script', 'archive script', 'run', 'dev server'],
  actions: ['spotlight', 'code review', 'fix errors', 'preferences', 'prompts'],
  misc: ['repository', 'root path', 'workspaces path', 'icon', 'files to copy', 'preview'],
  cloud: ['remote', 'cloud', 'vercel', 'docker', 'e2b', 'daytona', 'sandbox', 'microvm', 'snapshot', 'setup token', 'install script']
}

const p = (section: PersonalSection) => ({ section })
const a = (agent: AgentKind) => ({ section: 'agents' as const, agent })
const r = (tab: RepoSection) => ({ section: 'repo' as const, tab })

export const SETTINGS: SettingEntry[] = [
  // General
  {
    id: 'language',
    page: p('general'),
    titleKey: 'settings.language.label',
    title: 'Language',
    description: 'Menus, buttons, settings and statuses. Applies immediately.',
    descriptionKey: 'settings.language.help',
    // The word in each offered language, so it can be found from any of them.
    keywords: ['locale', 'translation', 'i18n', 'idioma', 'langue', 'sprache', 'língua', '语言', '言語', '언어']
  },
  { id: 'message-send-key', page: p('general'), titleKey: 'settings.general.sendKey.label', title: 'Send messages with', description: 'Choose which key combination sends messages', descriptionKey: 'settings.general.sendKey.help' },
  { id: 'follow-up-mode', page: p('general'), titleKey: 'settings.general.followUp.label', title: 'Follow-up behavior', description: 'Queue messages to send after the agent finishes, or steer the agent mid-turn.', descriptionKey: 'settings.general.followUp.help', keywords: ['queue', 'steer'] },
  { id: 'notifications', page: p('general'), titleKey: 'settings.general.notifications.label', title: 'Agent notifications', description: 'Get notified when an agent finishes working.', descriptionKey: 'settings.general.notifications.help' },
  { id: 'completion-sound', page: p('general'), titleKey: 'settings.general.sound.label', title: 'Completion sound', description: 'Choose what plays when an agent finishes working in a chat.', descriptionKey: 'settings.general.sound.help', keywords: ['chime', 'audio'] },
  { id: 'dock-badge', page: p('general'), titleKey: 'settings.general.dockBadge.label', title: 'Dock badge', description: 'Show how many chats are waiting for you on the app icon.', descriptionKey: 'settings.general.dockBadge.help' },
  // #3
  { id: 'tray-icon', page: p('general'), titleKey: 'attention.settings.tray', title: 'Tray icon', description: 'How many workspaces need you, with a list that jumps to each one, in the menu bar or system tray.', descriptionKey: 'settings.row.trayIcon.desc', keywords: ['menu bar', 'tray', 'status bar', 'count'] },
  { id: 'full-disk-access', page: p('general'), titleKey: 'settings.general.fullDisk.label', title: 'Full disk access permissions', description: 'To let agents work without repeated folder permission prompts.', descriptionKey: 'settings.general.fullDisk.help', mac: true },
  { id: 'auto-convert-long-text', page: p('general'), titleKey: 'settings.general.autoConvert.label', title: 'Auto-convert long text', description: 'Convert pasted text over 5000 characters into text attachments', descriptionKey: 'settings.general.autoConvert.help' },
  { id: 'assistant', page: p('general'), titleKey: 'assistant.settings.enabled', title: 'Foreman assistant', description: 'Ask how to configure Foreman and get things done. Runs on your default agent.', descriptionKey: 'assistant.settings.enabledHelp', keywords: ['assistant', 'help', 'ask', 'ai', 'how do i'] },
  { id: 'welcome-tour', page: p('general'), titleKey: 'tour.label', title: 'Welcome tour', description: 'A short walk past Foreman’s main controls.', descriptionKey: 'tour.settings.help', keywords: ['tour', 'onboarding', 'help', 'getting started', 'introduction', 'walkthrough'] },
  { id: 'assistant-history', page: p('general'), titleKey: 'assistant.settings.history', title: 'Assistant history', description: 'Delete every assistant conversation.', descriptionKey: 'assistant.settings.historyHelp', keywords: ['assistant', 'clear', 'conversations'] },
  { id: 'not-absolutely-right', page: p('general'), titleKey: 'settings.general.notAbsolutelyRight.label', title: "I'm not absolutely right, thank you very much", description: 'Strip "You\'re absolutely right!" from agent messages', descriptionKey: 'settings.general.notAbsolutelyRight.help' },
  { id: 'always-show-context-usage', page: p('general'), titleKey: 'settings.general.contextUsage.label', title: 'Always show context usage', description: 'By default, it is only shown when more than 70% is used.', descriptionKey: 'settings.general.contextUsage.help', keywords: ['context wheel', 'tokens'] },
  { id: 'keep-awake', page: p('general'), titleKey: 'settings.general.keepAwake.label', title: 'Keep the computer awake while agents run', description: 'Prevent your computer from sleeping while an agent is actively working.', descriptionKey: 'settings.general.keepAwake.help', keywords: ['caffeinate', 'sleep', 'battery', 'thermal', 'hot', 'power'] },
  { id: 'check-for-updates', page: p('general'), titleKey: 'settings.general.checkForUpdates.label', title: 'Check for updates when Foreman starts', description: 'Ask GitHub for the newest Foreman release at each start and say when there is one to download. Nothing is downloaded or installed for you.', descriptionKey: 'settings.general.checkForUpdates.help', keywords: ['update', 'upgrade', 'version', 'release', 'download', 'new version', 'about'] },
  { id: 'expand-tool-calls', page: p('general'), titleKey: 'settings.general.expandToolCalls.label', title: "Don't collapse tool calls", description: 'Show all tool calls expanded by default instead of collapsed. Toggle with ⌃O.', descriptionKey: 'settings.row.expandToolCalls.desc', keywords: ['garry mode'] },
  // #14: the default app, the detected apps with their paths, and the custom command (the old Editor command).
  {
    id: 'open-in-apps',
    page: p('general'),
    titleKey: 'settings.openIn.section',
    title: 'Open in apps',
    description: 'The default app for the Open button, the editors and terminals Foreman found, and the custom command.',
    descriptionKey: 'settings.row.openInApps.desc',
    keywords: ['editor command', 'custom command', 'open in editor', 'vscode', 'vs code', 'cursor', 'zed', 'windsurf', 'intellij', 'jetbrains', 'sublime', 'terminal', 'iterm', 'ghostty', 'finder', 'explorer']
  },
  { id: 'terminal-shell', page: p('general'), titleKey: 'settings.terminal.shell.label', title: 'Shell', description: 'The shell new terminal tabs start: PowerShell 7, Windows PowerShell, Git Bash, Command Prompt, WSL or a custom one.', descriptionKey: 'settings.row.terminalShell.desc', keywords: ['terminal', 'pwsh', 'powershell', 'git bash', 'bash', 'cmd', 'command prompt', 'wsl', 'zsh'], windows: true },
  { id: 'scripts-run-with', page: p('general'), titleKey: 'settings.terminal.scripts.label', title: 'Scripts run with', description: 'Run scripts, setup and checks go through their own shell, cmd.exe by default.', descriptionKey: 'settings.row.scriptsRunWith.desc', keywords: ['cmd', 'script shell'], windows: true },

  // Account
  { id: 'github', page: p('account'), title: 'GitHub', description: 'How Foreman authenticates GitHub operations on this computer.', descriptionKey: 'settings.account.github.desc', keywords: ['gh', 'token', 'pat'] },
  { id: 'privacy-mode', page: p('account'), titleKey: 'settings.account.privacyMode', title: 'Privacy mode', description: 'Turn off features that send your messages to an AI provider outside a chat, such as generated chat titles.', descriptionKey: 'settings.account.privacyMode.help', keywords: ['enterprise data privacy'] },
  { id: 'claude-tool-approvals', page: p('account'), titleKey: 'settings.account.claudeApprovals', title: 'Claude Code tool approvals', description: 'Require manual approval before agents can run tools.', descriptionKey: 'settings.account.claudeApprovals.help', keywords: ['permissions'] },
  { id: 'codex-tool-approvals', page: p('account'), titleKey: 'settings.account.codexApprovals', title: 'Codex tool approvals', keywords: ['sandbox', 'permissions'] },

  // Integrations
  { id: 'integrations-connections', page: p('integrations'), titleKey: 'integrations.connections.title', title: 'Connections', description: 'GitHub, Linear and Slack accounts Foreman and your agents use, with one default per service.', descriptionKey: 'settings.row.integrationsConnections.desc', keywords: ['linear', 'slack', 'github', 'token', 'api key', 'pat', 'mcp', 'work', 'personal', 'account'] },
  { id: 'slack-rules', page: p('integrations'), titleKey: 'integrations.rules.title', title: 'Slack rules', description: 'Message yourself, reviewers or a channel when a pull request or agent needs attention.', descriptionKey: 'settings.row.slackRules.desc', keywords: ['slack', 'dm', 'notify', 'review', 'reviewer', 'ci', 'pull request'] },
  { id: 'slack-people', page: p('integrations'), titleKey: 'integrations.people.title', title: 'People', description: 'Which Slack person each GitHub reviewer is.', descriptionKey: 'settings.row.slackPeople.desc', keywords: ['slack', 'github', 'reviewer', 'match'] },

  // Appearance
  { id: 'theme', page: p('appearance'), titleKey: 'settings.appearance.theme', title: 'Theme', description: 'Light, dark, or follow the system. Toggle with ⌘⌥T.', descriptionKey: 'settings.row.theme.desc' },
  { id: 'zoom', page: p('appearance'), titleKey: 'settings.appearance.zoom', title: 'App zoom', description: 'Adjust the size of the interface.', descriptionKey: 'settings.appearance.zoom.help' },
  { id: 'colored-sidebar-diffs', page: p('appearance'), titleKey: 'settings.appearance.coloredDiffs', title: 'Colored sidebar diffs', description: 'Always show line change colors in the sidebar, even for unselected workspaces.', descriptionKey: 'settings.appearance.coloredDiffs.help' },
  { id: 'window-layout', page: p('appearance'), titleKey: 'settings.appearance.windowLayout', title: 'Window layout', description: 'One workspace with its changes beside it, or several workspaces side by side.', descriptionKey: 'settings.row.windowLayout.desc', keywords: ['layout', 'tiles', 'grid', 'panes', 'side by side', 'parallel'] },
  { id: 'sidebar-side', page: p('appearance'), titleKey: 'settings.appearance.sidebar', title: 'Workspaces sidebar', description: 'Which side of the window the sidebar sits on.', descriptionKey: 'settings.appearance.sidebar.help', keywords: ['layout', 'left', 'right', 'move', 'pane'] },
  { id: 'side-panel-side', page: p('appearance'), titleKey: 'settings.appearance.sidePanel', title: 'Side panel', description: 'Which side of the chat the changes and checks panel sits on.', descriptionKey: 'settings.appearance.sidePanel.help', keywords: ['layout', 'left', 'right', 'move', 'pane', 'changes'] },
  { id: 'terminal-placement', page: p('appearance'), titleKey: 'settings.appearance.terminalPanel', title: 'Terminal panel', description: 'Where Run, Setup and terminals go.', descriptionKey: 'settings.row.terminalPlacement.desc', keywords: ['layout', 'bottom', 'move', 'pane', 'run'] },
  { id: 'pane-sizes', page: p('appearance'), titleKey: 'settings.appearance.paneSizes', title: 'Pane sizes', description: "Reset every pane to its default size.", descriptionKey: 'settings.row.paneSizes.desc', keywords: ['layout', 'resize', 'width', 'height'] },
  { id: 'color-vision', page: p('appearance'), titleKey: 'settings.appearance.colorVision', title: 'Accessible colors', description: 'Theme optimized for color vision differences.', descriptionKey: 'settings.appearance.colorVision.help', keywords: ['color blind', 'deuteranopia', 'tritanopia'] },
  // Accessibility
  { id: 'content-font-size', page: p('accessibility'), titleKey: 'settings.accessibility.contentSize.label', title: 'Content text size', description: 'The size of chat messages, diff code and files. The rest of the interface keeps its own size.', descriptionKey: 'settings.accessibility.contentSize.help', keywords: ['accessibility', 'low vision', 'text size', 'font size', 'larger text', 'magnify', 'zoom', 'a11y'] },
  { id: 'terminal-font-content', page: p('accessibility'), titleKey: 'settings.accessibility.terminalFollows.label', title: 'Terminal text follows content size', description: 'Terminals use the content text size instead of their own.', descriptionKey: 'settings.accessibility.terminalFollows.help', keywords: ['accessibility', 'low vision', 'text size', 'font size', 'terminal', 'a11y'] },
  { id: 'reduce-motion', page: p('accessibility'), titleKey: 'settings.accessibility.reduceMotion.label', title: 'Reduce motion', description: 'Stop spinning, pulsing, sliding and smooth scrolling. Automatic follows the system setting.', descriptionKey: 'settings.accessibility.reduceMotion.help', keywords: ['accessibility', 'motion', 'animation', 'animations', 'vestibular', 'spinner', 'a11y'] },
  { id: 'announce', page: p('accessibility'), titleKey: 'settings.accessibility.announce.label', title: 'Announce agent activity', description: 'What the screen reader is told about agents: only what needs you, your open chat too, or every chat.', descriptionKey: 'settings.accessibility.announce.help', keywords: ['accessibility', 'announce', 'announcements', 'screen reader', 'live region', 'narrator', 'nvda', 'voiceover', 'a11y'] },
  { id: 'announce-summary', page: p('accessibility'), titleKey: 'settings.accessibility.announceSummary.label', title: 'Say what changed when a turn ends', description: 'Announces the end-of-turn summary (files, lines, checks) instead of only that the agent finished.', descriptionKey: 'settings.accessibility.announceSummary.help', keywords: ['accessibility', 'summary', 'announce', 'screen reader', 'live region', 'finished', 'a11y'] },
  { id: 'earcons', page: p('accessibility'), titleKey: 'settings.accessibility.earcons.label', title: 'Sound cues', description: 'Four short sounds for started, needs you, finished and failed, in place of the completion sound.', descriptionKey: 'settings.accessibility.earcons.help', keywords: ['accessibility', 'earcon', 'earcons', 'sound', 'audio', 'cue', 'chime', 'a11y'] },
  { id: 'speech-output', page: p('accessibility'), titleKey: 'settings.accessibility.speech.label', title: "Foreman reads announcements aloud", description: "Foreman speaks announcements itself, with a voice from your system, instead of sending them to the screen reader.", descriptionKey: 'settings.accessibility.speech.help', keywords: ['accessibility', 'speech', 'voice', 'text to speech', 'tts', 'read aloud', 'speak', 'narrator', 'a11y'] },
  { id: 'speech-voice', page: p('accessibility'), titleKey: 'settings.accessibility.voice.label', title: 'Voice', description: "Which voice on your system Foreman speaks with. Automatic uses the default voice for the interface language.", descriptionKey: 'settings.accessibility.voice.help', keywords: ['accessibility', 'speech', 'voice', 'text to speech', 'tts', 'read aloud', 'a11y'] },
  { id: 'speech-rate', page: p('accessibility'), titleKey: 'settings.accessibility.rate.label', title: 'Speech rate', description: 'How fast Foreman speaks, from half speed to double.', descriptionKey: 'settings.accessibility.rate.help', keywords: ['accessibility', 'speech', 'voice', 'rate', 'speed', 'text to speech', 'tts', 'read aloud', 'a11y'] },
  { id: 'stt-provider', page: p('accessibility'), title: 'Speech to text engine', description: 'Dictate with the model that runs on this computer, or send the audio to OpenAI with your own key. OpenAI is refused while Privacy mode is on.', keywords: ['accessibility', 'speech', 'dictation', 'voice input', 'microphone', 'whisper', 'openai', 'speech to text', 'stt', 'a11y'] },
  { id: 'stt-language', page: p('accessibility'), title: 'Dictation language', description: 'The language you speak when you dictate, as a language code such as en.', keywords: ['accessibility', 'speech', 'dictation', 'voice input', 'microphone', 'whisper', 'language', 'a11y'] },
  { id: 'push-to-talk', page: p('accessibility'), title: 'Push to talk', description: 'Hold the dictation keys to record and let go to stop, or press once to start and again to stop.', keywords: ['accessibility', 'speech', 'dictation', 'voice input', 'microphone', 'push to talk', 'hold', 'toggle', 'a11y'] },
  { id: 'speech-volume', page: p('accessibility'), titleKey: 'settings.accessibility.volume.label', title: 'Speech volume', description: "How loud Foreman's voice is, relative to the system volume.", descriptionKey: 'settings.accessibility.volume.help', keywords: ['accessibility', 'speech', 'voice', 'volume', 'loud', 'text to speech', 'tts', 'read aloud', 'a11y'] },
  { id: 'terminal-screen-reader', page: p('accessibility'), title: 'Screen reader support', titleKey: 'settings.advanced.screenReader.label', description: 'Lets a screen reader read terminal output. Automatic turns it on while the system reports a screen reader.', descriptionKey: 'settings.advanced.screenReader.help', keywords: ['accessibility', 'screen reader', 'nvda', 'jaws', 'voiceover', 'narrator', 'terminal', 'a11y'] },
  // #21
  { id: 'home-board', page: p('appearance'), titleKey: 'settings.home.board.label', title: 'Board view on Home', description: 'Adds a List | Board switch to Home.', descriptionKey: 'settings.row.homeBoard.desc', keywords: ['kanban', 'lanes', 'board', 'home'] },
  { id: 'home-layout', page: p('appearance'), titleKey: 'settings.home.layout.label', title: 'Default Home layout', description: 'What Home shows when Foreman starts.', descriptionKey: 'settings.row.homeLayout.desc', keywords: ['kanban', 'board', 'list', 'home'] },
  { id: 'home-done-days', page: p('appearance'), titleKey: 'settings.home.doneDays.label', title: 'Show Done lane for', description: 'How long finished work stays on the board.', descriptionKey: 'settings.row.homeDoneDays.desc', keywords: ['kanban', 'board', 'done', 'merged'] },
  { id: 'mono-font', page: p('appearance'), titleKey: 'settings.appearance.monoFont', title: 'Mono font', description: 'Font used for code and diffs', descriptionKey: 'settings.appearance.monoFont.help' },
  { id: 'code-ligatures', page: p('appearance'), titleKey: 'settings.appearance.ligatures', title: 'Code ligatures', description: 'Use font ligatures in file views and diffs.', descriptionKey: 'settings.appearance.ligatures.help' },
  { id: 'terminal-font', page: p('appearance'), titleKey: 'settings.appearance.terminalFont', title: 'Terminal font', description: 'Font family and size for the terminal.', descriptionKey: 'settings.appearance.terminalFont.help' },

  // Default models
  { id: 'loadout', page: p('models'), titleKey: 'settings.row.loadout', title: 'Loadout', description: 'Choose which models you want to use', descriptionKey: 'settings.row.loadout.desc', keywords: ['default model', 'model picker', 'favorite models', 'edit models'] },
  { id: 'claude-output-style', page: p('models'), titleKey: 'settings.row.claudeOutputStyle', title: 'Claude output style', description: 'Choose which output style to apply to new chats.', descriptionKey: 'settings.row.claudeOutputStyle.desc', keywords: ['personality', 'concise', 'explanatory', 'learning'] },
  { id: 'review-model', page: p('models'), titleKey: 'settings.row.reviewModel', title: 'Review model', description: 'Used when you ask for a code review.', descriptionKey: 'settings.row.reviewModel.desc' },
  { id: 'default-plan-mode', page: p('models'), titleKey: 'settings.row.defaultPlanMode', title: 'Default to plan mode in new chats' },

  // Git
  // O2
  { id: 'gitlab-accounts', page: p('git'), titleKey: 'gitlab.accounts.title', title: 'Accounts', description: 'Where Foreman reads pull requests, merge requests and CI: GitHub and GitLab hosts.', descriptionKey: 'settings.row.gitlabAccounts.desc', keywords: ['gitlab', 'glab', 'github', 'token', 'self-managed', 'merge request', 'host', 'pipeline'] },
  { id: 'open-pr-in', page: p('git'), titleKey: 'settings.git.openPrIn.label', title: 'Open pull requests in', keywords: ['graphite'] },
  { id: 'branch-prefix', page: p('git'), titleKey: 'settings.git.branchPrefix.label', title: 'Branch name prefix', description: 'Prefix for new workspace branch names.', descriptionKey: 'settings.git.branchPrefix.help', keywords: ['username'] },
  { id: 'auto-rename-branches', page: p('git'), titleKey: 'settings.git.autoRename.label', title: 'Automatically rename new branches' },
  { id: 'rename-workspace-with-branch', page: p('git'), titleKey: 'settings.git.renameWorkspace.label', title: 'Rename workspace when branch is named' },
  { id: 'delete-branch-on-archive', page: p('git'), titleKey: 'settings.git.deleteBranchOnArchive.label', title: 'Delete branch on archive', description: 'Delete the local branch when archiving a workspace.', descriptionKey: 'settings.git.deleteBranchOnArchive.help' },
  { id: 'archive-on-merge', page: p('git'), titleKey: 'settings.git.archiveOnMerge.label', title: 'Archive on merge', description: 'Automatically archive a workspace after merging its PR in Foreman', descriptionKey: 'settings.git.archiveOnMerge.help' },
  { id: 'automerge', page: p('git'), titleKey: 'settings.git.automerge.label', title: 'Automerge', description: 'Show an automerge button in the git panel when checks are pending.', descriptionKey: 'settings.row.automerge.desc' },
  { id: 'optional-checks-block', page: p('git'), titleKey: 'settings.git.optionalChecks.label', title: 'Treat optional checks as blocking', description: 'Hide the merge button when any check has failed, including checks GitHub considers optional.', descriptionKey: 'settings.git.optionalChecks.help' },
  { id: 'push-auto-setup-remote', page: p('git'), titleKey: 'settings.git.pushAutoSetupRemote.label', title: 'Set upstream on plain git push', description: 'Configure new workspaces so plain git push sets a branch upstream.', descriptionKey: 'settings.row.pushAutoSetupRemote.desc' },
  { id: 'stacked-prs', page: p('git'), titleKey: 'settings.git.stackedPrs.label', title: 'Use GitHub stacked PRs', description: 'Tell agents they can use gh stack for PR stacking.', descriptionKey: 'settings.row.stackedPrs.desc' },

  // Agents
  // #22
  { id: 'agents-catalog', page: { section: 'agents', agent: 'catalog' }, titleKey: 'agentCatalog.page.title', title: 'Agents', description: 'Every coding agent Foreman can run: enable them, see what each can do, how to install.', descriptionKey: 'settings.row.agentsCatalog.desc', keywords: ['catalog', 'gemini', 'qwen', 'kimi', 'droid', 'copilot', 'goose', 'aider', 'amp', 'crush', 'cline', 'acp', 'terminal agent', 'enable'] },
  { id: 'agents-signin', page: { section: 'agents', agent: 'signin' }, titleKey: 'agentCatalog.signin.title', title: 'Sign-in', description: 'How each agent signs in: Login, API key or shared provider keys.', descriptionKey: 'settings.row.agentsSignin.desc', keywords: ['login', 'api key', 'auth', 'credentials'] },
  { id: 'provider-keys', page: { section: 'agents', agent: 'keys' }, titleKey: 'agentCatalog.keys.title', title: 'Provider keys', description: 'Provider API keys saved once, with the agents allowed to use each.', descriptionKey: 'settings.row.providerKeys.desc', keywords: ['openai', 'anthropic', 'openrouter', 'groq', 'api key', 'shared keys'] },
  { id: 'agent-claude', page: a('claude'), title: 'Claude Code', description: 'Sign-in, API key, Chrome and executable path.', descriptionKey: 'settings.row.agentClaude.desc', keywords: ['anthropic', 'login'] },
  { id: 'chrome-mode', page: a('claude'), titleKey: 'settings.row.chromeMode', title: 'Use Claude Code with Chrome', description: 'Allow Claude Code to control your Chrome browser.', descriptionKey: 'settings.row.chromeMode.desc', keywords: ['browser'] },
  { id: 'agent-codex', page: a('codex'), title: 'Codex', description: 'Sign-in, API key and executable path.', descriptionKey: 'settings.row.agentCodex.desc', keywords: ['openai', 'chatgpt'] },
  { id: 'agent-cursor', page: a('cursor'), title: 'Cursor', description: 'Cursor API key.', descriptionKey: 'settings.row.agentCursor.desc' },
  // O8
  { id: 'models-claude', page: a('claude'), titleKey: 'settings.row.modelsClaude', title: 'Claude Code models', description: 'Choose which models appear in the model picker, with context sizes.', descriptionKey: 'settings.row.agentModels.desc', keywords: ['hide models', 'model picker', 'context window'] },
  { id: 'models-codex', page: a('codex'), titleKey: 'settings.row.modelsCodex', title: 'Codex models', description: 'Choose which models appear in the model picker, with context sizes.', descriptionKey: 'settings.row.agentModels.desc', keywords: ['hide models', 'model picker', 'context window'] },
  { id: 'models-cursor', page: a('cursor'), titleKey: 'settings.row.modelsCursor', title: 'Cursor models', description: 'Choose which models appear in the model picker, with context sizes.', descriptionKey: 'settings.row.agentModels.desc', keywords: ['hide models', 'model picker', 'context window'] },
  { id: 'agent-opencode', page: a('opencode'), title: 'OpenCode', description: 'Providers, models and executable path.', descriptionKey: 'settings.row.agentOpencode.desc', keywords: ['openrouter', 'providers'] },

  // Environment
  { id: 'environment-variables', page: p('environment'), titleKey: 'settings.env.table', title: 'Environment variables', description: 'Variables passed to agents, scripts and terminals.', descriptionKey: 'settings.row.environmentVariables.desc', keywords: ['api key', 'secrets'] },
  { id: 'env-files', page: p('environment'), titleKey: 'settings.env.files.label', title: 'Env files', description: 'Load environment variables from env files.', descriptionKey: 'settings.env.files.help', keywords: ['.env', 'dotenv'] },

  // Experimental
  { id: 'auto-permission-mode', page: p('experimental'), titleKey: 'settings.experimental.autoPermission.label', title: 'Auto permission mode', description: 'Claude decides which actions need your approval.', descriptionKey: 'settings.row.autoPermissionMode.desc', keywords: ['permissions', 'auto mode', 'yolo'] },
  { id: 'auto-run-after-setup', page: p('experimental'), titleKey: 'settings.experimental.autoRun.label', title: 'Auto-run after setup', description: "Start a repository's run script automatically after a new workspace finishes setup.", descriptionKey: 'settings.experimental.autoRun.help' },
  { id: 'fork-to-new-tab', page: p('experimental'), titleKey: 'settings.experimental.fork.label', title: 'Fork chat to new tab', description: "Fork a chat from an answer's ⋯ menu (Fork from here), its tab's context menu, or with ⌘⌥↵.", descriptionKey: 'settings.row.forkToNewTab.desc', keywords: ['fork', 'branch chat', 'fork from here'] },
  { id: 'show-resource-usage', page: p('experimental'), titleKey: 'settings.experimental.resourceUsage.label', title: 'Show resource usage', description: 'Shows CPU and memory usage in the sidebar footer.', descriptionKey: 'settings.experimental.resourceUsage.help' },

  // Advanced
  { id: 'workspaces-folder', page: p('advanced'), titleKey: 'settings.advanced.workspacesFolder.label', title: 'Workspaces folder', description: 'Where new workspaces (git worktrees) are created.', descriptionKey: 'settings.advanced.workspacesFolder.help', keywords: ['root directory'] },
  { id: 'script-shell', page: p('advanced'), titleKey: 'settings.advanced.scriptShell.label', title: 'Script shell', description: 'What runs Run scripts, setup and archive scripts, and checks: Command Prompt, PowerShell or Git Bash.', descriptionKey: 'settings.row.scriptShell.desc', keywords: ['cmd', 'powershell', 'git bash', 'bash', 'scripts', 'FOREMAN_PORT'], windows: true },
  { id: 'terminal-scrollback', page: p('advanced'), titleKey: 'settings.advanced.scrollback.label', title: 'Scrollback limit', description: 'Approximate terminal output to keep.', descriptionKey: 'settings.advanced.scrollback.help' },
  { id: 'terminal-copy-on-select', page: p('advanced'), title: 'Copy on select', titleKey: 'settings.advanced.copyOnSelect.label', description: 'Selecting text in a terminal copies it to the clipboard.', descriptionKey: 'settings.advanced.copyOnSelect.help', keywords: ['clipboard', 'terminal', 'selection'] },
  { id: 'keep-agents-running', page: p('advanced'), title: 'Keep agents running after Quit', titleKey: 'keepRunning.settings.label', description: 'Claude Code and Codex turns run in a background host, so Quit can leave them working.', descriptionKey: 'settings.row.keepAgentsRunning.desc', keywords: ['background', 'quit', 'keep', 'running', 'host', 'tray', 'reconnect', 'restart', 'agents'] },
  { id: 'max-running-agents', page: p('advanced'), title: 'Maximum agents running at once', titleKey: 'settings.advanced.maxAgents.label', description: 'Over it, new turns queue and start oldest first as running ones finish. Remote workspaces don’t count.', descriptionKey: 'settings.advanced.maxAgents.help', keywords: ['limit', 'concurrent', 'parallel', 'queue', 'queued', 'memory', 'agents', 'running'] },
  { id: 'background-wait', page: p('advanced'), title: 'Stop waiting for background tasks', titleKey: 'settings.advanced.backgroundWait.label', description: 'How long a Claude Code turn that has answered stays open for its background shells and subagents.', descriptionKey: 'settings.advanced.backgroundWait.help', keywords: ['background', 'tasks', 'shell', 'subagent', 'timeout', 'memory', 'dev server'] },
  { id: 'terminal-restore', page: p('advanced'), title: 'Restore terminals after a restart', titleKey: 'settings.advanced.restoreTerminals.label', description: 'Terminal tabs come back with their names and last output, dimmed. Processes are not kept.', descriptionKey: 'settings.row.terminalRestore.desc', keywords: ['terminal', 'scrollback', 'restart', 'reopen', 'history', 'tabs'] },
  { id: 'cli-command', page: p('advanced'), titleKey: 'settings.advanced.cli.label', title: 'foreman command', description: 'Start workspaces, change settings and drive Foreman from a terminal.', descriptionKey: 'settings.row.cliCommand.desc', keywords: ['cli', 'command line', 'shell', 'path', 'install'] },

  // Usage
  { id: 'usage-report', page: p('usage'), titleKey: 'settings.page.usage', title: 'Usage', description: 'Reported cost, turns and agent time by repo and model, for the last 7, 30 or 90 days.', descriptionKey: 'settings.row.usageReport.desc', keywords: ['cost', 'spend', 'tokens', 'turns'] },

  // Data & devices
  { id: 'database', page: p('data'), title: 'foreman.db', description: 'Where Foreman keeps workspaces, chats and check results.', descriptionKey: 'settings.row.database.desc', keywords: ['sqlite', 'size', 'messages', 'legacy', 'migration'] },
  { id: 'claude-transcripts', page: p('data'), titleKey: 'settings.data.transcripts', title: 'Claude transcripts', description: 'Claude conversations mirrored in foreman.db, and mirror errors.', descriptionKey: 'settings.row.claudeTranscripts.desc', keywords: ['mirror', 'session', 'native resume', 'transcript'] },
  { id: 'keep-cleared-history', page: p('data'), titleKey: 'settings.data.keepCleared', title: 'Keep cleared history', description: 'Keep turns removed by /clear and rewind, searchable. Off keeps only receipts.', descriptionKey: 'settings.row.keepClearedHistory.desc', keywords: ['clear', 'rewind', 'retention'] },
  { id: 'daily-backup', page: p('data'), titleKey: 'settings.data.dailyBackup', title: 'Daily backup', description: 'A copy of foreman.db and an attachment list, once a day.', descriptionKey: 'settings.row.dailyBackup.desc', keywords: ['backup', 'back up now'] },
  { id: 'backup-folder', page: p('data'), titleKey: 'settings.data.backupFolder', title: 'Backup folder', keywords: ['backup', 'back up now'] },
  { id: 'git-backup-destination', page: p('data'), titleKey: 'settings.gitBackup.title', title: 'Git configuration backup', description: 'Back up settings, templates, repositories and workspace registrations to GitHub or another Git remote.', descriptionKey: 'settings.row.gitBackupDestination.desc', keywords: ['git', 'github', 'restore', 'templates', 'repositories', 'workspaces'] },
  { id: 'daily-git-backup', page: p('data'), titleKey: 'settings.gitBackup.daily', title: 'Daily Git backup', description: 'Back up changed configuration once a day while Foreman is open.', descriptionKey: 'settings.row.dailyGitBackup.desc', keywords: ['git', 'github', 'schedule'] },

  // Repository pages (one set per repo)
  { id: 'repo-base-branch', page: r('git'), titleKey: 'repoSettings.baseBranch.label', title: 'Branch new workspaces from', description: 'Each workspace is an isolated copy of your codebase.', descriptionKey: 'repoSettings.baseBranch.help', keywords: ['default branch', 'main'] },
  { id: 'repo-remote', page: r('git'), titleKey: 'repoSettings.remote.label', title: 'Remote', description: 'Where to push, pull, and open pull requests.', descriptionKey: 'repoSettings.remote.help', keywords: ['origin'] },
  { id: 'repo-github-account', page: r('integrations'), titleKey: 'settings.row.repoGithubAccount', title: 'GitHub account', description: 'The gh account pushes, pull requests and agents in this repo act as.', descriptionKey: 'settings.row.repoGithubAccount.desc', keywords: ['github', 'gh', 'account', 'identity', 'work', 'personal', 'login', 'token'] },
  { id: 'repo-work-in-repo-folder', page: r('git'), titleKey: 'repoSettings.workInRepoFolder.label', title: 'Work directly in the repository folder', description: 'New workspaces default to working on a branch right in this folder.', descriptionKey: 'settings.row.repoWorkInRepoFolder.desc', keywords: ['main', 'no worktree', 'in place', 'direct'] },
  { id: 'repo-delete-branch-on-archive', page: r('git'), titleKey: 'settings.git.deleteBranchOnArchive.label', title: 'Delete branch on archive' },
  { id: 'repo-archive-on-merge', page: r('git'), titleKey: 'settings.git.archiveOnMerge.label', title: 'Archive on merge' },
  { id: 'repo-push-auto-setup-remote', page: r('git'), titleKey: 'settings.git.pushAutoSetupRemote.label', title: 'Set upstream on plain git push' },
  { id: 'repo-linear', page: r('integrations'), titleKey: 'settings.row.repoLinear', title: 'Linear', description: 'The Linear workspace agents and New workspace use in this repository.', descriptionKey: 'settings.row.repoLinear.desc', keywords: ['linear', 'issues', 'mcp', 'work', 'personal', 'api key'] },
  { id: 'repo-slack', page: r('integrations'), titleKey: 'settings.row.repoSlack', title: 'Slack', description: 'The Slack workspace this repository’s rules message through.', descriptionKey: 'settings.row.repoSlack.desc', keywords: ['slack', 'dm', 'notifications', 'rules'] },
  { id: 'repo-environment-variables', page: r('environment'), titleKey: 'settings.env.table', title: 'Environment variables', description: 'Variables for this repository; they override user ones.', descriptionKey: 'settings.row.repoEnvironmentVariables.desc' },
  { id: 'repo-env-files', page: r('environment'), titleKey: 'settings.env.files.label', title: 'Env files' },
  { id: 'setup-script', page: r('scripts'), titleKey: 'settings.row.setupScript', title: 'Setup steps', description: 'Named steps that run in order when a new workspace is created, each with a timeout', descriptionKey: 'settings.row.setupScript.desc' },
  { id: 'setup-retry', page: r('scripts'), titleKey: 'setupSteps.retry.label', title: 'Retry failed step', description: 'Run a setup step that fails or times out once more before setup stops', descriptionKey: 'settings.row.setupRetry.desc' },
  { id: 'archive-script', page: r('scripts'), titleKey: 'settings.row.archiveScript', title: 'Archive steps', description: 'Named steps that run in order before a workspace is archived, each with a timeout', descriptionKey: 'settings.row.archiveScript.desc', keywords: ['archive script', 'parallel'] },
  // O18
  { id: 'repo-docker-cleanup', page: r('scripts'), titleKey: 'settings.row.repoDockerCleanup', title: 'Remove Docker containers when archiving', description: 'Removes the containers labelled foreman.workspace with the workspace’s id.', descriptionKey: 'settings.row.repoDockerCleanup.desc', keywords: ['docker', 'compose', 'container', 'cleanup'] },
  // G3 · O18
  { id: 'repo-docker-extras', page: r('scripts'), titleKey: 'docker.extras.label', title: 'Also remove their volumes and networks', description: 'Anonymous volumes go with the containers; networks they used are removed when nothing else uses them.', descriptionKey: 'settings.row.repoDockerExtras.desc', keywords: ['docker', 'volume', 'network'] },
  { id: 'run-scripts', page: r('scripts'), titleKey: 'repoSettings.runScripts.label', title: 'Run scripts', description: 'Shortcuts for quick actions, like running your dev server or test suite', descriptionKey: 'repoSettings.runScripts.help', keywords: ['dev server'] },
  { id: 'repo-checks', page: r('scripts'), titleKey: 'repoSettings.checks.label', title: 'Checks', description: 'Commands that Run checks runs in each workspace.', descriptionKey: 'settings.row.repoChecks.desc', keywords: ['test', 'lint', 'typecheck'] },
  { id: 'repo-checks-after-turn', page: r('scripts'), titleKey: 'repoSettings.checksAfterTurn.label', title: 'Run checks after a completed turn', description: 'Run the checks when a turn completes and nothing else is working in the workspace.', descriptionKey: 'settings.row.repoChecksAfterTurn.desc', keywords: ['automatic', 'auto', 'test', 'lint'] },
  { id: 'sensitive-paths', page: r('git'), titleKey: 'repoSettings.sensitive.label', title: 'Sensitive paths', description: 'Changes to files matching these patterns are flagged for a closer look.', descriptionKey: 'settings.row.sensitivePaths.desc', keywords: ['migrations', 'lockfile', 'env'] },
  { id: 'run-mode', page: r('scripts'), titleKey: 'repoSettings.runMode.label', title: 'Run mode', description: "Whether starting a run script stops it in the repository's other workspaces.", descriptionKey: 'settings.row.runMode.desc' },
  // #2
  { id: 'teach-agents', page: r('actions'), titleKey: 'reports.settings.teach', title: 'Teach agents Foreman', description: 'Tell agents how to report when they’re stuck, need input or are done, and ask for a review.', descriptionKey: 'settings.row.teachAgents.desc', keywords: ['foreman report', 'review', 'instructions', 'agent says'] },
  { id: 'agents-may-start', page: r('actions'), titleKey: 'reports.settings.mayStart', title: 'Let agents start workspaces and queue messages', description: 'Allow foreman run and foreman send from inside an agent turn.', descriptionKey: 'settings.row.agentsMayStart.desc', keywords: ['foreman run', 'foreman send', 'token'] },
  { id: 'teach-agents-preview', page: r('actions'), titleKey: 'reports.settings.instructions', title: 'Instructions added', description: 'The exact text each agent gets with Teach agents Foreman.', descriptionKey: 'settings.row.teachAgentsPreview.desc' },
  { id: 'plan-the-work', page: r('actions'), titleKey: 'reports.settings.plan', title: '“Plan the work” template', description: 'A lead-chat template that ends with foreman run snippets.', descriptionKey: 'settings.row.planTheWork.desc', keywords: ['lead', 'plan', 'template'] },
  { id: 'spotlight-testing', page: r('actions'), titleKey: 'repoSettings.spotlight.label', title: 'Use spotlight testing', description: 'Test workspace changes in the repository root.', descriptionKey: 'settings.row.spotlightTesting.desc' },
  // #17
  { id: 'auto-review', page: r('actions'), titleKey: 'autoReview.setting.label', title: 'Auto review', description: 'A read-only agent reviews the diff after a worker’s turn passes its checks. Off by default.', descriptionKey: 'settings.row.autoReview.desc', keywords: ['review', 'read-only', 'reviewer', 'budget'] },
  { id: 'prompt-code-review', page: r('actions'), titleKey: 'repoSettings.prompts.codeReview.title', title: 'Code review preferences', description: 'Custom instructions sent to the agent when you click Review.', descriptionKey: 'settings.row.promptCodeReview.desc' },
  { id: 'prompt-create-pr', page: r('actions'), titleKey: 'repoSettings.prompts.createPr.title', title: 'Create PR preferences', description: 'Custom instructions sent to the agent when you click Create PR.', descriptionKey: 'settings.row.promptCreatePr.desc' },
  { id: 'prompt-fix-errors', page: r('actions'), titleKey: 'repoSettings.prompts.fixErrors.title', title: 'Fix errors preferences', description: 'Custom instructions sent to the agent when you click Fix errors.', descriptionKey: 'settings.row.promptFixErrors.desc' },
  { id: 'prompt-resolve-conflicts', page: r('actions'), titleKey: 'repoSettings.prompts.resolveConflicts.title', title: 'Resolve conflicts preferences', description: 'Custom instructions sent to the agent when you click Resolve conflicts.', descriptionKey: 'settings.row.promptResolveConflicts.desc' },
  { id: 'prompt-rename-branch', page: r('actions'), titleKey: 'repoSettings.prompts.renameBranch.title', title: 'Branch rename preferences', description: 'Custom instructions for generating branch names from your messages.', descriptionKey: 'settings.row.promptRenameBranch.desc' },
  { id: 'prompt-general', page: r('actions'), titleKey: 'repoSettings.prompts.general.title', title: 'General preferences', description: 'Custom instructions sent to the agent at the start of every new chat.', descriptionKey: 'settings.row.promptGeneral.desc' },
  { id: 'repo-icon', page: r('misc'), titleKey: 'repoSettings.icon.label', title: 'Icon', description: 'Shown next to the repository name in the sidebar.', descriptionKey: 'repoSettings.icon.help' },
  { id: 'root-path', page: r('misc'), titleKey: 'repoSettings.rootPath.label', title: 'Root path' },
  { id: 'workspaces-path', page: r('misc'), titleKey: 'repoSettings.workspacesPath.label', title: 'Workspaces path' },
  { id: 'preview-urls', page: r('misc'), titleKey: 'repoSettings.previewUrls.label', title: 'Preview URLs', description: "Set the terminal panel's Open URLs.", descriptionKey: 'settings.row.previewUrls.desc', keywords: ['localhost', 'port'] },
  { id: 'files-to-copy', page: r('misc'), titleKey: 'repoSettings.filesToCopy.label', title: 'Files to copy', description: 'Copy these gitignored files into each new workspace.', descriptionKey: 'settings.row.filesToCopy.desc', keywords: ['.env', 'worktreeinclude'] },
  { id: 'remove-repository', page: r('misc'), titleKey: 'repoSettings.remove.label', title: 'Remove repository', keywords: ['delete'] },
  // Remote workspaces: the personal page and each repository's Remote tab.
  { id: 'cloud-workspaces', page: p('cloud'), titleKey: 'cloud.flag.label', title: 'Remote workspaces', description: 'Show the This computer / Remote choice when creating a workspace.', descriptionKey: 'settings.row.cloudFlag.desc', keywords: ['vercel', 'docker', 'e2b', 'daytona', 'sandbox', 'experimental', 'cloud'] },
  { id: 'cloud-claude-auth', page: p('cloud'), titleKey: 'cloud.claude.title', title: 'Claude Code in remote workspaces', description: 'How Claude Code signs in inside sandboxes: a setup token or the API key.', descriptionKey: 'settings.row.cloudClaude.desc', keywords: ['setup-token', 'setup token', 'oauth', 'api key', 'anthropic'] },
  { id: 'cloud-codex-auth', page: p('cloud'), titleKey: 'cloud.codex.title', title: 'Codex in remote workspaces', keywords: ['openai', 'api key'] },
  { id: 'cloud-wake-on-open', page: p('cloud'), titleKey: 'cloud.house.wake.label', title: 'Wake a remote workspace when you open it', keywords: ['wake', 'sleep', 'sandbox'] },
  { id: 'cloud-stop-orphans', page: p('cloud'), titleKey: 'cloud.house.orphans.label', title: 'Stop orphaned sandboxes on launch', keywords: ['orphan', 'cleanup'] },
  { id: 'cloud-delete-snapshots', page: p('cloud'), titleKey: 'cloud.house.snapshots.label', title: 'Delete snapshots when a workspace is forgotten', keywords: ['snapshot', 'storage'] },
  { id: 'cloud-max-running', page: p('cloud'), titleKey: 'cloud.house.max.label', title: 'Max running', description: 'Remote workspaces running at once across all repositories.', descriptionKey: 'settings.row.cloudMaxRunning.desc', keywords: ['limit', 'concurrency', 'sandboxes'] },
  { id: 'cloud-usage', page: p('cloud'), titleKey: 'cloud.usage.rowTitle', title: 'This month’s usage', description: 'This month’s sandbox use on each provider.', descriptionKey: 'settings.row.cloudUsage.desc', keywords: ['usage', 'cpu', 'billing', 'cost'] },
  { id: 'repo-cloud-provider', page: r('cloud'), titleKey: 'cloud.repo.provider.label', title: 'Runs on', keywords: ['provider', 'vercel', 'docker', 'e2b', 'daytona', 'connection'] },
  { id: 'repo-cloud-enabled', page: r('cloud'), titleKey: 'cloud.repo.enabled.label', title: 'Remote workspaces', description: 'Offer Remote in the New workspace dialog for this repository.', descriptionKey: 'settings.row.cloudRepoEnabled.desc', keywords: ['vercel', 'docker', 'e2b', 'daytona', 'sandbox', 'cloud'] },
  { id: 'repo-cloud-size', page: r('cloud'), titleKey: 'cloud.repo.size.label', title: 'Size', description: 'The sandbox’s vCPUs, from the sizes its provider offers.', descriptionKey: 'settings.row.cloudRepoSize.desc', keywords: ['vcpu', 'cpu', 'memory'] },
  { id: 'repo-cloud-region', page: r('cloud'), titleKey: 'cloud.repo.region.label', title: 'Region', description: 'Where sandboxes and their snapshots live.', descriptionKey: 'settings.row.cloudRepoRegion.desc', keywords: ['iad1', 'location'] },
  { id: 'repo-cloud-idle', page: r('cloud'), titleKey: 'cloud.repo.idle.label', title: 'Sleep after', description: 'Minutes idle before a remote workspace’s sandbox sleeps.', descriptionKey: 'settings.row.cloudRepoIdle.desc', keywords: ['idle', 'sleep', 'timeout'] },
  { id: 'repo-cloud-continue', page: r('cloud'), titleKey: 'cloud.repo.continue.label', title: 'Continue an interrupted turn', keywords: ['session limit', 'hobby', '45 minutes'] },
  { id: 'repo-cloud-build', page: r('cloud'), titleKey: 'cloud.repo.computer.title', title: 'Base', description: 'The base every new remote workspace starts from, and its build log.', descriptionKey: 'settings.row.cloudRepoBuild.desc', keywords: ['build', 'base image', 'snapshot', 'log'] },
  { id: 'repo-cloud-install', page: r('cloud'), titleKey: 'cloud.repo.install.label', title: 'Install software', keywords: ['install script', 'apt', 'dependencies'] }
]
