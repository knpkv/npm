import { expect, test } from "@playwright/test"

const story = (id: string, theme = "dark"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:${theme};forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable`

const iconButtonSizes: ReadonlyArray<readonly [name: string, size: number]> = [
  ["Mark done", 32],
  ["Add item", 40],
  ["Search", 48],
  ["Continue", 56]
]

test("preserves deliberate control geometry and the shared focus treatment", async ({ page }) => {
  await page.goto(story("primitives-button--states"))

  const dense = page.locator("[data-button-size=\"dense\"]")
  const compact = page.locator("[data-button-size=\"compact\"]")
  const standard = page.locator("[data-button-size=\"default\"]")
  const principal = page.locator("[data-button-size=\"principal\"]")
  await expect(compact).toBeVisible()

  expect(Math.round((await dense.boundingBox())?.height ?? 0)).toBe(32)
  expect(Math.round((await compact.boundingBox())?.height ?? 0)).toBe(40)
  expect(Math.round((await standard.boundingBox())?.height ?? 0)).toBe(48)
  expect(Math.round((await principal.boundingBox())?.height ?? 0)).toBe(56)

  await compact.focus()
  await expect(compact).toBeFocused()
  const focus = await compact.evaluate((element) => {
    const style = getComputedStyle(element)
    return { offset: style.outlineOffset, width: style.outlineWidth }
  })
  expect(focus).toEqual({ offset: "2px", width: "3px" })

  await page.goto(story("primitives-iconbutton--states"))
  for (const [name, size] of iconButtonSizes) {
    const button = page.getByRole("button", { name })
    const box = await button.boundingBox()
    expect(Math.round(box?.height ?? 0)).toBe(size)
    expect(Math.round(box?.width ?? 0)).toBe(size)
  }
})

test("sizes toggle groups to the shared control heights, border included", async ({ page }) => {
  await page.goto(story("primitives-togglegroup--interaction"))
  const groups: ReadonlyArray<readonly [name: string, size: number]> = [
    ["Range", 32],
    ["Range (compact)", 40],
    ["Range (default)", 48]
  ]
  for (const [name, size] of groups) {
    const group = page.getByRole("radiogroup", { exact: true, name })
    expect(Math.round((await group.boundingBox())?.height ?? 0)).toBe(size)
    // The options carry the full height themselves; the outline does not take it from them.
    for (
      const box of await group.getByRole("radio").evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect())
      )
    ) {
      expect(Math.round(box.height)).toBe(size)
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(size)
    }
  }
})

test("keeps a toggle group on one row that scrolls inside a narrow screen", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(story("primitives-togglegroup--interaction"))
  const tops = await page
    .getByRole("radiogroup", { exact: true, name: "Range (default)" })
    .getByRole("radio")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test("keeps state explanations readable without horizontal overflow at 320 pixels", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 320 })
  await page.goto(story("primitives-statepanel--gallery"))

  await expect(page.getByText("Blocked")).toBeVisible()
  await expect(page.getByRole("status")).toContainText("Checking changes")
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
})
