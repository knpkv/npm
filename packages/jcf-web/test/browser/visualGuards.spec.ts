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
    await page.getByRole("button", { name: width <= 900 ? "Calendar" : "Agenda", exact: true }).click()
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
      const [light, dark] = [luminance(rgb(getComputedStyle(element).color)), luminance(background)].sort(
        (a, b) => b - a
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

// Without stripes, a saved block's provider word is the only visible sign of which record it is,
// so it stays shown in narrow collision lanes too.
test("saved blocks name their provider in the calendar", async ({ page }) => {
  await open(page, 1280)
  const labels = await page.locator(".jcf-block-logged").evaluateAll((blocks) =>
    blocks.map((block) => {
      const source = block.querySelector(".jcf-block-source")
      return source !== null && getComputedStyle(source).display !== "none" ? (source.textContent ?? "") : ""
    })
  )
  expect(labels.length).toBeGreaterThan(0)
  expect([...labels].sort()).toEqual(["Clockify", "Jira"])
})

// B1 (#526 review): at 768 five day columns did not fit and the calendar was cut at its right edge.
test("below 900px the week opens as an agenda", async ({ page }) => {
  await open(page, 768)
  await expect(page.locator(".jcf-calendar")).toBeHidden()
  await expect(page.locator(".jcf-agenda")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const width of [1024, 1280, 1920]) {
  // B2 (#526 review): ticket keys and time ranges wrapped inside event blocks ("09:00–|10:00").
  test(`event block keys and times stay on one line at ${width}px`, async ({ page }) => {
    await open(page, width)
    const lines = await page
      .locator(".jcf-block .jcf-block-key, .jcf-block .jcf-block-clock")
      .evaluateAll((spans) =>
        spans
          .filter((span) => span.getClientRects().length > 0)
          .map((span) =>
            Math.round(span.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(span).lineHeight))
          )
      )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((count) => count === 1)).toBe(true)
  })
}

for (const width of [768, 1024, 1280]) {
  // B3 (#526 review): eleven toolbar controls wrapped into ragged rows with Log time alone on one.
  test(`the toolbar fits one row and Log time never sits alone at ${width}px`, async ({ page }) => {
    await open(page, width)
    const tops = await page
      .locator(".jcf-bar button")
      .evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)))
    const logTime = await page.getByRole("button", { name: "Log time", exact: true }).first().boundingBox()
    expect(logTime).not.toBeNull()
    const rowOfLogTime = tops.filter((top) => Math.abs(top - Math.round(logTime?.y ?? 0)) <= 2)
    expect(new Set(tops).size).toBe(1)
    expect(rowOfLogTime.length).toBeGreaterThan(1)
  })
}

// B4 (#526 review): a failed read named no consequence and left earlier totals looking current.
test("a failed read says what is shown and marks the totals as old", async ({ page }) => {
  await open(page, 1280)
  await page.route(
    "**/api/week/stream?*",
    (route) => route.fulfill({ status: 503, json: { message: "Jira is temporarily unavailable" } })
  )
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).click()
  const alert = page.getByRole("alert").filter({ hasText: "Could not load the week" })
  await expect(alert).toContainText("Jira is temporarily unavailable. The week below is from the read at")
  await expect(alert.getByRole("button", { name: "Try again", exact: true })).toBeVisible()
  // QA-63c: the alert states the failure once; the totals are only marked old.
  await expect(page.getByRole("group", { name: "Week totals" })).toContainText("Totals from")
  await expect(page.getByRole("group", { name: "Week totals" })).not.toContainText("failed")
  await expect(page.locator(".jcf-read-at")).toHaveText("Last read failed")
  // ui-b (#545): the agent card says the read stopped once, not in both its status and its body.
  await expect(page.getByText(/the read failed/u)).toHaveCount(await page.locator(".jcf-agent-ended").count())
})

// #526 review: at 768 the editor floated over the agenda with nothing behind it. Below 1100px it is
// a sheet: a scrim covers the week, the page is inert behind it, and the scrim closes it.
test("below 1100px the editor opens as a sheet over an inert page", async ({ page }) => {
  await open(page, 768)
  await page.locator(".jcf-agenda-entry[data-kind=\"proposable\"]").first().click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await expect(editor).toBeVisible()
  await expect(page.locator(".jcf-scrim")).toBeVisible()
  expect(await page.locator(".jcf-week-region").evaluate((region) => region.closest("[inert]") !== null)).toBe(true)
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.activeElement?.closest(".jcf-editor") !== null)).toBe(true)
  await page.locator(".jcf-scrim").click({ position: { x: 10, y: 10 } })
  await expect(editor).toHaveCount(0)
})

/** The part of a layout-shift entry the sum needs: when it happened and how much moved. */
const Shifts = Schema.Array(Schema.Struct({ startTime: Schema.Number, value: Schema.Number }))

const sheetSizes: ReadonlyArray<readonly [number, number]> = [
  [768, 1000],
  [640, 450]
]

// QA-63b: the agent sheet grew and shrank as the agent streamed (CLS 0.16 at 768), and at 200% zoom
// the masthead re-wrapped as its status changed (CLS 1.25) and the sheet cut the conversation off.
for (const [width, height] of sheetSizes) {
  test(`the agent sheet streams without moving the page at ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height })
    const response = await page.request.post("/__test/reset")
    const { url } = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
    await page.goto(url)
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const clickedAt = await page.evaluate(() => performance.now())
    await request.get("/__test/hold-start")
    await page.getByRole("button", { name: "Rescan sessions", exact: true }).click()
    await expect(page.getByRole("region", { name: "Agent request", exact: true }).locator("pre")).toContainText(
      "supplied evidence"
    )
    await request.get("/__test/finish")
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const entries = Schema.decodeUnknownSync(Shifts)(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            // A page that never shifted has no entries, and the observer never calls back.
            window.setTimeout(() => resolve([]), 500)
            new PerformanceObserver((list) => resolve(list.getEntries().map((entry) => entry.toJSON()))).observe({
              type: "layout-shift",
              buffered: true
            })
          })
      )
    )
    const shifted = entries.filter((entry) => entry.startTime > clickedAt).reduce((sum, entry) => sum + entry.value, 0)
    expect(shifted).toBeLessThan(0.05)
    // The whole conversation can be read inside the sheet.
    const answer = page.getByRole("region", { name: "Agent response", exact: true })
    await answer.scrollIntoViewIfNeeded()
    await expect(answer).toBeInViewport()
  })
}

// QA-56: the editor drew browser-default 20x20 checkboxes in a default fieldset, and a resize grip.
test("the editor chooses layers with the same buttons as the calendar and has no resize grip", async ({ page }) => {
  await open(page, 1280)
  await page.getByRole("button", { name: /^PROJ-123, 11:00–12:00/u }).click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await expect(editor.locator("input[type=\"checkbox\"]")).toHaveCount(0)
  const layers = editor.getByRole("group", { name: "Write to selected layers" })
  await expect(layers.getByRole("button", { name: "Jira" })).toHaveAttribute("aria-pressed", "true")
  const resize = await editor
    .locator("textarea")
    .first()
    .evaluate((element) => getComputedStyle(element).resize)
  expect(resize).toBe("none")
})
