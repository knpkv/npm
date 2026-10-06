import { expect, test } from "@playwright/test"

const story = (id: string, theme = "dark"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:${theme};forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable`

const iconButtonSizes: ReadonlyArray<readonly [name: string, size: number]> = [
  ["Add item", 44],
  ["Search", 48],
  ["Continue", 56]
]

test("preserves deliberate control geometry and the shared focus treatment", async ({ page }) => {
  await page.goto(story("primitives-button--states"))

  const compact = page.locator("[data-button-size=\"compact\"]")
  const standard = page.locator("[data-button-size=\"default\"]")
  const principal = page.locator("[data-button-size=\"principal\"]")
  await expect(compact).toBeVisible()

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

test("draws every gallery track on one scale and fits a 320 pixel screen", async ({ page }) => {
  for (const width of [1000, 320]) {
    await page.setViewportSize({ height: 900, width })
    await page.goto(story("primitives-limittrack--gallery"))
    await expect(page.locator("[data-limit] [data-tone]").first()).toBeVisible()
    const widths = await page.locator("[data-limit] [data-tone]").evaluateAll((tracks) =>
      tracks.map((track) => Math.round(track.getBoundingClientRect().width))
    )
    expect(widths.length).toBeGreaterThan(1)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
    const dimensions = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth
    }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
  }
})

test("preserves stale readings and their key in forced colours", async ({ page }) => {
  await page.goto(story("primitives-limittrack--gallery"))
  const stale = page.locator("[data-limit=\"Codex weekly\"] [data-part=\"fill\"]")
  const fresh = page.locator("[data-limit=\"5-hour window\"] [data-part=\"fill\"]")
  const staleKey = page.locator("[data-mark=\"stale\"]")
  const unknown = page.locator("[data-limit=\"Codex 5-hour\"] [data-part=\"fill\"]")
  await expect(stale).toBeVisible()
  await expect(staleKey).toBeVisible()
  await expect(stale).not.toHaveCSS("background-image", "none")
  await expect(fresh).toHaveCSS("background-image", "none")
  await expect(unknown).toHaveCount(0)
  const normalWidth = (await stale.boundingBox())?.width

  await page.emulateMedia({ forcedColors: "active" })
  await expect(stale).toHaveCSS("forced-color-adjust", "none")
  await expect(staleKey).toHaveCSS("forced-color-adjust", "none")
  await expect(stale).not.toHaveCSS("background-image", "none")
  await expect(staleKey).not.toHaveCSS("background-image", "none")
  await expect(fresh).toHaveCSS("background-image", "none")
  await expect(unknown).toHaveCount(0)
  expect((await stale.boundingBox())?.width).toBe(normalWidth)
})

test("keeps the near mark two-toned over the empty track and over a full fill, in forced colours too", async ({ page }) => {
  await page.goto(story("primitives-limittrack--gallery"))
  const marks = [
    page.locator("[data-limit=\"5-hour window\"] [data-part=\"near\"]"),
    page.locator("[data-limit=\"Weekly, large model\"] [data-part=\"near\"]"),
    page.locator("[data-mark=\"near\"]")
  ]
  const tones = (mark: (typeof marks)[number]) =>
    mark.evaluate((element) => {
      const style = getComputedStyle(element)
      return { adjust: style.forcedColorAdjust, core: style.backgroundColor, shadow: style.boxShadow }
    })
  const modes: ReadonlyArray<"none" | "active"> = ["none", "active"]
  for (const forcedColors of modes) {
    await page.emulateMedia({ forcedColors })
    for (const mark of marks) {
      await expect(mark).toBeVisible()
      const { adjust, core, shadow } = await tones(mark)
      expect(shadow).not.toBe("none")
      expect(shadow).not.toContain(core)
      if (forcedColors === "active") expect(adjust).toBe("none")
    }
  }
})
