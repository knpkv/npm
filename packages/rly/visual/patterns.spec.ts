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
