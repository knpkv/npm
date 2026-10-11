import type { Page } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { maskUuidText, screenshotSettings, settleCaptureFonts, settleCapturePage } from "./capture.js"
import { BrowserFailure, Snapshot } from "./schema.js"

export const browserCall = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new BrowserFailure({ operation, cause }) })

export interface Capture {
  readonly snapshot: Snapshot
  readonly frame: Uint8Array
  readonly regions: ReadonlyMap<string, Uint8Array>
}

/** Visible named regions, resolved tokens, document-space boxes, DOM order and nearest region parent. */
export const capturePage = (page: Page) =>
  browserCall("capture regions", async (): Promise<Capture> => {
    await settleCaptureFonts(page)
    await settleCapturePage(page)
    const raw = await page.evaluate(() => {
      const properties = [
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "border-top",
        "border-right",
        "border-bottom",
        "border-left",
        "border-radius",
        "row-gap",
        "column-gap",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left"
      ]
      const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-region]"))
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        regions: elements.filter((element) =>
          element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        ).map((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            name: element.dataset.region,
            copy: element.innerText,
            box: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
            parent: element.parentElement?.closest<HTMLElement>("[data-region]")?.dataset.region ?? null,
            overflow: element.scrollWidth > element.clientWidth,
            styles: Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]))
          }
        })
      }
    })
    const snapshot = Schema.decodeUnknownSync(Snapshot)(raw)
    const restore = await maskUuidText(page)
    try {
      const masks = page.locator("[data-visual-uuid]")
      const frame = await page.screenshot({ ...screenshotSettings, mask: [masks], fullPage: true })
      const regions = new Map<string, Uint8Array>()
      for (const region of snapshot.regions) {
        const locator = page.locator(`[data-region="${region.name}"]`)
        if (await locator.count() === 1) {
          regions.set(region.name, await locator.screenshot({ ...screenshotSettings, mask: [masks] }))
        }
      }
      return { snapshot, frame, regions }
    } finally {
      try {
        await restore.evaluate((undo) => {
          undo()
        })
      } finally {
        await restore.dispose()
      }
    }
  })
