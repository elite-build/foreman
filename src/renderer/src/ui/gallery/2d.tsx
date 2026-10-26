import { useState } from 'react'
import type { ReactNode } from 'react'
import { Combobox } from '../Combobox'
import { Dialog, Sheet } from '../Dialog'
import { HoverCard } from '../HoverCard'
import { Listbox } from '../Listbox'
import type { ListboxOption } from '../Listbox'
import { Popover } from '../Popover'
import { Resizer } from '../Resizer'
import { Tree, TreeItem } from '../Tree'
import type { TreeNodeRow } from '../Tree'

// Dev-only page of every overlay and structure component, states included. Plain strings: it never ships.
// Dialogs and sheets are drawn as non-modal previews inside frames so they can all be seen (and screenshotted) at
// once; the buttons open the real, modal ones.

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 } as const
const stack = { display: 'flex', flexDirection: 'column', gap: 8 } as const
const frame = { position: 'relative', width: 420, height: 300, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' } as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ ...stack, marginBottom: 24 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

const LANGUAGES: ListboxOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français', disabled: true, description: 'Translation in progress' },
  { value: 'de', label: 'Deutsch' },
  { value: 'long', label: 'A language with a very long name that has to be cut off at the edge of the list' }
]

const MODELS: ListboxOption[] = [
  { value: 'a', label: 'Claude Opus', group: 'Claude', trailing: <span className="faint">default</span> },
  { value: 'b', label: 'Claude Sonnet', group: 'Claude', description: 'Faster, lower cost' },
  { value: 'c', label: 'GPT', group: 'Codex' },
  { value: 'd', label: 'Composer', group: 'Cursor', disabled: true, description: 'Not signed in' }
]

const BRANCHES: ListboxOption[] = [
  { value: 'main', label: 'main', trailing: <span className="faint">default</span> },
  { value: 'feature/login', label: 'feature/login' },
  { value: 'feature/logout', label: 'feature/logout', disabled: true, description: '~/work/logout' },
  { value: 'release/2026-10-with-a-very-long-branch-name-that-keeps-going', label: 'release/2026-10-with-a-very-long-branch-name-that-keeps-going' }
]

const TREE: (TreeNodeRow & { name: string })[] = [
  { path: 'src', name: 'src', dir: true, depth: 0, expanded: true },
  { path: 'src/main', name: 'main', dir: true, depth: 1, expanded: false },
  { path: 'src/shared', name: 'shared', dir: true, depth: 1, expanded: true },
  { path: 'src/shared/types.ts', name: 'types.ts', dir: false, depth: 2 },
  { path: 'src/shared/a-file-with-a-rather-long-name-that-is-cut-off.ts', name: 'a-file-with-a-rather-long-name-that-is-cut-off.ts', dir: false, depth: 2 },
  { path: 'README.md', name: 'README.md', dir: false, depth: 0 }
]

function PopoverDemo({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <div style={{ height: 240, display: 'flex', alignItems: 'flex-end' }}>
      <Popover open={open} onOpenChange={setOpen} label="Model" trigger={(props) => <button {...props} className="ui-btn">Model</button>}>
        <Listbox label="Models" options={MODELS} value="b" onChange={() => setOpen(false)} />
      </Popover>
    </div>
  )
}

function ComboDemo({ startOpen, inline, initial = '' }: { startOpen?: boolean; inline?: boolean; initial?: string }) {
  const [query, setQuery] = useState(initial)
  const [value, setValue] = useState<string | null>('main')
  const [open, setOpen] = useState<boolean | undefined>(startOpen)
  const shown = BRANCHES.filter((b) => b.value.includes(query))
  return (
    <div style={{ width: 300 }}>
      <Combobox
        label="Branch"
        mono
        inline={inline}
        options={shown}
        value={value}
        query={query}
        onQueryChange={setQuery}
        onChange={setValue}
        open={open}
        onOpenChange={startOpen === undefined ? undefined : setOpen}
        placeholder={value ?? 'Choose a branch'}
        empty="No branches match"
      />
    </div>
  )
}

function Dialogs() {
  const [dialog, setDialog] = useState(false)
  const [sheet, setSheet] = useState(false)
  return (
    <div style={row}>
      <div style={stack}>
        <span className="faint">Dialog (preview)</span>
        <div style={frame}>
          <Dialog preview title="Rename workspace" description="Pick a name you will recognise." closeLabel="Close" onClose={() => {}} footer={<><button className="ui-btn">Cancel</button><button className="ui-btn ui-btn--primary">Save</button></>}>
            <input aria-label="Name" defaultValue="fix-login" style={{ width: '100%' }} />
          </Dialog>
        </div>
      </div>
      <div style={stack}>
        <span className="faint">Dialog, large, toolbar, long body (preview)</span>
        <div style={frame}>
          <Dialog preview size="lg" title="Choose an agent" toolbar={<input aria-label="Search" placeholder="Search" style={{ width: '100%' }} />} onClose={() => {}} footer={<button className="ui-btn">Done</button>}>
            {Array.from({ length: 12 }, (_, i) => (
              <p key={i} style={{ margin: '0 0 8px' }}>Agent {i + 1}: a line of body text that scrolls inside the dialog.</p>
            ))}
          </Dialog>
        </div>
      </div>
      <div style={stack}>
        <span className="faint">Sheet (preview)</span>
        <div style={frame}>
          <Sheet preview title="Add variable" description="Saved for every workspace." closeLabel="Close" onClose={() => {}} footer={<><button className="ui-btn">Cancel</button><button className="ui-btn ui-btn--primary">Save</button></>}>
            <label style={stack}>
              Name
              <input defaultValue="ANTHROPIC_BASE_URL" />
            </label>
          </Sheet>
        </div>
      </div>
      <div style={stack}>
        <span className="faint">Real, modal</span>
        <button className="ui-btn" onClick={() => setDialog(true)}>Open dialog</button>
        <button className="ui-btn" onClick={() => setSheet(true)}>Open sheet</button>
        {dialog && (
          <Dialog title="Delete workspace" closeLabel="Close" onClose={() => setDialog(false)} footer={<button className="ui-btn ui-btn--danger" onClick={() => setDialog(false)}>Delete</button>}>
            <p style={{ margin: 0 }}>This removes the worktree. Escape or the backdrop closes it.</p>
          </Dialog>
        )}
        {sheet && (
          <Sheet title="Edit variable" closeLabel="Close" onClose={() => setSheet(false)} footer={<button className="ui-btn ui-btn--primary" onClick={() => setSheet(false)}>Save</button>}>
            <input aria-label="Value" defaultValue="value" />
          </Sheet>
        )}
      </div>
    </div>
  )
}

function TreeDemo() {
  const [selected, setSelected] = useState('src/shared/types.ts')
  return (
    <div style={{ width: 300 }}>
      <Tree label="Files" rows={TREE} onToggle={() => {}} onOpen={setSelected}>
        {TREE.map((r) => (
          <TreeItem key={r.path} path={r.path} selected={r.path === selected} title={r.path}>
            <span className="mono">{r.name}</span>
          </TreeItem>
        ))}
      </Tree>
    </div>
  )
}

function ResizerDemo() {
  const [size, setSize] = useState(220)
  return (
    <div style={{ display: 'flex', height: 120, width: 520, border: '1px solid var(--border)' }}>
      <div style={{ position: 'relative', width: size, flex: 'none', padding: 8, background: 'var(--bg-sidebar)' }}>
        Panel, {size}px
        <Resizer label="Resize panel" edge="right" value={size} min={140} max={360} onResize={(next) => setSize(next)} onReset={() => setSize(220)} />
      </div>
      <div style={{ padding: 8 }}>Content</div>
    </div>
  )
}

export function Gallery2d() {
  const [lang, setLang] = useState('es')
  return (
    <div>
      <Section title="Popover">
        <div style={row}>
          <PopoverDemo startOpen={false} />
          <PopoverDemo startOpen />
        </div>
      </Section>

      <Section title="HoverCard (focus or hover the trigger; the second is held open)">
        <div style={{ ...row, minHeight: 140 }}>
          <HoverCard label="Pull request" trigger={(props) => <button {...props} className="ui-btn">PR #42</button>}>
            <strong>PR #42</strong>
            <span>CI failing (2 checks)</span>
            <button className="ui-link-btn">Refresh</button>
          </HoverCard>
          <HoverCard label="Why" open side="right" width={260} trigger={(props) => <button {...props} className="ui-btn">Why is it here?</button>}>
            <strong>Why this card is in Ready</strong>
            <span>All checks passed, review approved.</span>
          </HoverCard>
        </div>
      </Section>

      <Section title="Listbox">
        <div style={row}>
          <div style={{ width: 260, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)' }}>
            <Listbox label="Language" options={LANGUAGES} value={lang} onChange={setLang} />
          </div>
          <div style={{ width: 260, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)' }}>
            <Listbox label="Models, grouped" options={MODELS} value="b" onChange={() => {}} />
          </div>
        </div>
      </Section>

      <Section title="Combobox (closed, open with a long option, empty, inline results)">
        <div style={{ ...row, minHeight: 260 }}>
          <ComboDemo />
          <ComboDemo startOpen />
          <ComboDemo startOpen initial="zzz" />
          <ComboDemo startOpen inline initial="feature" />
        </div>
      </Section>

      <Section title="Dialog and Sheet">
        <Dialogs />
      </Section>

      <Section title="Tree">
        <TreeDemo />
      </Section>

      <Section title="Resizer (arrow keys, drag, double-click to reset)">
        <ResizerDemo />
      </Section>
    </div>
  )
}
