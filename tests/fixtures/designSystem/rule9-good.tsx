// expect 9=0
// Layout in a style object, a plain divider (also when it depends on a prop), and table layout.
export function Good(props: { first: boolean; width: number }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', width: props.width, borderTop: '1px solid var(--border)' }}>
      <span style={{ borderBottom: props.first ? '1px solid var(--border)' : '1px solid var(--border)' }}>Hi</span>
      <table style={{ borderCollapse: 'collapse', borderSpacing: 0 }} />
    </div>
  )
}
