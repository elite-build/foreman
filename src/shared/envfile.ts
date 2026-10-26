// Dotenv parsing shared by env files (main) and the "paste KEY=VALUE lines"
// shortcut in Settings (renderer). Deliberately small: no interpolation.

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface EnvPair {
  key: string
  value: string
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch))
}

/** Index of the quote that closes a value opened with `quote` at position 0, or -1. */
function closingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === quote) return i
  }
  return -1
}

/**
 * Parse dotenv text. Blank lines and `#` comments are skipped, `export ` is
 * allowed, values may be "double" (with \n \t escapes) or 'single' quoted.
 * Quoted values may span lines when `multiline` is set (used for pasting).
 * Lines whose name isn't a valid variable name are reported in `invalid`.
 */
export function parseDotenv(text: string, options: { multiline?: boolean } = {}): { pairs: EnvPair[]; invalid: string[] } {
  const pairs: EnvPair[] = []
  const invalid: string[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trimStart()
    const eq = line.indexOf('=')
    if (eq <= 0) {
      invalid.push(line)
      continue
    }
    const key = line.slice(0, eq).trim()
    let rest = line.slice(eq + 1).trimStart()
    if (!ENV_NAME.test(key)) {
      invalid.push(key)
      continue
    }
    let value: string
    const quote = rest[0]
    if (quote === '"' || quote === "'") {
      let end = closingQuote(rest, quote)
      // A quoted value may continue on the next lines when pasting.
      while (end < 0 && options.multiline && n + 1 < lines.length) {
        rest += '\n' + lines[++n]
        end = closingQuote(rest, quote)
      }
      const body = end < 0 ? rest.slice(1) : rest.slice(1, end)
      value = quote === '"' ? unescapeDouble(body) : body
    } else {
      // Unquoted: a " #" starts a comment.
      const comment = rest.search(/\s#/)
      value = (comment >= 0 ? rest.slice(0, comment) : rest).trim()
    }
    pairs.push({ key, value })
  }
  return { pairs, invalid }
}

/** Serialize one value for an env file, quoting only when needed. */
export function formatEnvValue(value: string): string {
  if (value === '') return '""'
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}
