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

const open = async (page: Page) => {
  // Opened links land on a stub page instead of a DNS failure, so the popup keeps its URL.
  await page.context().route(
    "https://example.test/**",
    (route) => route.fulfill({ body: "linked", contentType: "text/plain" })
  )
  await page.request.post("/__test/reset")
  await page.goto("/")
  await page.getByRole("button", { name: /fixture-pane/ }).click()
  await expect(page.getByText("connected", { exact: true })).toBeVisible()
  await expect.poll(async () => (await screen(page)).rows.some((row) => row.startsWith("300 "))).toBe(true)
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
    const transform = await page.locator(".ghostty-terminal canvas").evaluate((canvas) =>
      new DOMMatrixReadOnly(getComputedStyle(canvas).transform).m42
    )
    expect(transform).toBeGreaterThan(0)
    await touch("touchEnd", start.y + 60)
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
    const jump = olderOutput(page).getByRole("button", { name: "Jump to latest output" })
    await expect(jump).toBeVisible()
    await page.waitForTimeout(200)
    await jump.tap()
    await expect(jump).toHaveCount(0)
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
