// expect 4=0 5=0 9=7
// A look of its own in a style object: fill, border, radius, shadow, outline, a computed value, a divider that isn't plain.
export function Bad(props: { on: boolean; colour: string }) {
  return (
    <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)' }}>
      <span style={{ boxShadow: 'var(--shadow-sm)', outline: props.on ? '2px solid var(--focus-ring)' : 'none' }}>Hi</span>
      <i style={{ backgroundColor: props.colour }} />
      <b style={{ borderTop: '2px solid var(--border)' }} />
    </div>
  )
}
