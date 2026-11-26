// A link in an agent's reply that names a file: the forms agents write (Antigravity's file:/// and </C:/…>, Claude's and
// Codex's worktree-relative paths with a line) resolve to a full path; web links, other schemes and anchors don't.
import { describe, expect, it } from 'vitest'
import { fileLinkPath, looksLikeFileLink } from '../src/shared/fileLink'

const root = 'C:\\work\\repo'

describe('fileLinkPath', () => {
  it('reads a file:/// link, decoding its name', () => {
    expect(fileLinkPath('file:///C:/Users/me/.gemini/brain/mobile-mocks.html')).toBe('C:/Users/me/.gemini/brain/mobile-mocks.html')
    expect(fileLinkPath('file:///Users/me/My%20Notes.md')).toBe('/Users/me/My Notes.md')
    expect(fileLinkPath('file://localhost/Users/me/a.md')).toBe('/Users/me/a.md')
  })

  it('reads a drive path written as a URL path, and plain full paths', () => {
    expect(fileLinkPath('/C:/Users/me/mocks/mobile/index.html')).toBe('C:/Users/me/mocks/mobile/index.html')
    expect(fileLinkPath('C:\\Users\\me\\all-screens.png')).toBe('C:\\Users\\me\\all-screens.png')
    expect(fileLinkPath('/Users/me/a.md')).toBe('/Users/me/a.md')
  })

  it('puts a relative path in the worktree and drops a line after it', () => {
    expect(fileLinkPath('src/a.ts#L42', root)).toBe('C:\\work\\repo\\src\\a.ts')
    expect(fileLinkPath('./src/a.ts:42:7', root)).toBe('C:\\work\\repo\\src\\a.ts')
    expect(fileLinkPath('docs/x.md', '/home/me/repo')).toBe('/home/me/repo/docs/x.md')
  })

  it('opens nothing for a relative path without a worktree', () => {
    expect(fileLinkPath('src/a.ts')).toBeNull()
  })

  it('leaves web links, other schemes and anchors alone', () => {
    for (const href of ['https://example.com/a.html', 'http://localhost:5173', 'mailto:a@b.c', 'vscode://file/C:/a.ts', '#top', ''])
      expect(fileLinkPath(href, root)).toBeNull()
  })
})

describe('looksLikeFileLink', () => {
  it('is true for the forms Markdown would drop as an unsafe scheme', () => {
    expect(looksLikeFileLink('file:///C:/a.html')).toBe(true)
    expect(looksLikeFileLink('C:/a.html')).toBe(true)
    expect(looksLikeFileLink('C:\\a.html')).toBe(true)
    expect(looksLikeFileLink('javascript:alert(1)')).toBe(false)
    expect(looksLikeFileLink('https://example.com')).toBe(false)
  })
})
