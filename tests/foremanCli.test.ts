import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForemanCli } from '../src/main/foremanCli'
import { METHODS } from '../src/main/cli/methods'
import { MCP_CLI_READ_COMMANDS } from '../src/shared/foremanCli'
import { READABLE_SETTINGS } from '../src/shared/assistant'
import { SETTINGS_SCHEMA } from '../src/shared/settingsSchema'
import { delegationRig } from './foremanDelegationHarness'

afterEach(() => vi.restoreAllMocks())

describe('workspace MCP CLI escape hatch', () => {
  it('uses CLI parsing and handlers, preserving their per-setting agent read policy', async () => {
    const r = delegationRig()
    const cli = new ForemanCli(r.host)
    r.state.settings.workspacesRoot = 'private-workspace-path'
    const update = r.host.api.updateSettings = vi.fn(async () => r.state.settings)
    const token = vi.spyOn(r.host, 'cliToken')
    for (const spec of SETTINGS_SCHEMA) {
      const query = cli.call({ args: ['settings', 'get', spec.key] }, r.scope)
      if ((READABLE_SETTINGS as readonly string[]).includes(spec.field)) {
        const result = await query
        expect(result.output).toContain(spec.key)
        expect(result.contentIsData).toBe(true)
      } else expect(JSON.parse((await query).output)).toMatchObject({ rows: [], omitted: [spec.key] })
    }
    expect((await cli.call({ args: ['settings', 'list'] }, { ...r.scope, readOnly: true })).output).not.toContain('private-workspace-path')
    expect(update).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
  })

  it('supports the reviewed CLI reads and help without treating help as execution', async () => {
    const r = delegationRig()
    const cli = new ForemanCli(r.host)
    for (const args of [['settings', 'keys'], ['settings', 'search', 'theme'], ['settings', 'path', 'appearance.theme'], ['settings'], ['--help'], ['new', '--help']]) {
      expect((await cli.call({ args }, r.scope)).output.length).toBeGreaterThan(0)
    }
    expect(r.createWorkspace).not.toHaveBeenCalled()
  })

  it('redirects supported operations to dedicated tools and refuses writes, I/O and scope overrides', async () => {
    const r = delegationRig()
    const cli = new ForemanCli(r.host)
    await expect(cli.call({ args: ['new', 'research'] }, r.scope)).rejects.toThrow('start_task')
    await expect(cli.call({ args: ['checks'] }, r.scope)).rejects.toThrow('run_checks')
    for (const args of [
      ['settings', 'set', 'appearance.theme', 'dark'],
      ['settings', 'import', 'settings.json'], ['settings', 'export', '--out', 'settings.json'],
      ['settings', 'path', 'appearance.theme', '--open'], ['settings', 'get', 'appearance.theme', '--yes'],
      ['repo', 'settings', 'list', 'other'], ['mcp-bridge', 'app'],
      ['settings', 'get', 'appearance.theme; echo injected']
    ]) await expect(cli.call({ args }, r.scope)).rejects.toThrow()
    await expect(cli.call({ args: ['settings', 'list'], cwd: 'elsewhere' }, r.scope)).rejects.toThrow()
    expect(r.createWorkspace).not.toHaveBeenCalled()
    expect(r.state.settings.theme).toBe('system')
  })

  it('fails closed when a reviewed method changes tier and checks revocation before returning output', async () => {
    const r = delegationRig()
    const cli = new ForemanCli(r.host)
    const original = METHODS['settings-get']
    try {
      METHODS['settings-get'] = { ...original, tier: 'admin' }
      await expect(cli.call({ args: ['settings', 'get', 'appearance.theme'] }, r.scope)).rejects.toThrow('reviewed fallback policy')
    } finally { METHODS['settings-get'] = original }
    let live = true
    vi.spyOn(original, 'handle').mockImplementationOnce(async () => { live = false; return { text: 'private-result' } })
    await expect(cli.call({ args: ['settings', 'get', 'appearance.theme'] }, { ...r.scope, refresh: () => {
      if (!live) throw new Error('grant revoked')
      return r.scope
    } })).rejects.toThrow('grant revoked')
    r.session.closedAt = 'now'
    await expect(cli.call({ args: ['--help'] }, r.scope)).rejects.toThrow('no longer available')
    for (const method of Object.values(MCP_CLI_READ_COMMANDS)) expect(METHODS[method].tier).toBe('read')
  })

  it('bounds output and refuses cancelled requests', async () => {
    const r = delegationRig()
    const cli = new ForemanCli(r.host)
    vi.spyOn(METHODS['settings-list'], 'handle').mockResolvedValueOnce({ text: '', rows: ['x'.repeat(40_000)] })
    const result = await cli.call({ args: ['settings', 'list'] }, r.scope)
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBe(32_000)
    await expect(cli.call({ args: ['--help'] }, { ...r.scope, signal: AbortSignal.abort() })).rejects.toThrow('cancelled')
  })
})
