// expect 2=6
// A div made focusable and clickable, role="button", widget roles (also on a native button), and a role chosen at runtime.
export function Bad(props: { open: boolean; index: number }) {
  return (
    <div>
      <div onClick={() => undefined} tabIndex={0}>Row</div>
      <span role="button">Fake</span>
      <li role="option" aria-selected>Item</li>
      <button type="button" role="tab">Tab</button>
      <div role="separator" tabIndex={0} aria-valuenow={props.index} />
      <div role={props.open ? 'menu' : undefined} onKeyDown={() => undefined} tabIndex={props.index} />
    </div>
  )
}
