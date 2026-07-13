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

const projection = async (root: ReturnType<Page["locator"]>): Promise<ReadonlyArray<ReadonlyArray<string>>> =>
  root.locator("[data-rly-relationship-id]").evaluateAll((items) =>
    items.map((item) => [
      item.getAttribute("data-rly-relationship-id") ?? "",
      item.getAttribute("data-rly-relationship-lifecycle") ?? "",
      item.getAttribute("data-rly-relationship-kind") ?? "",
      item.getAttribute("data-rly-relationship-direction") ?? "",
      item.querySelector("[data-rly-relationship-evidence]")?.textContent?.trim() ?? ""
    ])
  )

test("keeps every stage explicit in the compact forced-color rail", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("patterns-stagerail--compact-forced-colors", "active"))

  const stages = page.locator("[data-rly-stage-id]")
  const connectors = page.locator("[data-rly-stage-connector]")
  await expect(stages).toHaveCount(6)
  await expect(connectors).toHaveCount(5)
  for (const label of ["Not started", "Building", "Verified", "Held", "Blocked", "Ready"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible()
  }
  for (let index = 0; index < (await connectors.count()); index += 1) {
    await expect(connectors.nth(index)).toHaveCSS("width", "1px")
  }
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("stages-320.png") })
})

test("keeps lifecycle, direction, people, and missing endpoints explicit at 320 pixels", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-relationshipchain--compact-forced-colors", "active"))

  const chain = page.getByRole("region", { name: "Compact lifecycle matrix" })
  const records = chain.locator("[data-rly-relationship-id]")
  await expect(records).toHaveCount(7)
  for (const lifecycle of ["missing", "inferred", "proposed", "verified", "governed", "rejected", "superseded"]) {
    await expect(page.locator(`[data-rly-relationship-lifecycle="${lifecycle}"]`)).toHaveCount(1)
  }
  const missing = chain.locator("[data-rly-endpoint-state='missing']")
  await expect(missing).toContainText("Missing CodeCommit pull request")
  await expect(missing).toContainText("No implementation relationship has been recorded.")
  await expect(missing.locator("a")).toHaveCount(0)
  const links = chain.locator("a")
  await expect(links.nth(0)).toHaveAttribute("href", /\/jira\//u)
  await expect(links.nth(1)).toHaveAttribute("href", /\/pull-requests\//u)
  await links.nth(0).focus()
  await page.keyboard.press("Tab")
  await expect(page.locator(":focus")).toHaveAttribute("href", /\/pull-requests\//u)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("chain-320.png") })
})

test("keeps chain and native table projections equivalent", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_440 })
  await page.goto(story("patterns-relationshiptable--equivalence"))

  const chain = page.getByRole("region", { name: "Chain projection" })
  const table = page.getByRole("region", { name: "Table twenty" })
  await expect(chain.locator("[data-rly-relationship-id]")).toHaveCount(20)
  await expect(table.locator("tbody tr")).toHaveCount(20)
  expect(await projection(table)).toEqual(await projection(chain))
  await expect(table.getByRole("columnheader")).toHaveCount(4)

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-relationshiptable--compact-forced-colors", "active"))
  await expect(page.locator("[data-rly-relationship-id]")).toHaveCount(7)
  await expect(page.getByRole("columnheader")).toHaveCount(4)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("table-320.png") })
})
