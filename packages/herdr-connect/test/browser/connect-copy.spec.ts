/** Copy, links and touch scrolling in the Connect terminal, against the fixture hub. */
import { devices, expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"

const Screen = Schema.Struct({ cols: Schema.Number, rows: Schema.Array(Schema.String) })
const Command = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.String),
  lines: Schema.optional(Schema.Number)
})

const open = async (
  page: Page,
  scrollState?: {
    readonly mode: "known" | "unknown"
    readonly start?: number
    readonly lines?: number
    readonly chase?: number
    readonly delay?: number
    readonly rtt?: number
    // No reading at all until a test sends one, as before a hub's first read lands.
    readonly muted?: boolean
  }
) => {
  // Opened links land on a stub page instead of a DNS failure, so the popup keeps its URL.
  await page.context().route(
    "https://example.test/**",
    (route) => route.fulfill({ body: "linked", contentType: "text/plain" })
  )
  await page.request.post("/__test/reset")
  if (scrollState !== undefined) {
    const query = new URLSearchParams({
      mode: scrollState.mode,
      start: String(scrollState.start ?? 0),
      lines: String(scrollState.lines ?? 300),
      chase: String(scrollState.chase ?? 0),
      delay: String(scrollState.delay ?? 0)
    })
    if (scrollState.rtt !== undefined) query.set("rtt", String(scrollState.rtt))
    await page.request.post(`/__test/scroll-state?${query.toString()}`)
    if (scrollState.muted === true) await page.request.post("/__test/scroll-state/mute?on=1")
  }
  await page.goto("/")
  await page.getByRole("button", { name: /fixture-pane/ }).click()
  await expect(page.getByText("connected", { exact: true })).toBeVisible()
  // A session that starts scrolled back never shows the newest line, so wait for any screen instead.
  const newest = (scrollState?.start ?? 0) > 0 ? "" : "300 "
  await expect.poll(async () => (await screen(page)).rows.some((row) => row.startsWith(newest) && row.trim() !== ""))
    .toBe(true)
}

const screen = async (page: Page) =>
  Schema.decodeUnknownSync(Screen)(await (await page.request.get("/__test/screen")).json())
const commands = async (page: Page) =>
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ at: Schema.Number, command: Command })))(
    await (await page.request.get("/__test/commands")).json()
  ).map((entry) => entry.command)

/** Viewport point at the centre of a cell, found by the text on the fixture's screen. */
const cellPoint = async (page: Page, rowPrefix: string, col: number) => {
  const current = await screen(page)
  const row = current.rows.findIndex((text) => text.startsWith(rowPrefix))
  expect(row).toBeGreaterThanOrEqual(0)
  const box = await page.locator(".ghostty-terminal canvas").boundingBox()
  if (box === null) throw new Error("terminal canvas missing")
  const width = box.width / current.cols
  const height = box.height / current.rows.length
  return { x: box.x + (col + 0.5) * width, y: box.y + (row + 0.5) * height }
}

/** The floating context the client shows while it knows it scrolled back. */
const olderOutput = (page: Page) => page.getByRole("status", { name: /^Older output/ })

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

const controlClick = async (page: Page, point: { readonly x: number; readonly y: number }) => {
  await page.keyboard.down("Control")
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up("Control")
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] })

  test("drag selects without touching the clipboard; Ctrl+C copies and is not sent", async ({ page }) => {
    await open(page)
    await page.evaluate(() => navigator.clipboard.writeText("untouched"))
    const from = await cellPoint(page, "290 ", 0)
    const to = await cellPoint(page, "291 ", 14)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
    expect(await clipboard(page)).toBe("untouched")
    await page.keyboard.press("Control+c")
    await expect.poll(() => clipboard(page)).toBe("290 output line\n291 output line")
    expect((await commands(page)).filter((command) => command.text === "\u0003")).toEqual([])
  })

  test("Ctrl+C without a selection still interrupts the agent", async ({ page }) => {
    await open(page)
    const point = await cellPoint(page, "295 ", 2)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press("Control+c")
    await expect.poll(async () => (await commands(page)).some((command) => command.text === "\u0003")).toBe(true)
  })

  test("triple-click selects a whole wrapped line", async ({ page }) => {
    await open(page)
    const current = await screen(page)
    const first = current.rows.findIndex((row) => row.startsWith("285 "))
    const second = current.rows[first + 1] ?? ""
    const point = await cellPoint(page, second, 3)
    await page.mouse.click(point.x, point.y, { clickCount: 3 })
    await page.keyboard.press("Control+c")
    await expect.poll(() => clipboard(page)).toBe(
      `285 ${"long-command --flag ".repeat(6)}https://example.test/wrapped/path`
    )
  })

  test("Ctrl+click opens an http link in a new tab and ignores other schemes", async ({ context, page }) => {
    await open(page)
    const link = await cellPoint(page, "281 ", 12)
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      controlClick(page, link)
    ])
    await expect.poll(() => popup.url()).toBe("https://example.test/guide?step=2")
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    await popup.close()

    const opened: Array<string> = []
    context.on("page", (other) => opened.push(other.url()))
    const unsafe = await cellPoint(page, "283 ", 14)
    await controlClick(page, unsafe)
    await page.waitForTimeout(300)
    expect(opened).toEqual([])
  })
})

test.describe("touch", () => {
  const iPhone = devices["iPhone 13"]
  test.use({
    deviceScaleFactor: iPhone.deviceScaleFactor,
    hasTouch: iPhone.hasTouch,
    isMobile: iPhone.isMobile,
    permissions: ["clipboard-read", "clipboard-write"],
    userAgent: iPhone.userAgent,
    viewport: iPhone.viewport
  })

  test("a tap on a link opens it", async ({ context, page }) => {
    await open(page)
    const link = await cellPoint(page, "281 ", 12)
    const [popup] = await Promise.all([context.waitForEvent("page"), page.touchscreen.tap(link.x, link.y)])
    await expect.poll(() => popup.url()).toBe("https://example.test/guide?step=2")
  })

  test("a vertical pan follows the finger, scrolls the server, and never raises the keyboard", async ({ page }) => {
    await open(page)
    const client = await page.context().newCDPSession(page)
    const start = await cellPoint(page, "290 ", 10)
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) =>
      client.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: start.x, y }] })
    await touch("touchStart", start.y)
    for (let step = 1; step <= 10; step++) await touch("touchMove", start.y + step * 6)
    // 61 px is never a whole number of lines, so the part of a line the server cannot scroll stays
    // drawn under the finger even after every requested line has landed.
    await touch("touchMove", start.y + 61)
    await expect.poll(() =>
      page.locator(".ghostty-terminal canvas").evaluate((canvas) =>
        new DOMMatrixReadOnly(getComputedStyle(canvas).transform).m42
      )
    ).toBeGreaterThan(0)
    await touch("touchEnd", start.y + 61)
    await expect.poll(async () =>
      (await commands(page)).filter((command) => command.type === "terminal.scroll" && command.direction === "up")
        .reduce((sum, command) => sum + (command.lines ?? 0), 0)
    ).toBeGreaterThanOrEqual(3)
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA")
    await expect(olderOutput(page)).toHaveAccessibleName(/^Older output, \d+ lines back$/)
  })

  test("a flick keeps scrolling after the finger lifts", async ({ page }) => {
    await open(page)
    const client = await page.context().newCDPSession(page)
    const start = await cellPoint(page, "290 ", 10)
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] })
    for (let step = 1; step <= 5; step++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x, y: start.y + step * 24 }]
      })
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    const upLines = async () =>
      (await commands(page)).filter((command) => command.type === "terminal.scroll" && command.direction === "up")
        .reduce((sum, command) => sum + (command.lines ?? 0), 0)
    const atLift = await upLines()
    // The finger covered 120px (8 lines at most); momentum carries well past it.
    await expect.poll(upLines).toBeGreaterThan(Math.max(atLift, 8) + 8)
  })

  test("Jump to latest reaches the newest output and stops scrolling there", async ({ page }) => {
    await open(page)
    const client = await page.context().newCDPSession(page)
    const start = await cellPoint(page, "290 ", 10)
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] })
    for (let step = 1; step <= 8; step++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x, y: start.y + step * 10 }]
      })
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    const jump = page.getByRole("toolbar", { name: "Terminal keyboard controls" })
      .getByRole("button", { name: "Jump to latest output" })
    await expect(jump).toBeVisible()
    await page.waitForTimeout(200)
    await expect(olderOutput(page)).toBeVisible()
    await jump.tap()
    await expect(olderOutput(page)).toHaveCount(0)
    await expect.poll(async () => (await screen(page)).rows.some((row) => row.startsWith("300 "))).toBe(true)
    // Once a page down changes nothing, the jump stops sending.
    const settled = (await commands(page)).length
    await page.waitForTimeout(600)
    expect((await commands(page)).length).toBe(settled)
  })

  test("the rail's Latest key is always there and stops once a page down changes nothing", async ({ page }) => {
    await open(page)
    await expect(olderOutput(page)).toHaveCount(0)
    await page.getByRole("toolbar", { name: "Terminal keyboard controls" })
      .getByRole("button", { name: "Jump to latest output" }).tap()
    const downs = async () =>
      (await commands(page)).filter((command) => command.type === "terminal.scroll" && command.direction === "down")
        .length
    await expect.poll(downs).toBeGreaterThan(0)
    await page.waitForTimeout(600)
    // Already at the newest output: one page down, one unchanged frame, then it stops.
    expect(await downs()).toBeLessThanOrEqual(3)
    const settled = await downs()
    await page.waitForTimeout(600)
    expect(await downs()).toBe(settled)
  })

  test("the Select key opens the same text view without a long-press", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: "Select terminal text to copy" }).tap()
    const layer = page.getByRole("region", { name: "Terminal text" })
    await expect(layer).toContainText("300 output line")
    await layer.getByRole("button", { name: "Done" }).tap()
    await expect(layer).toHaveCount(0)
  })

  test("long-press shows the screen as selectable text and copies it whole", async ({ page }) => {
    await open(page)
    const client = await page.context().newCDPSession(page)
    const point = await cellPoint(page, "290 ", 4)
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
    await page.waitForTimeout(600)
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    const layer = page.getByRole("region", { name: "Terminal text" })
    await expect(layer).toBeVisible()
    await expect(layer).toContainText("https://example.test/wrapped/path")
    await layer.getByRole("button", { name: "Copy screen" }).tap()
    await expect.poll(() => clipboard(page)).toContain("290 output line\n291 output line")
    await layer.getByRole("button", { name: "Done" }).tap()
    await expect(layer).toHaveCount(0)
  })
})

// The rail must never cut a key or hide one off to the side on a phone.
for (const width of [320, 390]) {
  test(`every rail key is whole and inside the bar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await open(page)
    const rail = page.getByRole("toolbar", { name: "Terminal keyboard controls" })
    const bar = await rail.boundingBox()
    if (bar === null) throw new Error("rail missing")
    const keys = await rail.getByRole("button").all()
    expect(keys.length).toBeGreaterThanOrEqual(10)
    for (const key of keys) {
      const box = await key.boundingBox()
      if (box === null) throw new Error("key missing")
      expect(box.x).toBeGreaterThanOrEqual(bar.x)
      expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5)
      expect(box.height).toBeGreaterThanOrEqual(32)
    }
    expect(
      await rail.evaluate((element) => {
        const scroller = element.querySelector(".terminal-key-scroll")
        return scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth
      })
    ).toBeLessThanOrEqual(0)
  })
}

test.describe("scroll position from the hub", () => {
  const rail = (page: Page) => page.getByRole("toolbar", { name: "Terminal keyboard controls" })
  const downs = async (page: Page) =>
    (await commands(page)).filter((command) => command.type === "terminal.scroll" && command.direction === "down")
      .map((command) => command.lines ?? 0)

  test("a pane left scrolled back says so on open, and Latest returns in exact pages", async ({ page }) => {
    await open(page, { mode: "known", start: 50 })
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back")
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect(olderOutput(page)).toHaveCount(0)
    expect(await downs(page)).toEqual([50])
  })

  test("a deep jump keeps one command in flight and still lands on the newest line", async ({ page }) => {
    await open(page, { mode: "known", start: 30_000, lines: 31_000 })
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 30000 lines back")
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect(olderOutput(page)).toHaveCount(0, { timeout: 20_000 })
    const sent = await downs(page)
    expect(sent.reduce((total, lines) => total + lines, 0)).toBe(30_000)
    expect(sent.length).toBe(75)
    const inFlight = Schema.decodeUnknownSync(Schema.Struct({ most: Schema.Number }))(
      await (await page.request.get("/__test/in-flight")).json()
    )
    expect(inFlight.most).toBe(1)
  })

  test("output that arrives before Latest is clicked is sent too", async ({ page }) => {
    await open(page, { mode: "known", start: 50 })
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back")
    // herdr keeps the reader's place, so 10 new lines put the pane 60 back before any reading says so.
    await page.request.post("/__test/grow?lines=10")
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page)).toEqual([50, 10])
    await expect(olderOutput(page)).toHaveCount(0)
    await expect.poll(async () => (await screen(page)).rows.some((row) => row.startsWith("310 "))).toBe(true)
  })

  test("a page scrolled up locally is returned by Latest before any reading arrives", async ({ page }) => {
    await open(page, { mode: "known", start: 0 })
    await page.request.post("/__test/scroll-state/mute?on=1")
    const point = await cellPoint(page, "295 ", 2)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press("PageUp")
    await expect.poll(async () => (await commands(page)).some((command) => command.direction === "up")).toBe(true)
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    const ups = (await commands(page)).filter((command) => command.direction === "up").map((command) =>
      command.lines ?? 0
    )
    await expect.poll(() => downs(page)).toEqual(ups)
    await expect.poll(async () => (await screen(page)).rows.some((row) => row.startsWith("300 "))).toBe(true)
  })

  test("a jump deeper than 120,000 lines still lands on the newest line in one press", async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, { mode: "known", start: 120_400, lines: 121_000 })
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 120400 lines back")
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect(olderOutput(page)).toHaveCount(0, { timeout: 60_000 })
    expect((await downs(page)).reduce((total, lines) => total + lines, 0)).toBe(120_400)
  })

  test("from a known position, Page Down scrolls toward the newest output; at the bottom it sends nothing", async ({ page }) => {
    await open(page, { mode: "known", start: 50 })
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back")
    const point = await cellPoint(page, "2", 2)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press("PageDown")
    await expect.poll(() => downs(page)).not.toEqual([])
    const sent = (await downs(page)).reduce((total, lines) => total + lines, 0)
    // A page is the screen's height, but never more than the 50 lines the pane is back.
    expect(sent).toBe(Math.min(50, (await screen(page)).rows.length))
    if (sent < 50) await expect(olderOutput(page)).toHaveAccessibleName(`Older output, ${String(50 - sent)} lines back`)
    else await expect(olderOutput(page)).toHaveCount(0)

    await open(page, { mode: "known", start: 0 })
    const bottom = await cellPoint(page, "295 ", 2)
    await page.mouse.click(bottom.x, bottom.y)
    await page.keyboard.press("PageDown")
    await page.waitForTimeout(300)
    expect(await downs(page)).toEqual([])
  })

  test("a reading taken before a local scroll does not undo it", async ({ page }) => {
    await open(page, { mode: "known", start: 0 })
    await page.request.post("/__test/scroll-state/mute?on=1")
    const point = await cellPoint(page, "295 ", 2)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press("PageUp")
    await expect.poll(async () => (await commands(page)).some((command) => command.direction === "up")).toBe(true)
    const ups = (await commands(page)).filter((command) => command.direction === "up").map((command) =>
      command.lines ?? 0
    )
    // herdr was sampled at the bottom before the Page Up reached it.
    await page.request.post("/__test/reading?offset=0&commands=0")
    await expect(olderOutput(page)).toHaveAccessibleName(`Older output, ${String(ups[0] ?? 0)} lines back`)
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page)).toEqual(ups)
  })

  test("Latest keeps going while output keeps arriving behind it, until a reading says 0", async ({ page }) => {
    await open(page, { mode: "known", start: 50, chase: 10 })
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    // 50, then the 5 lines that arrived during each of the ten pages after it.
    await expect.poll(() => downs(page), { timeout: 15_000 }).toEqual([50, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5])
    await expect(olderOutput(page)).toHaveCount(0)
  })

  test("Latest waits for a slow reading before it decides the pane is at the bottom", async ({ page }) => {
    // The reading after the first page takes 2.5 s, and 5 lines arrived while that page was sent.
    await open(page, { mode: "known", start: 50, chase: 1, delay: 2_500 })
    // The opening reading is just as slow.
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back", { timeout: 10_000 })
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page), { timeout: 15_000 }).toEqual([50, 5])
    await expect(olderOutput(page)).toHaveCount(0, { timeout: 10_000 })
  })

  test("a failed read keeps the last known position instead of showing the bottom", async ({ page }) => {
    await open(page, { mode: "known", start: 50 })
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back")
    await page.request.post("/__test/reading?offset=null&commands=0")
    await page.waitForTimeout(300)
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back")
  })

  test("a first reading taken before a scroll does not undo it", async ({ page }) => {
    await open(page, { mode: "known", start: 0, muted: true })
    const point = await cellPoint(page, "295 ", 2)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press("PageUp")
    await expect.poll(async () => (await commands(page)).some((command) => command.direction === "up")).toBe(true)
    const ups = (await commands(page)).filter((command) => command.direction === "up").map((command) =>
      command.lines ?? 0
    )
    // The hub's first read sampled the pane at the bottom, before the Page Up reached herdr.
    await page.request.post("/__test/reading?offset=0&commands=0")
    await page.waitForTimeout(300)
    await expect(olderOutput(page)).toHaveAccessibleName(`Older output, ${String(ups[0] ?? 0)} lines back`)
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page)).toEqual(ups)
  })

  test("a first reading that lands during a jump takes over with the exact rest", async ({ page }) => {
    // No reading yet, so Latest probes 400 lines a page; each page takes 300 ms to land.
    await open(page, { mode: "known", start: 2_000, lines: 3_000, muted: true, rtt: 300 })
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page)).toEqual([400])
    // The hub's first read, taken before that probe reached herdr.
    await page.request.post("/__test/reading?offset=2000&commands=0")
    await expect.poll(() => downs(page), { timeout: 10_000 }).toEqual([400, 400, 400, 400, 400])
    await page.waitForTimeout(1_000)
    // Exactly 2000: no probe past the bottom.
    expect(await downs(page)).toEqual([400, 400, 400, 400, 400])
  })

  test("a read that fails mid-jump waits for the page in flight before probing", async ({ page }) => {
    await open(page, { mode: "known", start: 50, muted: true, rtt: 1_500 })
    await page.request.post("/__test/reading?offset=50&commands=0")
    await expect(olderOutput(page)).toHaveAccessibleName("Older output, 50 lines back")
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page)).toEqual([50])
    await page.request.post("/__test/reading?offset=null&commands=0")
    await page.waitForTimeout(500)
    // The 50 is still in flight, so no second page yet.
    expect(await downs(page)).toEqual([50])
    await expect.poll(() => downs(page), { timeout: 10_000 }).toEqual([50, 400])
  })

  test("an unreadable position falls back to the local estimate and the page-by-page jump", async ({ page }) => {
    await open(page, { mode: "unknown", start: 30 })
    await expect(olderOutput(page)).toHaveCount(0)
    await rail(page).getByRole("button", { name: "Jump to latest output" }).click()
    await expect.poll(() => downs(page)).toContain(400)
  })
})
