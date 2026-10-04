import { expect, type Page, test } from "@playwright/test"
import { Deferred, Effect, Schema } from "effect"
import { totalTokens } from "../../src/core/Model.js"
import { LimitsReport, UsageReport } from "../../src/shared/contracts.js"

/** Replaces a decoded fixture report while retaining the real server's periods and identities. */
const replaceUsage = (page: Page, change: (report: UsageReport) => UsageReport) =>
  page.route("**/api/usage?*", async (route) => {
    const response = await route.fetch()
    const report = Schema.decodeUnknownSync(UsageReport)(await response.json())
    await route.fulfill({ response, json: change(report) })
  })

/** Signs in with the owner cookie the fixture hands out, as the bootstrap exchange would. */
const signIn = async (page: Page) => {
  const token = await (await page.request.get("/__test/session")).text()
  await page.context().addCookies([{ name: "agent_usage_owner", value: token, url: "http://127.0.0.1:4180/api" }])
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Agent usage" })).toBeVisible()
}

test("the printed URL signs in once and leaves no code in the address bar", async ({ page }) => {
  const url = await (await page.request.get("/__test/bootstrap")).text()
  await page.goto(url)
  await expect(page.getByRole("heading", { name: "Agent usage" })).toBeVisible()
  expect(page.url()).toBe("http://127.0.0.1:4180/")
})

test("usage is stacked by booking, with typed non-project keys listed rather than booked", async ({ page }) => {
  await signIn(page)
  const table = page.getByRole("table", { name: "Bookings" })
  await expect(table.getByRole("button", { name: "RPS-12" })).toBeVisible()
  await expect(table.getByRole("button", { name: "tools (repo)" })).toBeVisible()
  await expect(table.getByRole("button", { name: "GPT-6" })).toHaveCount(0)
  const status = page.getByRole("contentinfo", { name: "Ingest status" })
  await status.getByText("Ignored ticket-like keys").click()
  await expect(status.getByText("GPT (1 requests)", { exact: false })).toBeVisible()
  await expect(page.getByRole("group", { name: "Usage per day, stacked by booking" })).toBeVisible()
})

test("unpriced tokens are called out, and the booking shows ? instead of a number", async ({ page }) => {
  await signIn(page)
  await expect(page.getByText("tokens have no price", { exact: false })).toContainText("claude-unreleased-9")
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "RPS-12" }) })
  await expect(row).toContainText("+ ?")
})

test("limits now groups each agent's windows with a meter, a tone word and the balances", async ({ page }) => {
  await signIn(page)
  const claude = page.getByRole("region", { name: "Claude limits" })
  await expect(claude.getByRole("meter", { name: "Claude 5-hour used" })).toHaveAttribute("aria-valuenow", "42")
  // A healthy window shows its level and reading age, not a badge.
  await expect(claude.getByText("OK", { exact: true })).toHaveCount(0)
  await expect(claude).toContainText("read")
  await expect(page.getByRole("region", { name: "Limits now" })).toContainText("5K credits")
})

test("the usage panel leads with the range total and explains API-equivalent cost on demand", async ({ page }) => {
  await signIn(page)
  const panel = page.getByRole("region", { name: /^Usage by booking/ })
  await expect(panel.getByTestId("usage-total")).toHaveText(/^\$[\d,.]+$/)
  await expect(panel.getByText("not what a subscription charges", { exact: false })).toBeHidden()
  await panel.getByText("What is API-equivalent?").click()
  await expect(panel.getByText("not what a subscription charges", { exact: false })).toBeVisible()
})

test("picking a booking draws only it, and Show all brings the rest back", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: "RPS-12" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking — RPS-12 only" })).toBeVisible()
  await expect(page.getByTestId("usage-total")).toHaveText("$3.60")
  await page.getByRole("radiogroup", { name: "Measure" }).getByRole("radio", { name: "Tokens" }).click()
  await expect(page.getByTestId("usage-total")).toHaveText("880K")
  await page.getByRole("button", { name: "Show all" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking", exact: true })).toBeVisible()
  await expect(page.getByTestId("usage-total")).toHaveText("1.5M")
  await page.getByRole("radiogroup", { name: "Measure" }).getByRole("radio", { name: "API-eq. $" }).click()
  await expect(page.getByTestId("usage-total")).toHaveText("$8.10")
})

test("all-unpriced requests remain usage, with a warning and a token chart", async ({ page }) => {
  await replaceUsage(page, (report) => ({
    ...report,
    cells: report.cells.map((cell) => ({ ...cell, costUsd: 0, unpricedTokens: cell.tokens })),
    bookings: report.bookings.map((booking) => ({
      ...booking,
      costUsd: 0,
      unpricedTokens: totalTokens(booking.tokens),
      unpricedModels: ["new-model"]
    })),
    unpriced: { tokens: report.cells.reduce((sum, cell) => sum + cell.tokens, 0), models: ["new-model"] }
  }))
  await signIn(page)
  await expect(page.getByText("tokens have no price", { exact: false })).toContainText("new-model")
  await expect(page.getByText("No Claude or Codex request was made in this range.")).toHaveCount(0)
  await page.getByRole("radiogroup", { name: "Measure" }).getByRole("radio", { name: "Tokens" }).click()
  await expect(page.getByTestId("usage-total")).toHaveText("1.5M")
  await expect(page.getByRole("group", { name: "Usage per day, stacked by booking" })).toBeVisible()
})

test("an empty usage report says no requests", async ({ page }) => {
  await replaceUsage(page, (report) => ({
    ...report,
    cells: [],
    bookings: [],
    unpriced: { tokens: 0, models: [] }
  }))
  await signIn(page)
  await expect(page.getByText("No Claude or Codex request was made in this range.")).toBeVisible()
  await expect(page.getByText("tokens have no price", { exact: false })).toHaveCount(0)
})

test("hiding the sorted breakdown column restores the visible cost sort", async ({ page }) => {
  await signIn(page)
  await page.getByRole("checkbox", { name: "Show token breakdown" }).check()
  await page.getByRole("button", { name: "Sort by Input, currently none" }).click()
  await page.getByRole("checkbox", { name: "Show token breakdown" }).uncheck()
  const cost = page.getByRole("columnheader", { name: /API-eq. cost/ })
  await expect(cost).toHaveAttribute("aria-sort", "descending")
  await page.getByRole("button", { name: "Sort by API-eq. cost, currently descending" }).click()
  await expect(cost).toHaveAttribute("aria-sort", "ascending")
})

test("initial dashboard loading has one named status region", async ({ page }) => {
  const pending = Effect.runSync(Deferred.make<void>())
  await page.route(/\/api\/(?:usage|limits)\?/, async (route) => {
    await Effect.runPromise(Deferred.await(pending))
    await route.continue()
  })
  try {
    await signIn(page)
    await expect(page.getByRole("status", { name: "Loading limits" })).toBeVisible()
    await expect(page.getByRole("status")).toHaveCount(1)
  } finally {
    Effect.runSync(Deferred.succeed(pending, undefined))
  }
  await expect(page.getByTestId("usage-total")).toBeVisible()
})

test("unnamed-only limits still expose their readings table", async ({ page }) => {
  await page.route("**/api/limits?*", async (route) => {
    const response = await route.fetch()
    const report = Schema.decodeUnknownSync(LimitsReport)(await response.json())
    await route.fulfill({
      response,
      json: {
        ...report,
        series: report.series.map((series) => ({ ...series, label: "iguana_necktie", windowMinutes: null }))
      }
    })
  })
  await signIn(page)
  await page.getByText("Limit readings as a table").click()
  await expect(page.locator(".usage-readings table")).toContainText("Claude allowance iguana_necktie")
  await expect(page.locator(".usage-readings table")).toContainText("42%")
  await expect(page.getByText("No limit readings in this range yet.")).toHaveCount(0)
})

test("phone booking headers retain their names", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await signIn(page)
  const table = page.getByRole("table", { name: "Bookings" })
  await expect(table.getByRole("columnheader", { name: "Booking", exact: true })).toHaveCount(1)
  await expect(table.getByRole("columnheader", { name: "API-eq. cost", exact: true })).toHaveCount(1)
})

test("empty limit history keeps the no-readings state", async ({ page }) => {
  await page.route("**/api/limits?*", (route) => route.fulfill({ json: { series: [], latest: [], balances: [] } }))
  await signIn(page)
  await expect(page.getByText("No limit readings in this range yet.")).toBeVisible()
  await expect(page.getByText("Limit readings as a table")).toHaveCount(0)
})

test("changing the agent filter drops a picked booking, so the chart is never left empty", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: "tools (repo)" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking — tools (repo) only" })).toBeVisible()
  await page.getByRole("radiogroup", { name: "Agent" }).getByRole("radio", { name: "Codex" }).click()
  await expect(page.getByRole("heading", { name: "Usage by booking", exact: true })).toBeVisible()
})

test("a reload without a working session says how to get back in instead of showing empty charts", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Could not sign in")).toBeVisible()
})

test("every limit reading is also available as a table, without hovering", async ({ page }) => {
  await signIn(page)
  await page.getByText("Limit readings as a table").click()
  const table = page.locator(".usage-readings table")
  await expect(table.getByRole("rowheader", { name: "Claude 5-hour" })).toBeVisible()
  await expect(table).toContainText("42%")
})

test("the page fits a phone without horizontal page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await signIn(page)
  await expect(page.getByRole("group", { name: "Usage per day, stacked by booking" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Claude limits" }).getByRole("meter")).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test("the filters are named radio groups that arrow keys move through", async ({ page }) => {
  await signIn(page)
  const range = page.getByRole("radiogroup", { name: "Range" })
  await expect(range.getByRole("radio", { name: "7d" })).toHaveAttribute("aria-checked", "true")
  await range.getByRole("radio", { name: "7d" }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(range.getByRole("radio", { name: "30d" })).toBeFocused()
  await expect(range.getByRole("radio", { name: "30d" })).toHaveAttribute("aria-checked", "true")
})

test("each usage column can be reached by keyboard and says its total and bookings", async ({ page }) => {
  await signIn(page)
  const chart = page.getByRole("group", { name: "Usage per day, stacked by booking" })
  const columns = chart.getByRole("img")
  const last = columns.last()
  await last.focus()
  await expect(last).toHaveAccessibleName(/total/)
  await expect(page.getByRole("status").filter({ hasText: "Total" })).toBeVisible()
  await page.keyboard.press("ArrowLeft")
  await expect(columns.nth((await columns.count()) - 2)).toBeFocused()
  await page.keyboard.press("Home")
  await expect(columns.first()).toBeFocused()
})

test("on a phone, every column's breakdown stays inside the chart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await signIn(page)
  for (const { bucket, range } of [{ range: "7d", bucket: "day" }, { range: "24h", bucket: "hour" }]) {
    await page.getByRole("radiogroup", { name: "Range" }).getByRole("radio", { name: range }).click()
    const chart = page.getByRole("group", { name: `Usage per ${bucket}, stacked by booking` })
    await expect(chart).toBeVisible()
    const box = await chart.boundingBox()
    if (box === null) throw new Error("chart not laid out")
    const columns = chart.getByRole("img", { name: /total; / })
    const count = await columns.count()
    expect(count).toBeGreaterThan(0)
    for (let index = 0; index < count; index++) {
      await columns.nth(index).focus()
      const tooltip = page.locator(".usage-tooltip")
      const bounds = await tooltip.boundingBox()
      if (bounds === null) throw new Error("tooltip not shown")
      expect(bounds.x).toBeGreaterThanOrEqual(box.x - 0.5)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(box.x + box.width + 0.5)
    }
  }
})

test("a long ticket title stays inside its cell at desktop width", async ({ page }) => {
  const summary = "A ticket summary long enough to run across every column of the table if nothing stopped it ".repeat(
    3
  )
  await replaceUsage(page, (report) => ({
    ...report,
    bookings: report.bookings.map((booking) =>
      booking.booking._tag === "Ticket" ? { ...booking, title: { _tag: "Known", summary } } : booking
    )
  }))
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  for (const breakdown of [false, true]) {
    await page.getByRole("checkbox", { name: "Show token breakdown" }).setChecked(breakdown)
    const title = page.locator(".usage-title").filter({ hasText: "A ticket summary" }).first()
    const cell = page.locator("td").filter({ has: title })
    const titleBox = await title.boundingBox()
    const cellBox = await cell.boundingBox()
    if (titleBox === null || cellBox === null) throw new Error("title not laid out")
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 0.5)
  }
})

test("on a phone, a tall breakdown keeps every booking and the total readable", async ({ page }) => {
  await replaceUsage(page, (report) => {
    const period = report.periods.length - 1
    const bookings = Array.from({ length: 9 }, (_, index) => ({
      ...report.bookings[0]!,
      id: `long-${index}`,
      booking: { _tag: "Repo" as const, name: `a-really-quite-long-repository-name-${index}` },
      costUsd: 10 - index
    }))
    return {
      ...report,
      bookings,
      cells: bookings.map((booking) => ({
        period,
        booking: booking.id,
        tokens: 1_000,
        costUsd: booking.costUsd,
        unpricedTokens: 0
      }))
    }
  })
  await page.setViewportSize({ width: 390, height: 900 })
  await signIn(page)
  const chart = page.getByRole("group", { name: "Usage per day, stacked by booking" })
  await chart.getByRole("img", { name: /total; / }).last().focus()
  const tooltip = page.locator(".usage-tooltip")
  await expect(tooltip.locator(".usage-tooltip-row")).toHaveCount(9)
  // Hit-testing finds only what is painted and unclipped; the tooltip ignores the pointer in use.
  await tooltip.evaluate((element) => element.style.setProperty("pointer-events", "auto"))
  for (
    const line of [...(await tooltip.locator(".usage-tooltip-row").all()), tooltip.locator(".usage-tooltip-muted")]
  ) {
    // Scroll the page only: scrollIntoView would also scroll a clipping chart and hide the defect.
    await line.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 200))
    const box = await line.boundingBox()
    if (box === null) throw new Error("tooltip line not laid out")
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".usage-tooltip") !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    )
    expect(hit).toBe(true)
  }
})

test("a failed range change keeps labelling the shown total with the range it covers", async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole("region", { name: /^Usage by booking/ })).toContainText("· 7d")
  const total = await page.getByTestId("usage-total").textContent()
  await page.route("**/api/usage?*", (route) => route.fulfill({ status: 500, body: "boom" }))
  await page.getByRole("radiogroup", { name: "Range" }).getByRole("radio", { name: "24h" }).click()
  await expect(page.getByText("Usage could not be read")).toBeVisible()
  const panel = page.getByRole("region", { name: /^Usage by booking/ })
  await expect(page.getByTestId("usage-total")).toHaveText(total ?? "")
  await expect(panel).toContainText("· 7d")
  await expect(panel).not.toContainText("· 24h")
})

test("the token breakdown keeps every number on one line on a mid-width screen", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await signIn(page)
  await page.getByRole("checkbox", { name: "Show token breakdown" }).check()
  const table = page.getByRole("table", { name: "Bookings" })
  await expect(table.getByRole("columnheader", { name: "Cache write" })).toBeAttached()
  const wrapped = await table.locator(".usage-number").evaluateAll((numbers) =>
    numbers.filter((number) => number.getClientRects().length > 1).map((number) => number.textContent)
  )
  expect(wrapped).toEqual([])
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test("Escape dismisses a chart breakdown without moving focus", async ({ page }) => {
  await signIn(page)
  const column = page.getByRole("group", { name: "Usage per day, stacked by booking" }).getByRole("img", {
    name: /total; /
  }).last()
  await column.focus()
  const tooltip = page.locator(".usage-tooltip")
  await expect(tooltip).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(tooltip).toHaveCount(0)
  await expect(column).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(tooltip).toBeVisible()
})
