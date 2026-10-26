// expect 5=3
// Literal sizes in a style object.
export function Bad(props: { big: boolean }) {
  return (
    <div style={{ fontSize: 12, borderRadius: '4px' }}>
      <span style={{ fontSize: props.big ? '20px' : 'var(--text-sm)' }}>Hi</span>
    </div>
  )
}
