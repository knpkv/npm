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

test("keeps all service and freshness identities explicit in forced colors", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("patterns-evidencestamp--compact-forced-colors", "active"))

  for (const provider of ["CodeCommit", "CodePipeline", "Jira", "Confluence", "Clockify"]) {
    await expect(page.getByRole("img", { name: provider })).toBeVisible()
  }
  for (const state of ["Current", "Cached", "Stale", "Missing", "Unavailable"]) {
    await expect(page.getByText(state, { exact: true })).toBeVisible()
  }
  await expect(page.locator("[data-rly-evidence-source]")).toHaveCount(5)
  await expect(page.locator("[data-rly-evidence-freshness]")).toHaveCount(5)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("evidence-320.png") })
})

test("keeps named collaborator roles and controlled overflow clear at 320 pixels", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("patterns-peoplestrip--overflow"))

  const strip = page.getByRole("list", { exact: true, name: "Release collaborators" })
  await strip.getByRole("button", { name: "Show fewer people" }).click()
  await expect(strip.getByText("Avery Diaz")).toBeVisible()
  await expect(strip.getByText("PR author")).toBeVisible()
  const overflow = strip.getByRole("button", { name: "Show 2 more people" })
  await expect(overflow).toHaveText("+2 people")
  await overflow.click()
  await expect(strip.getByText("Emery van der Meer-Rodríguez with a deliberately long full name")).toBeVisible()
  await expect(strip.getByText("Merge approver")).toBeVisible()
  await expect(overflow).toHaveCount(0)
  await expect(strip.getByRole("button", { name: "Show fewer people" })).toHaveAttribute("aria-expanded", "true")
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("people-320.png") })
})

test(
  "keeps region headers on one rule and the content inside the frame at 320 pixels, in forced colors too",
  async ({ page }, testInfo) => {
    for (const forcedColors of ["auto", "active"]) {
      await page.setViewportSize({ height: 1_200, width: 320 })
      await page.goto(story("patterns-region--states", forcedColors))

      const findings = page.getByRole("region", { name: "Findings 2" })
      await expect(findings).toBeVisible()
      await expect(findings.getByRole("button", { name: "Acknowledge all" })).toBeVisible()
      const frame = await findings.boundingBox()
      const button = await findings.getByRole("button", { name: "Acknowledge all" }).boundingBox()
      expect(frame).not.toBeNull()
      expect(button).not.toBeNull()
      if (frame !== null && button !== null) expect(button.x + button.width).toBeLessThanOrEqual(frame.x + frame.width)
      const border = await findings.evaluate((element) => getComputedStyle(element).borderTopStyle)
      expect(border).toBe("solid")
      await expectNoHorizontalOverflow(page)
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: testInfo.outputPath(`region-320-${forcedColors}.png`)
      })
    }
  }
)
