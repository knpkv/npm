/**
 * Measure how far a page moves when rly's Geist fonts swap in over their metric-matched fallback.
 *
 * Every product shell's font-swap spec calls `measureFontSwapShift` once per viewport, launched
 * with `FONT_SWAP_LAUNCH_OPTIONS`:
 *
 *   test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })
 *   const swap = await measureFontSwapShift(page, { probe: "h1", ready: "table", url: "/" })
 *   expect(swap.sum, swap.report).toBeLessThanOrEqual(0.05)
 *
 * The page's woff2 responses are held, so first paint uses the fallback whatever the cache or
 * network does. Fonts inlined as `data:` URIs in a stylesheet are moved out to a held URL for the
 * same reason (a CSP that allows only `data:` fonts is widened to the held origin, in the test only);
 * a page whose fonts are inlined in its own document (review's offline guide) loads the
 * `text` from `externaliseInlineFonts(html)` and passes its `fonts` as `inlineFonts`. Once `ready` is
 * visible, the text under it must have rendered in a fallback face (`FALLBACK_FAMILIES`): a runner
 * without those fonts would otherwise measure system-ui and pass for the wrong reason. The fonts are
 * then released, and only layout-shift entries recorded after the release count, so data and
 * skeleton shifts before it never blame the fonts. `sum` adds every such entry (stricter than CLS,
 * which takes the worst session window).
 */
import type { Page, Route } from "@playwright/test"
import { Data, Schema } from "effect"

/** The faces rly's "Geist Fallback" and "Geist Mono Fallback" resolve to, as Chromium reports them. */
export const FALLBACK_FAMILIES: ReadonlyArray<string> = [
  "Arial",
  "Liberation Sans",
  "Arimo",
  "Courier New",
  "Liberation Mono",
  "Cousine"
]

/**
 * Launch options every font-swap spec uses (`test.use({ launchOptions: FONT_SWAP_LAUNCH_OPTIONS })`
 * at the top of its file). The headless shell hints the fallback fonts to whole-pixel advances, so
 * Liberation Mono's 0.6em runs 5% narrower than Geist Mono and lines re-wrap on the swap, a shift
 * desktop browsers, which position glyphs at subpixels, never show.
 */
export const FONT_SWAP_LAUNCH_OPTIONS = { args: ["--font-render-hinting=none"] }

/** The browser hints glyph advances to whole pixels, so fallback widths are not what users see. */
export class FontSwapHintedRenderingError extends Data.TaggedError("FontSwapHintedRenderingError")<{
  readonly measured: number
}> {
  override get message(): string {
    return `ten "0"s in Geist Mono Fallback at 14px measured ${this.measured}px, not 84px: launch with ` +
      `FONT_SWAP_LAUNCH_OPTIONS (--font-render-hinting=none) so glyphs keep their subpixel advances`
  }
}

/** The fallback never rendered: the runner lacks the fonts, or the stack skips the fallback face. */
export class FontSwapFallbackMissingError extends Data.TaggedError("FontSwapFallbackMissingError")<{
  readonly families: ReadonlyArray<string>
  readonly selector: string
}> {
  override get message(): string {
    return `${this.selector} rendered in ${this.families.join(", ") || "no font"} before Geist loaded, ` +
      `not in a metric-matched fallback (${FALLBACK_FAMILIES.join(", ")})`
  }
}

/** The page never asked for a woff2, so there was no swap to measure. */
export class FontSwapNoFontError extends Data.TaggedError("FontSwapNoFontError")<{ readonly url: string }> {
  override get message(): string {
    return `${this.url} requested no woff2 font, so its font swap cannot be measured`
  }
}

/** Geist was released but the text under `ready` still did not render in it. */
export class FontSwapNotSwappedError extends Data.TaggedError("FontSwapNotSwappedError")<{
  readonly families: ReadonlyArray<string>
  readonly selector: string
}> {
  override get message(): string {
    return `${this.selector} still rendered in ${this.families.join(", ") || "no font"} after Geist was released`
  }
}

/** One layout shift after the fonts were released, with the elements that moved. */
export const FontSwapEntry = Schema.Struct({ moved: Schema.Array(Schema.String), value: Schema.Number })
export type FontSwapEntry = typeof FontSwapEntry.Type

/** A layout-shift entry as the page records it (LayoutShift is not in lib.dom), parsed in Node. */
const RecordedShift = Schema.Struct({
  hadRecentInput: Schema.Boolean,
  moved: Schema.Array(Schema.String),
  startTime: Schema.Number,
  value: Schema.Number
})
const decodeShifts = Schema.decodeUnknownSync(Schema.Array(RecordedShift))

/** The shift the swap caused, and a readable report for an assertion message. */
export interface FontSwapShift {
  readonly entries: ReadonlyArray<FontSwapEntry>
  readonly fallback: ReadonlyArray<string>
  readonly report: string
  readonly sum: number
}

export interface FontSwapOptions {
  /** A selector that is on screen once the page has its data, so later shifts are the fonts'. */
  readonly ready: string
  /** A CSS selector whose first text-bearing element's rendered fonts are checked; defaults to `ready`. */
  readonly probe?: string
  /** Navigate here, or omit when the caller loads the page itself in `load`. */
  readonly url?: string
  /** Loads the page instead of `page.goto(url)`, for documents built in the test. */
  readonly load?: () => Promise<void>
  /** The `fonts` from `externaliseInlineFonts` when the document itself inlined them. */
  readonly inlineFonts?: ReadonlyMap<string, Buffer>
}

const HELD_ORIGIN = "https://rly-font-swap.invalid"
const INLINE_FONT = /url\(\s*(["']?)data:font\/woff2;base64,([A-Za-z0-9+/=]+)\1\s*\)/g

/** The page's CSP with the held font origin added to `font-src` (or `default-src` when that governs fonts). */
export const allowHeldFonts = (policy: string): string => {
  const directives = policy.split(";").map((directive) => directive.trim()).filter((directive) => directive.length > 0)
  const fontIndex = directives.findIndex((directive) => directive.startsWith("font-src"))
  if (fontIndex >= 0) {
    return directives.map((directive, index) => (index === fontIndex ? `${directive} ${HELD_ORIGIN}` : directive)).join(
      "; "
    )
  }
  return directives.map((
    directive
  ) => (directive.startsWith("default-src") ? `${directive} ${HELD_ORIGIN}` : directive))
    .join("; ")
}

/** A document or stylesheet with its inline woff2 fonts moved to held URLs. */
export interface ExternalisedFonts {
  readonly fonts: ReadonlyMap<string, Buffer>
  readonly text: string
}

/** Replace inline woff2 data URIs with held URLs, returning the rewritten text and the bytes per URL. */
export const externaliseInlineFonts = (text: string): ExternalisedFonts => {
  const fonts = new Map<string, Buffer>()
  const rewritten = text.replace(INLINE_FONT, (_match, _quote, base64: string) => {
    const url = `${HELD_ORIGIN}/${fonts.size}.woff2`
    fonts.set(url, Buffer.from(base64, "base64"))
    return `url("${url}")`
  })
  return { fonts, text: rewritten }
}

/** The platform fonts Chromium used for the first element under `selector` that renders its own text. */
const platformFamilies = async (page: Page, selector: string): Promise<ReadonlyArray<string>> => {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("DOM.enable")
    await cdp.send("CSS.enable")
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 })
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: `${selector}, ${selector} *`
    })
    for (const nodeId of nodeIds.slice(0, 64)) {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId })
      if (fonts.length > 0) return fonts.map((font) => font.familyName)
    }
    return []
  } finally {
    await cdp.detach()
  }
}

// In-page code is passed as source text, so the helper needs no DOM types in a consumer's tsconfig.
/** Records every layout shift, with each moved source's rect before → after, on `window.__rlyFontSwap`. */
const RECORD_SHIFTS = `
window.__rlyFontSwap = { releasedAt: Infinity, shifts: [] };
const rect = (box) => box ? Math.round(box.x) + "," + Math.round(box.y) + " " + Math.round(box.width) + "×" + Math.round(box.height) : "?";
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const moved = (entry.sources || []).map((source) => {
      const node = source.node;
      const text = node && node.nodeType === Node.TEXT_NODE ? ' "' + String(node.textContent || "").slice(0, 24) + '"' : "";
      return String(node ? node.nodeName : "").toLowerCase() + "." + String(node && node.className || "") + text + " " +
        rect(source.previousRect) + " → " + rect(source.currentRect);
    });
    window.__rlyFontSwap.shifts.push({ ...entry.toJSON(), moved });
  }
}).observe({ buffered: true, type: "layout-shift" });
`

/** Ten "0"s in the mono fallback at 14px: exactly 84px unless glyph advances are hinted. */
const MEASURE_ZEROS = `(() => {
  const canvas = document.createElement("canvas").getContext("2d");
  if (canvas === null) return 0;
  canvas.font = "14px 'Geist Mono Fallback'";
  return canvas.measureText("0000000000").width;
})()`

/** See the module comment. Throws a tagged error when the measurement itself is not valid. */
export const measureFontSwapShift = async (page: Page, options: FontSwapOptions): Promise<FontSwapShift> => {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let fontRequests = 0
  const held = new Map<string, Buffer>(options.inlineFonts ?? [])

  await page.addInitScript({ content: RECORD_SHIFTS })
  const holdFont = async (route: Route): Promise<void> => {
    fontRequests += 1
    await released
    const body = held.get(route.request().url())
    await (body === undefined
      ? route.continue()
      : route.fulfill({ body, contentType: "font/woff2", headers: { "access-control-allow-origin": "*" } }))
  }
  await page.route(/\.woff2(?:[?#].*)?$/, holdFont)
  // A page whose CSP allows only `data:` fonts would block the held URL, so documents also allow it.
  await page.route(
    (url) => url.protocol.startsWith("http"),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback()
      const response = await route.fetch()
      const headers = response.headers()
      const policy = headers["content-security-policy"]
      if (policy === undefined) return route.fulfill({ response })
      return route.fulfill({
        headers: { ...headers, "content-security-policy": allowHeldFonts(policy) },
        response
      })
    }
  )
  // Stylesheets that inline their fonts get them moved to held URLs, so they swap like a network font.
  await page.route(/\.css(?:[?#].*)?$/, async (route) => {
    const response = await route.fetch()
    const { fonts, text } = externaliseInlineFonts(await response.text())
    for (const [url, bytes] of fonts) held.set(url, bytes)
    await route.fulfill({ body: text, response })
  })

  try {
    if (options.load !== undefined) await options.load()
    else await page.goto(options.url ?? "/", { waitUntil: "commit" })
    await page.locator(options.ready).first().waitFor()
    const probe = options.probe ?? options.ready
    // Liberation Mono's "0" is exactly 0.6em, so ten of them at 14px are 84px unless advances are hinted.
    const zeros = Schema.decodeUnknownSync(Schema.Number)(await page.evaluate(MEASURE_ZEROS))
    if (Math.abs(zeros - 84) > 0.5) throw new FontSwapHintedRenderingError({ measured: zeros })
    const fallback = await platformFamilies(page, probe)
    if (fontRequests === 0) throw new FontSwapNoFontError({ url: page.url() })
    // The stack itself must name the metric-matched face: where system-ui is Liberation Sans, a stack
    // without it renders the same family unadjusted, which the platform-font check alone would pass.
    const stack = Schema.decodeUnknownSync(Schema.String)(
      await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(probe)})).fontFamily`)
    )
    if (!/Geist (?:Mono )?Fallback/.test(stack)) {
      throw new FontSwapFallbackMissingError({ families: [stack], selector: probe })
    }
    if (!fallback.some((family) => FALLBACK_FAMILIES.includes(family))) {
      throw new FontSwapFallbackMissingError({ families: fallback, selector: probe })
    }
    await page.evaluate("window.__rlyFontSwap.releasedAt = performance.now()")
    release()
    // Two frames after the fonts load, so the relayout after the last face loads has been observed.
    await page.evaluate(
      "document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))"
    )
    const swapped = await platformFamilies(page, probe)
    if (!swapped.some((family) => family.startsWith("Geist"))) {
      throw new FontSwapNotSwappedError({ families: swapped, selector: probe })
    }
    const releasedAt = Schema.decodeUnknownSync(Schema.Number)(await page.evaluate("window.__rlyFontSwap.releasedAt"))
    const entries: ReadonlyArray<FontSwapEntry> = decodeShifts(await page.evaluate("window.__rlyFontSwap.shifts"))
      .filter((shift) => shift.startTime >= releasedAt && !shift.hadRecentInput)
      .map(({ moved, value }) => ({ moved, value }))
    const sum = entries.reduce((total, entry) => total + entry.value, 0)
    return {
      entries,
      fallback,
      report: `font-swap shift ${sum.toFixed(4)} (fallback ${fallback.join(", ")}): ${JSON.stringify(entries)}`,
      sum
    }
  } finally {
    release()
    await page.unroute(/\.woff2(?:[?#].*)?$/)
    await page.unroute(/\.css(?:[?#].*)?$/)
    await page.unrouteAll({ behavior: "ignoreErrors" })
  }
}
