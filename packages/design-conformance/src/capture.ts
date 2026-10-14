import type { BrowserContextOptions, JSHandle, Page } from "@playwright/test"

export const VISUAL_TIME = "2026-07-14T12:00:00.000Z"
export const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu
export const captureContext = {
  reducedMotion: "reduce",
  locale: "en-US",
  timezoneId: "UTC"
} satisfies BrowserContextOptions
export const screenshotSettings = { animations: "disabled", caret: "hide", maskColor: "#808080" } satisfies Parameters<
  Page["screenshot"]
>[0]

/** Install before navigation. Keep timers running while Date reads stay fixed. */
export const installCaptureClock = async (page: Page): Promise<void> => {
  await page.clock.install({ time: new Date(VISUAL_TIME) })
  await page.clock.setFixedTime(new Date(VISUAL_TIME))
}

export const settleCaptureFonts = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    document.fonts.forEach((font) => {
      font.display = "block"
    })
    return document.fonts.ready.then(() => undefined)
  })
}

/** Call after any viewport changes, before framing evidence or taking screenshots. */
export const settleCapturePage = async (page: Page): Promise<void> => {
  await page.evaluate("document.fonts.ready")
  await page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()")
  await page.evaluate("window.scrollTo(0, 0)")
}

/** Restore original Text nodes after capture so framework node identities survive. */
export const maskUuidText = (page: Page): Promise<JSHandle<() => void>> =>
  page.evaluateHandle((source) => {
    const pattern = new RegExp(source, "giu")
    const restores: Array<() => void> = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes: Array<Node> = []
    while (walker.nextNode() !== null) {
      const node = walker.currentNode
      const ancestor = node.parentElement?.closest("[data-visual-uuid], script, style, noscript")
      if (ancestor === null || ancestor === undefined) nodes.push(node)
    }
    for (const node of nodes) {
      const value = node.textContent ?? ""
      const matches = Array.from(value.matchAll(pattern))
      if (matches.length === 0) continue
      const fragment = document.createDocumentFragment()
      let offset = 0
      for (const match of matches) {
        fragment.append(value.slice(offset, match.index))
        const span = document.createElement("span")
        span.setAttribute("data-visual-uuid", "")
        span.textContent = match[0]
        fragment.append(span)
        offset = match.index + match[0].length
      }
      fragment.append(value.slice(offset))
      const inserted = Array.from(fragment.childNodes)
      node.parentNode?.replaceChild(fragment, node)
      restores.push(() => {
        const first = inserted[0]
        if (first !== undefined) first.parentNode?.replaceChild(node, first)
        for (const replacement of inserted.slice(1)) replacement.parentNode?.removeChild(replacement)
      })
    }
    return () => {
      restores.reverse().forEach((restore) => {
        restore()
      })
    }
  }, UUID_PATTERN.source)

export const normalizeCopy = (value: string): string =>
  value
    .replaceAll(UUID_PATTERN, "<uuid>")
    .replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "<timestamp>")
    .replaceAll(/\s+/gu, " ").trim()
