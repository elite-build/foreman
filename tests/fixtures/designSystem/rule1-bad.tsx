// expect 1=6
// Raw controls: each element below is one finding.
export function Bad() {
  return (
    <form>
      <button type="button">Save</button>
      <input />
      <select />
      <textarea />
      <a onClick={() => undefined}>Not a link</a>
      <details>
        <summary>More</summary>
      </details>
    </form>
  )
}
