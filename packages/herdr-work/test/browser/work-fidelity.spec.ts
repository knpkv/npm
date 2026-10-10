import { expect, test } from "@playwright/test"
import { workFidelityStates } from "./work-fidelity-fixture.js"

test.use({ timezoneId: "UTC" })

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (const state of workFidelityStates) {
      test(`Work ${state}, ${width}, ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ height: 844, width: width + 2 })
        await page.goto(`/test/browser/fixture.html?fidelity=${state}`)
        await page.evaluate(
          (selectedTheme) => document.documentElement.setAttribute("data-rly-theme", selectedTheme),
          theme
        )
        // The shell owns the single page gutter. This fixture renders only its Work content.
        await page.addStyleTag({
          content:
            "body { margin: 0; } main { box-sizing: border-box; border: 1px solid var(--rly-color-border-2); background: var(--rly-color-canvas); padding: 24px 16px 40px; } @media(min-width: 60rem) { main { padding-inline: 32px; } }"
        })
        await page.evaluate(() => document.fonts.ready)
        expect(
          await page.evaluate(() =>
            [...document.fonts].some((face) =>
              face.family.replaceAll("\"", "") === "Geist Variable" && face.display === "block" &&
              face.status === "loaded"
            )
          )
        ).toBe(true)
        await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2)
        await expect(page.locator(".work-board-list .work-row-progress, .work-board-list .work-row-evidence"))
          .toHaveCount(0)
        expect(
          await page.locator(".work-row-meta").evaluateAll((metadata) =>
            metadata.every((element) => getComputedStyle(element).fontSize === "12px")
          )
        ).toBe(true)
        if (state === "3e") {
          const emptyTitle = page.locator(".work-empty-copy > strong")
          expect(await emptyTitle.evaluate((element) => Number(getComputedStyle(element).fontWeight)))
            .toBeGreaterThanOrEqual(600)
          expect(
            await page.locator(".work-empty-copy code").first().evaluate((element) =>
              getComputedStyle(element).backgroundColor
            )
          ).not.toBe("rgba(0, 0, 0, 0)")
        }
        if (state === "3b") {
          await expect(page.getByRole("region", { name: "Goal details" })).toBeVisible()
          await expect(page.locator(".work-detail .work-step-number")).toHaveCount(4)
          await expect(page.locator(".work-connect-link")).toHaveCSS("text-decoration-line", "underline")
          await expect(page.locator(".work-connect-link svg.lucide-arrow-right")).toHaveCount(1)
          await expect(
            page.locator(".work-detail-list > li").filter({ hasText: "Skip snapshot tests" })
              .locator("svg.lucide-x")
          ).toHaveCount(1)
          expect(
            await page.locator(".work-step-name").evaluateAll((names) =>
              names.every((name) => getComputedStyle(name).overflowWrap === "normal")
            )
          ).toBe(true)
          const circles = await page.locator(".work-step-number").evaluateAll((numbers) =>
            numbers.map((number) => ({ x: number.getBoundingClientRect().x, y: number.getBoundingClientRect().y }))
          )
          if (width === 390) {
            expect(new Set(circles.map((circle) => circle.x)).size).toBe(1)
            expect(new Set(circles.map((circle) => circle.y)).size).toBe(4)
          } else {
            expect(new Set(circles.map((circle) => circle.y)).size).toBe(1)
            expect(new Set(circles.map((circle) => circle.x)).size).toBe(4)
          }
        }
        if (state === "3c") await expect(page.locator(".work-detail").getByText(/^Owner gone/)).toBeVisible()
        if (state === "3n") await expect(page.locator("button.work-board-row")).toHaveCount(0)
        // Reproduce the reference's hovered row as well as its selected inspector row.
        const hoveredTitle = state === "3a" && width === 390
          ? "Connect characters polish"
          : state === "3b" && width === 1280
          ? "Approvals countdown copy"
          : state === "3c" && width === 390
          ? "Fix offline-backup flake"
          : undefined
        if (state === "3h" && width === 390) {
          await page.locator(".work-board-row").filter({ hasText: "Fix offline-backup flake" }).hover()
        } else if (theme === "light" && hoveredTitle !== undefined) {
          await page.locator(".work-board-row").filter({ hasText: hoveredTitle }).hover()
        }
        const screenshot = await page.locator("main").screenshot({
          path: testInfo.outputPath(`work-${state}-${width}-${theme}.png`)
        })
        await testInfo.attach("Work screenshot", {
          body: screenshot,
          contentType: "image/png"
        })
      })
    }
  }
}

test("a selected goal keeps one focusable row and marks its selected row", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/test/browser/fixture.html?fidelity=3b")
  const card = page.locator(".work-rows > li").filter({ has: page.locator(".work-board-row[aria-pressed=\"true\"]") })
  await expect(card.locator("button")).toHaveCount(1)
  await expect(card.locator("button")).toHaveAttribute("aria-pressed", "true")
  await expect(card.locator("a, input, [tabindex]")).toHaveCount(0)
  const button = card.locator("button")
  await button.focus()
  await expect(button).toBeFocused()
})

for (const state of ["3a", "3n"]) {
  test(`phone status options stay on one line and scroll every focused ${state} chip into view`, async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    await page.goto(`/test/browser/fixture.html?fidelity=${state}`)
    await page.addStyleTag({
      content: "body { margin: 0; } main { padding: 16px; } @media(min-width: 60rem) { main { padding: 32px; } }"
    })
    await page.evaluate(() => document.fonts.ready)
    const row = page.getByRole("group", { name: "Filter goals by status" })
    const chips = row.locator(".work-status-filter")
    const geometry = await row.evaluate((element) => {
      const boxes = [...element.querySelectorAll(".work-status-filter")].map((chip) => chip.getBoundingClientRect())
      return {
        height: element.getBoundingClientRect().height,
        scrollbarHeight: element.getBoundingClientRect().height - element.clientHeight,
        chipHeight: Math.max(...boxes.map((box) => box.height)),
        minHeight: Math.min(...boxes.map((box) => box.height)),
        tops: new Set(boxes.map((box) => Math.round(box.top))).size,
        overflow: getComputedStyle(element).overflowX
      }
    })
    expect(geometry.overflow).toBe("auto")
    expect(geometry.tops).toBe(1)
    expect(geometry.height - geometry.scrollbarHeight).toBeCloseTo(geometry.chipHeight, 0)
    expect(geometry.minHeight).toBeGreaterThanOrEqual(44)
    await chips.first().focus()
    for (let index = 0; index < await chips.count(); index++) {
      if (index > 0) await page.keyboard.press("Tab")
      const chip = chips.nth(index)
      await expect(chip).toBeFocused()
      await expect(chip).toBeInViewport({ ratio: 1 })
      const contained = await chip.evaluate((element) => {
        const viewport = element.parentElement?.getBoundingClientRect()
        const bounds = element.getBoundingClientRect()
        return viewport !== undefined && bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
      })
      expect(contained).toBe(true)
    }
    expect(await row.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
}
