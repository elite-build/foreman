// expect 4=1 5=1 9=0
// A style value rules 4 or 5 already flag is not counted again by rule 9.
export function Once() {
  return <div style={{ background: '#fff', borderRadius: 4 }} />
}
