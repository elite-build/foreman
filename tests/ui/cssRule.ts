import { readFileSync } from 'node:fs'

// Layout can't be measured in jsdom, so a few component contracts are pinned in their stylesheet: the declarations of a rule,
// and the order rules appear in (equal-specificity rules, so the later one wins).
export function readCss(name: string): string {
  return readFileSync(`src/renderer/src/ui/css/${name}.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The declarations of the rule whose selector is exactly `selector`, or undefined.
export function ruleBody(css: string, selector: string): string | undefined {
  return new RegExp(`(?:^|[}\\s])${escape(selector)}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
}

// Where the rule for `selector` starts: later means it wins at equal specificity.
export function ruleIndex(css: string, selector: string): number {
  return css.search(new RegExp(`(?:^|[}\\s])${escape(selector)}\\s*\\{`))
}
