// The Editor layout's rules: what the activity bar offers for the workspace on screen, and what picking a view does.
import { describe, expect, it } from 'vitest'
import { editorViewOf, editorViewsFor, pickEditorView, shownEditorView } from '../src/renderer/src/editorLayout'
import { workspaceSurfaces } from '../src/renderer/src/archivedView'

const views = (state: Parameters<typeof workspaceSurfaces>[0]['state'], cloud?: object) => [...editorViewsFor(workspaceSurfaces({ state, cloud } as Parameters<typeof workspaceSurfaces>[0]))]

describe('the editor layout', () => {
  it('remembers a view it offers, and falls back to Workspaces for anything else', () => {
    expect(editorViewOf('files')).toBe('files')
    expect(editorViewOf('terminal')).toBe('workspaces')
    expect(editorViewOf(undefined)).toBe('workspaces')
  })

  it('hides the sidebar when the view already showing is picked again, and shows any other', () => {
    expect(pickEditorView('changes', true, 'changes')).toEqual({ view: 'changes', open: false })
    expect(pickEditorView('changes', false, 'changes')).toEqual({ view: 'changes', open: true })
    expect(pickEditorView('changes', false, 'files')).toEqual({ view: 'files', open: true })
    expect(pickEditorView('changes', true, 'workspaces')).toEqual({ view: 'workspaces', open: true })
  })

  it('offers the side panel\'s tabs for the workspace on screen, and only Workspaces without one', () => {
    expect([...editorViewsFor(null)]).toEqual(['workspaces'])
    expect(views('ready')).toEqual(['workspaces', 'changes', 'commits', 'files', 'checks'])
    // A cloud workspace has no folder here to browse.
    expect(views('ready', { provider: 'vercel' })).toEqual(['workspaces', 'changes', 'commits', 'checks'])
    // Still being created: nothing to list commits of yet.
    expect(views('creating')).toEqual(['workspaces', 'changes', 'checks'])
    // Archived: its summary, under Changes.
    expect(views('archived')).toEqual(['workspaces', 'changes'])
  })

  it('shows Workspaces while the picked view has nothing to show', () => {
    expect(shownEditorView('files', editorViewsFor(null))).toBe('workspaces')
    expect(shownEditorView('files', new Set(['workspaces', 'files']))).toBe('files')
  })
})
