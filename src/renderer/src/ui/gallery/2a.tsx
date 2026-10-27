import { useState } from 'react'
import type { ReactNode } from 'react'
import { ActionRow } from '../ActionRow'
import { Button } from '../Button'
import { Callout } from '../Callout'
import { Card, CardButton } from '../Card'
import { ChipButton } from '../ChipButton'
import { Glyph } from '../Glyph'
import type { GlyphName } from '../Glyph'
import { IconButton } from '../IconButton'
import { Kbd } from '../Kbd'
import { LinkButton } from '../LinkButton'
import { MediaThumb } from '../MediaThumb'
import { Meter } from '../Meter'
import { Pressable } from '../Pressable'
import { Spinner } from '../Spinner'
import { Status } from '../Status'
import { Stepper } from '../Stepper'
import { Tag } from '../Tag'

// Dev-only page of every actions-and-display component and variant, states included. Plain strings: it never ships.

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const
const stack = { display: 'flex', flexDirection: 'column', gap: 8 } as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ ...stack, marginBottom: 24 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

const PlusIcon = (
  <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
    <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)
const CopyIcon = (
  <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
    <rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M2.2 8V2.8c0-.3.3-.6.6-.6H8" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)
const CloseIcon = (
  <svg viewBox="0 0 12 12" width="10" height="10" focusable="false">
    <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const GLYPHS: GlyphName[] = ['ok', 'warn', 'error', 'info', 'off']
const PICTURE = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="68"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6e8bb5"/><stop offset="1" stop-color="#c7a07a"/></linearGradient></defs><rect width="96" height="68" fill="url(#g)"/></svg>')

export function Gallery2a() {
  const [pressed, setPressed] = useState(true)
  const [selected, setSelected] = useState('b')
  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <Section title="Button">
        <div style={row}>
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button icon={PlusIcon}>With icon</Button>
        </div>
        <div style={row}>
          <Button size="sm">Small</Button>
          <Button size="sm" variant="primary">Small primary</Button>
          <Button size="sm" variant="danger">Small danger</Button>
          <Button size="sm" variant="ghost">Small ghost</Button>
        </div>
        <div style={row}>
          <Button disabled>Disabled</Button>
          <Button variant="primary" disabled>Disabled primary</Button>
          <Button variant="danger" disabled>Disabled danger</Button>
          <Button variant="ghost" disabled>Disabled ghost</Button>
        </div>
        <div style={{ ...row, maxWidth: 220 }}>
          <Button>A button label that is rather long for its box</Button>
        </div>
      </Section>

      <Section title="IconButton">
        <div style={row}>
          <IconButton label="Copy">{CopyIcon}</IconButton>
          <IconButton label="Wrap lines" pressed={pressed} onClick={() => setPressed((p) => !p)}>{PlusIcon}</IconButton>
          <IconButton label="More" aria-haspopup="menu" aria-expanded="true">{PlusIcon}</IconButton>
          <IconButton label="Disabled" disabled>{CopyIcon}</IconButton>
        </div>
      </Section>

      <Section title="LinkButton">
        <p style={{ margin: 0 }}>
          Some text with <LinkButton>an action</LinkButton> inside it, and <LinkButton danger>a dangerous one</LinkButton>.
        </p>
        <p style={{ margin: 0 }}>
          Links are blue and underlined: <LinkButton underline>a button in a sentence</LinkButton>, and <a href="#links">an anchor</a>.
        </p>
        <div style={row}>
          <LinkButton size="sm">Small</LinkButton>
          <LinkButton disabled>Disabled</LinkButton>
        </div>
      </Section>

      <Section title="ChipButton">
        <div style={row}>
          <ChipButton>Neutral</ChipButton>
          <ChipButton pressed>Plan mode</ChipButton>
          <ChipButton pressed>Pressed</ChipButton>
          <ChipButton haspopup="menu" expanded>Picker, open</ChipButton>
          <ChipButton haspopup="dialog">Picker, closed</ChipButton>
          <ChipButton disabled>Disabled</ChipButton>
          <ChipButton pill haspopup="dialog">
            <Status tone="warn" label="iPhone: pairing" />
          </ChipButton>
        </div>
      </Section>

      <Section title="Pressable">
        <Pressable onClick={() => undefined} style={{ padding: 10, border: '1px dashed currentColor', width: 280 }}>
          <strong>A single-action card</strong>
          <div>Unstyled; the caller owns the layout.</div>
        </Pressable>
      </Section>

      <Section title="ActionRow">
        <div style={{ ...stack, gap: 2, width: 420 }}>
          <ActionRow onPress={() => setSelected('a')} selected={selected === 'a'} actions={<IconButton label="Archive a">{CopyIcon}</IconButton>} revealActions>
            Workspace a (actions on hover or focus)
          </ActionRow>
          <ActionRow onPress={() => setSelected('b')} selected={selected === 'b'} actions={<IconButton label="Archive b">{CopyIcon}</IconButton>}>
            Workspace b
          </ActionRow>
          <ActionRow disabled onPress={() => undefined} actions={<IconButton label="Restore c">{CopyIcon}</IconButton>}>
            Workspace c, disabled
          </ActionRow>
          <ActionRow onPress={() => undefined} actions={<IconButton label="Archive d">{CopyIcon}</IconButton>}>
            <span style={{ overflowWrap: 'anywhere' }}>A workspace with a very long name that has to wrap or truncate somewhere sensible: feature/improve-the-login-flow-for-returning-users</span>
          </ActionRow>
          <ActionRow editor={<input aria-label="Rename" defaultValue="Editor slot" />} actions={<Button size="sm" variant="ghost">Save</Button>} />
          <ActionRow>A non-interactive row</ActionRow>
          <ActionRow divided>Divided one</ActionRow>
          <ActionRow divided>Divided two</ActionRow>
        </div>
      </Section>

      <Section title="Card and CardButton">
        <div style={{ ...row, alignItems: 'stretch' }}>
          <Card style={{ padding: 10, width: 150 }}>Static frame (quiet edge)</Card>
          <CardButton style={{ padding: 10, width: 150 }}>Interactive card (control edge)</CardButton>
          <CardButton selected style={{ padding: 10, width: 150 }}>Selected</CardButton>
          <CardButton target style={{ padding: 10, width: 150 }}>Drop target</CardButton>
          <Card empty style={{ padding: 10, width: 150 }}>Empty slot</Card>
          <Card empty target style={{ padding: 10, width: 150 }}>Empty, drop target</Card>
          <CardButton lifted style={{ padding: 10, width: 150 }}>Lifted (dragged away)</CardButton>
          <Card interactive ghost style={{ padding: 10, width: 150 }}>Ghost (follows the pointer)</Card>
          <Card interactive ghost tone="danger" style={{ padding: 10, width: 150 }}>Ghost that would remove</Card>
          <CardButton stripe="warn" size="sm" style={{ padding: 10, width: 150 }}>Small, warn stripe</CardButton>
          <CardButton disabled style={{ padding: 10, width: 150 }}>Disabled</CardButton>
          <ActionRow card selected={selected === 'a'} onPress={() => setSelected('a')} style={{ width: 200 }}>ActionRow card</ActionRow>
        </div>
        <div style={{ position: 'relative', width: 120, height: 80, margin: '14px 12px 0' }}>
          <Card interactive style={{ position: 'absolute', inset: 0, padding: 10 }}>Corner badge</Card>
          <IconButton label="Remove" variant="badge" style={{ position: 'absolute', top: -12, right: -12 }}>{CopyIcon}</IconButton>
        </div>
      </Section>

      <Section title="Glyph">
        <div style={row}>
          {GLYPHS.map((name) => (
            <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Glyph name={name} />
              {name}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Status">
        <div style={row}>
          <Status tone="ok" label="GitHub: connected" />
          <Status tone="warn" label="Needs you">2</Status>
          <Status tone="error" label="Linear: sign-in expired" />
          <Status tone="info" label="PR open">1</Status>
          <Status tone="off" label="Slack: off" />
        </div>
        <div style={row}>
          <span title="Needs you" style={{ display: 'inline-flex', gap: 6 }}>
            <Status tone="warn" label="Needs you" compact />
            login-flow (compact: the word is screen-reader text)
          </span>
        </div>
      </Section>

      <Section title="Tag">
        <div style={row}>
          <Tag>r3</Tag>
          <Tag tone="accent">tool</Tag>
          <Tag tone="outline">read only</Tag>
          <Tag tone="ok">Signed in</Tag>
          <Tag tone="warn">Pairing</Tag>
          <Tag tone="error">Token expired</Tag>
          <Tag tone="info">Beta</Tag>
        </div>
        <div style={{ ...row, maxWidth: 160 }}>
          <Tag tone="error">A long tag label that has to wrap inside a narrow box</Tag>
        </div>
      </Section>

      <Section title="Spinner">
        <div style={row}>
          <Spinner />
          <Spinner size={20} />
          <Spinner label="Cloning" />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Spinner /> Loading (decorative, the text says it)
          </span>
        </div>
      </Section>

      <Section title="Meter">
        <div style={{ ...stack, width: 320 }}>
          <Meter label="Usage, low" value={22} valueText="22% of 20 hours" />
          <Meter label="Usage, high" value={78} tone="warn" valueText="78% of 20 hours" />
          <Meter label="Usage, full" value={100} tone="error" valueText="Limit reached" />
          <Meter label="Usage, empty" value={0} />
        </div>
      </Section>

      <Section title="Stepper">
        <div style={{ ...stack, width: 380 }}>
          <Stepper
            label="Pull request, merged"
            statusText={{ done: 'done', upcoming: 'not yet' }}
            steps={[
              { id: 'commit', label: 'Committed', status: 'done' },
              { id: 'pr', label: 'PR #41', status: 'done' },
              { id: 'checks', label: 'Checks 4/4', status: 'done' },
              { id: 'merged', label: 'Merged', status: 'current', tone: 'info' }
            ]}
          />
          <Stepper
            label="Pull request, checks running"
            statusText={{ done: 'done', upcoming: 'not yet' }}
            steps={[
              { id: 'commit', label: 'Committed', status: 'done' },
              { id: 'pr', label: 'PR #41', status: 'done' },
              { id: 'checks', label: 'Checks', status: 'current' },
              { id: 'merged', label: 'Merged', status: 'upcoming' }
            ]}
          />
          <Stepper
            label="Pull request, a check failed"
            statusText={{ done: 'done', upcoming: 'not yet' }}
            steps={[
              { id: 'commit', label: 'Committed', status: 'done' },
              { id: 'pr', label: 'PR #41', status: 'done' },
              { id: 'checks', label: 'Checks 3/4 with a long label', status: 'done', tone: 'error', icon: CloseIcon },
              { id: 'merged', label: 'Merged', status: 'current', tone: 'info' }
            ]}
          />
        </div>
      </Section>

      <Section title="Callout">
        <div style={{ ...stack, width: 460 }}>
          <Callout>A plain note.</Callout>
          <Callout tone="info" title="Heads up">Info with a title and an action.</Callout>
          <Callout tone="ok" role="status">Saved.</Callout>
          <Callout tone="warn" actions={<Button size="sm">Fix it</Button>}>Your sandbox is asleep. Wake it to run commands.</Callout>
          <Callout tone="error" role="alert" title="Run failed" actions={<><Button size="sm">Retry</Button><Button size="sm" variant="ghost">Dismiss</Button></>}>
            Something went wrong with a very long message that wraps: ENOENT: no such file or directory, open &apos;/Users/someone/projects/some/deeply/nested/file.ts&apos;
          </Callout>
        </div>
        <div style={{ ...stack, width: 560, gap: 0 }}>
          <Callout banner>Viewing history. Changes since then are hidden.</Callout>
          <Callout banner tone="warn" actions={<Button size="sm">Wake</Button>}>Sandbox asleep</Callout>
          <Callout banner tone="info" role="status">Reconnected</Callout>
          <Callout banner tone="error" role="alert">Offline</Callout>
        </div>
      </Section>

      <Section title="Kbd">
        <p style={{ margin: 0 }}>
          Press <Kbd>Esc</Kbd> to close, <Kbd>Ctrl+K</Kbd> to search.
        </p>
      </Section>

      <Section title="MediaThumb">
        <div style={row}>
          <MediaThumb src={PICTURE} name="screenshot-login.png" onRemove={() => undefined} removeLabel="Remove screenshot-login.png" />
          <MediaThumb src={PICTURE} name="a-very-long-file-name-that-gets-cut-off.png" />
          <MediaThumb name="notes.txt">
            <Glyph name="info" />
          </MediaThumb>
        </div>
      </Section>
    </div>
  )
}
