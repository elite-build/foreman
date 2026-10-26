import { useState } from 'react'
import type { ReactNode } from 'react'
import { ContextMenu } from '../ContextMenu'
import { Disclosure } from '../Disclosure'
import { Menu, MenuButton, MenuCheckboxItem, MenuControlRow, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from '../Menu'
import { Segmented } from '../Segmented'
import { SplitButton } from '../SplitButton'
import { Tab, TabList, TabPanel, Tabs } from '../Tabs'

// Dev-only page of every composite-navigation component and variant, states included. Plain strings: it never ships.

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 24 } as const
const stack = { display: 'flex', flexDirection: 'column', gap: 8 } as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ ...stack, marginBottom: 24 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

const glyph = (path: string) => (
  <svg viewBox="0 0 12 12" width="14" height="14" focusable="false">
    <path d={path} fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const DotsIcon = glyph('M2 6h.01M6 6h.01M10 6h.01')
const ChevronIcon = glyph('M3 4.5l3 3 3-3')
const PlusIcon = glyph('M6 2v8M2 6h8')
const MinusIcon = glyph('M2 6h8')
const CloseIcon = glyph('M3 3l6 6M9 3l-6 6')
const PencilIcon = glyph('M2 10l.6-2.6L8 2l2 2-5.4 5.4z')

const LONG = 'A deliberately long chat title that has to wrap or be cut without breaking the menu around it'

// A menu shown open in the page, so a screenshot sees it without clicks; it keeps its real keyboard behaviour.
const inline = { position: 'static', display: 'inline-block' } as const

function SegmentedDemo() {
  const [view, setView] = useState<string | undefined>('rich')
  const [size, setSize] = useState<string | undefined>('split')
  const [none, setNone] = useState<string | undefined>(undefined)
  const options = [
    { value: 'rich', label: 'Rich' },
    { value: 'source', label: 'Source' },
    { value: 'split', label: 'Split', disabled: true, title: 'Not available for this file' }
  ]
  return (
    <Section title="Segmented">
      <div style={row}>
        <Segmented value={view} options={options} label="Bordered" onChange={setView} />
        <Segmented value={view} options={options} label="Plain" plain onChange={setView} />
        <Segmented value={view} options={options} label="Plain small" plain small onChange={setView} />
      </div>
      <div style={row}>
        <Segmented value={size} options={options} label="Selected option disabled (the Tab stop moves to the first enabled)" onChange={setSize} />
        <Segmented value={none} options={options} label="Nothing picked" onChange={setNone} />
        <Segmented
          value="long"
          options={[
            { value: 'long', label: 'A long option label' },
            { value: 'other', label: 'Another quite long option' }
          ]}
          label="Long labels"
          onChange={() => {}}
        />
      </div>
    </Section>
  )
}

function TabsDemo() {
  const [underline, setUnderline] = useState('general')
  const [pill, setPill] = useState('all')
  const [chat, setChat] = useState('one')
  const [editing, setEditing] = useState<string | null>('two')
  const [disabled, setDisabled] = useState('general')
  return (
    <Section title="Tabs">
      <div style={{ ...stack, maxWidth: 560 }}>
        <Tabs value={underline} onChange={setUnderline}>
          <TabList label="Underline">
            <Tab value="general">General</Tab>
            <Tab value="scripts">Scripts</Tab>
            <Tab value="actions">Actions</Tab>
          </TabList>
          <TabPanel value="general">General settings for this repository.</TabPanel>
          <TabPanel value="scripts">Scripts that run in each workspace.</TabPanel>
          <TabPanel value="actions">Buttons shown in the workspace header.</TabPanel>
        </Tabs>
        <Tabs value={disabled} onChange={setDisabled}>
          <TabList label="Underline with a disabled tab">
            <Tab value="general">General</Tab>
            <Tab value="scripts" disabled title="Needs a repository">
              Scripts
            </Tab>
            <Tab value="actions">Actions with a rather long name</Tab>
          </TabList>
        </Tabs>
        <Tabs value={pill} onChange={setPill} variant="pill">
          <TabList label="Pill">
            <Tab value="all">All</Tab>
            <Tab value="mine">Mine</Tab>
            <Tab value="archived">Archived</Tab>
          </TabList>
        </Tabs>
        <Tabs value={chat} onChange={setChat} variant="chat">
          <TabList label="Chat">
            <Tab value="one" actions={<button className="ui-icon-btn" aria-label="Close Chat one" title="Close Chat one">{CloseIcon}</button>}>
              Chat one
            </Tab>
            <Tab
              value="two"
              editor={editing === 'two' ? <input aria-label="Rename chat" defaultValue="Chat two" onBlur={() => setEditing(null)} /> : undefined}
              actions={<button className="ui-icon-btn" aria-label="Close Chat two" title="Close Chat two">{CloseIcon}</button>}
              onDoubleClick={() => setEditing('two')}
            >
              Chat two
            </Tab>
            <Tab value="long" actions={<button className="ui-icon-btn" aria-label="Close long chat" title="Close long chat">{CloseIcon}</button>}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{LONG}</span>
            </Tab>
            <button className="ui-icon-btn" aria-label="New chat" title="New chat">
              {PlusIcon}
            </button>
          </TabList>
        </Tabs>
      </div>
    </Section>
  )
}

function MenusDemo() {
  const [wrap, setWrap] = useState(true)
  const [target, setTarget] = useState('a')
  const [zoom, setZoom] = useState(100)
  return (
    <Section title="Menu">
      <div style={row}>
        <MenuButton label="Row actions" look="icon" trigger={DotsIcon}>
          <MenuItem>Reset</MenuItem>
        </MenuButton>
        <MenuButton label="Add repository" trigger={<>Add repository {ChevronIcon}</>} placement="bottom-start">
          <MenuItem icon={PlusIcon}>Open project</MenuItem>
          <MenuItem icon={PencilIcon} hint="Ctrl+N">
            Quick start
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Recent</MenuLabel>
          <MenuItem>~/projects/foreman</MenuItem>
        </MenuButton>
        <MenuButton label="Diff source" look="ghost" small trigger={<>Uncommitted {ChevronIcon}</>} placement="bottom-start">
          <MenuLabel>Show changes from</MenuLabel>
          <MenuRadioItem checked onSelect={() => {}} description="Files changed since the base branch">
            All changes
          </MenuRadioItem>
          <MenuRadioItem checked={false} onSelect={() => {}} description="Needs a pull request" disabled>
            Pull request
          </MenuRadioItem>
        </MenuButton>
        <MenuButton label="Chip menu" look="chip" trigger={<>Plan {ChevronIcon}</>} placement="bottom-start">
          <MenuItem>Plan</MenuItem>
        </MenuButton>
        <MenuButton label="Disabled menu" trigger="Disabled" disabled>
          <MenuItem>Never shown</MenuItem>
        </MenuButton>
      </div>
      <div style={row}>
        <Menu label="Every item type" onClose={() => {}} initialFocus="none" style={inline}>
          <MenuItem icon={PencilIcon} hint="F2">
            Rename
          </MenuItem>
          <MenuItem disabled title="Nothing is selected">
            Copy (disabled)
          </MenuItem>
          <MenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
            Wrap lines
          </MenuCheckboxItem>
          <MenuCheckboxItem checked={false} onCheckedChange={() => {}}>
            Copy on select
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuLabel>Send to</MenuLabel>
          <MenuGroup label="Send to">
            <MenuRadioItem indent checked={target === 'a'} onSelect={() => setTarget('a')}>
              Chat A
            </MenuRadioItem>
            <MenuRadioItem indent checked={target === 'b'} onSelect={() => setTarget('b')}>
              {LONG}
            </MenuRadioItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuControlRow label="Zoom" icon={PlusIcon}>
            <MenuItem aria-label="Zoom out" onSelect={() => setZoom(zoom - 10)}>
              {MinusIcon}
            </MenuItem>
            <MenuItem aria-label="Reset zoom" variant="value" onSelect={() => setZoom(100)}>
              {zoom}%
            </MenuItem>
            <MenuItem aria-label="Zoom in" onSelect={() => setZoom(zoom + 10)}>
              {PlusIcon}
            </MenuItem>
          </MenuControlRow>
          <MenuSeparator />
          <MenuItem variant="danger" icon={CloseIcon}>
            Close terminal
          </MenuItem>
        </Menu>
        <ContextDemo />
      </div>
    </Section>
  )
}

function ContextDemo() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <div
        tabIndex={0}
        role="group"
        aria-label="Right-click area"
        style={{ width: 220, height: 90, display: 'grid', placeItems: 'center', border: '1px dashed currentColor' }}
        onContextMenu={(e) => {
          e.preventDefault()
          setAt({ x: e.clientX, y: e.clientY })
        }}
      >
        Right-click here
      </div>
      {at && (
        <ContextMenu x={at.x} y={at.y} label="Context menu" onClose={() => setAt(null)}>
          <MenuItem hint="Ctrl+C">Copy</MenuItem>
          <MenuItem>Paste</MenuItem>
          <MenuSeparator />
          <MenuItem variant="danger">Clear</MenuItem>
        </ContextMenu>
      )}
    </>
  )
}

function SplitDemo() {
  return (
    <Section title="SplitButton">
      <div style={row}>
        <SplitButton label="Open" menuLabel="Open in" size="sm">
          <MenuItem>Editor</MenuItem>
          <MenuItem>Terminal</MenuItem>
        </SplitButton>
        <SplitButton label="Open" menuLabel="Open in">
          <MenuItem>Editor</MenuItem>
        </SplitButton>
        <SplitButton label="Create pull request" menuLabel="More ways to create" variant="primary">
          <MenuItem>Create draft</MenuItem>
        </SplitButton>
        <SplitButton label="Sync" menuLabel="Sync options" variant="ghost">
          <MenuItem>Pull</MenuItem>
        </SplitButton>
        <SplitButton label="Open" menuLabel="Open in" menuDisabled>
          <MenuItem>Editor</MenuItem>
        </SplitButton>
        <SplitButton label="Open" menuLabel="Open in" disabled>
          <MenuItem>Editor</MenuItem>
        </SplitButton>
      </div>
    </Section>
  )
}

function DisclosureDemo() {
  const [open, setOpen] = useState(true)
  return (
    <Section title="Disclosure">
      <div style={{ ...stack, maxWidth: 420 }}>
        <Disclosure label="Setup prompt">Runs once when a workspace is created.</Disclosure>
        <Disclosure label="Setup prompt (open)" open={open} onOpenChange={setOpen}>
          Controlled, and open to begin with.
        </Disclosure>
        <Disclosure label="How variables are loaded" quiet>
          .env files load in this order.
        </Disclosure>
        <Disclosure label={LONG} defaultOpen>
          {LONG}
        </Disclosure>
      </div>
    </Section>
  )
}

export function Gallery2c() {
  return (
    <div style={{ padding: 16 }}>
      <SegmentedDemo />
      <TabsDemo />
      <MenusDemo />
      <SplitDemo />
      <DisclosureDemo />
    </div>
  )
}
