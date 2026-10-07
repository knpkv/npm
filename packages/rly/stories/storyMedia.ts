/**
 * Whether a media query matches in the story's own window. A story always renders in a window, so a
 * missing one is a broken harness, never a reason to assume a desktop.
 */
export const storyMedia = (element: Element, query: string): boolean => {
  const view = element.ownerDocument.defaultView
  if (view === null) throw new Error(`story element has no window to evaluate ${query}`)
  return view.matchMedia(query).matches
}
