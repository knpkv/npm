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

// Conservative per-axis physical-pixel bound for Chromium screenshot textures.
const FrameDimension = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16_384))
export const FrameSize = Schema.Struct({ width: FrameDimension, height: FrameDimension })

/** Native RAF polling survives the installed clock. Two frame callbacks bracket a render opportunity. */
export const waitForCapturePaint = async (page: Page): Promise<void> => {
  const ready = await page.waitForFunction(
    (state) => {
      state.polls += 1
      return state.polls >= 3
    },
    { polls: 0 },
    { polling: "raf" }
  )
  await ready.dispose()
}

/** Finish finite motion, reset infinite motion, and reject script-created motion until evidence is complete. */
const freezeCaptureMotion = (page: Page) =>
  page.evaluateHandle(() => {
    const animate = Element.prototype.animate
    const style = document.createElement("style")
    style.textContent = "*, ::before, ::after { transition: none !important; }"
    let lateAnimation = false
    Element.prototype.animate = function(this: Element, ...args: Parameters<Element["animate"]>) {
      lateAnimation = true
      const animation = animate.apply(this, args)
      animation.cancel()
      return animation
    }
    const restore = () => {
      Element.prototype.animate = animate
      style.remove()
    }
    try {
      for (const animation of document.getAnimations()) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish()
        else animation.cancel()
      }
      document.head.append(style)
      return {
        interrupted: () =>
          lateAnimation ||
          document.getAnimations().some((animation) => animation.playState === "running" || animation.pending),
        restore
      }
    } catch (cause) {
      restore()
      throw cause
    }
  })

// Motion is already frozen for metadata and every image. Screenshots must not mutate it again.
const frozenScreenshotSettings = { ...screenshotSettings, animations: "allow" } satisfies Parameters<
  Page["screenshot"]
>[0]

/** Visible named regions, resolved tokens, document-space boxes, DOM order and nearest region parent. */
export const capturePage = (page: Page) =>
  browserCall("capture regions", async (): Promise<Capture> => {
    await settleCaptureFonts(page)
    await settleCapturePage(page)
    const motion = await freezeCaptureMotion(page)
    try {
      const restore = await maskUuidText(page)
      try {
        await waitForCapturePaint(page)
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
        Schema.decodeUnknownSync(FrameSize)(
          await page.evaluate(() => ({
            width: Math.ceil(
              Math.max(
                document.body.scrollWidth,
                document.documentElement.scrollWidth,
                document.body.offsetWidth,
                document.documentElement.offsetWidth,
                document.body.clientWidth,
                document.documentElement.clientWidth
              ) * window.devicePixelRatio
            ),
            height: Math.ceil(
              Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight,
                document.body.offsetHeight,
                document.documentElement.offsetHeight,
                document.body.clientHeight,
                document.documentElement.clientHeight
              ) * window.devicePixelRatio
            )
          }))
        )
        const masks = page.locator("[data-visual-uuid]")
        const frame = await page.screenshot({ ...frozenScreenshotSettings, mask: [masks], fullPage: true })
        const regions = new Map<string, Uint8Array>()
        for (const region of snapshot.regions) {
          const locator = page.locator(`[data-region="${region.name}"]`)
          if (await locator.count() === 1) {
            regions.set(region.name, await locator.screenshot({ ...frozenScreenshotSettings, mask: [masks] }))
          }
        }
        if (await motion.evaluate((guard) => guard.interrupted())) {
          throw new BrowserFailure({
            operation: "late capture animation",
            cause: "An animation started or resumed after capture motion was frozen"
          })
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
    } finally {
      try {
        await motion.evaluate((guard) => guard.restore())
      } finally {
        await motion.dispose()
      }
    }
  })
