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
