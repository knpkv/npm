import { expect, type Page, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { monitorEnv } from "../../playwright.config.js"

// One publication for the file: the monitor accepts at most one per second, in increasing sequence.
test.beforeAll(() => {
  execFileSync("node", ["dist/cli.js", "demo"], { env: { ...process.env, ...monitorEnv } })
})

/** Open the synthetic demo board (three agents) with the view key. */
const openDemo = async (page: Page, width = 1280) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  await page.getByLabel("View key").fill(monitorEnv.MONITOR_VIEW_TOKEN)
  await page.getByRole("button", { name: "Open board" }).click()
  await expect(page.getByRole("heading", { name: "Demo flight board" })).toBeVisible()
}

// QA-95: each card drew a 3px coloured top stripe for its state; state is now a word.
test("cards draw no one-sided stripe and lead with their state word", async ({ page }) => {
  await openDemo(page)
  const stripes = await page.locator("body").evaluate((body) =>
    [...body.querySelectorAll("*")].flatMap((element) => {
      const style = getComputedStyle(element)
      const width = (side: string) =>
        style.getPropertyValue(`border-${side}-style`) === "none"
          ? 0
          : Number.parseFloat(style.getPropertyValue(`border-${side}-width`))
      const stripe = Math.abs(width("left") - width("right")) >= 2 || Math.abs(width("top") - width("bottom")) >= 2
      return stripe || style.boxShadow.includes("inset") ? [`${element.tagName}.${element.className}`] : []
    })
  )
  expect(stripes).toEqual([])
  await expect(page.locator(".agent .state")).toHaveText(["Working", "Blocked", "Done"])
  await expect(page.locator("#headline")).toHaveText("Reviewer is blocked: Browser slot in use")
})

// QA-97: a failed poll wiped the board; the last snapshot now stays, labelled with its age.
test("an outage keeps the last snapshot and says how old it is", async ({ page }) => {
  // The fake clock must own the page's timers from the start, including the ten-second poll.
  await page.clock.install()
  await openDemo(page)
  await page.route("**/boards/**", (route) => route.abort("internetdisconnected"))
  await page.clock.runFor(10_000)
  await expect(page.locator("#connection")).toContainText(/^Offline: showing the snapshot from /u)
  await expect(page.locator(".agent")).toHaveCount(3)
  await expect(page.getByRole("heading", { name: "Demo flight board" })).toBeVisible()
})

// ui-b: the board is read across a room. At 1920 it was a 780px column of 185px tiles with ~11px facts.
// QA-100: tiles stretched to the tallest in their row, leaving ~150px blank under a short card.
test("on a wall display the tiles fill the width, each ends at its last fact and facts are large", async ({ page }) => {
  await openDemo(page, 1920)
  const tiles = await page.locator(".agent").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { top: Math.round(box.top), width: box.width, height: Math.round(box.height) }
    })
  )
  const used = tiles.reduce((sum, tile) => sum + tile.width, 0)
  expect(used / 1920).toBeGreaterThan(0.8)
  const blankBelow = await page.locator(".agent").evaluateAll((elements) =>
    elements.map((element) => {
      const last = element.lastElementChild?.getBoundingClientRect().bottom ?? 0
      const padding = Number.parseFloat(getComputedStyle(element).paddingBottom)
      return Math.round(element.getBoundingClientRect().bottom - padding - last)
    })
  )
  expect(blankBelow.every((blank) => blank <= 1)).toBe(true)
  const fact = await page.locator(".agent dd").first().evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize)
  )
  expect(fact).toBeGreaterThanOrEqual(18)
})

// ui-b: "Blocked" was said three times; the card line gives only the reason.
test("a blocked card names its reason once, under its state word", async ({ page }) => {
  await openDemo(page)
  await expect(page.locator(".blocked .blocker")).toHaveText("Browser slot in use")
  await expect(page.locator("#connection")).toHaveText(/updated \d{2}:\d{2}$/u)
})

// QA-162: going offline wrapped the longer status line and pushed Lock and the whole board down
// (CLS 0.17 at 390, 0.40 at 768, 0.59 at 200% zoom).
for (
  const { height, name, width } of [
    { name: "390", width: 390, height: 844 },
    { name: "768", width: 768, height: 1024 },
    { name: "1280 at 200% zoom", width: 640, height: 450 }
  ]
) {
  test(`going offline moves neither Lock nor the board at ${name}`, async ({ page }) => {
    await page.clock.install()
    await openDemo(page, width)
    await page.setViewportSize({ width, height })
    const positions = () =>
      Promise.all([page.locator("#lock").boundingBox(), page.locator(".agent").first().boundingBox()]).then((boxes) =>
        boxes.map((box) => box?.y)
      )
    const before = await positions()
    await page.route("**/boards/**", (route) => route.abort("internetdisconnected"))
    await page.clock.runFor(10_000)
    await expect(page.locator("#connection")).toContainText(/^Offline: showing the snapshot from /u)
    expect(await positions()).toEqual(before)
  })
}

// ui-b on #577: "Herdr monitor" wrapped to two lines beside Lock board at 320px.
test("at 320px the title stays on one line beside Lock", async ({ page }) => {
  await openDemo(page, 320)
  const [title, lock] = await Promise.all([
    page.getByRole("heading", { level: 1 }).evaluate((heading) => {
      const range = document.createRange()
      range.selectNodeContents(heading)
      return range.getClientRects().length
    }),
    page.locator("#lock").boundingBox()
  ])
  expect(title).toBe(1)
  expect(lock !== null && lock.x + lock.width <= 320).toBe(true)
})

// ui-b on #577: at 1920 the board ran full width and fact values floated far from their labels, and
// each tile sized its own label column, so values did not line up across a row.
test("on a wall display content stops at 90rem and fact values line up across tiles", async ({ page }) => {
  await openDemo(page, 1920)
  const width = await page.locator("main").evaluate((main) => main.getBoundingClientRect().width)
  const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
  expect(width).toBeLessThanOrEqual(90 * rem)
  const valueStarts = await page.locator(".agent").evaluateAll((tiles) =>
    tiles.map((tile) => {
      const value = tile.querySelector("dd")?.getBoundingClientRect().left ?? 0
      return Math.round(value - tile.getBoundingClientRect().left)
    })
  )
  expect(new Set(valueStarts).size).toBe(1)
})
