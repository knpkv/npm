import type { JSHandle, Page } from "@playwright/test"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import { maskUuidText, screenshotSettings, settleCaptureFonts, settleCapturePage } from "./capture.js"
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
  // Only finish/cancel events produced by freezing accepted motion get one allowance.
  // All allowances expire before metadata; subsequent events stay recorded even after removal.
  const initialEvents = [];
  for (const animation of accepted) {
    if (animation instanceof CSSAnimation) {
      const timing = animation.effect?.getComputedTiming();
      const finite = Number.isFinite(timing?.endTime);
      initialEvents.push({
        target: animation.effect?.target,
        name: animation.animationName,
        pseudo: animation.effect?.pseudoElement ?? "",
        start: finite && timing?.progress === null,
        cancel: !finite
      });
    }
  }
  const recordMotion = event => {
    const key = event.type === "animationstart" ? "start" : "cancel";
    const initial = event.type === "transitionrun" ? undefined : initialEvents.find(entry =>
      entry[key] && entry.target === event.target && entry.name === event.animationName &&
      entry.pseudo === event.pseudoElement
    );
    if (initial !== undefined) initial[key] = false;
    else lateAnimation = true;
  };
  const events = ["animationstart", "animationcancel", "transitionrun"];
  for (const event of events) document.addEventListener(event, recordMotion, true);
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
      beginEvidence: () => { initialEvents.length = 0; },
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

/** Visible named regions, resolved tokens, document-space boxes, DOM order and nearest region parent. */
export const capturePage = (page: Page) =>
  browserCall("capture regions", async (): Promise<Capture> => {
    await settleCaptureFonts(page)
    await settleCapturePage(page)
    // Flush pre-freeze CSS start/run events before installing the capture listener.
    await waitForCapturePaint(page)
    const motion = await freezeCaptureMotion(page)
    try {
      const restore = await maskUuidText(page)
      try {
        await waitForCapturePaint(page)
        await motion.evaluate((guard) => guard.beginEvidence())
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
        const scale = await page.evaluate(() => window.devicePixelRatio)
        const regions = cropRegions(frame, snapshot, scale)
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
