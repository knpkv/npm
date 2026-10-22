import { expect, test } from "@playwright/test"

/** Empty agents cannot hide uncertainty from the independent approvals source. */
for (const state of ["partial", "failed", "empty"]) {
  test(`empty Home retains the ${state} approval reading`, async ({ baseURL, context, page }) => {
    if (baseURL === undefined) throw new Error("Missing fixture origin")
    await context.addCookies([{ name: "connect-fixture", value: "empty", url: baseURL }])
    if (state === "partial") {
      await page.route("**/v1/modules/connect/needs-you", (route) =>
        route.fulfill({
          json: {
            _tag: "Partial",
            items: [],
            sources: [{ provider: "fleet", issue: { state: "failed", reason: "offline" } }]
          }
        }))
    }
    await page.goto(`/?todayFixture=${state}#connect/overview`)
    await expect(page.locator(".connect-home-empty")).toBeVisible()
    if (state === "empty") await expect(page.locator(".connect-home-strip")).toHaveCount(0)
    else {
      const strip = page.locator(".connect-home-strip-compact")
      await expect(strip.getByRole("link", { name: "Approvals unknown, open Fleet Approvals", exact: true }))
        .toBeVisible()
      await expect(strip.locator("strong")).toHaveCount(0)
      const stripBounds = await strip.boundingBox()
      const emptyBounds = await page.locator(".connect-home-empty").boundingBox()
      expect(stripBounds).not.toBeNull()
      expect(emptyBounds).not.toBeNull()
      if (stripBounds === null || emptyBounds === null) return
      expect(emptyBounds.y - stripBounds.y - stripBounds.height).toBeCloseTo(36, 1)
      await strip.getByRole("link").click()
      await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toBeFocused()
    }
  })
}

for (const theme of ["light", "dark"]) {
  test(
    `Connect home groups the existing reading and Ready states in ${theme}`,
    async ({ baseURL, context, page }, info) => {
      if (baseURL === undefined) throw new Error("Missing fixture origin")
      await context.addCookies([{ name: "connect-fixture", value: "ready", url: baseURL }])
      await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light" })
      await page.goto("/")
      await page.locator("body").evaluate((body, theme) => body.setAttribute("data-rly-theme", theme), theme)
      expect(new URL(page.url()).hash).toBe("#connect/overview")
      const home = page.locator("[data-module=\"connect\"]")
      await expect(home.locator(".connect-home-group h2")).toHaveCount(4)
      await page.evaluate(() => document.fonts.ready)
      await expect.soft(home.locator(".connect-updated")).toHaveCount(0)
      const geometry = await home.evaluate((element) => {
        const intro = element.querySelector(".connect-home-intro")?.getBoundingClientRect()
        const header = document.querySelector(".superapp-header")?.getBoundingClientRect()
        const shell = element.querySelector(".connect-shell")
        const groupHeading = element.querySelector(".connect-home-group-heading")
        const title = groupHeading?.querySelector("h2")
        const voice = element.querySelector(".connect-agent-work")
        const cards = element.querySelectorAll(".connect-home-agent")
        const readingTimes = element.querySelectorAll(
          ".connect-home-last-activity, [data-home-group=\"ready\"] .connect-agent-copy > span:last-child"
        )
        return {
          introTop: intro?.top,
          headerBottom: header?.bottom,
          headerHeight: header?.height,
          inset: shell === null ? null : getComputedStyle(shell).paddingBlockStart,
          shellTop: shell?.getBoundingClientRect().top,
          groupHeadingHeight: groupHeading?.getBoundingClientRect().height,
          titleMargin: title == null ? null : getComputedStyle(title).marginBlock,
          voiceClamp: voice === null ? null : getComputedStyle(voice).webkitLineClamp,
          shellBottom: shell?.getBoundingClientRect().bottom,
          lastCardBottom: cards.item(cards.length - 1)?.getBoundingClientRect().bottom,
          readingTimeColors: [...readingTimes].map((time) => getComputedStyle(time).color),
          metaColor: getComputedStyle(element.querySelector(".connect-agent-copy small") ?? element).color
        }
      })
      expect.soft(geometry.headerHeight).toBe(64)
      expect.soft(geometry.inset).toBe("0px")
      // Phone puts the 32px breadcrumb line (design rule 45) between the header and the page.
      expect.soft(geometry.shellTop).toBe((geometry.headerBottom ?? 0) + (info.project.name === "phone" ? 32 : 0))
      expect.soft(geometry.groupHeadingHeight).toBe(info.project.name === "phone" ? 48 : 44)
      expect.soft(geometry.titleMargin).toBe("0px")
      expect.soft(geometry.voiceClamp).toBe("2")
      expect(geometry.readingTimeColors.length).toBeGreaterThan(0)
      for (const color of geometry.readingTimeColors) expect.soft(color).toBe(geometry.metaColor)
      expect.soft(geometry.shellBottom).toBeGreaterThanOrEqual(geometry.lastCardBottom ?? Infinity)
      if (info.project.name === "desktop") {
        // Export52 wraps the title and directory switch in a 24px desktop mast inset.
        expect.soft(geometry.introTop).toBe((geometry.headerBottom ?? 0) + 24)
        const navigation = await page.locator(".superapp-sidebar").evaluate((sidebar) => {
          const brand = sidebar.querySelector(".superapp-sidebar-brand")
          const settings = sidebar.querySelector(".superapp-settings")
          const primary = sidebar.querySelector(".superapp-module-nav > a")
          const secondary = sidebar.querySelector(".superapp-module-nav > a[data-secondary]")
          return {
            brandHeight: brand?.getBoundingClientRect().height,
            settingsHeight: settings?.getBoundingClientRect().height,
            primaryLineHeight: primary == null ? null : getComputedStyle(primary).lineHeight,
            secondaryLineHeight: secondary == null ? null : getComputedStyle(secondary).lineHeight
          }
        })
        expect.soft(navigation.brandHeight).toBe(48)
        expect.soft(navigation.settingsHeight).toBe(40)
        expect.soft(navigation.primaryLineHeight).toBe("22.5px")
        expect.soft(navigation.secondaryLineHeight).toBe("21px")
      }
      await expect(home.locator(".connect-home-group h2")).toHaveText([
        "Needs you 3",
        "Working 3",
        "Ready 2",
        "Recently done 1"
      ])
      await expect(home.locator(".connect-home-strip > div")).toContainText("3need you")
      await expect(home.locator(".connect-home-strip > a")).toContainText("3approvals waiting")
      await expect(home.locator("[data-home-group=\"ready\"]")).toContainText("Idle since")
      await expect(home.locator("[data-home-group=\"ready\"] .connect-agent-work")).toHaveCount(0)
      await expect(home.getByText("Worker with Agent, hub", { exact: true })).toBeVisible()
      await expect(home.getByText("Pair partner with Build, hub", { exact: true })).toBeVisible()
      await expect(page.locator("[data-rly-relay-launcher]")).toHaveCount(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()?.width ?? 0
      )
    }
  )
}

for (const alias of ["#today", "#today/overview", "#fleet/connect", "?tab=connect"]) {
  test(`the retired ${alias} entry lands on Connect home`, async ({ page }) => {
    await page.goto(`/${alias}`)
    await expect(page.locator("[data-module=\"connect\"]")).toBeVisible()
    expect(new URL(page.url()).hash).toBe("#connect/overview")
    await expect(page.locator("[data-module=\"today\"]")).toHaveCount(0)
    expect((await page.request.get("/v1/modules/today/needs-you")).status()).toBe(404)
  })
}

for (
  const { expected, state } of [
    { state: "empty", expected: "0" },
    { state: "partial", expected: "At least3" },
    { state: "expired", expected: "0" },
    { state: "failed", expected: "Approvals unknown" }
  ]
) {
  test(`Home labels the ${state} approval reading independently of agents`, async ({ page }) => {
    await page.goto(`/?todayFixture=${state}`)
    const approvals = page.locator(".connect-home-strip > a")
    if (state === "failed") {
      await expect(approvals).toContainText(expected)
      await expect(approvals).toHaveAccessibleName("Approvals unknown, open Fleet Approvals")
      await expect(approvals.locator("small")).toHaveCount(0)
    } else await expect(approvals).toContainText(`${expected}approvals waiting`)
    if (state === "partial") await expect(approvals).toContainText("cedar didn’t answer, so there may be more")
  })
}

test("Home opens Fleet Approvals and Back returns to the same agent reading", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator(".connect-home-strip > a")).toContainText("3approvals waiting")
  await page.locator(".connect-home-strip > a").click()
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toBeFocused()
  expect(new URL(page.url()).hash).toBe("#fleet/approvals")
  await page.goBack()
  await expect(page.locator("[data-module=\"connect\"]")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#connect/overview")
})

test("Home approval polling stops inactive or hidden and resumes immediately without another dashboard owner", async ({ page }) => {
  await page.clock.install()
  let approvals = 0
  let dashboard = 0
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path === "/v1/modules/connect/needs-you") approvals += 1
    if (path === "/v1/dashboard") dashboard += 1
  })
  await page.goto("/?tab=approvals")
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toBeVisible()
  const before = dashboard
  const nav = page.locator(".superapp-sidebar, .superapp-bottom").filter({ visible: true })
  await nav.getByRole("link", { name: "Connect", exact: true }).click()
  await expect(page.locator(".connect-home-strip > a")).toContainText("3approvals waiting")
  expect(approvals).toBe(1)
  expect(dashboard).toBe(before)
  await nav.getByRole("link", { name: /^Fleet(?:,|$)/ }).click()
  await page.clock.runFor(5_050)
  expect(approvals).toBe(1)
  await nav.getByRole("link", { name: "Connect", exact: true }).click()
  await expect.poll(() => approvals).toBe(2)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await page.clock.runFor(5_050)
  expect(approvals).toBe(2)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(() => approvals).toBe(3)
})

test("a failed approval refresh keeps its previous count explicitly old", async ({ page }) => {
  await page.clock.install()
  await page.goto("/")
  await expect(page.locator(".connect-home-strip > a")).toContainText("3approvals waiting")
  await page.route(
    "**/v1/modules/connect/needs-you",
    (route) => route.fulfill({ status: 503, json: { error: "unavailable" } })
  )
  await page.clock.runFor(5_100)
  await expect(page.locator(".connect-home-strip > a")).toContainText("Previous reading3approvals waiting")
  await expect(page.locator(".connect-home-strip > a")).toContainText("Couldn't refresh approvals")
})

test("a blocked-agent push link opens its exact Connect stage and retains the mounted approval owner", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "/connect/?host=hub&agent=agent-1&open=stage"
    link.textContent = "Open blocked agent"
    document.querySelector("[data-module=\"connect\"]")?.prepend(link)
  })
  await page.getByRole("link", { name: "Open blocked agent", exact: true }).click()
  const stage = page.getByRole("dialog", { name: "Agent", exact: true })
  await expect(stage).toBeVisible()
  await expect.poll(() => stage.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  const url = new URL(page.url())
  expect(url.hash).toBe("#connect/overview")
  expect(url.searchParams.get("host")).toBe("hub")
  expect(url.searchParams.get("agent")).toBe("agent-1")
  expect(url.searchParams.get("open")).toBe("stage")
  await expect(page.getByRole("tab", { name: "Approvals", exact: true, includeHidden: true })).toHaveCount(1)
})

/** Empty Home points only to existing Fleet Work and the existing shell Host access sheet. */
test(
  "complete-empty Home offers existing navigation instead of empty activity groups",
  async ({ baseURL, context, page }, info) => {
    if (baseURL === undefined) throw new Error("Missing fixture origin")
    await context.addCookies([{ name: "connect-fixture", value: "empty", url: baseURL }])
    await page.goto("/?todayFixture=empty")
    await expect(page.getByRole("heading", { name: "No agents on any host yet", exact: true })).toBeVisible()
    await expect(page.locator(".connect-home-group")).toHaveCount(0)
    await expect(page.locator(".connect-home-strip")).toHaveCount(0)
    const emptyGeometry = await page.locator(".connect-home-empty").evaluate((empty) => ({
      top: empty.getBoundingClientRect().top,
      agentsTop: empty.parentElement?.getBoundingClientRect().top,
      buttons: [...empty.querySelectorAll("button")].map((button) => ({
        height: button.getBoundingClientRect().height,
        fontSize: getComputedStyle(button).fontSize,
        weight: getComputedStyle(button).fontWeight,
        radius: getComputedStyle(button).borderRadius
      })),
      stepsLineHeight: getComputedStyle(empty.querySelector("ol") ?? empty).lineHeight
    }))
    expect.soft(emptyGeometry.top - (emptyGeometry.agentsTop ?? 0)).toBe(info.project.name === "phone" ? 16 : 24)
    expect(emptyGeometry.buttons).toHaveLength(2)
    for (const button of emptyGeometry.buttons) {
      expect.soft(button.height).toBe(info.project.name === "phone" ? 48 : 44)
      expect.soft(button.fontSize).toBe("16px")
      expect.soft(button.weight).toBe("430")
      expect.soft(button.radius).toBe("14px")
    }
    expect.soft(emptyGeometry.stepsLineHeight).toBe("22.5px")
    await page.getByRole("button", { name: "Check hosts", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Hosts", exact: true })).toBeVisible()
    await page.getByRole("dialog").getByRole("button", { name: /Close/ }).click()
    await page.getByRole("button", { name: "Open Fleet, Work", exact: true }).click()
    expect(new URL(page.url()).hash).toBe("#fleet/work")
  }
)

/** A failed host leaves its last-known work visible, never labelled as currently Working. */
test(
  "Home names a silent host agent Unknown with cached work and last activity",
  async ({ baseURL, context, page }, info) => {
    if (baseURL === undefined) throw new Error("Missing fixture origin")
    await context.addCookies([{ name: "connect-fixture", value: "partial", url: baseURL }])
    await page.goto("/")
    const card = page.locator("[data-home-group=\"unknown\"] .connect-home-agent")
    await expect(card).toHaveCount(1)
    await expect(card.locator("[data-home-state]")).toHaveText("Unknown")
    await expect(card).toContainText("Reviewing the last finding")
    await expect(card).toContainText("Last activity")
    await expect(page.locator("[data-home-group=\"unknown\"] h2")).toHaveText("Unknown, cedar not answering 1")
    await expect(card.locator(".connect-home-last-activity + .connect-agent-work")).toHaveCount(1)
    const notice = page.locator(".connect-home-read-notice")
    await expect(notice.locator("svg.lucide-clock")).toHaveCount(1)
    const retry = await notice.getByRole("button", { name: "Retry", exact: true }).boundingBox()
    expect.soft(retry?.height).toBe(info.project.name === "phone" ? 48 : 44)
    expect.soft(
      await notice.locator("div > span:last-child").evaluate((element) => getComputedStyle(element).lineHeight)
    ).toBe("21px")
    const spacing = await page.locator(".connect-home-strip").evaluate((strip) => ({
      strip: strip.getBoundingClientRect().top,
      notice: document.querySelector(".connect-home-read-notice")?.getBoundingClientRect().bottom
    }))
    expect(spacing.strip - (spacing.notice ?? Infinity)).toBe(20)
  }
)

/** Routine polls stay quiet; a held request has its own deadline and failed reads retain separate wording. */
test("Home refresh notices wait for an old reading and settle without shifting routine polls", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-11T12:00:00Z") })
  const releases: Array<() => void> = []
  let reads = 0
  let held = 0
  await page.route("**/v1/connect/agents**", async (route) => {
    const response = await route.fetch()
    reads += 1
    if (reads > 1) {
      held += 1
      await new Promise<void>((resolve) => releases.push(resolve))
    }
    await route.fulfill({ response })
    if (reads > 1) held -= 1
  })
  await page.goto("/")
  const home = page.locator("[data-module=\"connect\"]")
  await expect(home.locator(".connect-home-agent").first()).toBeVisible()
  const strip = home.locator(".connect-home-strip")
  const notice = home.locator(".connect-home-read-notice")
  const originalTop = (await strip.boundingBox())?.y
  expect(originalTop).toBeDefined()
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.clock.runFor(5_050)
    await expect.poll(() => held).toBe(1)
    await page.clock.runFor(200)
    await expect(notice).toHaveCount(0)
    expect((await strip.boundingBox())?.y).toBe(originalTop)
    releases.shift()?.()
    await expect.poll(() => held).toBe(0)
    await expect(notice).toHaveCount(0)
  }
  await page.clock.runFor(5_050)
  await expect.poll(() => held).toBe(1)
  await expect(notice).toHaveCount(0)
  await page.clock.runFor(5_050)
  await expect(notice).toContainText("Refreshing")
  await expect(notice).toContainText("Updated 10 sec ago.")
  releases.shift()?.()
  await expect.poll(() => held).toBe(0)
  await expect(notice).toHaveCount(0)
  expect((await strip.boundingBox())?.y).toBe(originalTop)
  await page.unroute("**/v1/connect/agents**")
  await page.route(
    "**/v1/connect/agents**",
    (route) => route.fulfill({ status: 503, body: "private_transport_detail" })
  )
  await page.clock.runFor(5_050)
  await expect(notice).toContainText("Couldn’t refresh")
  await expect(notice).toContainText("Previous reading")
  await expect(notice).toContainText(". Retrying every 5 seconds.")
  await expect(notice).not.toContainText("Refreshing")
  await expect(home).not.toContainText("private_transport_detail")
  const previous = strip.locator(":scope > div").getByText("Previous reading", { exact: true })
  const count = strip.locator(":scope > div > strong")
  expect(await previous.evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px")
  expect(await previous.evaluate((element) => getComputedStyle(element).fontWeight)).toBe("520")
  const previousBounds = await previous.boundingBox()
  const countBounds = await count.boundingBox()
  expect(previousBounds).not.toBeNull()
  expect(countBounds).not.toBeNull()
  if (previousBounds === null || countBounds === null) return
  expect(previousBounds.y + previousBounds.height).toBeLessThanOrEqual(countBounds.y)
  await expect(strip.locator(":scope > a")).not.toContainText("Previous reading")
  await expect(home.locator(".connect-home-agent").first()).not.toContainText("Old reading")
  await expect(notice.locator("svg.lucide-clock")).toHaveCount(1)
})
