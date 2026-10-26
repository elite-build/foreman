// What the renderer's modules expect of a browser at import time and jsdom lacks. Import it first in a jsdom test that
// pulls in whole components (it must run before theme.ts and the like load).
if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as typeof window.matchMedia
  window.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as typeof ResizeObserver
  window.Element.prototype.scrollIntoView ??= () => undefined
}
