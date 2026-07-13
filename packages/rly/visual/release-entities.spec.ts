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

test("keeps six release outcomes distinct and scan-friendly", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_400, width: 1_440 })
  await page.goto(story("patterns-releaserow--six-states"))

  const rows = page.locator("[data-rly-release-state]")
  await expect(rows).toHaveCount(6)
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-rly-release-state")))).toEqual([
    "blocked",
    "ready",
    "deploying",
    "building",
    "shipped",
    "held"
  ])
  await expect(page.getByRole("button", { name: "Preview release" })).toHaveCount(6)
  const firstRow = rows.first()
  const firstRowBox = await firstRow.boundingBox()
  const firstActionBox = await firstRow.getByRole("button", { name: "Preview release" }).boundingBox()
  if (firstRowBox === null || firstActionBox === null) throw new Error("Release row geometry was unavailable")
  expect(firstActionBox.y - firstRowBox.y).toBeLessThan(120)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("release-states.png") })

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-releaserow--compact", "active"))
  await expectNoHorizontalOverflow(page)
})

test("moves from release row to controlled preview and restores focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_100, width: 1_200 })
  await page.goto(story("patterns-releasepreview--interaction"))

  const trigger = page.getByRole("button", { name: "Preview Copper Finch" })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Release preview: v2.4.0 Copper Finch" })
  await expect(dialog).toBeVisible()
  await expect(page.locator("[data-rly-release-preview-summary]")).toBeFocused()
  await expect(dialog.locator("[data-rly-release-preview-slot]")).toHaveCount(5)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("release-preview.png") })
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()

  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("patterns-releasepreview--compact-forced-colors", "active"))
  await expect(page.getByRole("dialog")).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("shows six Jira items with PR and pipeline dimensions", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_400, width: 1_440 })
  await page.goto(story("patterns-worksetcard--release-dimensions"))

  await expect(page.locator("[data-rly-workset-dimension]")).toHaveCount(3)
  await expect(page.locator("[data-rly-workset-jira-id]")).toHaveCount(6)
  await expect(page.locator("[data-rly-workset-pr-id]")).toHaveCount(2)
  await expect(page.locator("[data-rly-workset-pipeline-id]")).toHaveCount(1)
  await expect(page.locator("[data-rly-linked-jira-key='OPS-430']")).toHaveCount(2)
  await expect(page.getByText("OPS-433 has no CodeCommit pull request")).toBeVisible()
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("release-workset.png") })

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-worksetcard--cardinalities-forced-colors", "active"))
  await expectNoHorizontalOverflow(page)
})

test("preserves entity rows across every degraded state and compact reflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_600, width: 1_440 })
  await page.goto(story("patterns-entitytable--states"))

  await expect(page.getByRole("region", { name: "Ready entities" }).locator("[data-rly-entity-row-id]")).toHaveCount(20)
  for (const state of ["stale", "partial", "error", "unavailable"]) {
    await expect(
      page.getByRole("region", { name: `${state} entities` }).locator("[data-rly-entity-row-id]")
    ).toHaveCount(6)
  }

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-entitytable--compact-forced-colors", "active"))
  await expect(page.locator("[data-rly-entity-row-id]")).toHaveCount(6)
  const sort = page.getByRole("button", { name: "Sort by Item, currently ascending" })
  await expect(sort).toBeVisible()
  await sort.focus()
  await expect(sort).toBeFocused()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("entity-table-320.png") })
})

test("keeps service context and actor provenance visible", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_600, width: 1_440 })
  await page.goto(story("patterns-entityshell--services"))
  await expect(page.locator("[data-rly-entity-shell]")).toHaveCount(5)
  for (const service of ["codecommit", "codepipeline", "jira", "confluence", "clockify"]) {
    await expect(page.locator(`[data-rly-service="${service}"]`).first()).toBeVisible()
  }

  await page.goto(story("patterns-timelinerow--actor-kinds"))
  for (const actor of ["human", "agent", "plugin", "system"]) {
    await expect(page.locator(`[data-rly-timeline-actor="${actor}"]`).first()).toBeVisible()
  }
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("timeline-actors.png") })
})
