// expect 5=0
// Tokens, zero, and computed values (a user setting, a size prop) aren't judged; nor are objects that aren't a style.
export const XTERM = { fontSize: 12 }

export function Good(props: { size: number }) {
  return (
    <div style={{ fontSize: 'var(--text-sm)', borderRadius: 0 }}>
      <span style={{ fontSize: props.size }}>Preview</span>
    </div>
  )
}
