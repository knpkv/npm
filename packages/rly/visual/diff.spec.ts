import { expect, type Locator, type Page, test } from "@playwright/test"

const story = (id: string, forcedColors = "auto"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:${forcedColors};reducedMotion:reduce;locale:en;density:comfortable`

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
}

const expectInsideViewport = async (locator: Locator, page: Page): Promise<void> => {
  const bounds = await locator.boundingBox()
  if (bounds === null) throw new Error("Diff surface geometry was unavailable")
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0)
}

const constructedThemeCss = (container: Locator): Promise<string> =>
  container.evaluate((element) => {
    const root = element.shadowRoot
    if (root === null) throw new Error("Diff shadow root was unavailable")
    return root.adoptedStyleSheets
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join("\n")
  })

const fallbackThemeCss = (container: Locator): Promise<string> =>
  container.evaluate((element) => {
    const themes = element.shadowRoot?.querySelectorAll("style[data-theme-css]")
    if (themes === undefined || themes.length === 0) throw new Error("Diff fallback theme style was unavailable")
    return Array.from(themes, (theme) => theme.textContent ?? "").join("\n")
  })

test("renders the actual split diff and preserves the completed review interaction", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_100, width: 1_440 })
  await page.goto(story("diff-diffcodeview--workbench"))

  await expect(page.locator("[data-diff-code-view-workbench-play-complete='true']")).toBeAttached()
  const diff = page.locator("[data-rly-diff-code-view]")
  await expect(diff).toHaveAttribute("data-rly-diff-mode", "split")
  await expect(diff.locator("diffs-container")).toHaveCount(2)
  await expect(page.getByText("All six linked pull requests are now approved.")).toBeVisible()
  await expect(page.getByText("Audit evidence appended without resetting the viewer")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("diff-split.png") })
})

test("updates an adopted diff theme without remounting", async ({ page }) => {
  await page.goto(story("diff-diffcodeview--theme-transition"))
  const container = page.locator("diffs-container").first()

  await expect.poll(() => constructedThemeCss(container)).toContain("color-scheme: light")
  await container.evaluate((element) => {
    element.dataset.themeTransitionIdentity = "retained"
  })
  await page.getByRole("button", { name: "Use dark diff theme" }).click()
  await expect(page.locator("[data-diff-theme-type='dark']")).toBeAttached()
  await expect.poll(() => constructedThemeCss(container)).toContain("color-scheme: dark")
  await expect(container).toHaveAttribute("data-theme-transition-identity", "retained")
})

test("updates the style-element diff theme fallback without remounting", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: undefined })
  })
  await page.goto(story("diff-diffcodeview--theme-transition"))
  const container = page.locator("diffs-container").first()

  await expect.poll(() => fallbackThemeCss(container)).toContain("color-scheme: light")
  await container.evaluate((element) => {
    element.dataset.themeTransitionIdentity = "retained"
  })
  await page.getByRole("button", { name: "Use dark diff theme" }).click()
  await expect(page.locator("[data-diff-theme-type='dark']")).toBeAttached()
  await expect.poll(() => fallbackThemeCss(container)).toContain("color-scheme: dark")
  await expect(container).toHaveAttribute("data-theme-transition-identity", "retained")
})

test("keeps the real stacked and wrapped renderer inside 320 pixels", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("diff-diffcodeview--stacked-wrapped"))

  await expect(page.locator("[data-diff-code-view-stacked-wrapped-play-complete='true']")).toBeAttached()
  const diff = page.locator("[data-rly-diff-code-view]")
  await expect(diff).toHaveAttribute("data-rly-diff-mode", "stacked")
  await expect(diff.locator("diffs-container")).toHaveCount(2)
  await expectInsideViewport(diff, page)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("diff-stacked-320.png") })
})

test("renders rich application annotations in light and dark virtualized presentations", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_440 })
  await page.goto(story("diff-diffcodeview--rich-annotations").replace("theme:dark", "theme:light"))
  await expect(page.locator("[data-diff-code-view-rich-annotations-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-diff-annotation]")).toHaveCount(5)
  await expect(page.locator("[data-annotation-status='dismissed']")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("diff-rich-annotations-light.png")
  })

  await page.goto(story("diff-diffcodeview--rich-annotations-dark"))
  await expect(page.locator("[data-diff-code-view-rich-annotations-dark-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-diff-mode='stacked']")).toBeAttached()
  await expect(page.locator("[data-rly-diff-annotation]")).toHaveCount(5)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("diff-rich-annotations-dark.png")
  })
})

test("preserves virtualized state across annotation replacement", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1_200 })
  await page.goto(story("diff-diffcodeview--annotation-state-preservation"))
  await expect(page.locator("[data-diff-code-view-annotation-state-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-annotation-status='resolved']")).toBeVisible()
})

test("keeps rich annotations in the synchronous bounded fallback", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_440 })
  await page.goto(story("diff-boundeddiffcodeview--rich-annotations"))
  await expect(page.locator("[data-bounded-diff-rich-annotations-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-diff-annotation]")).toHaveCount(5)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("diff-bounded-rich-annotations.png")
  })
})

test("keeps the six-file bird-eye review, people, and stale evidence visible", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_440 })
  await page.goto(story("diff-diffworkbench--bird-eye-review"))

  await expect(page.locator("[data-diff-workbench-bird-eye-play-complete='true']")).toBeAttached()
  const workbench = page.getByRole("region", { name: "PR-184 complete diff review" })
  await expect(workbench).toHaveAttribute("data-rly-diff-scope", "all-files")
  await expect(workbench).not.toHaveAttribute("data-rly-diff-selected-file")
  await expect(workbench.locator("[data-rly-diff-file-id]")).toHaveCount(6)
  await expect(workbench.locator("diffs-container")).toHaveCount(3)
  await expect(workbench.locator("code[data-code]").first()).toHaveAttribute("tabindex", "0")
  await expect(workbench.locator("[data-rly-diff-finding-source='human']")).toHaveCount(1)
  await expect(workbench.locator("[data-rly-diff-finding-source='agent']")).toHaveCount(2)
  await expect(workbench.locator("[data-rly-diff-finding-anchor='stale']")).toHaveCount(1)
  await expect(workbench.getByText("Agent finding · not an approval").first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("diff-workbench.png") })
})

test("opens agent prevention details from the keyboard without compact overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("diff-difffinding--compact-forced-colors", "active"))

  const prevention = page.locator("[data-rly-diff-finding-prevention='eslint']")
  const summary = prevention.locator("summary")
  await expect(prevention).toHaveAttribute("open", "")
  await summary.focus()
  await expect(summary).toBeFocused()
  await summary.press("Enter")
  await expect(prevention).not.toHaveAttribute("open")
  await summary.press("Enter")
  await expect(prevention).toHaveAttribute("open", "")
  await expect(prevention.getByText("Matcher or invariant")).toBeVisible()
  await expect(prevention.getByText("Must reject")).toBeVisible()
  await expect(prevention.getByText("Must allow")).toBeVisible()
  await expect(prevention.getByText("Boundary")).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("diff-prevention-320.png")
  })
})

test("shows the complete 500-file inventory and compact forced-color states", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 900, width: 1_200 })
  await page.goto(story("diff-difffiletree--complete-five-hundred"))

  await expect(page.locator("[data-diff-file-tree-five-hundred-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-diff-file-id]")).toHaveCount(500)
  await expect(page.locator("[data-rly-diff-file-id='inventory-file-1']")).toBeVisible()
  await expect(page.locator("[data-rly-diff-file-id='inventory-file-500']")).toBeAttached()
  await expect(page.locator("[data-rly-catalog] pre")).toHaveCount(0)
  await expect(page.getByText("500/500")).toBeVisible()

  await page.setViewportSize({ height: 1_100, width: 320 })
  await page.goto(story("diff-difffiletree--compact-forced-colors", "active"))
  await expect(page.locator("[data-diff-file-tree-compact-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-catalog]")).toHaveAttribute("data-rly-forced-colors", "active")
  await expect(page.locator("[data-rly-diff-file-id]")).toHaveCount(7)
  for (const state of ["ready", "loading", "binary", "generated", "oversized", "unavailable", "error"]) {
    await expect(page.locator(`[data-rly-diff-content-state='${state}']`)).toHaveCount(1)
  }
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("diff-inventory-320.png") })
})
