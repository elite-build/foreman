// expect 1=0
// Links with an href, spread props that may carry one, components and plain layout are fine.
function Button(props: { children: string }) {
  return props.children
}

export function Good(props: { link: { href: string } }) {
  return (
    <div>
      <a href="https://example.com">Docs</a>
      <a {...props.link}>Spread</a>
      <Button>Save</Button>
      <details>
        <p>No summary, no control.</p>
      </details>
    </div>
  )
}
