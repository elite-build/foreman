// O9 (G4): a saved command's exit status, from a marker typed with it or the shell's own OSC 133.
import { describe, expect, it } from 'vitest'
import { CommandStatusScanner, commandInput, commandInputWithStatus, statusShell } from '../src/shared/savedCommands'
import { createT } from '../src/shared/i18n'

describe('statusShell', () => {
  it('knows the shells it can ask', () => {
    expect(statusShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
    expect(statusShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
    expect(statusShell('C:\\Windows\\system32\\cmd.exe')).toBe('cmd')
    expect(statusShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix')
    expect(statusShell('C:\\Windows\\system32\\wsl.exe')).toBe('posix')
    expect(statusShell('/bin/zsh')).toBe('posix')
    expect(statusShell('/opt/homebrew/bin/fish')).toBeNull()
    expect(statusShell('nu')).toBeNull()
  })
})

describe('commandInputWithStatus', () => {
  it('puts the marker on the last line, so a command reading input never reads it', () => {
    expect(commandInputWithStatus('npm test', 'posix')).toBe(`npm test; printf '\\033]133;D;%s\\007' "$?"\r`)
    expect(commandInputWithStatus('npm ci\nnpm test\n', 'posix')).toBe(`npm ci\rnpm test; printf '\\033]133;D;%s\\007' "$?"\r`)
    expect(commandInputWithStatus('dir', 'cmd')).toBe('dir & call echo [foreman:exit=%^ERRORLEVEL%]\r')
    const ps = commandInputWithStatus('npm test', 'powershell')
    expect(ps.startsWith('npm test; $__fo=$?;')).toBe(true)
    expect(ps).toContain('$LASTEXITCODE')
  })

  it('an unknown shell, a background job or an empty line types the command as before', () => {
    expect(commandInputWithStatus('npm test', null)).toBe(commandInput('npm test'))
    expect(commandInputWithStatus('npm run dev &', 'posix')).toBe('npm run dev &\r')
    // `&&` is a chain, not a background job.
    expect(commandInputWithStatus('a &&', 'posix')).toContain('printf')
  })
})

describe('CommandStatusScanner', () => {
  it('reads OSC 133;D with a status, ended by BEL or ST', () => {
    const s = new CommandStatusScanner()
    expect(s.feed('out\x1b]133;D;0\x07$ ')).toEqual([0])
    expect(s.feed('\x1b]133;D;2\x1b\\')).toEqual([2])
    expect(s.feed('\x1b]133;D;1;aid=7\x07')).toEqual([1])
  })

  it('skips a "finished" with no status and the other OSC 133 marks', () => {
    const s = new CommandStatusScanner()
    expect(s.feed('\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D\x07')).toEqual([])
  })

  it('finds a marker split across chunks, once', () => {
    const s = new CommandStatusScanner()
    expect(s.feed('build ok\x1b]13')).toEqual([])
    expect(s.feed('3;D;')).toEqual([])
    expect(s.feed('127\x07prompt> ')).toEqual([127])
    expect(s.feed('more')).toEqual([])
  })

  it("reads cmd's plain marker, but not the echo of the typed line", () => {
    const s = new CommandStatusScanner()
    expect(s.feed('C:\\w> dir & call echo [foreman:exit=%^ERRORLEVEL%]\r\n')).toEqual([])
    expect(s.feed('File Not Found\r\n[foreman:exit=1]\r\n')).toEqual([1])
  })

  it('the tab title is translated', () => {
    expect(createT('es')('commands.exit.fail', { code: 2 })).toBe('El último comando falló (salida 2)')
  })
})
