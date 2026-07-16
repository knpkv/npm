import { expect, type Page, test } from "@playwright/test"

const story = (id: string, forcedColors = "auto"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:${forcedColors};reducedMotion:reduce;locale:en;density:comfortable`

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
}

test("opens exact context before the agent composer without stealing focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_100, width: 1_200 })
  await page.goto(story("patterns-agentdrawer--interaction"))

  const launcher = page.getByRole("button", { name: /Ask agent.*Release v2.4.0/u })
  await launcher.click()
  const dialog = page.getByRole("dialog", { name: "Release agent" })
  const context = dialog.locator("[data-rly-agent-drawer-slot=\"context\"]")
  await expect(context).toBeFocused()
  expect(
    await dialog.locator("[data-rly-agent-drawer-slot]").evaluateAll((slots) =>
      slots.map((slot) => slot.getAttribute("data-rly-agent-drawer-slot"))
    )
  ).toEqual([
    "context",
    "evidence",
    "capabilities",
    "thread",
    "composer"
  ])
  const update = page.getByRole("button", { name: "Add live update" })
  await update.click()
  await expect(update).toBeFocused()
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("agent-drawer.png") })
  await page.keyboard.press("Escape")
  await expect(launcher).toBeFocused()

  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("patterns-agentdrawer--compact-forced-colors", "active"))
  await expect(page.getByRole("dialog", { name: "Release agent" })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("keeps human and agent identity distinct in an isolated release thread", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_200 })
  await page.goto(story("patterns-agentthread--release-thread"))

  await expect(page.locator("[data-agent-thread-release-thread-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-agent-thread-message]")).toHaveCount(4)
  await expect(
    page.locator("[data-rly-agent-thread-actor='human'] [data-rly-agent-thread-avatar-shape='circle']")
  ).toHaveCount(1)
  await expect(
    page.locator("[data-rly-agent-thread-actor='agent'] [data-rly-agent-thread-avatar-shape='rounded-square']")
  ).toHaveCount(2)
  const append = page.getByRole("button", { name: "Append agent update" })
  await expect(append).toBeFocused()

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-agentthread--compact-forced-colors", "active"))
  await expect(page.locator("[data-rly-agent-thread-message]")).toHaveCount(20)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("agent-thread-320.png") })
})

test("shows cancellable and truthful terminal agent jobs", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_400, width: 1_440 })
  await page.goto(story("patterns-agentjob--states"))

  await expect(page.locator("[data-agent-job-states-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-agent-job-state]")).toHaveCount(6)
  await expect(page.locator("[data-rly-agent-job-outcome]")).toHaveCount(3)
  await expect(page.locator("[data-rly-agent-job-state='cancel-requested'] button")).toHaveCount(0)
  const cancel = page.getByRole("button", { name: "Request cancellation" }).first()
  await expect(cancel).toBeFocused()
  await expect(page.getByText("Cancellation requests: 1")).toBeVisible()

  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("patterns-agentjob--compact-forced-colors", "active"))
  await expect(page.getByText("64%", { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("agent-job-320.png") })
})

test("requires a human confirmation and keeps terminal outcomes explicit", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_200 })
  await page.goto(story("patterns-governedactionreview--confirmation"))

  await expect(page.locator("[data-governed-action-confirmation-play-complete='true']")).toBeAttached()
  await expect(page.getByText("The agent proposed this action. Only the named human reviewer can authorize it."))
    .toBeVisible()
  const authorize = page.getByRole("button", { name: "Authorize exact action" })
  await expect(page.getByRole("checkbox")).toBeChecked()
  await expect(authorize).toBeEnabled()
  await expect(page.getByRole("status")).toContainText("Human authorization callback requested.")
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("governed-review.png") })

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-governedactionreview--terminal-states", "active"))
  await expect(page.locator("[data-rly-governed-action-state]")).toHaveCount(6)
  await expect(page.getByRole("button", { name: "Authorize exact action" })).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})
