// #14 (G4): the apps' real icons (app.getFileIcon on the program, cached) instead of monograms.
import { describe, expect, it } from 'vitest'
import { OpenInService, type OpenInProbe } from '../src/main/openIn'
import { iconSources, type OpenInApp } from '../src/shared/openIn'
import { createT } from '../src/shared/i18n'

const app = (id: OpenInApp['id'], path: string | null, launcher?: string) => ({ id, path, ...(launcher ? { launcher } : {}) })

describe('iconSources', () => {
  it('Windows: the program beside a bin\\*.cmd launcher, else the .exe itself', () => {
    expect(iconSources(app('vscode', 'C:\\Users\\y\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'), 'win32')).toEqual([
      'C:\\Users\\y\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
    ])
    expect(iconSources(app('cursor', 'C:\\P\\cursor\\Cursor.exe', 'C:\\P\\cursor\\resources\\app\\bin\\cursor.cmd'), 'win32')[0]).toBe('C:\\P\\cursor\\Cursor.exe')
    expect(iconSources(app('intellij', 'C:\\JetBrains\\IDEA\\bin\\idea64.exe'), 'win32')).toEqual(['C:\\JetBrains\\IDEA\\bin\\idea64.exe'])
    // A Toolbox script has no program beside it: no icon, so the monogram stays.
    expect(iconSources(app('webstorm', 'C:\\Users\\y\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\webstorm.cmd'), 'win32')).toEqual([])
    expect(iconSources(app('files', 'C:\\Windows\\explorer.exe'), 'win32')).toEqual(['C:\\Windows\\explorer.exe'])
  })

  it('macOS: the .app bundle around a command-line tool inside it', () => {
    expect(iconSources(app('vscode', '/Applications/Visual Studio Code.app', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'), 'darwin')).toEqual([
      '/Applications/Visual Studio Code.app'
    ])
    expect(iconSources(app('zed', '/usr/local/bin/zed'), 'darwin')).toEqual(['/usr/local/bin/zed'])
  })

  it('nothing for an app that was not found', () => {
    expect(iconSources(app('zed', null), 'win32')).toEqual([])
  })
})

function probe(files: string[]): OpenInProbe {
  return {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\L', PATH: '' },
    exists: (f) => files.includes(f),
    readdir: () => [],
    run: async () => null
  }
}

describe('OpenInService.icons', () => {
  it('asks the OS once per file, skips missing files, and leaves out apps without an icon', async () => {
    const asked: string[] = []
    const files = ['C:\\L\\Programs\\Microsoft VS Code\\Code.exe', 'C:\\Windows\\explorer.exe']
    const service = new OpenInService(
      () => ({ openInDefault: '', openInPaths: { vscode: 'C:\\L\\Programs\\Microsoft VS Code\\bin\\code.cmd' }, editorCommand: '' }),
      {
        openPath: async () => {},
        fileIcon: async (file) => {
          asked.push(file)
          return file.endsWith('Code.exe') ? 'data:image/png;base64,AAA' : null
        }
      },
      () => probe([...files, 'C:\\L\\Programs\\Microsoft VS Code\\bin\\code.cmd'])
    )
    const first = await service.icons()
    expect(first).toEqual({ vscode: 'data:image/png;base64,AAA' })
    await service.icons()
    expect(asked.filter((f) => f.endsWith('Code.exe'))).toHaveLength(1)
  })

  it('a host without icons gives none', async () => {
    const service = new OpenInService(() => ({ openInDefault: '', openInPaths: {}, editorCommand: '' }), { openPath: async () => {} }, () => probe([]))
    expect(await service.icons()).toEqual({})
  })

  it('the right-click hint is translated', () => {
    expect(createT('es')('openIn.setDefault.title')).toBe('App predeterminada para Abrir')
  })
})
