import { useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox } from '../Checkbox'
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

const maskedLabels = { copy: 'Copy API key', reveal: 'Reveal API key', hide: 'Hide API key', edit: 'Edit API key', remove: 'Remove API key' }

export function Gallery2b() {
  const [select, setSelect] = useState('one')
  const [on, setOn] = useState(true)
  const [size, setSize] = useState(14)
  const [auth, setAuth] = useState<string | undefined>('token')
  const [tree, setTree] = useState<string | undefined>('main')
  const [conn, setConn] = useState<string | undefined>(undefined)
  const [prefix, setPrefix] = useState<string | undefined>('custom')

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
