/**
 * What to light when search jumps to a setting that is too tall to flash whole (stacked rows such as the loadout, a model
 * list, a block of controls under a section): its title and description. A row's own text block; otherwise the
 * title and description of the section the target sits in (or is); otherwise the first row's text inside it.
 */
export function settingFlashParts(target: HTMLElement): (HTMLElement | null)[] {
  if (target.matches('.set-row')) return [target.querySelector<HTMLElement>(':scope > .set-row-text')]
  const section = target.matches('.set-section') ? target : target.closest<HTMLElement>('.set-section')
  // The section's own title: it may sit in a header row (the model list's count and "show all"), but not in a nested section.
  const title = section && [...section.querySelectorAll<HTMLElement>('h2')].find((h) => h.closest('.set-section') === section)
  if (section && title) return [title, section.querySelector<HTMLElement>(':scope > .set-section-desc')]
  return [target.querySelector<HTMLElement>('.set-row-text')]
}
