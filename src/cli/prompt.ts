// Asking for a passphrase without echoing it. Scripts set FOREMAN_PASSPHRASE instead.
import { CliError } from './client'

export function readPassphrase(question: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.FOREMAN_PASSPHRASE) return Promise.resolve(env.FOREMAN_PASSPHRASE)
  const input = process.stdin
  if (!input.isTTY) return Promise.reject(new CliError('Needs a passphrase: set FOREMAN_PASSPHRASE, or run this in a terminal.'))
  return new Promise((resolve) => {
    process.stderr.write(question)
    let value = ''
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          input.setRawMode(false)
          process.stderr.write('\n')
          process.exit(130)
        }
        if (ch === '\r' || ch === '\n') {
          input.setRawMode(false)
          input.pause()
          input.off('data', onData)
          process.stderr.write('\n')
          return resolve(value)
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    input.on('data', onData)
  })
}
