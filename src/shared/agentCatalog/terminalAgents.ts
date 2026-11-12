// The terminal agents: each one's own CLI in a terminal tab in the worktree. Foreman sees the files and the process, not
// the conversation, so they have no capability record. Agents whose sign-in nobody has confirmed are UNCONFIRMED
// ("Check docs") and get no keys.
import { TERMINAL_CAPS, UNCONFIRMED, type CatalogAgent } from './catalog'

export const TERMINAL_AGENTS: CatalogAgent[] = [
  {
    id: 'aider', name: 'Aider', monogram: 'Ai', level: 'terminal', binaries: ['aider'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://aider.chat/docs/install.html', scratch: ['.aider*']
  },
  {
    id: 'amp', name: 'Amp', monogram: 'Am', level: 'terminal', binaries: ['amp'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'AMP_API_KEY', keyUrl: 'https://ampcode.com/settings' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://ampcode.com/manual'
  },
  {
    id: 'crush', name: 'Crush', monogram: 'Cr', level: 'terminal', binaries: ['crush'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/charmbracelet/crush', scratch: ['.crush/']
  },
  {
    id: 'cline', name: 'Cline', monogram: 'Cl', level: 'terminal', binaries: ['cline'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['auth'] }, apiKey: { envVar: 'CLINE_API_KEY' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/cline/cline'
  },
  {
    id: 'kiro', name: 'Kiro', monogram: 'Kr', level: 'terminal', binaries: ['kiro-cli'], versionArgs: ['--version'], terminal: { args: ['chat'] },
    auth: { login: { args: ['login'], statusArgs: ['whoami', '--format', 'json'], statusFormat: 'json-account' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://kiro.dev/docs/getting-started/installation/'
  },
  {
    id: 'kilocode', name: 'Kilo Code', monogram: 'Kc', level: 'terminal', binaries: ['kilo', 'kilocode'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['auth', 'login'] }, sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli'
  },
  {
    id: 'continue', name: 'Continue', monogram: 'Co', level: 'terminal', binaries: ['cn'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.continue.dev/cli/quickstart'
  },
  {
    id: 'devin', name: 'Devin', monogram: 'Dv', level: 'terminal', binaries: ['devin'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['auth', 'login'], statusArgs: ['auth', 'status'] }, apiKey: { envVar: 'DEVIN_API_KEY' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.devin.ai/get-started/devin-intro'
  },
  {
    id: 'openhands', name: 'OpenHands', monogram: 'Oh', level: 'terminal', binaries: ['openhands'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.openhands.dev/openhands/usage/cli/installation', scratch: ['.openhands/']
  },
  {
    id: 'auggie', name: 'Auggie', monogram: 'Au', level: 'terminal', binaries: ['auggie'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.augmentcode.com/cli/overview'
  },
  {
    id: 'grok', name: 'Grok CLI', monogram: 'Gr', level: 'terminal', binaries: ['grok'], versionArgs: ['--version'], terminal: { args: ['--no-auto-update'] },
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'XAI_API_KEY', keyUrl: 'https://console.x.ai' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.x.ai/build/overview'
  },
  {
    id: 'vibe', name: 'Mistral Vibe', monogram: 'Mv', level: 'terminal', binaries: ['vibe'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['--setup'] }, apiKey: { envVar: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/mistralai/mistral-vibe', scratch: ['.vibe/']
  },
  { id: 'kimchi', name: 'Kimchi', monogram: 'Kh', level: 'terminal', binaries: ['kimchi'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.kimchi.dev/docs/coding-getting-started' },
  { id: 'muse', name: 'Muse', monogram: 'Mu', level: 'terminal', binaries: ['muse'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://ai.meta.com/llama/' },
  { id: 'mimo', name: 'Mimo Code', monogram: 'Mi', level: 'terminal', binaries: ['mimo'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/XiaomiMiMo/MiMo-Code' },
  { id: 'autohand', name: 'Autohand', monogram: 'Ah', level: 'terminal', binaries: ['autohand'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.autohand.ai/working-with-autohand-code/cli' },
  { id: 'codewhale', name: 'Codewhale', monogram: 'Cw', level: 'terminal', binaries: ['codewhale', 'codew'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/Hmbown/Codewhale' },
  { id: 'primeagent', name: 'Prime Agent', monogram: 'Pa', level: 'terminal', binaries: ['prime-agent'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md' }
]
