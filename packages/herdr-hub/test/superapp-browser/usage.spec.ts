import { expect, test } from "@playwright/test"
import { LONG_USAGE_HOST } from "./usage-fixture.js"

test("a single long breadcrumb uses its available phone line", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/")
  const current = page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=\"page\"]")
  await expect(current).toHaveText("Today")
  await current.locator("bdi").evaluate((element) => {
    element.textContent = "A longer single module label"
  })
  await page.evaluate(() => document.fonts.ready)
  const size = await current.evaluate((element) => ({
    box: element.getBoundingClientRect().width,
    line: element.parentElement?.getBoundingClientRect().width ?? Infinity,
    text: element.querySelector("bdi")?.getBoundingClientRect().width ?? Infinity
  }))
  expect(size.box).toBeGreaterThan(size.line / 2)
  expect(size.box + 0.5).toBeGreaterThanOrEqual(size.text)
})

test("forced colours keep the selected range label readable", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  const selected = page.getByRole("radio", { name: "7 days", exact: true })
  await expect(selected).toHaveAttribute("aria-checked", "true")
  const colors = await selected.evaluate((element) => {
    const reference = document.createElement("span")
    reference.style.cssText = "forced-color-adjust:none;color:HighlightText;background:Highlight"
    document.body.append(reference)
    const actual = getComputedStyle(element)
    const expected = getComputedStyle(reference)
    const result = {
      color: actual.color,
      background: actual.backgroundColor,
      expectedColor: expected.color,
      expectedBackground: expected.backgroundColor
    }
    reference.remove()
    return result
  })
  expect(colors.color).toBe(colors.expectedColor)
  expect(colors.background).toBe(colors.expectedBackground)
  expect(colors.color).not.toBe(colors.background)
})

test("the tablet breadcrumb keeps the complete current page label", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  const current = page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=\"page\"]")
  await expect(current).toHaveText("Tokens")
  await page.evaluate(() => document.fonts.ready)
  const size = await current.evaluate((element) => ({
    box: element.getBoundingClientRect().width,
    text: element.querySelector("bdi")?.getBoundingClientRect().width ?? Infinity
  }))
  expect(size.box + 0.5).toBeGreaterThanOrEqual(size.text)
})

test("the wide Usage chart aligns with the module column", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  await expect(page.locator("[aria-label=\"By host\"] li")).toHaveCount(3)
  await page.evaluate(() => document.fonts.ready)
  const size = await page.locator(".usage-details").evaluate((element) => ({
    heading: element.querySelector(".usage-details-intro")?.getBoundingClientRect().left,
    chart: element.querySelector(".usage-tab-panel")?.getBoundingClientRect().left
  }))
  expect(size.heading).toBeDefined()
  expect(size.chart).toBe(size.heading)
})

test("a delayed unknown-host repair keeps focus on a range control", async ({ page }) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/v1\/connect\/(usage|limits)(\?|$)/, async (route) => {
    await gate
    await route.continue()
  })
  try {
    await page.goto("/?range=7d&timeZone=UTC&host=NOPE#usage/limits")
    const radio = page.getByRole("radio", { name: "7 days", exact: true })
    await expect(page.locator("[data-module-page=\"limits\"]")).toBeFocused()
    await radio.focus()
    release()
    await expect.poll(() => new URL(page.url()).searchParams.get("host")).toBeNull()
    await expect(radio).toBeFocused()
  } finally {
    release()
  }
})

test("Usage selectors drive range, zone and local host filtering with replaced history", async ({ page }) => {
  const queries: Array<URLSearchParams> = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/v1/connect/usage") queries.push(url.searchParams)
  })
  await page.goto("/?range=30d&timeZone=UTC&host=bad%2Fhost#usage/tokens")
  const module = page.locator("[data-module=\"usage\"]")
  await expect(module.getByRole("heading", { name: "Tokens", exact: true }).first()).toBeVisible()
  await expect(module.getByText("Some URL selectors were reset. Valid selections were kept.")).toBeVisible()
  expect(new URL(page.url()).search).toBe("?range=30d&timeZone=UTC")
  const before = await page.evaluate(() => history.length)
  await module.getByRole("radio", { name: "7 days", exact: true }).click()
  await expect(module.locator("[aria-label=\"By host\"] li")).toHaveCount(3)
  await expect(module.getByText("Some URL selectors were reset. Valid selections were kept.")).toHaveCount(0)
  expect(new URL(page.url()).search).toBe("?range=7d&timeZone=UTC")
  expect(await page.evaluate(() => history.length)).toBe(before)
  await expect(module.getByRole("radio", { name: "7 days", exact: true })).toBeFocused()
  expect(queries.map((query) => [query.get("range"), query.get("timeZone")])).toEqual([["30d", "UTC"], ["7d", "UTC"]])
  const requests = queries.length
  await module.getByRole("combobox", { name: "Host", exact: true }).focus()
  await module.getByRole("combobox", { name: "Host", exact: true }).selectOption("birch")
  await expect(module.getByRole("combobox", { name: "Host", exact: true })).toBeFocused()
  await expect(module.locator("[aria-label=\"By host\"] li")).toHaveCount(1)
  await expect(module.locator("[aria-label=\"By host\"]")).toContainText("birch")
  expect(new URL(page.url()).searchParams.get("host")).toBe("birch")
  expect(queries).toHaveLength(requests)
  await expect(module.getByRole("link", { name: "Open agent-usage on this machine" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:3112/"
  )
})

test("hidden Usage preserves exact Fleet approval selectors and target focus", async ({ page }) => {
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  await expect(page.locator("[aria-label=\"By host\"] li")).toHaveCount(3)
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "?approvalHost=ALPHA&approvalJob=alpha-off-page#fleet/approvals"
    document.body.append(link)
    link.click()
    link.remove()
  })
  await expect(page.locator("[data-approval-target=\"true\"]")).toHaveAttribute("data-approval-job", "alpha-off-page")
  await expect(page.locator("[data-approval-target=\"true\"]")).toBeFocused()
  expect(new URL(page.url()).search).toBe("?approvalHost=ALPHA&approvalJob=alpha-off-page")
  await page.goBack()
  await expect(page.locator("[data-module=\"usage\"]")).toBeVisible()
  await expect(page.locator("[data-module-page=\"tokens\"]")).toBeFocused()
})

test("Today opens Usage limits and deliberate Fleet links still reach the original tab", async ({ page }, info) => {
  await page.goto("/")
  await page.getByRole("link", { name: "Check limits", exact: true }).click()
  await expect(page.locator("[data-module-page=\"limits\"]")).toBeFocused()
  expect(new URL(page.url()).hash).toBe("#usage/limits")
  if (info.project.name === "phone") {
    const bottom = page.getByRole("navigation", { name: "Mobile modules", exact: true })
    await expect(bottom.getByRole("link", { name: "Usage details", exact: true })).toHaveCount(0)
    await expect(bottom.getByRole("button", { name: "All modules, current module Usage details", exact: true }))
      .toHaveAttribute("aria-current", "page")
  }
  await page.locator("[data-module=\"usage\"]").getByRole("link", { name: "Fleet usage", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Usage", exact: true })).toBeFocused()
  expect(new URL(page.url()).hash).toBe("#fleet/usage")
  await page.goto("/?tab=usage")
  await expect(page.getByRole("tab", { name: "Usage", exact: true })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#fleet/usage")
})

for (const state of ["normal", "partial", "stale", "empty", "failed"]) {
  test(`Usage ${state} remains truthful and fits the viewport`, async ({ baseURL, context, page }) => {
    if (baseURL === undefined) throw new Error("Missing fixture origin")
    await context.addCookies([{ name: "usage-fixture", value: state, url: baseURL }])
    await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
    const module = page.locator("[data-module=\"usage\"]")
    if (state === "failed") {
      await expect(module.getByText("Couldn't load usage. Trying again in five minutes.")).toBeVisible()
      await expect(module.getByRole("button", { name: "Retry" })).toBeVisible()
      await context.clearCookies()
      await module.getByRole("button", { name: "Retry" }).click()
      await expect(module.locator("[aria-label=\"By host\"] li")).toHaveCount(3)
    } else if (state === "empty") {
      await expect(module.getByText("No host has usage to show.")).toBeVisible()
      await expect(module.locator("[aria-label=\"By host\"] li")).toHaveCount(0)
    } else {
      await expect(module.locator("[aria-label=\"By host\"] li")).toHaveCount(3)
      if (state === "partial") {
        await expect(module.locator("[aria-label=\"By host\"] li").filter({ hasText: "cedar" })).toContainText(
          "Unknown"
        )
        await expect(module.locator(".usage-details-intro")).toContainText("344M reported tokens")
        await expect(module.getByText("Unknown hosts are left out of the total.")).toBeVisible()
      }
      if (state === "stale") {
        await expect(module.locator("[aria-label=\"By host\"] li").filter({ hasText: "birch" }).locator("time"))
          .toBeVisible()
      }
    }
    await page.evaluate(() => document.fonts.ready)
    const width = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
    expect(width.content).toBeLessThanOrEqual(width.viewport)
    await expect(page.locator("[data-rly-relay-launcher]")).toHaveCount(1)
  })
}

test("poll counts follow the page, inactive and hidden state", async ({ page }) => {
  await page.clock.install()
  let usage = 0
  let limits = 0
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path === "/v1/connect/usage") usage += 1
    if (path === "/v1/connect/limits") limits += 1
  })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  await expect(page.locator("[aria-label=\"By host\"] li")).toHaveCount(3)
  expect(usage).toBe(1)
  expect(limits).toBe(0)
  await page.locator("[data-module-page=\"limits\"]").click()
  await expect(page.getByRole("region", { name: "Claude limits", exact: true })).toBeVisible()
  expect(usage).toBe(1)
  expect(limits).toBe(1)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await page.clock.runFor(300_100)
  expect(usage).toBe(1)
  expect(limits).toBe(1)
})

/** The host codec permits 253-character names, which must fit both the report and selector at 320px. */
test("a maximum-length host fits the report and host selector", async ({ baseURL, context, page }) => {
  if (baseURL === undefined) throw new Error("Missing fixture origin")
  await context.addCookies([{ name: "usage-fixture", value: "longhost", url: baseURL }])
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  const row = page.locator("[aria-label=\"By host\"] li").filter({ hasText: LONG_USAGE_HOST })
  await expect(row).toHaveCount(1)
  const host = page.getByRole("combobox", { name: "Host", exact: true })
  await host.selectOption(LONG_USAGE_HOST)
  await expect(host).toHaveValue(LONG_USAGE_HOST)
  await expect(row).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
  expect(size.content).toBeLessThanOrEqual(size.viewport)
  const selected = await host.boundingBox()
  expect(selected).not.toBeNull()
  expect((selected?.x ?? Infinity) + (selected?.width ?? Infinity)).toBeLessThanOrEqual(320)
})
