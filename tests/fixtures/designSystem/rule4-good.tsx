// expect 4=0
// Tone names are data, not colours; tokens and currentColor are fine; "PR #12" is not a colour.
export const TONE: 'red' | 'green' = 'red'
export const TITLE = 'PR #12'

export function Good() {
  return (
    <svg fill="currentColor">
      <text style={{ color: 'var(--red)' }} data-tone="red">Hi</text>
    </svg>
  )
}
