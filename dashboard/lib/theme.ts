/**
 * Calls `redraw` when the theme changes (next-themes switches a class on <html>), so canvases that paint with the
 * theme's colors can pick up the new ones. Returns a function that stops watching.
 */
export function watchTheme(redraw: () => void): () => void {
  const observer = new MutationObserver(redraw)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}
