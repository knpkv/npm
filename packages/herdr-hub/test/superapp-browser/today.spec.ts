import { expect, test } from "@playwright/test"

test("keeps expiry readings on one line at the narrowest phone and desktop widths", async ({ page }) => {
  await page.clock.install()
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await expect(page.locator(".today-request")).toHaveCount(3)
    await page.clock.runFor(15_100)
    await expect(page.locator(".today-request-expiry").first()).toContainText("s left")
    const readings = await page.locator(".today-request-expiry").evaluateAll((elements) =>
      elements.map((element) => ({
        height: element.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(element).lineHeight),
        text: element.textContent
      }))
    )
    expect(readings.length).toBe(3)
    for (const reading of readings) expect(reading.height).toBeLessThanOrEqual(reading.line + 1)
    const words = await page.locator(".today-request-copy strong").evaluateAll((elements) =>
      elements.flatMap((element) => {
        const text = element.firstChild
        if (text === null) throw new Error("Missing operation title")
        return [...(text.textContent ?? "").matchAll(/\S+/g)].map((word) => {
          const range = document.createRange()
          range.setStart(text, word.index)
          range.setEnd(text, word.index + word[0].length)
          return { word: word[0], lines: range.getClientRects().length }
        })
      })
    )
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) expect(word.lines, word.word).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
})

for (const theme of ["light", "dark"]) {
  test(`renders Fleet-only Today with usable links and no fabricated usage in ${theme}`, async ({ page }) => {
    await page.goto("/")
    await page.evaluate((theme) => {
      document.body.setAttribute("data-rly-theme", theme)
      document.body.style.colorScheme = theme
    }, theme)
    await expect(page.getByRole("heading", { name: "3 things need you.", exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe("#today/overview")
    const today = page.locator("[data-module=\"today\"]")
    await expect(today.locator(".today-request")).toHaveCount(3)
    await expect(today.getByRole("heading", { name: "Bots on the move", exact: true })).toBeVisible()
    await expect(today.getByText("Checking module navigation", { exact: true })).toBeVisible()
    await expect(today.getByText("Completed", { exact: true })).toBeVisible()
    await expect(today.locator("[role=\"meter\"], [role=\"progressbar\"]")).toHaveCount(0)
    await expect(today.locator("button")).toHaveCount(0)
    await expect(page.locator("[data-rly-relay-launcher]")).toHaveCount(1)
    await page.evaluate(() => document.fonts.ready)
    const dimensions = await today.evaluate((element) => ({
      width: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
      links: [...element.querySelectorAll("a")].map((link) => ({
        height: link.getBoundingClientRect().height,
        width: link.getBoundingClientRect().width
      }))
    }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width)
    expect(dimensions.links.length).toBeGreaterThan(0)
    for (const link of dimensions.links) {
      expect(link.height).toBeGreaterThanOrEqual(44)
      expect(link.width).toBeGreaterThan(0)
    }
    await today.getByRole("link", { name: "Check local limits", exact: true }).click()
    await expect(page.getByRole("tab", { name: "Usage", exact: true })).toBeFocused()
    expect(new URL(page.url()).hash).toBe("#fleet/usage")
  })
}

const discoveryStates: ReadonlyArray<readonly [state: string, heading: string, detail: string]> = [
  ["empty", "You're clear.", "A quiet day for your fleet"],
  ["partial", "At least 3 things need you.", "cedar is offline."],
  ["expired", "No approvals are waiting. 1 expired.", "Expired"],
  ["failed", "Couldn't read your fleet.", "No reading is available yet."]
]

for (const [state, heading, detail] of discoveryStates) {
  test(`keeps ${state} discovery truthful`, async ({ page }) => {
    await page.goto(`/?todayFixture=${state}`)
    const today = page.locator("[data-module=\"today\"]")
    await expect(today.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    await expect(today.getByText(detail, { exact: state !== "failed" })).toBeVisible()
    if (state !== "empty") await expect(today.getByText("You're clear.", { exact: true })).toHaveCount(0)
    if (state === "empty") await expect(today.locator(".today-empty")).toContainText(/Checked \d{2}:\d{2}/)
    if (state === "partial" || state === "failed") await expect(today.locator("[role=alert] button")).toHaveCount(0)
  })
}

test("Today opens and focuses a case-preserved off-page peer approval, and Back returns to Today", async ({ page }) => {
  await page.goto("/")
  const firstPage = await page.request.get("/v1/dashboard")
  expect(await firstPage.text()).not.toContain("alpha-off-page")
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === "/v1/pending-approval" && url.searchParams.get("host") === "ALPHA" &&
      url.searchParams.get("jobId") === "alpha-off-page"
  })
  const previous = await page.evaluate(() => history.length)
  await page.locator(".today-request").filter({ hasText: "ALPHA" }).click()
  expect((await response).status()).toBe(200)
  expect(new URL(page.url()).searchParams.get("approvalHost")).toBe("ALPHA")
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toHaveAttribute("aria-selected", "true")
  const target = page.locator("[data-approval-target=\"true\"]")
  await expect(target).toHaveAttribute("data-approval-job", "alpha-off-page")
  await expect(target).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(previous + 1)
  await page.goBack()
  await expect(page.locator("[data-module=\"today\"]")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#today/overview")
})

test("one Today poll stops while inactive or hidden and adds no dashboard owner", async ({ page }) => {
  await page.clock.install()
  let todayReads = 0
  let dashboardReads = 0
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path === "/v1/modules/today/needs-you") todayReads += 1
    if (path === "/v1/dashboard") dashboardReads += 1
  })
  await page.goto("/?tab=approvals")
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toBeVisible()
  await page.clock.runFor(50)
  const baseline = dashboardReads
  const nav = page.getByRole("navigation", { name: /^(Modules|Mobile modules)$/ }).filter({ visible: true })
  await nav.getByRole("link", { name: "Today", exact: true }).click()
  await expect(page.getByRole("heading", { name: "3 things need you.", exact: true })).toBeVisible()
  expect(todayReads).toBe(1)
  expect(dashboardReads).toBe(baseline)
  await nav.getByRole("link", { name: "Fleet", exact: true }).click()
  await page.clock.runFor(5_050)
  expect(todayReads).toBe(1)
  await nav.getByRole("link", { name: "Today", exact: true }).click()
  await expect.poll(() => todayReads).toBe(2)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await page.clock.runFor(5_050)
  expect(todayReads).toBe(2)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(() => todayReads).toBe(3)
})

test("a failed refresh keeps the previous list explicitly old", async ({ page }) => {
  await page.clock.install()
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "3 things need you.", exact: true })).toBeVisible()
  await page.route(
    "**/v1/modules/today/needs-you",
    (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{\"error\":\"unavailable\"}" })
  )
  await page.clock.runFor(5_100)
  const today = page.locator("[data-module=\"today\"]")
  await expect(today.getByRole("heading", { name: "Previous reading: 3 approvals.", exact: true })).toBeVisible()
  await expect(today.locator(".today-request")).toHaveCount(3)
  await expect(today.getByText(/Previous reading shown/)).toBeVisible()
})

test("a blocked-agent notification link from Today opens its exact Connect stage", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "/connect/?host=hub&agent=agent-1&open=stage"
    link.textContent = "Open blocked agent"
    document.querySelector("[data-module=\"today\"]")?.prepend(link)
  })
  await page.getByRole("link", { name: "Open blocked agent", exact: true }).click()
  const stage = page.getByRole("dialog", { name: "Agent", exact: true })
  await expect(stage).toBeVisible()
  await expect.poll(() => stage.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  expect(new URL(page.url()).hash).toBe("#fleet/connect")
  expect(new URL(page.url()).searchParams.get("host")).toBe("hub")
  expect(new URL(page.url()).searchParams.get("agent")).toBe("agent-1")
  expect(new URL(page.url()).searchParams.get("open")).toBe("stage")
  await expect(page.getByRole("tab", { name: "Approvals", exact: true, includeHidden: true })).toHaveCount(1)
})
