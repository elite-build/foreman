// `foreman completion bash|zsh|fish|pwsh`: shell completion scripts generated from the command table, so a
// new command or option completes without anyone touching a script. They complete command and subcommand
// names, options and the fixed words an option or a positional takes. They never call the app.
import { ALIASES, COMMANDS, COMMON_OPTIONS, visibleCommands, type CommandSpec } from '../shared/cliCommands'
import { topicNames } from './help'

export const SHELLS = ['bash', 'zsh', 'fish', 'pwsh'] as const
export type Shell = (typeof SHELLS)[number]

interface Node {
  // What can come next: subcommands, or the words a positional takes.
  words: string[]
  // Options, long and short spellings.
  flags: string[]
  // Option → the words it takes.
  choices: Record<string, string[]>
  // For fish: a description for each word.
  describe: Record<string, string>
}

/** Every place the cursor can be: the root, each noun with verbs, each command. Keyed by the words typed so far. */
export function completionModel(commands: CommandSpec[] = COMMANDS): Map<string, Node> {
  const visible = visibleCommands(commands)
  const model = new Map<string, Node>()
  const node = (key: string): Node => {
    if (!model.has(key)) model.set(key, { words: [], flags: [], choices: {}, describe: {} })
    return model.get(key)!
  }
  const add = (list: string[], word: string) => {
    if (!list.includes(word)) list.push(word)
  }
  const root = node('')
  add(root.flags, '--help')
  add(root.flags, '--version')
  const top = new Set(visible.map((c) => c.path[0]))
  for (const spec of visible) {
    add(root.words, spec.path[0])
    root.describe[spec.path[0]] ??= spec.path.length === 1 ? spec.summary : ''
    // Each prefix of a longer path is a noun listing its verbs.
    for (let i = 1; i < spec.path.length; i++) {
      const parent = node(spec.path.slice(0, i).join(' '))
      add(parent.words, spec.path[i])
      parent.describe[spec.path[i]] = spec.summary
    }
    const own = node(spec.path.join(' '))
    const options = { ...spec.options, ...COMMON_OPTIONS }
    for (const [name, option] of Object.entries(options)) {
      add(own.flags, `--${name}`)
      if (option.short) add(own.flags, `-${option.short}`)
      if (option.choices) {
        own.choices[`--${name}`] = [...option.choices]
        if (option.short) own.choices[`-${option.short}`] = [...option.choices]
      }
    }
    const first = spec.args[0]
    if (first?.choices) for (const word of first.choices) add(own.words, word)
  }
  // An alias completes where the noun it stands for does.
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!top.has(target[0]) || target.length > 1) continue
    add(root.words, alias)
    model.set(alias, model.get(target[0])!)
  }
  const help = node('help')
  for (const word of [...root.words, ...topicNames()]) add(help.words, word)
  return model
}

const q = (text: string) => `'${text.replace(/'/g, "'\\''")}'`
const pq = (text: string) => `'${text.replace(/'/g, "''")}'`
const fq = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** The paths a typed word may extend: every key of the model but the root. */
function known(model: Map<string, Node>): string[] {
  return [...model.keys()].filter(Boolean)
}

function bash(model: Map<string, Node>): string {
  const cases = [...model.entries()].map(([key, n]) => `    ${q(key)}) words=${q(n.words.join(' '))}; flags=${q(n.flags.join(' '))} ;;`)
  const values = [...model.entries()].flatMap(([key, n]) => Object.entries(n.choices).map(([flag, list]) => `    ${q(`${key}:${flag}`)}) COMPREPLY=($(compgen -W ${q(list.join(' '))} -- "$cur")); return ;;`))
  return `# bash completion for foreman. Load it with: source <(foreman completion bash)
_foreman() {
  local cur prev path="" w next i words flags
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    case "$w" in -*) continue ;; esac
    next="\${path:+$path }$w"
    case "$next" in
      ${known(model).map(q).join('|')}) path="$next" ;;
    esac
  done
  case "$path:$prev" in
${values.join('\n')}${values.length ? '\n' : ''}  esac
  case "$path" in
${cases.join('\n')}
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$words" -- "$cur"))
  fi
}
complete -F _foreman foreman
`
}

function zsh(model: Map<string, Node>): string {
  const cases = [...model.entries()].map(([key, n]) => `    ${q(key)}) candidates=(${n.words.map(q).join(' ')}); flags=(${n.flags.map(q).join(' ')}) ;;`)
  const values = [...model.entries()].flatMap(([key, n]) => Object.entries(n.choices).map(([flag, list]) => `    ${q(`${key}:${flag}`)}) compadd -- ${list.map(q).join(' ')}; return ;;`))
  return `#compdef foreman
# zsh completion for foreman. Load it with: source <(foreman completion zsh)
_foreman() {
  local path="" w next cur="\${words[CURRENT]}" prev="\${words[CURRENT-1]}"
  local -a candidates flags
  for w in "\${(@)words[2,CURRENT-1]}"; do
    [[ "$w" == -* ]] && continue
    next="\${path:+$path }$w"
    case "$next" in
      ${known(model).map(q).join('|')}) path="$next" ;;
    esac
  done
  case "$path:$prev" in
${values.join('\n')}${values.length ? '\n' : ''}  esac
  case "$path" in
${cases.join('\n')}
  esac
  if [[ "$cur" == -* ]]; then
    compadd -- $flags
  else
    compadd -- $candidates
  fi
}
if [ "$funcstack[1]" = "_foreman" ]; then
  _foreman "$@"
else
  compdef _foreman foreman
fi
`
}

function fish(model: Map<string, Node>): string {
  const lines = [
    '# fish completion for foreman. Save it with: foreman completion fish > ~/.config/fish/completions/foreman.fish',
    'function __foreman_path',
    '  set -l path foreman',
    '  set -l typed (commandline -opc)',
    '  set -e typed[1]',
    '  for w in $typed',
    "    string match -q -- '-*' $w; and continue",
    '    set -l next "$path $w"',
    `    contains -- "$next" ${known(model)
      .map((k) => fq(`foreman ${k}`))
      .join(' ')}; and set path "$next"`,
    '  end',
    '  echo $path',
    'end',
    'complete -c foreman -f'
  ]
  for (const [key, n] of model) {
    const at = `-n ${fq(`test (__foreman_path) = ${fq(key ? `foreman ${key}` : 'foreman')}`)}`
    // fish's `test` takes the quoted path literally, so the inner quotes are part of the condition.
    for (const word of n.words) lines.push(`complete -c foreman ${at} -a ${fq(word)}${n.describe[word] ? ` -d ${fq(n.describe[word])}` : ''}`)
    for (const flag of n.flags) {
      const long = flag.startsWith('--')
      const values = n.choices[flag]
      lines.push(`complete -c foreman ${at} ${long ? '-l' : '-s'} ${flag.replace(/^-+/, '')}${values ? ` -x -a ${fq(values.join(' '))}` : ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function pwsh(model: Map<string, Node>): string {
  const key = (k: string) => pq(k ? `foreman ${k}` : 'foreman')
  const list = (items: string[]) => `@(${items.map(pq).join(', ')})`
  const words = [...model.entries()].map(([k, n]) => `    ${key(k)} = ${list(n.words)}`)
  const flags = [...model.entries()].map(([k, n]) => `    ${key(k)} = ${list(n.flags)}`)
  const choices = [...model.entries()].flatMap(([k, n]) => Object.entries(n.choices).map(([flag, values]) => `    ${pq(`${k ? `foreman ${k}` : 'foreman'}|${flag}`)} = ${list(values)}`))
  return `# PowerShell completion for foreman. Load it with: foreman completion pwsh | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName foreman -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $known = @(${known(model)
    .map((k) => pq(`foreman ${k}`))
    .join(', ')})
  $words = @{
${words.join('\n')}
  }
  $flags = @{
${flags.join('\n')}
  }
  $choices = @{
${choices.join('\n')}
  }
  $typed = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -ne '' -and $typed.Count -gt 0) {
    if ($typed.Count -gt 1) { $typed = @($typed[0..($typed.Count - 2)]) } else { $typed = @() }
  }
  $path = 'foreman'
  foreach ($w in $typed) {
    if ($w.StartsWith('-')) { continue }
    $next = "$path $w"
    if ($known -contains $next) { $path = $next }
  }
  $prev = if ($typed.Count -gt 0) { $typed[-1] } else { '' }
  if ($choices.ContainsKey("$path|$prev")) { $candidates = $choices["$path|$prev"] }
  elseif ($wordToComplete.StartsWith('-')) { $candidates = $flags[$path] }
  else { $candidates = $words[$path] }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`
}

export function completionScript(shell: string, commands: CommandSpec[] = COMMANDS): string | undefined {
  const model = completionModel(commands)
  switch (shell) {
    case 'bash':
      return bash(model)
    case 'zsh':
      return zsh(model)
    case 'fish':
      return fish(model)
    case 'pwsh':
      return pwsh(model)
    default:
      return undefined
  }
}
