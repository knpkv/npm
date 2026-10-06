import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { monitorEnv } from "../../playwright.config.js"

// Review finding: an unbroken task or branch name widened its tile, and the page, at phone width.
test("unbroken task and branch names wrap inside their tile at 390px", async ({ page }, testInfo) => {
  // The monitor accepts one publication per second, after the demo board.spec published.
  await page.waitForTimeout(1100)
  const now = Date.now()
  const long = "verifySignedApprovalAgainstRequestedRevisionBeforeShipping".repeat(3)
  const file = testInfo.outputPath("snapshot.json")
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      boardId: "main",
      sequence: now,
      sourceAt: now,
      title: "Long names",
      agents: [{
        id: "long",
        name: long,
        task: long,
        state: "working",
        status: long,
        blocker: null,
        jiraKey: null,
        branch: `feat/${long}`,
        pullRequest: null,
        clockify: null,
        elapsedSeconds: 60
      }]
    })
  )
  execFileSync("node", ["dist/cli.js", "publish", file], { env: { ...process.env, ...monitorEnv } })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto("/")
  await page.getByLabel("View key").fill(monitorEnv.MONITOR_VIEW_TOKEN)
  await page.getByRole("button", { name: "Open board" }).click()
  await expect(page.getByRole("heading", { name: "Long names" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  const tile = await page.locator(".agent").boundingBox()
  const widest = await page.locator(".agent *").evaluateAll((elements) =>
    Math.max(...elements.map((element) => element.getBoundingClientRect().right))
  )
  expect(tile !== null && widest <= tile.x + tile.width + 1).toBe(true)
})
