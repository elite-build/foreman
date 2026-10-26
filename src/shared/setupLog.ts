// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** The last `count` non-empty lines of a log, without terminal colour codes. */
export function tailLines(log: string, count: number): string {
  return log
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n')
}
