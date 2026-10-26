/** Literal, case-insensitive matches with offsets in the original string. */
export function textMatches(text: string, query: string): { start: number; end: number }[] {
  if (!query) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index!, end: match.index! + match[0].length }))
}

/** Ranges can cross Markdown formatting and syntax-highlighting spans. */
export function chatSearchRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const ranges: Range[] = []
  for (const row of root.querySelectorAll('[data-chat-item]')) {
    const nodes: { node: Text; start: number; end: number }[] = []
    let text = ''
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('button:not(.tool-row), [data-search-ignore], .xterm, script, style')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    })
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const start = text.length
      text += node.data
      nodes.push({ node, start, end: text.length })
    }
    for (const match of textMatches(text, query)) {
      const first = nodes.find((n) => n.end > match.start)
      const last = nodes.find((n) => n.end >= match.end)
      if (!first || !last) continue
      const range = document.createRange()
      range.setStart(first.node, match.start - first.start)
      range.setEnd(last.node, match.end - last.start)
      ranges.push(range)
    }
  }
  return ranges
}

/** Reveal the match inside nested scroll areas, such as a long tool's output. */
export function revealChatMatch(range: Range, root: HTMLElement): void {
  let element = range.startContainer.parentElement
  while (element && root.contains(element)) {
    const style = getComputedStyle(element)
    const match = range.getBoundingClientRect()
    const viewport = element.getBoundingClientRect()
    if (element.scrollHeight > element.clientHeight && /(auto|scroll)/.test(style.overflowY)) {
      element.scrollTop += match.top - viewport.top - element.clientHeight / 2 + match.height / 2
    }
    if (element.scrollWidth > element.clientWidth && /(auto|scroll)/.test(style.overflowX)) {
      if (match.left < viewport.left || match.right > viewport.right) {
        element.scrollLeft += match.left - viewport.left - element.clientWidth / 2 + match.width / 2
      }
    }
    if (element === root) break
    element = element.parentElement
  }
}
