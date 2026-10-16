import type { JSHandle, Page } from "@playwright/test"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import { maskUuidText, screenshotSettings, settleCaptureFonts, settleCapturePage } from "./capture.js"
import { guardCaptureNavigation, subscribeCaptureNavigation } from "./navigation.js"
import { BrowserFailure, Snapshot } from "./schema.js"

export const browserCall = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new BrowserFailure({ operation, cause }) })

export type RegionPixels = Data.TaggedEnum<{
  Image: { readonly bytes: Uint8Array }
  OffFrame: {}
}>
export const RegionPixels = Data.taggedEnum<RegionPixels>()

export interface Capture {
  readonly snapshot: Snapshot
  readonly frame: Uint8Array
  readonly regions: ReadonlyMap<string, RegionPixels>
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

interface MotionGuard {
  readonly beginEvidence: () => void
  readonly interrupted: () => boolean
  readonly restore: () => void
}

// Browser source stays literal: tsx can inject host-only helpers into nested function callbacks.
const motionGuardScript = String.raw`(() => {
  const animate = Element.prototype.animate;
  const style = document.createElement("style");
  style.textContent = "*, ::before, ::after { transition: none !important; }";
  const accepted = new Set(document.getAnimations());
  let lateAnimation = false;
  const recordMotion = () => { lateAnimation = true; };
  const events = ["animationstart", "animationcancel", "transitionrun"];
  Element.prototype.animate = function(...args) {
    lateAnimation = true;
    const animation = animate.apply(this, args);
    animation.cancel();
    return animation;
  };
  const restore = () => {
    for (const event of events) document.removeEventListener(event, recordMotion, true);
    Element.prototype.animate = animate;
    style.remove();
  };
  try {
    for (const animation of accepted) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      else animation.cancel();
    }
    document.head.append(style);
    return {
      beginEvidence: () => {
        for (const event of events) document.addEventListener(event, recordMotion, true);
      },
      interrupted: () => lateAnimation || document.getAnimations().some(animation =>
        !accepted.has(animation) || animation.playState === "running" || animation.pending
      ),
      restore
    };
  } catch (cause) {
    restore();
    throw cause;
  }
})()`

/** Finish finite motion, reset infinite motion, and reject new animation identities until evidence is complete. */
const freezeCaptureMotion = (page: Page): Promise<JSHandle<MotionGuard>> =>
  page.evaluateHandle<MotionGuard>(motionGuardScript)

/** Crop every region from the same frame, without scrolling or re-rendering the document. */
export const cropRegions = (bytes: Uint8Array, snapshot: Snapshot, scale = 1): ReadonlyMap<string, RegionPixels> => {
  const source = PNG.sync.read(Buffer.from(bytes))
  return new Map<string, RegionPixels>(snapshot.regions.map((region) => {
    // Check layout area before rounding: fractional coordinates must not fabricate a pixel.
    if (region.box.width === 0 || region.box.height === 0) return [region.name, RegionPixels.OffFrame()]
    const x = Math.max(0, Math.floor(region.box.x * scale))
    const y = Math.max(0, Math.floor(region.box.y * scale))
    const width = Math.min(source.width, Math.ceil((region.box.x + region.box.width) * scale)) - x
    const height = Math.min(source.height, Math.ceil((region.box.y + region.box.height) * scale)) - y
    if (width <= 0 || height <= 0) return [region.name, RegionPixels.OffFrame()]
    Schema.decodeUnknownSync(FrameSize)({ width, height })
    const target = new PNG({ width, height })
    PNG.bitblt(source, target, x, y, width, height, 0, 0)
    return [region.name, RegionPixels.Image({ bytes: PNG.sync.write(target) })]
  }))
}

// Motion is already frozen for metadata and every image. Screenshots must not mutate it again.
const frozenScreenshotSettings = { ...screenshotSettings, animations: "allow" } satisfies Parameters<
  Page["screenshot"]
>[0]

/** Reject motion spawned by freeze-event handlers before sampling, and recheck after pixels. */
const assertCaptureMotion = async (motion: JSHandle<MotionGuard>): Promise<void> => {
  if (await motion.evaluate((guard) => guard.interrupted())) {
    throw new BrowserFailure({
      operation: "late capture animation",
      cause: "An animation started or resumed after capture motion was frozen"
    })
  }
}

/** Read the same evidence before and after screenshot-induced style and viewport recalculation. */
const readCaptureSnapshot = async (page: Page): Promise<Snapshot> => {
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
  return Schema.decodeUnknownSync(Snapshot)(raw)
}

const readFrameSize = async (page: Page) =>
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

/** Visible named regions, resolved tokens, document-space boxes, DOM order and nearest region parent. */
export const capturePage = (page: Page, shot = page.url()) =>
  browserCall("capture regions", async (): Promise<Capture> => {
    await settleCaptureFonts(page)
    await settleCapturePage(page)
    const motion = await freezeCaptureMotion(page)
    try {
      // Deliver finish/cancel events before every subsequent CSS motion event becomes late.
      await waitForCapturePaint(page)
      await motion.evaluate((guard) => guard.beginEvidence())
      await assertCaptureMotion(motion)
      const restore = await maskUuidText(page)
      try {
        await waitForCapturePaint(page)
        const masks = page.locator("[data-visual-uuid]")
        // A full-page screenshot can re-evaluate media queries and font selection. Never crop
        // its pixels with metadata from the preceding layout, or silently accept perpetual drift.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const snapshot = await readCaptureSnapshot(page)
          const size = await readFrameSize(page)
          const frame = await page.screenshot({ ...frozenScreenshotSettings, mask: [masks], fullPage: true })
          await page.evaluate("document.fonts.ready")
          await waitForCapturePaint(page)
          await assertCaptureMotion(motion)
          const after = await readCaptureSnapshot(page)
          const afterSize = await readFrameSize(page)
          if (
            JSON.stringify(snapshot) === JSON.stringify(after) && JSON.stringify(size) === JSON.stringify(afterSize)
          ) {
            const scale = await page.evaluate(() => window.devicePixelRatio)
            return { snapshot, frame, regions: cropRegions(frame, snapshot, scale) }
          }
        }
        throw new BrowserFailure({
          operation: "capture did not settle",
          cause: "Region evidence or document size changed across three consecutive screenshots"
        })
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
  }).pipe((capture) => guardCaptureNavigation(shot, subscribeCaptureNavigation(page), capture))
