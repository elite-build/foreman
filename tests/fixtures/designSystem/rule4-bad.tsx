// expect 4=5
// Colours in strings and templates, named colours in a style object and on SVG; an injected ::highlight style.
export const ACCENT = '#abc'
export const SHADOW = `0 0 0 1px rgb(1, 2, 3)`
export const HIGHLIGHT = `::highlight(find) { background: #e9b94955; }`

export function Bad() {
  return (
    <svg fill="red">
      <text style={{ color: 'white' }}>Hi</text>
    </svg>
  )
}
