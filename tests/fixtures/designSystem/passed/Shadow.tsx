// A component this file defines itself is judged where it is defined, even if it is named like one in ui/.
function Pressable(props: { className?: string }) {
  return <span className={props.className} />
}

export function Shadow() {
  return <Pressable className="shadowed" />
}
