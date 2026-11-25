import { useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox } from '../Checkbox'
import { CodeEditor, type CodeEditorChange, type CodeEditorMark, type CodeEditorToken } from '../CodeEditor'
import { Field } from '../Field'
import { FileInput } from '../FileInput'
import { MaskedValue } from '../MaskedValue'
import { RadioCards } from '../RadioCards'
import { RadioList } from '../RadioList'
import { Range } from '../Range'
import { Select } from '../Select'
import { Switch } from '../Switch'
import { TextArea } from '../TextArea'
import { TextInput } from '../TextInput'

// Dev-only page of every form component and variant, states included. Plain strings: it never ships.

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

const icon = (path: string) => (
  <svg viewBox="0 0 12 12" width="14" height="14" focusable="false">
    <path d={path} fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
)
const FolderIcon = icon('M1.2 3.2c0-.6.4-1 1-1h2.6l1.1 1.2h3.9c.6 0 1 .4 1 1v4.9c0 .6-.4 1-1 1H2.2c-.6 0-1-.4-1-1z')
const WifiIcon = icon('M1 4.6a7.2 7.2 0 0 1 10 0M2.8 6.6a4.6 4.6 0 0 1 6.4 0M4.6 8.5a2 2 0 0 1 2.8 0')

const LONG = 'A deliberately long label that has to wrap onto a second line without breaking the layout of the control around it'

const options = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two', group: 'Group' },
  { value: 'three', label: 'A very long option label that the select has to cope with', group: 'Group' }
]

// A tiny TOML tokenizer, enough for the sample: [tables], keys, strings, numbers, booleans and comments.
function tokenizeToml(line: string): CodeEditorToken[] {
  const out: CodeEditorToken[] = []
  const table = /^(\s*)(\[[^\]]*\]+)(.*)$/.exec(line)
  if (table) return [{ text: table[1] }, { text: table[2], kind: 'title' }, ...tokenizeToml(table[3])]
  const pattern = /(#.*$)|("(?:[^"\\]|\\.)*"?)|\b(true|false)\b|(-?\b\d+(?:\.\d+)?\b)|((?<=^\s*|[{,]\s*)[\w.-]+(?=\s*=))/g
  let at = 0
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) })
    const kind = m[1] ? 'comment' : m[2] ? 'string' : m[3] ? 'keyword' : m[4] ? 'number' : 'property'
    out.push({ text: m[0], kind })
    at = m.index + m[0].length
    if (!m[0]) pattern.lastIndex++
  }
  if (at < line.length) out.push({ text: line.slice(at) })
  return out
}

const FLOW = [
  '# Research, then implement, then review',
  '[steps.implement]',
  'kind = "turn"',
  'persona = "developer"',
  'prompt = "Implement the plan."',
  '',
  '[steps.qa]',
  'kind = "review"',
  'persona = "qa-engineer"',
  'context = ["diff", "checks.result"]',
  '',
  '[loops.qa-until-clean]',
  'over = ["qa", "address", "checks"]',
  'at_most = { iterations = 2 }',
  'same_tab = true',
  '[edges]',
  'qa = { clean = "done", findings = "address", because = "a deliberately long line that scrolls sideways instead of wrapping" }'
].join('\n')

const FLOW_MARKS: CodeEditorMark[] = [
  { line: 10, tone: 'error', from: 20, to: 35, message: '"checks.result" isn\'t something a step can be shown. Did you mean checks.results?' },
  { line: 14, tone: 'warn', from: 11, to: 29, message: 'This loop has no time limit.' }
]
const markLabel = (m: CodeEditorMark) => `Line ${m.line}, ${m.tone === 'error' ? 'problem' : m.tone === 'warn' ? 'warning' : 'note'}: ${m.message}`

// A reviewed snippet: each token kind once, a note, and the three kinds of change (plus one removed above line 1).
const REVIEW = [
  '// Reviewed by the QA step',
  'import type { Flow } from "./flow"',
  'const limit: number = 2',
  'const pattern = /^step-\\d+$/',
  'const label = <Badge tone="info" />',
  'const retries = null ?? true',
  'console.log(input)',
  '@deprecated'
].join('\n')
const REVIEW_TOKENS: CodeEditorToken[][] = [
  [{ text: '// Reviewed by the QA step', kind: 'comment' }],
  [{ text: 'import', kind: 'keyword' }, { text: ' type { ' }, { text: 'Flow', kind: 'type' }, { text: ' } from ' }, { text: '"./flow"', kind: 'string' }],
  [{ text: 'const', kind: 'keyword' }, { text: ' limit: ' }, { text: 'number', kind: 'type' }, { text: ' = ' }, { text: '2', kind: 'number' }],
  [{ text: 'const', kind: 'keyword' }, { text: ' pattern = ' }, { text: '/^step-\\d+$/', kind: 'regexp' }],
  [{ text: 'const', kind: 'keyword' }, { text: ' label = <' }, { text: 'Badge', kind: 'tag' }, { text: ' ' }, { text: 'tone', kind: 'property' }, { text: '=' }, { text: '"info"', kind: 'string' }, { text: ' />' }],
  [{ text: 'const', kind: 'keyword' }, { text: ' retries = ' }, { text: 'null', kind: 'literal' }, { text: ' ?? ' }, { text: 'true', kind: 'literal' }],
  [{ text: 'console', kind: 'builtin' }, { text: '.log(' }, { text: 'input', kind: 'variable' }, { text: ')' }],
  [{ text: '@deprecated', kind: 'meta' }]
]
const REVIEW_CHANGES: CodeEditorChange[] = [
  { line: 0, kind: 'removed' },
  { line: 2, kind: 'modified' },
  { line: 3, kind: 'added' },
  { line: 6, kind: 'removed' }
]
const REVIEW_MARKS: CodeEditorMark[] = [{ line: 6, tone: 'info', message: 'Reviewer: is null meant here, or an empty step?' }]

const maskedLabels = { copy: 'Copy API key', reveal: 'Reveal API key', hide: 'Hide API key', edit: 'Edit API key', remove: 'Remove API key' }

export function Gallery2b() {
  const [select, setSelect] = useState('one')
  const [on, setOn] = useState(true)
  const [size, setSize] = useState(14)
  const [auth, setAuth] = useState<string | undefined>('token')
  const [tree, setTree] = useState<string | undefined>('main')
  const [conn, setConn] = useState<string | undefined>(undefined)
  const [prefix, setPrefix] = useState<string | undefined>('custom')
  const [merge, setMerge] = useState<string | undefined>('wait')
  const [flow, setFlow] = useState(FLOW)
  const [caretLine, setCaretLine] = useState(1)

  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <Section title="Field">
        <Field label="Branch name">{(c) => <TextInput {...c} defaultValue="feature/login" />}</Field>
        <Field label="With help" description="Letters, numbers and dashes.">
          {(c) => <TextInput {...c} />}
        </Field>
        <Field label="With an error" description="Letters, numbers and dashes." error="A branch with this name already exists.">
          {(c) => <TextInput {...c} defaultValue="main" />}
        </Field>
        <Field label="Hidden label" hideLabel>
          {(c) => <TextInput type="search" placeholder="Search…" {...c} />}
        </Field>
        <Field label={LONG} description={LONG} error={LONG}>
          {(c) => <TextInput {...c} />}
        </Field>
      </Section>

      <Section title="TextInput">
        <div style={row}>
          <TextInput aria-label="Text" placeholder="Text" />
          <TextInput aria-label="Number" type="number" defaultValue={42} width={90} />
          <TextInput aria-label="Date" type="date" defaultValue="2026-10-24" width={165} />
          <TextInput aria-label="Time" type="time" defaultValue="14:30" width={115} />
          <TextInput aria-label="Search" type="search" placeholder="Search" />
          <TextInput aria-label="Password" type="password" defaultValue="hunter2" />
        </div>
        <div style={row}>
          <TextInput aria-label="Mono" mono defaultValue="~/code/foreman/src/renderer" />
          <TextInput aria-label="Invalid" aria-invalid="true" defaultValue="bad value" />
          <TextInput aria-label="Disabled" disabled defaultValue="disabled" />
          <TextInput aria-label="Read only" readOnly defaultValue="read only" />
          <TextInput aria-label="Long value" defaultValue={LONG} />
        </div>
      </Section>

      <Section title="TextArea">
        <Field label="Notes">{(c) => <TextArea {...c} defaultValue={'Two lines\nof text'} />}</Field>
        <TextArea aria-label="Script" mono rows={4} defaultValue={'#!/bin/sh\nnpm install\nnpm test'} />
        <TextArea aria-label="Invalid" aria-invalid="true" defaultValue="needs fixing" />
        <TextArea aria-label="Read only" readOnly defaultValue="read only" />
        <TextArea aria-label="Disabled" disabled defaultValue="disabled" />
      </Section>

      <Section title="CodeEditor: a highlighted range, an error and a warning; read only">
        <Field label="research-then-implement.toml" description={`Caret on line ${caretLine}.`}>
          {(c) => (
            <CodeEditor
              {...c}
              value={flow}
              onChange={setFlow}
              tokenize={tokenizeToml}
              highlight={{ from: 7, to: 10 }}
              marks={FLOW_MARKS}
              markLabel={markLabel}
              onCaretLine={setCaretLine}
              rows={18}
            />
          )}
        </Field>
        <CodeEditor aria-label="Read-only TOML" readOnly value={'[steps.checks]\nkind = "checks"\nretries = 2'} tokenize={tokenizeToml} rows={3} />
      </Section>

      <Section title="CodeEditor: changes, pre-tokenised kinds and a note; read only">
        <Field
          label="review.ts"
          description="Changes: a line removed above line 1, line 2 modified, line 3 added, a line removed after line 6. Line 6 has a note."
        >
          {(c) => (
            <CodeEditor
              {...c}
              readOnly
              value={REVIEW}
              tokenLines={REVIEW_TOKENS}
              changes={REVIEW_CHANGES}
              marks={REVIEW_MARKS}
              markLabel={markLabel}
              rows={8}
            />
          )}
        </Field>
      </Section>

      <Section title="Range">
        <div style={row}>
          <Range aria-label="Font size" min={10} max={20} value={size} valueText={`${size}px`} onChange={(e) => setSize(Number(e.target.value))} />
          <span>{size}px</span>
          <Range aria-label="Disabled" disabled defaultValue={50} />
        </div>
      </Section>

      <Section title="FileInput">
        <div style={row}>
          <FileInput aria-label="Icon" chooseLabel="Choose file…" noneLabel="No file chosen" accept="image/*" />
          <FileInput aria-label="Several" chooseLabel="Choose files…" noneLabel="No file chosen" multiple />
          <FileInput aria-label="Disabled" chooseLabel="Choose file…" noneLabel="No file chosen" disabled />
        </div>
      </Section>

      <Section title="Checkbox">
        <div style={row}>
          <Checkbox>Unchecked</Checkbox>
          <Checkbox defaultChecked>Checked</Checkbox>
          <Checkbox indeterminate>Mixed</Checkbox>
          <Checkbox disabled>Disabled</Checkbox>
          <Checkbox disabled defaultChecked>
            Disabled, checked
          </Checkbox>
        </div>
        <div style={{ maxWidth: 320 }}>
          <Checkbox>{LONG}</Checkbox>
        </div>
      </Section>

      <Section title="Select">
        <div style={row}>
          <Select label="Plain" value={select} options={options} onChange={setSelect} />
          <Select label="Narrow" value={select} options={options} onChange={setSelect} width={90} />
          <Select label="Disabled" value="one" options={options} onChange={() => {}} disabled />
          <Select label="Invalid" aria-invalid="true" value="one" options={options} onChange={() => {}} />
        </div>
        <Field label="In a Field" error="Pick another">
          {(c) => <Select {...c} value={select} options={options} onChange={setSelect} />}
        </Field>
      </Section>

      <Section title="MaskedValue">
        <div style={{ maxWidth: 420, ...stack }}>
          <MaskedValue label="API key" labels={maskedLabels} hint="abcd" reveal={async () => 'sk-ant-api03-abcd'} onEdit={() => {}} onRemove={async () => {}} />
          <MaskedValue label="Token" labels={maskedLabels} reveal={async () => 'tok'} />
          <MaskedValue label="Long" labels={maskedLabels} hint={'x'.repeat(60)} reveal={async () => 'y'.repeat(80)} onEdit={() => {}} onRemove={async () => {}} />
        </div>
      </Section>

      <Section title="Switch">
        <div style={row}>
          <Switch label="Off" checked={false} onChange={() => {}} />
          <Switch label="On" checked={on} onChange={setOn} />
          <Switch label="Disabled off" checked={false} onChange={() => {}} disabled />
          <Switch label="Disabled on" checked onChange={() => {}} disabled />
        </div>
      </Section>

      <Section title="RadioList">
        <RadioList
          legend="Branch prefix"
          value={prefix}
          onChange={setPrefix}
          options={[
            { value: 'github', label: 'GitHub username', description: 'Branches start with your username.' },
            { value: 'custom', label: 'Custom', extra: prefix === 'custom' ? <TextInput aria-label="Custom prefix" mono defaultValue="yatin/" /> : undefined },
            { value: 'none', label: 'None', disabled: true, reason: 'Needs a connected repository' },
            { value: 'long', label: LONG }
          ]}
        />
        <RadioList
          legend="Descriptions beside their labels"
          descriptions="beside"
          value={merge}
          onChange={setMerge}
          options={[
            { value: 'admin', label: 'Merge now with admin bypass', description: 'gh pr merge --squash --admin, then tag and build straight away' },
            { value: 'wait', label: 'Wait for an approval', description: 'I open the PR and stop. Run the skill again after it merges.' },
            { value: 'long', label: LONG, description: 'A long label wraps in its column; the descriptions stay lined up.' }
          ]}
        />
        <RadioList
          legend="Inline, nothing chosen"
          inline
          value={undefined}
          onChange={() => {}}
          options={[
            { value: 'a', label: 'Small' },
            { value: 'b', label: 'Medium' },
            { value: 'c', label: 'Large', disabled: true }
          ]}
        />
      </Section>

      <Section title="RadioCards: grid, with actions and an invalid chosen card">
        <RadioCards
          legend="Sign-in method"
          value={auth}
          onChange={setAuth}
          options={[
            {
              value: 'token',
              label: 'Setup token',
              description: 'Expires in 30 days.',
              actions: (
                <>
                  <button type="button">Run setup</button>
                  <button type="button">Paste token</button>
                </>
              )
            },
            { value: 'key', label: 'API key', description: 'No key saved yet.', invalid: true, actions: <button type="button">Add key</button> },
            { value: 'sub', label: 'Subscription', disabled: true, reason: 'Not available on this account.' },
            { value: 'long', label: LONG, description: LONG }
          ]}
        />
      </Section>

      <Section title="RadioCards: stack, icons, disabled with a reason">
        <RadioCards
          legend="Start from"
          layout="stack"
          value={tree}
          onChange={setTree}
          options={[
            { value: 'main', label: <span className="mono">~/code/foreman</span>, description: 'main · clean', icon: FolderIcon },
            { value: 'second', label: <span className="mono">~/code/foreman-2</span>, description: 'feature/login · 2 changes', icon: FolderIcon },
            { value: 'busy', label: <span className="mono">~/code/foreman-3</span>, icon: FolderIcon, disabled: true, reason: 'dakar · in use by another workspace' }
          ]}
        />
      </Section>

      <Section title="RadioCards: nothing chosen yet, and collapsed in a narrow container">
        <RadioCards
          legend="Connection"
          value={conn}
          onChange={setConn}
          options={[
            { value: 'lan', label: 'Same Wi-Fi', description: 'Fastest. Phone and computer on one network.', icon: WifiIcon },
            { value: 'private', label: 'Private link', description: 'Works anywhere, through a secure tunnel.' }
          ]}
        />
        <div style={{ width: 380 }}>
          <RadioCards
            legend="Narrow (380px)"
            value="a"
            onChange={() => {}}
            options={[
              { value: 'a', label: 'One', description: 'Stacks into a single column.' },
              { value: 'b', label: 'Two', description: 'Below 560px of width.' }
            ]}
          />
        </div>
      </Section>
    </div>
  )
}
