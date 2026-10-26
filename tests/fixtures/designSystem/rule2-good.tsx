// expect 2=0
// Event delegation and stopPropagation wrappers (no tabIndex), programmatic focus (tabIndex -1), non-widget roles, and
// roles given to components (judged where they are defined).
function Thing(props: { role: string }) {
  return <div>{props.role}</div>
}

export function Good() {
  return (
    <div onClick={() => undefined}>
      <div onMouseDown={(e) => e.stopPropagation()}>Wrapper</div>
      <div tabIndex={-1} onKeyDown={() => undefined}>Dialog body</div>
      <div role="status">Saved</div>
      <div role="alert">Failed</div>
      <Thing role="menu" />
    </div>
  )
}

export function Divider() {
  return <div role="separator">Switched to Codex</div>
}
