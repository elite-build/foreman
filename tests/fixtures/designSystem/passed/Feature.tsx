// Feature code handing class names to ui/ components (stand-ins in ./ui).
import { ActionRow, Menu, Pressable } from './ui'

export function Feature({ on }: { on: boolean }) {
  return (
    <>
      {/* A literal, a conditional and a template: the whole words count, a word that touches ${…} does not. */}
      <Pressable className="card-pick">x</Pressable>
      <Pressable className={on ? 'pick-a' : 'pick-b'}>x</Pressable>
      <Pressable className={`tpl-${on} fixed-word`}>x</Pressable>
      {/* Other class attributes of a component, and a class inside primaryProps. */}
      <Menu triggerClassName="menu-trigger" panelClassName="menu-panel">x</Menu>
      <ActionRow className="row" primaryProps={{ className: 'row-main' }}>x</ActionRow>
      {/* Plain elements are not ui/ markup. */}
      <div className="plain-div">x</div>
    </>
  )
}
