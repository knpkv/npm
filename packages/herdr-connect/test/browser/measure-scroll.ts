/**
 * Touch-scroll measurement against the fixture hub, for before/after comparison.
 *
 * Usage: run `tsx test/browser/measure-scroll.ts` with `CONNECT_FIXTURE_URL` set to a running fixture.
 * Real touches go through CDP, so passive listeners, page scroll and the browser's own gesture
 * handling behave as they do on a phone. Where the content sits is read from the fixture — the
 * number of its top line — plus any transform the client draws on the canvas.
 */
import { chromium, devices } from "@playwright/test"
import { Config, Console, Effect, Schema } from "effect"
import { TerminalClientCommand } from "../../src/model.js"

const url = await Effect.runPromise(Config.String("CONNECT_FIXTURE_URL"))
const Screen = Schema.Struct({ cols: Schema.Number, rows: Schema.Array(Schema.String) })
const Received = Schema.Array(Schema.Struct({ at: Schema.Number, command: TerminalClientCommand }))

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices["iPhone 13"] })
const page = await context.newPage()
await page.goto(url)
await page.getByRole("button", { name: /fixture-pane/ }).click()
await page.locator("canvas").first().waitFor()
await page.waitForTimeout(500)

const screen = async () =>
  Schema.decodeUnknownSync(Screen)(await (await page.request.get(`${url}__test/screen`)).json())
const received = async () =>
  Schema.decodeUnknownSync(Received)(await (await page.request.get(`${url}__test/commands`)).json())
const topLine = async () => Number((await screen()).rows[0]?.slice(0, 3) ?? "0")

const client = await context.newCDPSession(page)
const box = await page.locator("canvas").first().boundingBox()
if (box === null) throw new Error("terminal canvas missing")
const x = box.x + box.width / 2
const cellHeight = box.height / (await screen()).rows.length
const firstTop = await topLine()

type Sample = { readonly finger: number; readonly content: number; readonly pageY: number }

const sample = async (finger: number) => {
  const top = await topLine()
  const view = await page.evaluate(() => {
    const canvas = document.querySelector("canvas")
    return {
      offset: canvas === null ? 0 : new DOMMatrixReadOnly(getComputedStyle(canvas).transform).m42,
      pageY: window.scrollY + (window.visualViewport?.offsetTop ?? 0)
    }
  })
  return { finger, content: (firstTop - top) * cellHeight + view.offset, pageY: view.pageY }
}

const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) =>
  client.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y }]
  })

// Slow drag: finger moves 240px down (towards older output) in 4px steps at ~60 Hz.
const startY = box.y + 120
await touch("touchStart", startY)
const drag: Array<Sample> = []
for (let step = 1; step <= 60; step++) {
  await touch("touchMove", startY + step * 4)
  await page.waitForTimeout(16)
  drag.push(await sample(step * 4))
}
await touch("touchEnd", startY + 240)
await page.waitForTimeout(400)
const settled = await sample(240)

// Flick: 120px in 5 quick steps, then release and watch for momentum.
await page.waitForTimeout(300)
const flickStart = await sample(0)
await touch("touchStart", startY)
for (let step = 1; step <= 5; step++) {
  await touch("touchMove", startY + step * 24)
  await page.waitForTimeout(8)
}
// Lift straight after the last move, as a finger does; sampling first would read as a pause.
const releaseAt = Date.now()
await touch("touchEnd", startY + 120)
const atRelease = await sample(120)
await page.waitForTimeout(800)
const afterFlick = await sample(120)

const commands = await received()
const linesAfterRelease = commands
  .filter((entry) => entry.at > releaseAt)
  .reduce((sum, entry) => sum + (entry.command.type === "terminal.scroll" ? entry.command.lines : 0), 0)
const errors = drag.map((s) => Math.abs(s.finger - s.content))
const result = {
  cellHeight: Number(cellHeight.toFixed(1)),
  drag: {
    meanTrackingErrorPx: Number((errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(1)),
    maxTrackingErrorPx: Number(Math.max(...errors).toFixed(1)),
    contentAtEndPx: Number(drag.at(-1)?.content.toFixed(1)),
    contentSettledPx: Number(settled.content.toFixed(1)),
    fingerPx: 240
  },
  flick: {
    contentAtReleasePx: Number((atRelease.content - flickStart.content).toFixed(1)),
    momentumAfterReleasePx: Number((afterFlick.content - atRelease.content).toFixed(1)),
    linesRequestedAfterRelease: linesAfterRelease
  },
  pageDriftPx: Math.max(...[...drag, settled, atRelease, afterFlick].map((s) => Math.abs(s.pageY))),
  scrollCommands: commands.filter((entry) => entry.command.type === "terminal.scroll").length
}
await Effect.runPromise(Console.log(JSON.stringify(result, null, 2)))
await browser.close()
