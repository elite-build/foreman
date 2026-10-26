// expect 3=2
export function Bad() {
  return (
    <div>
      <div contentEditable />
      <div contentEditable="plaintext-only" />
    </div>
  )
}
