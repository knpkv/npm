import { expect, test } from "@playwright/test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import { capturePage } from "../src/browser.js"
import { installCaptureClock, VISUAL_TIME } from "../src/capture.js"

test("capture waits for native frames after masking, even with a paused clock", async ({ page }) => {
  await installCaptureClock(page)
  await page.clock.pauseAt(new Date(VISUAL_TIME))
  await page.setContent("<main data-region=\"content\">Workspace 12345678-1234-1234-1234-123456789012</main>")

  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const waitForFunction = page.waitForFunction.bind(page)
  const screenshot = page.screenshot.bind(page)
  let barriers = 0
  let barrierPassed = false
  let screenshots = 0
  page.waitForFunction = async <R, Arg>(...args: Parameters<typeof page.waitForFunction<R, Arg>>) => {
    barriers += 1
    // The first barrier drains freeze-generated events; hold the masked evidence barrier.
    if (barriers === 1) return waitForFunction<R, Arg>(...args)
    expect(await page.locator("[data-visual-uuid]").count()).toBe(1)
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
    const handle = await waitForFunction<R, Arg>(...args)
    barrierPassed = true
    return handle
  }
  page.screenshot = async (options) => {
    expect(barrierPassed).toBe(true)
    screenshots += 1
    return screenshot(options)
  }
  const capture = Effect.runPromise(capturePage(page))
  try {
    await Promise.race([Effect.runPromise(Deferred.await(entered)), capture])
    expect(screenshots).toBe(0)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await capture
  }
  const result = await capture
  expect(result.frame.byteLength).toBeGreaterThan(0)
  expect(screenshots).toBe(1)
  expect(barriers).toBe(3)
  expect(await page.locator("[data-visual-uuid]").count()).toBe(0)
})

test("an oversized full-page frame fails before the screenshot protocol call", async ({ page }) => {
  await page.setContent("<main data-region=\"content\" style=\"width:17000px\">Workspace</main>")
  const screenshot = page.screenshot.bind(page)
  let screenshots = 0
  page.screenshot = async (options) => {
    screenshots += 1
    return screenshot(options)
  }
  const result = await Effect.runPromise(capturePage(page).pipe(Effect.exit))
  expect(result._tag).toBe("Failure")
  expect(screenshots).toBe(0)
})

/** Solid fixture colors locate the rendered rectangles independently of the sampled DOM geometry. */
const paintedBox = (image: PNG, color: { readonly red: number; readonly green: number; readonly blue: number }) => {
  let x = image.width
  let y = image.height
  let right = -1
  let bottom = -1
  for (let row = 0; row < image.height; row += 1) {
    for (let column = 0; column < image.width; column += 1) {
      const pixel = (row * image.width + column) * 4
      if (
        image.data[pixel] === color.red && image.data[pixel + 1] === color.green &&
        image.data[pixel + 2] === color.blue && image.data[pixel + 3] === 255
      ) {
        x = Math.min(x, column)
        y = Math.min(y, row)
        right = Math.max(right, column)
        bottom = Math.max(bottom, row)
      }
    }
  }
  expect(right).toBeGreaterThanOrEqual(x)
  expect(bottom).toBeGreaterThanOrEqual(y)
  return { x, y, width: right - x + 1, height: bottom - y + 1 }
}

test("running transitions and infinite animations have matching sampled metadata and pixels", async ({ page }) => {
  test.setTimeout(15_000)
  await installCaptureClock(page)
  await page.clock.pauseAt(new Date(VISUAL_TIME))
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.setViewportSize({ width: 390, height: 260 })
  await page.setContent(`
    <style>
      body { margin: 0; background: white; font-size: 16px; }
      [data-region] { position: absolute; inset-inline-start: 1em; inline-size: 2.5em; block-size: 2.5em; }
      #transition { inset-block-start: 1em; background: rgb(255, 0, 0); }
      #infinite { inset-block-start: 6em; background: rgb(0, 0, 255); }
      @media (prefers-reduced-motion: no-preference) {
        #transition { transition: inline-size 60s linear, background-color 60s linear; }
        #infinite { animation: slide 60s infinite linear; }
      }
      @keyframes slide { from { transform: translateX(5em); } to { transform: translateX(10em); } }
    </style>
    <div id="transition" data-region="transition"></div>
    <div id="infinite" data-region="infinite"></div>
  `)
  const initial = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("#transition")
    if (element !== null) {
      element.getBoundingClientRect()
      element.style.inlineSize = "7.5em"
      element.style.backgroundColor = "rgb(0, 255, 0)"
    }
    const animations = document.getAnimations()
    for (const animation of animations) animation.currentTime = 30_000
    return animations.map((animation) => ({
      running: animation.playState === "running",
      endTime: animation.effect?.getComputedTiming().endTime
    }))
  })
  expect(initial).toHaveLength(3)
  expect(initial.every((animation) => animation.running)).toBe(true)
  expect(initial.filter((animation) => animation.endTime === Number.POSITIVE_INFINITY)).toHaveLength(1)

  const result = await Effect.runPromise(capturePage(page))
  const frame = PNG.sync.read(Buffer.from(result.frame))
  const colors = [
    { name: "transition", red: 0, green: 255, blue: 0, css: "rgb(0, 255, 0)" },
    { name: "infinite", red: 0, green: 0, blue: 255, css: "rgb(0, 0, 255)" }
  ]
  expect(result.snapshot.regions.map((region) => region.name)).toEqual(colors.map((color) => color.name))
  expect(result.regions.size).toBe(2)
  for (const color of colors) {
    const region = result.snapshot.regions.find((region) => region.name === color.name)
    const box = paintedBox(frame, color)
    expect(region?.box).toEqual(box)
    expect(region?.styles["background-color"]).toBe(color.css)
    const bytes = result.regions.get(color.name)
    expect(bytes?._tag).toBe("Image")
    if (bytes?._tag === "Image") {
      const image = PNG.sync.read(Buffer.from(bytes.bytes))
      expect({ width: image.width, height: image.height }).toEqual({ width: box.width, height: box.height })
      expect(paintedBox(image, color)).toEqual({ x: 0, y: 0, width: box.width, height: box.height })
    }
  }
  expect(result.snapshot.regions[0]?.box.width).toBe(120)
  expect(result.snapshot.regions[1]?.box.x).toBe(16)
})

test("a script animation started after sampling invalidates capture and restores the motion guard", async ({ page }) => {
  test.setTimeout(15_000)
  await page.setContent(
    "<div data-region=\"content\" style=\"inline-size:40px;block-size:40px;transition:inline-size 60s linear\"></div>"
  )
  const original = await page.evaluateHandle(() => Element.prototype.animate)
  try {
    const screenshot = page.screenshot.bind(page)
    page.screenshot = async (options) => {
      const pending = screenshot(options)
      await page.evaluate(() => {
        document.querySelector("[data-region]")?.animate(
          [{ transform: "translateX(0px)" }, { transform: "translateX(100px)" }],
          { duration: 60_000, fill: "forwards" }
        )
      })
      return pending
    }
    const result = await Effect.runPromise(capturePage(page).pipe(Effect.result))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "BrowserFailure",
        cause: { _tag: "BrowserFailure", operation: "late capture animation" }
      }
    })
    expect(await original.evaluate((animate) => Element.prototype.animate === animate)).toBe(true)
    expect(await page.locator("[data-region]").evaluate((element) => getComputedStyle(element).transitionDuration))
      .toBe("60s")
  } finally {
    await original.dispose()
  }
})

for (const duration of ["0s", "0.01s"]) {
  test(`late finished CSS animation (${duration}) invalidates sampled evidence`, async ({ page }) => {
    test.setTimeout(15_000)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.setContent(`
      <style>
        body { margin: 0; }
        [data-region] { inline-size: 2.5em; block-size: 2.5em; background: rgb(255, 0, 0); }
        @media (prefers-reduced-motion: no-preference) { .late { animation: grow ${duration} forwards; } }
        @keyframes grow { to { inline-size: 7.5em; background: rgb(0, 255, 0); } }
      </style>
      <div data-region="content"></div>
    `)
    const screenshot = page.screenshot.bind(page)
    page.screenshot = async (options) => {
      await page.evaluate(async () => {
        document.querySelector("[data-region]")?.classList.add("late")
        await Promise.all(document.getAnimations().map((animation) => animation.finished))
      })
      return screenshot(options)
    }
    const result = await Effect.runPromise(capturePage(page).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "BrowserFailure",
        cause: { _tag: "BrowserFailure", operation: "late capture animation" }
      })
    }
  })
}

test("below-fold region evidence uses frame crops without firing scroll mutations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 260 })
  await page.setContent(`
    <style>
      body { margin: 0; font-size: 16px; }
      [data-region] { inline-size: 2.5em; block-size: 2.5em; background: rgb(255, 0, 0); }
      #below { margin-block-start: 30em; }
    </style>
    <div data-region="above"></div><div id="below" data-region="below"></div>
    <script>addEventListener('scroll',()=>{document.documentElement.dataset.scrolled='true';document.querySelector('#below').style.background='rgb(0, 255, 0)'})</script>
  `)
  const result = await Effect.runPromise(capturePage(page))
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await page.locator("html").getAttribute("data-scrolled")).toBeNull()
  const frame = PNG.sync.read(Buffer.from(result.frame))
  for (const region of result.snapshot.regions) {
    const bytes = result.regions.get(region.name)
    expect(bytes?._tag).toBe("Image")
    if (bytes?._tag !== "Image") continue
    const image = PNG.sync.read(Buffer.from(bytes.bytes))
    const expected = new PNG({ width: image.width, height: image.height })
    PNG.bitblt(frame, expected, region.box.x, region.box.y, image.width, image.height, 0, 0)
    expect(image.data).toEqual(expected.data)
    expect(paintedBox(image, { red: 255, green: 0, blue: 0 }))
      .toEqual({ x: 0, y: 0, width: 40, height: 40 })
  }
})

/** A no-fill animation vanishes from getAnimations before capture checks its evidence. */
test("late no-fill CSS motion retains event evidence after animationend mutates the region", async ({ page }) => {
  test.setTimeout(15_000)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.setContent(`
    <style>
      body { margin: 0; font-size: 16px; }
      [data-region] { inline-size: 2.5em; block-size: 2.5em; background: rgb(255, 0, 0); }
      @media (prefers-reduced-motion: no-preference) { .late { animation: grow 0s; } }
      @keyframes grow { to { inline-size: 7.5em; } }
    </style>
    <div data-region="content"></div>
  `)
  const screenshot = page.screenshot.bind(page)
  page.screenshot = async (options) => {
    await page.locator("[data-region]").evaluate((element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("animationend", () => {
          element.style.inlineSize = "7.5em"
          element.style.backgroundColor = "rgb(0, 255, 0)"
          resolve()
        }, { once: true })
        element.classList.add("late")
        element.getBoundingClientRect()
      })
    )
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
    expect(await page.locator("[data-region]").evaluate((element) => element.getBoundingClientRect().width)).toBe(120)
    return screenshot(options)
  }
  const result = await Effect.runPromise(capturePage(page).pipe(Effect.result))
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "BrowserFailure", cause: { _tag: "BrowserFailure", operation: "late capture animation" } }
  })
  page.screenshot = screenshot
  await page.setContent("<div data-region=content style='inline-size:40px;block-size:40px'></div>")
  expect((await Effect.runPromise(capturePage(page))).snapshot.regions[0]?.box.width).toBe(40)
})

test("in-frame and partially clipped regions retain matching frame pixels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 260 })
  for (const x of [0, -20]) {
    await page.setContent(`
      <style>body { margin: 0; } [data-region] { inline-size: 40px; block-size: 40px; background: rgb(255, 0, 0); transform: translateX(${x}px); }</style>
      <div data-region=content></div>
    `)
    const result = await Effect.runPromise(capturePage(page))
    expect(result.snapshot.regions[0]?.box).toEqual({ x, y: 0, width: 40, height: 40 })
    const pixels = result.regions.get("content")
    expect(pixels?._tag).toBe("Image")
    if (pixels?._tag !== "Image") continue
    const image = PNG.sync.read(Buffer.from(pixels.bytes))
    expect(paintedBox(image, { red: 255, green: 0, blue: 0 }))
      .toEqual({ x: 0, y: 0, width: 40 + x, height: 40 })
    expect(await page.evaluate(() => scrollX + scrollY)).toBe(0)
  }
})

const finiteMotionHtml = (fill: string, delay: number) => `
  <style>
    body { margin: 0; font-size: 16px; }
    main { inline-size: 7.5em; block-size: 2.5em; background: rgb(0, 255, 0); }
    @media (prefers-reduced-motion: no-preference) { main { animation: grow 60s ${delay}s ${fill} linear; } }
    @keyframes grow {
      from { inline-size: 2.5em; background: rgb(255, 0, 0); }
      to { inline-size: 7.5em; background: rgb(0, 255, 0); }
    }
  </style>
  <main data-region=content></main>
`

for (
  const { delay, fill } of [
    { fill: "backwards", delay: 60 },
    { fill: "both", delay: 60 },
    { fill: "none", delay: 60 },
    { fill: "forwards", delay: 60 },
    { fill: "both", delay: 0 }
  ]
) {
  /** Fill-derived progress during delay must not turn pre-existing motion into a late animation. */
  test(`pre-existing ${delay === 0 ? "immediate" : "delayed"} ${fill} motion captures final geometry and pixels`, async ({ page }) => {
    test.setTimeout(15_000)
    await installCaptureClock(page)
    await page.clock.pauseAt(new Date(VISUAL_TIME))
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.setViewportSize({ width: 390, height: 260 })
    await page.setContent(finiteMotionHtml(fill, delay))
    const initial = await page.evaluate(() => {
      const animations = document.getAnimations()
      for (const animation of animations) animation.currentTime = 0
      return animations.map((animation) => ({
        currentTime: animation.currentTime,
        delay: animation.effect?.getComputedTiming().delay,
        progress: animation.effect?.getComputedTiming().progress
      }))
    })
    expect(initial).toHaveLength(1)
    expect(initial[0]?.delay).toBe(delay * 1000)
    if (delay > 0 && (fill === "backwards" || fill === "both")) expect(initial[0]?.progress).toBe(0)
    const captured = await Effect.runPromise(capturePage(page).pipe(Effect.result))
    expect(captured._tag, captured._tag === "Failure" ? JSON.stringify(captured.failure) : undefined).toBe("Success")
    if (captured._tag !== "Success") return
    const result = captured.success
    const expected = { x: 0, y: 0, width: 120, height: 40 }
    expect(result.snapshot.regions[0]?.box).toEqual(expected)
    expect(paintedBox(PNG.sync.read(Buffer.from(result.frame)), { red: 0, green: 255, blue: 0 })).toEqual(expected)
  })
}

/** Record queued-event delivery in the same browser call that installs capture listeners. */
test("freeze-generated animationstart and animationend are delivered before capture listeners start", async ({ page }) => {
  test.setTimeout(15_000)
  await installCaptureClock(page)
  await page.clock.pauseAt(new Date(VISUAL_TIME))
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.setContent(finiteMotionHtml("both", 60))
  await page.evaluate(() => {
    for (const type of ["animationstart", "animationend"]) {
      document.addEventListener(type, (event) => {
        const root = document.documentElement
        root.dataset.motionEvents = [root.dataset.motionEvents, event.type].filter(Boolean).join(",")
      }, true)
    }
  })
  const evaluateHandle = page.evaluateHandle.bind(page)
  let calls = 0
  page.evaluateHandle = async <R, Arg>(...args: Parameters<typeof page.evaluateHandle<R, Arg>>) => {
    calls += 1
    if (calls !== 1) return evaluateHandle<R, Arg>(...args)
    const [source, arg] = args
    const script = Schema.decodeUnknownSync(Schema.String)(source)
    // Wrap the guard without extra browser round trips between the barrier and listener installation.
    return evaluateHandle<R, Arg>(
      String.raw`(() => {
      const guard = ${script};
      const begin = guard.beginEvidence;
      guard.beginEvidence = () => {
        const root = document.documentElement;
        root.dataset.motionEventsAtEvidence = root.dataset.motionEvents ?? "";
        begin();
      };
      return guard;
    })()`,
      arg
    )
  }
  expect((await Effect.runPromise(capturePage(page))).snapshot.regions[0]?.box.width).toBe(120)
  expect(await page.locator("html").getAttribute("data-motion-events-at-evidence"))
    .toBe("animationstart,animationend")
  expect(await page.locator("html").getAttribute("data-motion-events")).toBe("animationstart,animationend")
})

/** The flush interval must not admit motion spawned by an accepted animation's completion handler. */
test("motion spawned by a freeze event is rejected before sampling or taking a screenshot", async ({ page }) => {
  test.setTimeout(15_000)
  await installCaptureClock(page)
  await page.clock.pauseAt(new Date(VISUAL_TIME))
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.setContent(
    finiteMotionHtml("both", 60) + `
    <style>
      @media (prefers-reduced-motion: no-preference) { .late { animation: later 60s linear; } }
      @keyframes later { to { inline-size: 12em; } }
    </style>
  `
  )
  await page.locator("main").evaluate((element) => {
    element.addEventListener("animationend", () => {
      element.classList.add("late")
      element.getBoundingClientRect()
    }, { once: true })
  })
  let screenshots = 0
  const screenshot = page.screenshot.bind(page)
  page.screenshot = async (options) => {
    screenshots += 1
    return screenshot(options)
  }
  expect(await Effect.runPromise(capturePage(page).pipe(Effect.result))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "BrowserFailure", cause: { _tag: "BrowserFailure", operation: "late capture animation" } }
  })
  expect(screenshots).toBe(0)
})

/** Full-page Chromium capture re-evaluates media queries even when the breakpoint is unchanged. */
test("the first capture settles screenshot-triggered layout before publishing unchanged-source evidence", async ({ page }) => {
  await installCaptureClock(page)
  await page.clock.pauseAt(new Date(VISUAL_TIME))
  await page.setViewportSize({ width: 1280, height: 260 })
  await page.setContent(`
    <style>
      body { margin: 0; }
      main { inline-size: 120px; block-size: 40px; background: rgb(255, 0, 0); }
      .measured { block-size: 80px; }
      footer { margin-block-start: 400px; }
    </style>
    <main data-region=content></main><footer>Below the viewport</footer>
    <script>
      matchMedia("(max-width: 599px)").addEventListener("change", () => {
        document.querySelector("main").classList.add("measured");
      });
    </script>
  `)
  const originalSource = await page.locator("script").textContent()
  expect(await page.locator("main").evaluate((element) => element.getBoundingClientRect().height)).toBe(40)
  const first = await Effect.runPromise(capturePage(page))
  const control = await Effect.runPromise(capturePage(page))
  expect(await page.locator("script").textContent()).toBe(originalSource)
  expect(first.snapshot).toEqual(control.snapshot)
  expect(first.frame).toEqual(control.frame)
  expect(first.snapshot.regions[0]?.box).toEqual({ x: 0, y: 0, width: 120, height: 80 })
  expect(paintedBox(PNG.sync.read(Buffer.from(first.frame)), { red: 255, green: 0, blue: 0 }))
    .toEqual(first.snapshot.regions[0]?.box)
})

/** A discarded warm-up frame must not make an endlessly changing document look conformant. */
test("capture refuses geometry that changes on every screenshot and restores UUID masking", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 260 })
  await page.setContent(`
    <style>body { margin: 0; } main { inline-size: 120px; block-size: 40px; } footer { margin-block-start: 400px; }</style>
    <main data-region=content>12345678-1234-1234-1234-123456789012</main><footer>Below the viewport</footer>
    <script>
      let height = 40;
      matchMedia("(max-width: 599px)").addEventListener("change", () => {
        document.querySelector("main").style.blockSize = ++height + "px";
      });
    </script>
  `)
  const result = await Effect.runPromise(capturePage(page).pipe(Effect.result))
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "BrowserFailure", cause: { _tag: "BrowserFailure", operation: "capture did not settle" } }
  })
  expect(await page.locator("[data-visual-uuid]").count()).toBe(0)
  expect(await page.locator("main").textContent()).toBe("12345678-1234-1234-1234-123456789012")
})

/** Whole-frame extent is evidence even if every named region stays still. */
test("capture settles document size changes outside named regions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 260 })
  await page.setContent(`
    <style>body { margin: 0; } main { block-size: 40px; } footer { block-size: 400px; }</style>
    <main data-region=content>Workspace</main><footer></footer>
    <script>
      matchMedia("(max-width: 599px)").addEventListener("change", () => {
        document.querySelector("footer").style.blockSize = "800px";
      });
    </script>
  `)
  const first = await Effect.runPromise(capturePage(page))
  const control = await Effect.runPromise(capturePage(page))
  expect(first.snapshot).toEqual(control.snapshot)
  expect(first.frame).toEqual(control.frame)
  expect(PNG.sync.read(Buffer.from(first.frame)).height).toBe(840)
})
