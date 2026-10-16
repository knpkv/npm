import { expect, test } from "@playwright/test"
import { limitsFixture, LONG_USAGE_HOST, usageFixture } from "./usage-fixture.js"

/** By tool cannot retry a Limits read it does not own. */
test("a retained Limits error has Retry only on the Limits page", async ({ page }) => {
  await page.route(/\/v1\/connect\/limits(\?|$)/, (route) => route.fulfill({ status: 503, body: "unavailable" }))
  await page.goto("/?range=7d&timeZone=UTC#usage/limits")
  const module = page.locator("[data-module=\"usage\"]")
  // On Limits the page tabs sit in the header outlet Usage owns; elsewhere they stay in its slot.
  const usage = page.locator("[data-module=\"usage\"], [data-module-owner=\"usage\"]")
  await expect(module.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await usage.getByRole("link", { name: "By tool", exact: true }).click()
  await expect(page.locator(".usage-by-tool-total")).toContainText("tokens")
  await expect(module.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
  await usage.getByRole("link", { name: "Limits", exact: true }).click()
  await expect(module.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
})

test("phone Usage has one module title and four installed destinations", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Phone chrome")
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  await expect(page.locator(".superapp-phone-title")).toHaveText("Usage")
  await expect(page.locator(".superapp-breadcrumb")).toBeHidden()
  await expect(page.locator(".superapp-bottom a")).toHaveText(["Connect", "Fleet1", "Code", "Usage"])
  await expect(page.locator(".superapp-bottom a[aria-current=\"page\"]")).toHaveAccessibleName("Usage")
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
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

test("the tablet Usage header names the module and current page without nested navigation", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 })
  await page.goto("/?range=7d&timeZone=UTC#usage/tokens")
  await expect(page.locator(".usage-details-intro h1")).toHaveText("Usage")
  await expect(page.locator(".usage-details-tabs [aria-current=\"page\"]")).toHaveText("Tokens")
  await expect(page.locator(".superapp-breadcrumb")).toBeHidden()
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

/** Chromium fires focusout when React removes the focused tab; late empty readings still land focus on the empty tab. */
test("empty readings that arrive after navigation move focus to the empty Limits tab", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop empty mast")
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  // The client rejects negative instants, so the fixture reads at the browser server's own clock.
  const now = Date.now()
  await page.route(/\/v1\/connect\/usage(\?|$)/, async (route) => {
    await gate
    await route.fulfill({ json: usageFixture({ range: "7d", timeZone: "UTC" }, now, "empty-readings") })
  })
  await page.route(/\/v1\/connect\/limits(\?|$)/, async (route) => {
    await gate
    await route.fulfill({ json: limitsFixture(now, "empty-readings") })
  })
  try {
    await page.goto("/#fleet/approvals")
    await page.locator(".superapp-sidebar").getByRole("link", { name: "Usage", exact: true }).click()
    await expect(page.locator("[data-region=\"tabs\"]:visible [data-module-page=\"limits\"]")).toBeFocused()
    release()
    await expect(page.locator(".usage-limits-empty")).toBeVisible()
    await expect(page.locator(".usage-empty-tabs [data-module-page=\"limits\"]")).toBeFocused()
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

test("Usage is primary on phone and retired Fleet Usage links migrate to By tool", async ({ page }, info) => {
  await page.goto("/")
  const nav = page.locator(".superapp-sidebar, .superapp-bottom").filter({ visible: true })
  await nav.getByRole("link", { name: "Usage", exact: true }).click()
  await expect(page.locator("[data-module-page=\"limits\"]")).toBeFocused()
  expect(new URL(page.url()).hash).toBe("#usage/limits")
  if (info.project.name === "phone") {
    const bottom = page.getByRole("navigation", { name: "Mobile modules", exact: true })
    await expect(bottom.getByRole("link", { name: "Usage", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(bottom.getByRole("button", { name: "More", exact: true })).not.toHaveAttribute("aria-current", "page")
  }
  for (const route of ["/#fleet/usage", "/?tab=usage", "/#usage/by-agent"]) {
    await page.goto(route)
    await expect(page.locator("[data-module-page=\"by-tool\"]")).toBeFocused()
    expect(new URL(page.url()).hash).toBe("#usage/by-tool")
    await expect(page.getByRole("tab", { name: "Usage", exact: true })).toHaveCount(0)
  }
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
        await expect(
          module.locator("[aria-label=\"By host\"]").locator("..").locator("..").filter({
            hasText: "344M reported tokens"
          })
        ).toContainText("344M reported tokens")
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
  // Older engines keep the native fixed sizing. The complete host also remains in the reading text.
  await page.goto(`/?range=7d&timeZone=UTC&host=${encodeURIComponent(LONG_USAGE_HOST)}#usage/by-tool`)
  await expect(page.locator(".usage-by-tool-reading")).toContainText(LONG_USAGE_HOST)
  const byToolHost = page.getByRole("combobox", { name: "Host", exact: true })
  await byToolHost.evaluate((element) => element.style.setProperty("field-sizing", "fixed"))
  await expect(byToolHost).toHaveValue(LONG_USAGE_HOST)
  expect(await byToolHost.evaluate((element) => getComputedStyle(element).maxInlineSize)).toBe("100%")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

/** Export 41 gives By tool one module masthead, a segmented range, and a single-host reading. */
test("By tool matches its installed masthead and toolbar geometry", async ({ page }, info) => {
  await page.goto("/?range=7d#usage/by-tool")
  await expect(page.locator(".usage-by-tool table tbody tr")).not.toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  const geometry = await page.locator(".usage-details[data-usage-page=\"by-tool\"]").evaluate((element) => {
    const mast = element.querySelector(".usage-details-mast") ?? element.querySelector(".usage-details-intro")
    const tabs = element.querySelector(".usage-details-tabs")
    const select = element.querySelector("select")
    const range = element.querySelector("[role=\"radiogroup\"]")
    const table = element.querySelector("table")
    const header = document.querySelector(".superapp-header")
    if (mast === null || tabs === null || select === null || range === null || table === null || header === null) {
      return null
    }
    const main = document.querySelector(".superapp-main")?.getBoundingClientRect()
    return {
      mast: { left: mast.getBoundingClientRect().left, right: mast.getBoundingClientRect().right },
      main: { left: main?.left, right: main?.right },
      tabsTop: tabs.getBoundingClientRect().top,
      tabsHeight: tabs.getBoundingClientRect().height,
      headerBottom: header.getBoundingClientRect().bottom,
      selectHeight: select.getBoundingClientRect().height,
      selectSizing: getComputedStyle(select).getPropertyValue("field-sizing"),
      rangeHeight: range.getBoundingClientRect().height,
      readingGap: (element.querySelector(".usage-by-tool-reading")?.getBoundingClientRect().top ?? Infinity) -
        (element.querySelector(".usage-details-controls")?.getBoundingClientRect().bottom ?? -Infinity),
      tabFont: getComputedStyle(tabs.querySelector("a") ?? tabs).fontSize,
      rowFont: getComputedStyle(table.querySelector("th[scope=\"row\"]") ?? table).fontWeight
    }
  })
  expect(geometry).not.toBeNull()
  if (geometry === null) return
  expect(geometry.mast).toEqual(geometry.main)
  expect(geometry.tabsHeight).toBe(44)
  expect(geometry.tabFont).toBe("15px")
  expect(geometry.rowFont).toBe("430")
  expect(geometry.selectHeight).toBe(info.project.name === "phone" ? 44 : 40)
  expect(geometry.selectSizing).toBe("content")
  expect(geometry.rangeHeight).toBe(info.project.name === "phone" ? 46 : 42)
  expect(geometry.readingGap).toBe(info.project.name === "phone" ? 16 : 20)
  if (info.project.name === "phone") {
    expect(geometry.tabsTop).toBe(geometry.headerBottom)
    await expect(page.locator(".superapp-phone-title")).toHaveText("Usage By tool")
  }
  await page.emulateMedia({ forcedColors: "active" })
  const contrast = await page.getByRole("radio", { name: "7 days", exact: true }).evaluate((element) => {
    const styles = getComputedStyle(element)
    return { adjust: styles.forcedColorAdjust, background: styles.backgroundColor, color: styles.color }
  })
  expect(contrast.adjust).toBe("none")
  expect(contrast.background).not.toBe(contrast.color)
})

/** Limits shares the designed module mast and tabs while its shipped body stays unchanged. */
/** The Limits header is the design's header region: its weight, tab type, phone inset and reading order. */
test("the grouped Limits header follows the design's type, order and phone inset", async ({ page }, info) => {
  await page.goto("/?range=7d&timeZone=UTC#usage/limits")
  // Hidden module slots keep their own region tags; the shown page has one header.
  const header = page.locator("[data-region=\"header\"]:visible")
  const tabs = header.locator("[data-region=\"tabs\"]")
  await expect(tabs.getByRole("link", { name: "Limits", exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(header).toHaveCSS("font-weight", "430")
  await expect(tabs).toHaveCSS("font-size", "16px")
  await expect(tabs).toHaveCSS("line-height", "24px")
  // The tab labels keep their own 15px type; only the region's inherited type follows the design.
  await expect(tabs.getByRole("link", { name: "Limits", exact: true })).toHaveCSS("font-size", "15px")
  if (info.project.name === "phone") {
    // The phone header shows only the module title: no page heading or lead, and the tabs sit on the mast's inset.
    await expect(header.locator(".usage-empty-titles")).toHaveCSS("display", "none")
    await expect(tabs).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(tabs).toHaveCSS("padding-left", "0px")
    await expect(tabs).toHaveCSS("padding-right", "0px")
    const box = await tabs.boundingBox()
    expect(box?.x).toBe(8)
    expect(box?.width).toBe(374)
  } else {
    // Hosts and notifications read before Ask Relay, as in the design; the grid still places Ask Relay last.
    const order = await header.locator(".superapp-header").evaluate((element) => {
      const hosts = element.querySelector(".superapp-host")
      const relay = element.querySelector(".fleet-shell-relay")
      return hosts !== null && relay !== null
        ? hosts.compareDocumentPosition(relay) & Node.DOCUMENT_POSITION_FOLLOWING
        : -1
    })
    // Node.DOCUMENT_POSITION_FOLLOWING: the relay comes after the hosts control in document order.
    expect(order).toBe(4)
  }
})

/** Each Limits layout offers assistive technology exactly one page heading at every width, with no visible change. */
const limitsLayouts: ReadonlyArray<"readings" | "empty"> = ["readings", "empty"]
for (const layout of limitsLayouts) {
  test(`${layout} Limits has one level-one heading`, async ({ page }) => {
    if (layout === "empty") {
      const now = Date.now()
      await page.route(
        /\/v1\/connect\/usage(\?|$)/,
        (route) => route.fulfill({ json: usageFixture({ range: "7d", timeZone: "UTC" }, now, "empty-readings") })
      )
      await page.route(
        /\/v1\/connect\/limits(\?|$)/,
        (route) => route.fulfill({ json: limitsFixture(now, "empty-readings") })
      )
    }
    await page.goto("/?range=7d&timeZone=UTC#usage/limits")
    await expect(page.locator(layout === "empty" ? ".usage-limits-empty" : ".usage-tab-now")).toBeVisible()
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Usage")
  })
}

test("Limits matches the shared Usage chrome geometry", async ({ page }, info) => {
  await page.goto("/#usage/limits")
  const tabs = page.locator("[data-region=\"header\"]:visible [data-region=\"tabs\"]")
  await expect(tabs).toBeVisible()
  const chrome = await tabs.evaluate((element) => {
    const link = element.querySelector("a")
    if (link === null) return null
    const bounds = element.getBoundingClientRect()
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      height: bounds.height,
      headerBottom: document.querySelector(".superapp-header")?.getBoundingClientRect().bottom,
      fontSize: getComputedStyle(link).fontSize,
      padding: getComputedStyle(link).paddingInlineStart,
      viewport: innerWidth
    }
  })
  expect(chrome).not.toBeNull()
  if (chrome === null) return
  expect(chrome.height).toBe(44)
  expect(chrome.fontSize).toBe("15px")
  expect(chrome.padding).toBe(info.project.name === "phone" ? "12px" : "4px")
  if (info.project.name === "phone") {
    // The design's phone tabs sit on the mast's 8px inset.
    expect(chrome.left).toBe(8)
    expect(chrome.right).toBe(chrome.viewport - 8)
    expect(chrome.top).toBe(chrome.headerBottom)
  }
})

/** Range transitions and failed refreshes preserve numbers while naming which reading they came from. */
test("By tool frames a retained range while updating, failing and retrying", async ({ page }, info) => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let fail = true
  await page.route("**/v1/connect/usage?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("range") !== "30d") return route.continue()
    await pending
    if (fail) return route.fulfill({ status: 503, body: "private fixture transport detail" })
    return route.continue()
  })
  try {
    await page.goto("/?range=7d&timeZone=UTC#usage/by-tool")
    const reading = page.locator(".usage-by-tool-reading")
    await expect(reading).toContainText("last 7 days")
    const total = await page.locator(".usage-by-tool-total").textContent()
    await page.getByRole("radio", { name: "30 days", exact: true }).click()
    await expect(page.getByRole("status").filter({ hasText: "Updating to 30 days" })).toHaveText(
      "Updating to 30 days… showing the last 7 days"
    )
    await expect(page.locator(".usage-by-tool-total")).toHaveText(total ?? "")
    const updating = page.locator(".usage-by-tool-updating")
    expect(await updating.evaluate((element) => getComputedStyle(element).lineHeight)).toBe("19.5px")
    expect(await updating.evaluate((element) => getComputedStyle(element).gap)).toBe("8px")
    expect(await updating.locator("svg").evaluate((element) => element.getBoundingClientRect().width)).toBe(12)
    const updatingBounds = await updating.boundingBox()
    const retainedBounds = await page.locator(".usage-by-tool-total").boundingBox()
    expect(updatingBounds).not.toBeNull()
    expect(retainedBounds).not.toBeNull()
    if (updatingBounds === null || retainedBounds === null) return
    expect(retainedBounds.y - updatingBounds.y - updatingBounds.height).toBeCloseTo(20, 1)
    release()
    const notice = page.locator(".usage-by-tool-notice")
    await expect(notice).toContainText("Couldn’t refresh")
    expect(
      await notice.locator(":scope > div > span:last-child").evaluate((element) => getComputedStyle(element).lineHeight)
    ).toBe("21px")
    await expect(notice).toContainText(/Previous reading \d\d:\d\d\. Retrying every 5 minutes\./)
    await expect(reading).toContainText("last 7 days")
    await expect(page.locator(".usage-details")).not.toContainText("private fixture transport detail")
    const readingColors = await notice.locator("time").evaluate((element) => ({
      time: getComputedStyle(element).color,
      text: element.parentElement === null ? null : getComputedStyle(element.parentElement).color
    }))
    expect(readingColors.time).toBe(readingColors.text)
    const retry = notice.getByRole("button", { name: "Retry", exact: true })
    const retryStyle = await retry.evaluate((element) => {
      const style = getComputedStyle(element)
      return { size: style.fontSize, weight: style.fontWeight, height: element.getBoundingClientRect().height }
    })
    expect(retryStyle).toEqual({ size: "16px", weight: "430", height: info.project.name === "phone" ? 44 : 36 })
    const noticeBounds = await notice.boundingBox()
    const previousBounds = await page.locator(".usage-by-tool-total").boundingBox()
    expect(noticeBounds).not.toBeNull()
    expect(previousBounds).not.toBeNull()
    if (noticeBounds === null || previousBounds === null) return
    expect(previousBounds.y - noticeBounds.y - noticeBounds.height).toBeCloseTo(20, 1)
    fail = false
    await retry.click()
    await expect(reading).toContainText("last 30 days")
    await expect(notice).toHaveCount(0)
    await expect(page.locator(".usage-by-tool-updating")).toHaveCount(0)
  } finally {
    release()
  }
})

/** The shell and empty header must share their structural breakpoint without introducing another grid column. */
for (const width of [600, 640, 641]) {
  test(`empty Limits stays in the shell column at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "One responsive sweep")
    await page.setViewportSize({ width, height: 900 })
    // The client rejects negative instants, so the fixture reads at the browser server's own clock.
    const now = Date.now()
    await page.route(
      /\/v1\/connect\/usage(\?|$)/,
      (route) => route.fulfill({ json: usageFixture({ range: "7d", timeZone: "UTC" }, now, "empty-readings") })
    )
    await page.route(
      /\/v1\/connect\/limits(\?|$)/,
      (route) => route.fulfill({ json: limitsFixture(now, "empty-readings") })
    )
    await page.goto("/?range=7d&timeZone=UTC#usage/limits")
    await expect(page.locator(".usage-limits-empty")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const header = page.locator(".usage-empty-header-region")
    await expect(header).toHaveCSS("grid-column-start", width <= 640 ? "1" : "2")
    const geometry = await header.evaluate((element) => ({
      header: element.getBoundingClientRect().toJSON(),
      main: document.querySelector(".superapp-main")?.getBoundingClientRect().toJSON(),
      scroll: document.documentElement.scrollWidth,
      viewport: innerWidth
    }))
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport)
    expect(geometry.main).toBeDefined()
    expect(geometry.header.x).toBeCloseTo(geometry.main?.x ?? Infinity, 0)
    expect(geometry.header.width).toBeCloseTo(geometry.main?.width ?? Infinity, 0)
    if (width <= 640) {
      await expect(page.locator(".usage-empty-titles")).toBeHidden()
      await expect(page.locator(".superapp-bottom")).toBeVisible()
    } else {
      await expect(page.locator(".usage-empty-titles")).toBeVisible()
      await expect(page.locator(".superapp-bottom")).toBeHidden()
    }
    await page.unroute(/\/v1\/connect\/usage(\?|$)/)
    await page.unroute(/\/v1\/connect\/limits(\?|$)/)
    // The hash is unchanged, so only a reload issues fresh reads.
    await page.reload()
    await expect(page.locator(".usage-limits-empty")).toHaveCount(0)
    await expect(page.locator(".superapp-header")).toHaveCSS("grid-column-start", width <= 640 ? "1" : "2")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
