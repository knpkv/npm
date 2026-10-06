import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { chooseTheme } from "./theme.js"

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 1000 })
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
}

/**
 * Every element that draws a coloured bar on one side only: a border edge thicker than its opposite
 * edge, or an inset box-shadow. State and provenance are words here, never a stripe.
 */
const oneSidedStripes = (page: Page) =>
  page.locator("main").evaluate((main) => {
    const width = (style: CSSStyleDeclaration, side: string) =>
      style.getPropertyValue(`border-${side}-style`) === "none"
        ? 0
        : Number.parseFloat(style.getPropertyValue(`border-${side}-width`))
    return [main, ...main.querySelectorAll("*")].flatMap((element) => {
      const style = getComputedStyle(element)
      const [top, right, bottom, left] = ["top", "right", "bottom", "left"].map((side) => width(style, side))
      const stripe = Math.abs(left! - right!) >= 2 || Math.abs(top! - bottom!) >= 2
      return stripe || style.boxShadow.includes("inset")
        ? [`${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`]
        : []
    })
  })

for (const width of [1280, 390]) {
  // QA-35..38: totals, saved blocks, agenda entries and layer toggles drew 3–4px provider stripes.
  test(`no element draws a one-sided stripe at ${width}px`, async ({ page }) => {
    await open(page, width)
    expect(await oneSidedStripes(page)).toEqual([])
    await page.getByRole("button", { name: width < 640 ? "Calendar" : "Agenda", exact: true }).click()
    expect(await oneSidedStripes(page)).toEqual([])
  })
}

for (const width of [1280, 768]) {
  // QA-34: a failed read during a rescan floated its alert over the page title and week buttons.
  test(`a failed read keeps the masthead and week navigation visible at ${width}px`, async ({ page }) => {
    await open(page, width)
    await page.route(
      "**/api/week/stream?*",
      (route) => route.fulfill({ status: 503, json: { message: "Jira is temporarily unavailable" } })
    )
    await page.getByRole("button", { name: "Rescan sessions", exact: true }).click()
    const alert = page.getByText("Could not load the week", { exact: true })
    await expect(alert).toBeVisible()
    const panel = await page.getByRole("alert").filter({ has: alert }).boundingBox()
    expect(panel).not.toBeNull()
    for (
      const target of [
        page.getByRole("heading", { level: 1 }),
        page.getByRole("button", { name: "Previous week", exact: true }),
        page.getByRole("button", { name: "This week", exact: true }),
        page.getByRole("button", { name: "Next week", exact: true })
      ]
    ) {
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      if (panel !== null && box !== null) {
        const overlapsX = Math.min(panel.x + panel.width, box.x + box.width) - Math.max(panel.x, box.x)
        const overlapsY = Math.min(panel.y + panel.height, box.y + box.height) - Math.max(panel.y, box.y)
        expect(overlapsX > 0.5 && overlapsY > 0.5).toBe(false)
      }
    }
  })
}

/** WCAG contrast of each matching element's text against the first opaque background behind it. */
const contrasts = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((elements) => {
    const rgb = (value: string) => {
      const probe = document.createElement("canvas").getContext("2d")!
      probe.fillStyle = value
      probe.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
      return { r: r!, g: g!, b: b!, a: a! }
    }
    const luminance = ({ b, g, r }: { r: number; g: number; b: number }) =>
      [r, g, b]
        .map((channel) => channel / 255)
        .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    return elements.map((element) => {
      let behind: Element | null = element
      let background = rgb("transparent")
      while (behind !== null && background.a === 0) {
        background = rgb(getComputedStyle(behind).backgroundColor)
        behind = behind.parentElement
      }
      const [light, dark] = [luminance(rgb(getComputedStyle(element).color)), luminance(background)].sort((a, b) =>
        b - a
      )
      return (light! + 0.05) / (dark! + 0.05)
    })
  })

for (const theme of ["Light", "Dark"] satisfies ReadonlyArray<"Light" | "Dark">) {
  // QA-47: weekday dates and hour labels were set in text-3 and failed 4.5:1 in the light theme.
  test(`calendar dates and hours reach 4.5:1 in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    await open(page, 1280)
    await chooseTheme(page, theme)
    const ratios = await contrasts(page, ".jcf-date, .jcf-hour-label")
    expect(ratios.length).toBeGreaterThan(0)
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
}

// QA-43/44: labels joined facts with middots ("Jira entries · 1"); facts are separated by words or commas.
test("visible copy separates facts without middots", async ({ page }) => {
  await open(page, 1280)
  expect(await page.locator("main").innerText()).not.toContain("·")
  await page.getByRole("button", { name: /^PROJ-123, 11:00–12:00/u }).click()
  await expect(page.getByRole("complementary", { name: "Time entry editor" })).toBeVisible()
  expect(await page.locator("main").innerText()).not.toContain("·")
})
