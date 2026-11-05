import { Code2, Copy, Eye, FileText, Film, FolderOpen, Globe, Image, SquareArrowOutUpRight } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import { fileOpenKind, isAbsolutePath, type FileOpenKind } from '../../../shared/fileOpen'
import { joinWorkspace } from '../../../shared/openIn'
import { relativeToRoots } from '../../../shared/portable'
import { useT, type RendererT } from '../i18n'
import { api, attempt, requestOpenFile, useStore } from '../store'
import { ChipButton, ContextMenu, MenuItem, MenuLabel, MenuSeparator } from '../ui'
import { useDefaultLabel } from './OpenIn'

/** What the chat's paths may open: absent for a cloud workspace, whose files are in its sandbox, not on this computer. */
export interface FileAccess {
  workspaceId: string
  // The worktree, for paths an agent gave relative to it, Copy relative path and Preview in Foreman.
  root?: string
  // Foreman's file viewer can show the workspace's files (a local worktree).
  preview: boolean
}

/** The full path a tool call named, or null when it can't be found on this computer. */
export function fullPath(file: unknown, root: string | undefined): string | null {
  const p = typeof file === 'string' ? file.trim() : ''
  if (!p) return null
  if (isAbsolutePath(p)) return p
  return root ? joinWorkspace(root, p) : null
}

const KIND_ICON = { browser: Globe, image: Image, pdf: FileText, media: Film, document: SquareArrowOutUpRight, editor: Code2, reveal: FolderOpen } as const

function revealLabel(platform: string, t: RendererT): string {
  if (platform === 'darwin') return t('toolRow.open.revealFinder')
  return platform === 'win32' ? t('toolRow.open.revealExplorer') : t('toolRow.open.revealFolder')
}

function openLabel(kind: FileOpenKind, editor: string, reveal: string, t: RendererT): string {
  if (kind === 'reveal') return reveal
  if (kind === 'editor') return editor ? t('openIn.viewer.inApp', { app: editor }) : t('openIn.viewer.inEditor')
  return t(`toolRow.open.${kind}`)
}

/**
 * A path in a tool call, as a button: a click opens the file where it belongs (shared/fileOpen.ts: a page in the
 * browser, a picture in the image viewer, code in the editor, a program only shown in its folder), Ctrl-click or
 * ⌘-click shows it in its folder, and right-click (or Shift+F10) offers the other places it can go.
 */
export function OpenFileChip({ path, label, access }: { path: string; label: string; access: FileAccess }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const editor = useDefaultLabel().name
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const kind = fileOpenKind(path)
  const reveal = revealLabel(platform, t)
  const action = openLabel(kind, editor, reveal, t)
  const Icon = KIND_ICON[kind]
  const inside = access.root ? relativeToRoots(path, access.root) : path
  const relative = inside !== path ? inside : null
  const open = (how: 'open' | 'reveal') => void attempt(() => api.openFile(path, how))
  const copy = (text: string) => void navigator.clipboard.writeText(text)

  const onContextMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    // From the keyboard (Shift+F10, the Menu key) there is no pointer: the menu opens under the chip.
    const box = e.currentTarget.getBoundingClientRect()
    setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left, y: box.bottom })
  }

  return (
    <>
      <ChipButton
        path
        className="tool-file"
        title={kind === 'reveal' ? `${action}. ${t('toolRow.open.programNote')}` : `${action} · ${t('toolRow.open.moreHint')}`}
        onClick={(e) => open(e.ctrlKey || e.metaKey ? 'reveal' : 'open')}
        onContextMenu={onContextMenu}
      >
        <span className="tool-file-name">{label}</span>
        {kind === 'reveal' ? <FolderOpen size={12} className="tool-file-go" aria-hidden /> : <SquareArrowOutUpRight size={12} className="tool-file-go" aria-hidden />}
      </ChipButton>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={t('toolRow.open.menu')} onClose={() => setMenu(null)}>
          <MenuLabel>{relative ?? label}</MenuLabel>
          <MenuItem icon={<Icon size={14} aria-hidden />} onSelect={() => open('open')}>
            {action}
          </MenuItem>
          {access.preview && relative && kind !== 'reveal' && (
            <MenuItem icon={<Eye size={14} aria-hidden />} onSelect={() => requestOpenFile(access.workspaceId, relative)}>
              {t('toolRow.open.preview')}
            </MenuItem>
          )}
          {/* A page's source is worth reading too; the editor is the one from Settings → Open in apps. */}
          {kind === 'browser' && (
            <MenuItem icon={<Code2 size={14} aria-hidden />} onSelect={() => void attempt(() => api.openInEditor(path))}>
              {openLabel('editor', editor, reveal, t)}
            </MenuItem>
          )}
          <MenuSeparator />
          {kind !== 'reveal' && (
            <MenuItem icon={<FolderOpen size={14} aria-hidden />} onSelect={() => open('reveal')}>
              {reveal}
            </MenuItem>
          )}
          <MenuItem icon={<Copy size={14} aria-hidden />} onSelect={() => copy(path)}>
            {t('changes.menu.copyPath')}
          </MenuItem>
          {relative && (
            <MenuItem icon={<Copy size={14} aria-hidden />} onSelect={() => copy(relative)}>
              {t('changes.menu.copyRelativePath')}
            </MenuItem>
          )}
        </ContextMenu>
      )}
    </>
  )
}
