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

const expectInInitialViewport = async (page: Page, selector: string): Promise<void> => {
  const geometry = await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return {
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    }
  })
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
}

// The 40px spacing token preserves one readable dossier row while the decision rail stays fixed.
const expectPersistentDecisionRail = async (page: Page, presentation: "dialog" | "sheet"): Promise<void> => {
  const geometry = await page.evaluate((currentPresentation) => {
    const surface = document.querySelector<HTMLElement>("[role='dialog']")
    const footer = document.querySelector<HTMLElement>(
      `[data-rly-release-preview-footer='${currentPresentation}']`
    )
    const dossier = document.querySelector<HTMLElement>(
      `[data-rly-release-preview-scroll='${currentPresentation}']`
    )
    if (surface === null || footer === null || dossier === null) return null
    const surfaceBounds = surface.getBoundingClientRect()
    const footerBounds = footer.getBoundingClientRect()
    return {
      dossierClientHeight: dossier.clientHeight,
      dossierScrollHeight: dossier.scrollHeight,
      footerBottom: footerBounds.bottom,
      footerTop: footerBounds.top,
      readableDossierMinBlockSize: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--rly-space-40")
      ),
      surfaceBottom: surfaceBounds.bottom,
      surfaceLeft: surfaceBounds.left,
      surfaceRight: surfaceBounds.right,
      surfaceTop: surfaceBounds.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    }
  }, presentation)
  expect(geometry).not.toBeNull()
  if (geometry === null) throw new Error(`Release preview ${presentation} decision rail geometry was unavailable`)
  expect(geometry.surfaceTop).toBeGreaterThanOrEqual(0)
  expect(geometry.surfaceLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.surfaceBottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.surfaceRight).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.surfaceTop)
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.surfaceBottom)
  expect(geometry.readableDossierMinBlockSize).toBeGreaterThan(0)
  expect(geometry.dossierClientHeight).toBeGreaterThanOrEqual(geometry.readableDossierMinBlockSize)
  expect(geometry.dossierScrollHeight).toBeGreaterThan(geometry.dossierClientHeight)
  const scrolled = await page.evaluate((currentPresentation) => {
    const footer = document.querySelector<HTMLElement>(
      `[data-rly-release-preview-footer='${currentPresentation}']`
    )
    const dossier = document.querySelector<HTMLElement>(
      `[data-rly-release-preview-scroll='${currentPresentation}']`
    )
    if (footer === null || dossier === null) return null
    dossier.scrollTop = dossier.scrollHeight
    return { dossierScrollTop: dossier.scrollTop, footerTop: footer.getBoundingClientRect().top }
  }, presentation)
  expect(scrolled).not.toBeNull()
  if (scrolled === null) throw new Error(`Release preview ${presentation} scroll geometry was unavailable`)
  expect(scrolled.dossierScrollTop).toBeGreaterThan(0)
  expect(scrolled.footerTop).toBe(geometry.footerTop)
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
  await page.setViewportSize({ height: 800, width: 1_200 })
  await page.goto(story("patterns-releasepreview--interaction"))

  const trigger = page.getByRole("button", { name: "Preview Copper Finch" })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Release preview: v2.4.0 Copper Finch" })
  await expect(dialog).toBeVisible()
  await expect(page.locator("[data-rly-release-preview-summary]")).toBeFocused()
  expect(
    await dialog.locator("[data-rly-release-preview-slot]").evaluateAll((slots) =>
      slots.map((slot) => slot.getAttribute("data-rly-release-preview-slot"))
    )
  ).toEqual(["collaborators", "primary-action", "stages", "workset", "evidence", "agent-entry"])
  await expectInInitialViewport(page, "[data-rly-release-preview-footer='dialog']")
  await expectPersistentDecisionRail(page, "dialog")
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("release-preview.png") })
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()

  for (const width of [480, 496, 640]) {
    await page.setViewportSize({ height: 800, width })
    await page.goto(story("patterns-releasepreview--compact-forced-colors", "active"))
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expectInInitialViewport(page, "[data-rly-release-preview-footer='sheet']")
    const geometry = await sheet.boundingBox()
    if (geometry === null) throw new Error(`Release preview sheet geometry was unavailable at ${width}px`)
    expect(geometry.x).toBe(0)
    expect(geometry.width).toBe(width)
    expect(geometry.height).toBe(800)
    await expectPersistentDecisionRail(page, "sheet")
  }

  for (const viewport of [{ height: 240, width: 641 }, { height: 320, width: 960 }]) {
    await page.setViewportSize(viewport)
    await page.goto(story("patterns-releasepreview--interaction"))
    await page.getByRole("button", { name: "Preview Copper Finch" }).click()
    await expectInInitialViewport(page, "[data-rly-release-preview-footer='dialog']")
    await expectPersistentDecisionRail(page, "dialog")
  }
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
