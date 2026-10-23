import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test"
import { Schema } from "effect"
import { connectFixture } from "./connect-fixture.js"

const fleetPages: ReadonlyArray<readonly [string, string]> = [
  ["work", "Work"],
  ["approvals", "Approvals"]
]
const sharedPanels: ReadonlyArray<readonly [string, string]> = [
  ["More", "More"],
  ["Notifications", "Notifications"],
  ["1 host configured: hub", "Hosts"]
]

const moreOpener = (page: Page) =>
  page.locator(".superapp-sidebar, .superapp-bottom").filter({ visible: true }).getByRole("button", {
    name: /^(Settings|More)$/
  })

/** Export 39 gives installed Fleet tabs their label width and the same gutter as its title. */
test("Fleet module tabs stay left aligned at label width", async ({ page }, info) => {
  await page.goto("/#fleet/approvals")
  await page.evaluate(() => document.fonts.ready)
  const tabs = page.getByRole("tablist", { name: "Relay applications" })
  await expect(tabs.getByRole("tab")).toHaveText(["Approvals", "Work"])
  const geometry = await tabs.evaluate((element) => ({
    title: document.querySelector(".superapp-module-heading h1")?.getBoundingClientRect().left,
    left: element.getBoundingClientRect().left,
    tabs: [...element.querySelectorAll("[role=\"tab\"]")].map((tab) => ({
      width: tab.getBoundingClientRect().width,
      height: tab.getBoundingClientRect().height
    }))
  }))
  expect(geometry.left).toBe(info.project.name === "phone" ? 8 : geometry.title)
  expect(geometry.tabs).toHaveLength(2)
  for (const tab of geometry.tabs) {
    expect(tab.width).toBeLessThan(120)
    expect(tab.height).toBe(44)
  }
})

/** A landscape cutout owns the edge gutter; labels cannot sit beneath the safe-area inset. */
test("Fleet module tabs respect landscape safe-area insets", async ({ context, page }, info) => {
  test.skip(info.project.name !== "phone", "Landscape phone")
  const session = await context.newCDPSession(page)
  try {
    await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: 44, right: 34 } })
    await page.setViewportSize({ width: 590, height: 390 })
    await page.goto("/#fleet/approvals")
    const safeArea = await page.evaluate(() => {
      const probe = document.createElement("div")
      probe.style.paddingInlineStart = "env(safe-area-inset-left)"
      document.body.append(probe)
      const padding = getComputedStyle(probe).paddingInlineStart
      probe.remove()
      return padding
    })
    expect(safeArea).toBe("44px")
    const padding = await page.locator("[data-fleet-layout=\"module\"] > .fleet-shell-main").evaluate((element) => ({
      left: getComputedStyle(element).paddingLeft,
      right: getComputedStyle(element).paddingRight
    }))
    expect(padding).toEqual({ left: "44px", right: "34px" })
    await page.goto("/#usage/by-tool")
    await expect(page.locator(".usage-by-tool table tbody tr")).not.toHaveCount(0)
    const usage = await page.locator(".usage-details[data-usage-page=\"by-tool\"]").evaluate((element) => {
      const mast = element.querySelector(".usage-details-mast") ?? element.querySelector(".usage-details-intro")
      const box = mast?.getBoundingClientRect()
      return {
        left: getComputedStyle(element).paddingLeft,
        right: getComputedStyle(element).paddingRight,
        mastLeft: box?.left,
        mastRight: box?.right,
        width: innerWidth,
        scrollWidth: document.scrollingElement?.scrollWidth,
        clientWidth: document.scrollingElement?.clientWidth
      }
    })
    expect(usage.left).toBe("44px")
    expect(usage.right).toBe("34px")
    expect(usage.mastLeft).toBe(0)
    expect(usage.mastRight).toBe(usage.width)
    expect(usage.scrollWidth).toBe(usage.clientWidth)
  } finally {
    await session.send("Emulation.setSafeAreaInsetsOverride", { insets: {} })
    await session.detach()
  }
})

/** Export 28 hides the phone host button; the same Host access action remains in More. */
const openSharedPanel = async (page: Page, button: string) => {
  if (button === "More") {
    const trigger = moreOpener(page)
    await trigger.click()
    return trigger
  }
  const headerTrigger = page.getByRole("button", { name: button, exact: true })
  if (await headerTrigger.isVisible()) {
    await headerTrigger.click()
    return headerTrigger
  }
  const trigger = moreOpener(page)
  await trigger.click()
  await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: /^Host access/ }).click()
  return trigger
}

for (const reducedMotion of ["no-preference", "reduce"] satisfies ReadonlyArray<"no-preference" | "reduce">) {
  test(`More exposes only working settings and restores focus with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    await page.goto("/")
    const opener = moreOpener(page)
    await opener.click()
    const more = page.getByRole("dialog", { name: "More", exact: true })
    // Only modules outside the phone bar are listed: Host resources, Sandboxes and Stacks.
    const moreModules = more.getByRole("navigation", { name: "More modules" })
    await expect(moreModules.getByRole("link")).toHaveCount(3)
    await expect(moreModules.getByRole("link", { name: /^Host resources/ })).toBeVisible()
    await expect(moreModules.getByRole("link", { name: /^Sandboxes/ })).toBeVisible()
    await expect(moreModules.getByRole("link", { name: /^Stacks/ })).toBeVisible()
    await expect(more.getByText("Appearance", { exact: true })).toHaveCount(0)
    await expect(more.getByRole("button", { name: /^Host access/ })).toBeVisible()
    await expect(more.getByRole("button", { name: /^Notifications/ })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(more).toHaveCount(0)
    await expect(opener).toBeFocused()
    await expect(page.locator("[data-module=\"connect\"]")).toBeVisible()
  })
}

test("More's real Host access and Notifications actions retain the same dialog owner", async ({ page }) => {
  await page.goto("/")
  for (
    const { name, title } of [{ name: "Host access", title: "Hosts" }, {
      name: "Notifications",
      title: "Notifications"
    }]
  ) {
    const opener = moreOpener(page)
    await opener.click()
    await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: new RegExp(`^${name}`) })
      .click()
    const dialog = page.getByRole("dialog", { name: title, exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.locator("[role=\"dialog\"]")).toHaveCount(1)
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
  }
})

test("keeps shared panel headings clear of the close target at the narrowest phone width", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Narrow phone panels")
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/#fleet/work")
  for (const [button, title] of sharedPanels) {
    await openSharedPanel(page, button)
    const panel = page.getByRole("dialog", { name: title, exact: true })
    const heading = panel.getByRole("heading", { name: title, exact: true })
    const close = panel.getByRole("button", { name: "Close", exact: true })
    await expect(heading).toBeVisible()
    expect(await heading.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBe(20)
    const right = await heading.evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect().right
    })
    const target = await close.boundingBox()
    expect(target?.width).toBeGreaterThanOrEqual(44)
    expect(target?.height).toBeGreaterThanOrEqual(44)
    expect(right).toBeLessThanOrEqual(target?.x ?? 0)
    await close.click()
  }
})

test("shows all five Relay poses while finished replies stay idle and listening clears on close", async ({ page }) => {
  for (const phase of ["idle", "listening", "thinking", "answering", "needs-you"]) {
    await page.goto(`/?relayFixture=${phase}#fleet/work`)
    await page.getByRole("button", { name: "Ask Relay", exact: true }).click()
    const panel = page.locator("[data-rly-relay-panel]")
    await expect(panel).toBeVisible()
    const composer = panel.getByRole("textbox")
    if (phase === "idle") await panel.getByRole("button", { name: "Close Relay", exact: true }).focus()
    if (phase === "listening") await composer.focus()
    await expect(panel.locator("[data-rly-relay-avatar=\"panel\"] [data-relay-phase]")).toHaveAttribute(
      "data-relay-phase",
      phase
    )
    const turns = panel.locator("[data-rly-relay-avatar=\"turn\"] [data-relay-phase]")
    expect(await turns.count()).toBeGreaterThan(0)
    if (phase === "idle" || phase === "listening") {
      await expect(panel.locator("[data-rly-relay-avatar=\"turn\"] [data-relay-phase=\"idle\"]")).toHaveCount(
        await turns.count()
      )
    } else {
      await expect(panel.locator(`[data-rly-relay-avatar="turn"] [data-relay-phase="${phase}"]`)).toHaveCount(1)
      await expect(panel.locator("[data-rly-relay-avatar=\"turn\"] [data-relay-phase=\"idle\"]")).toHaveCount(
        (await turns.count()) - 1
      )
    }
    await panel.getByRole("button", { name: "Close Relay", exact: true }).click()
    await expect(panel).toHaveCount(0)
    const launcher = page.locator("[data-rly-relay-avatar=\"launcher\"]")
    await expect(launcher.locator(".relay-chef-mark")).toHaveCount(1)
    await expect(launcher.locator("[data-relay-phase]")).toHaveCount(0)
  }
})

test("keeps the phone composer above both resizing and overlay keyboards", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Phone keyboard inset")
  await page.goto("/?relayFixture=idle#fleet/work")
  await page.getByRole("button", { name: "Ask Relay", exact: true }).click()
  const panel = page.locator("[data-rly-relay-panel=\"fullscreen\"]")
  await expect(panel).toBeVisible()
  const send = panel.getByRole("button", { name: "Send", exact: true })
  await page.setViewportSize({ width: 390, height: 480 })
  await expect.poll(async () => (await send.boundingBox())?.y ?? Infinity).toBeLessThan(480)
  expect(await send.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(480)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    const viewport = window.visualViewport
    if (viewport === null) throw new Error("Visual viewport missing")
    Object.defineProperty(viewport, "height", { configurable: true, value: 480 })
    viewport.dispatchEvent(new Event("resize"))
  })
  await expect
    .poll(() => send.evaluate((node) => node.getBoundingClientRect().bottom))
    .toBeLessThanOrEqual(480)
})

test("flat navigation and the module heading remain readable beside an active Relay", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop header allocation")
  for (const width of [768, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/?relayFixture=needs-you#fleet/work")
    await expect(page.locator(".superapp-module-heading h1")).toHaveText("Fleet")
    await expect(page.locator(".superapp-breadcrumb")).toBeHidden()
    await expect(page.locator(".superapp-sidebar a[aria-current=\"page\"]")).toHaveAccessibleName(
      "Fleet, 1 approval waiting"
    )
    for (const open of [false, true]) {
      if (open) await page.getByRole("button", { name: "Ask Relay", exact: true }).click()
      await expect(page.locator(".superapp-module-heading h1")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
  }
})

test(
  "sizes the conversation character and keeps its motion and forced-colour behavior across panel and turns",
  async ({
    page
  }, info) => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("/?relayFixture=turns")
    const launcher = page.locator("[data-rly-relay-launcher]")
    await launcher.click()
    const panel = page.locator("[data-rly-relay-panel]")
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAccessibleName("Ask Relay")
    const slots = [
      {
        node: panel.locator("[data-rly-relay-avatar=\"panel\"] svg"),
        size: 32
      }
    ]
    for (const { node, size } of slots) {
      const bounds = await node.boundingBox()
      expect(bounds?.width).toBe(size)
      expect(bounds?.height).toBe(size)
      expect(await node.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBeGreaterThan(0)
    }
    const turns = panel.locator("[data-rly-relay-avatar=\"turn\"] svg")
    await expect(turns).toHaveCount(3)
    await expect(panel.locator("[data-rly-relay-avatar=\"turn\"] svg[data-bucket=\"working\"]")).toHaveCount(1)
    await expect(panel.locator("[data-rly-relay-avatar=\"turn\"] svg[data-bucket=\"ready\"]")).toHaveCount(2)
    for (const turn of await turns.all()) {
      expect((await turn.boundingBox())?.width).toBe(24)
    }
    expect((await launcher.boundingBox())?.height).toBeGreaterThanOrEqual(info.project.name === "phone" ? 44 : 32)
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" })
    for (const node of [...slots.map(({ node }) => node), ...(await turns.all())]) {
      if (node === undefined) throw new Error("Character slot missing")
      expect(await node.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0)
      const contrast = await node.evaluate((svg) => {
        const body = svg.querySelector(".connect-creature-body")
        const pupil = svg.querySelector(".connect-creature-pupil")
        if (body === null || pupil === null) throw new Error("Shared character parts missing")
        return {
          fill: getComputedStyle(body).fill,
          stroke: getComputedStyle(body).stroke,
          pupil: getComputedStyle(pupil).fill
        }
      })
      expect(contrast.stroke).not.toBe("none")
      expect(contrast.fill).not.toBe(contrast.stroke)
      expect(contrast.pupil).toBe(contrast.stroke)
    }
  }
)

test("keeps a document anchor on first load", async ({ page }) => {
  await page.goto("/#main")
  await expect(page.locator("[data-module=\"connect\"]")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#main")
  await expect(page.getByText("This page doesn't exist in Relay.", { exact: true })).toHaveCount(0)
})

test(
  "phone breadcrumb and flat bar sit clear of Relay, and the breadcrumb hides in full-screen Relay",
  async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "Phone chrome")
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto("/#fleet/work")
      await expect(page.locator(".superapp-breadcrumb")).toHaveText("Fleet / Work", { useInnerText: true })
      await expect(page.locator(".superapp-phone-title")).toHaveText("Relay")
      await expect(page.locator(".superapp-bottom a")).toHaveText(["Connect", "Fleet1", "Code", "Usage"])
      const barGeometry = await page.locator(".superapp-bottom").evaluate((bar) => {
        const fleet = bar.querySelector("a[href*=\"#fleet/\"]")
        const badge = fleet?.querySelector(".superapp-module-badge")
        const current = bar.querySelector("a[aria-current=\"page\"]")
        const badgeBounds = badge?.getBoundingClientRect()
        return {
          height: bar.getBoundingClientRect().height,
          icons: [...bar.querySelectorAll(".superapp-icon")].map((icon) => icon.getBoundingClientRect().width),
          currentBackground: current === null ? null : getComputedStyle(current).backgroundColor,
          fleet: fleet?.getBoundingClientRect().toJSON(),
          badge: badgeBounds?.toJSON(),
          badgeHitsFleet: badgeBounds === undefined ? false : document.elementFromPoint(
            badgeBounds.x + badgeBounds.width / 2,
            badgeBounds.y + badgeBounds.height / 2
          )?.closest("a") === fleet
        }
      })
      expect.soft(barGeometry.height).toBe(76)
      expect.soft(barGeometry.icons).toEqual([24, 24, 24, 24, 24])
      expect.soft(barGeometry.currentBackground).toBe("rgba(0, 0, 0, 0)")
      expect.soft(barGeometry.badge?.left).toBeGreaterThanOrEqual(barGeometry.fleet?.left ?? Infinity)
      expect.soft(barGeometry.badge?.right).toBeLessThanOrEqual(barGeometry.fleet?.right ?? -Infinity)
      expect.soft(barGeometry.badgeHitsFleet).toBe(true)
      const labels = await page.locator(".superapp-phone-title").boundingBox()
      const launcher = await page.locator("[data-rly-relay-launcher]").boundingBox()
      expect(labels).not.toBeNull()
      expect(launcher).not.toBeNull()
      if (labels !== null && launcher !== null) expect(labels.x + labels.width).toBeLessThanOrEqual(launcher.x)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.locator("[data-rly-relay-launcher]").click()
      await expect(page.locator("[data-rly-relay-panel=\"fullscreen\"]")).toBeVisible()
      await expect(page.locator(".superapp-bottom")).toHaveAttribute("aria-hidden", "true")
      await expect(page.locator(".superapp-breadcrumb")).toBeHidden()
      await page.getByRole("button", { name: "Close Relay", exact: true }).click()
      await expect(page.locator(".superapp-bottom")).toBeVisible()
    }
  }
)

test("opens a legacy approval target and focuses the exact request", async ({ page }) => {
  await page.goto("/?tab=approvals&approvalHost=hub&approvalJob=job-1")
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toHaveAttribute("aria-selected", "true")
  expect(new URL(page.url()).hash).toBe("#fleet/approvals")
  await expect(page.locator("[data-approval-target=\"true\"]")).toHaveCount(1)
  await expect(page.locator("[data-approval-target=\"true\"]")).toBeFocused()
})

for (const jobId of ["job-1", "job-off-page"]) {
  test(`selects and focuses ${jobId} through an in-shell approval link`, async ({ page }) => {
    await page.goto("/#missing/page")
    const dashboard = await page.request.get("/v1/dashboard")
    expect(await dashboard.text()).not.toContain("job-off-page")
    await page.evaluate((jobId) => {
      const link = document.createElement("a")
      link.href = `/?tab=approvals&approvalHost=hub&approvalJob=${jobId}`
      link.id = "incoming-approval"
      link.textContent = "Open exact approval"
      document.querySelector(".superapp-main")?.prepend(link)
    }, jobId)
    const fetchedTarget = jobId === "job-off-page"
      ? page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === "/v1/pending-approval" &&
          url.searchParams.get("host") === "hub" && url.searchParams.get("jobId") === jobId
      })
      : null
    await page.locator("#incoming-approval").click()
    if (fetchedTarget !== null) expect((await fetchedTarget).status()).toBe(200)
    expect(new URL(page.url()).hash).toBe("#fleet/approvals")
    expect(new URL(page.url()).searchParams.get("approvalJob")).toBe(jobId)
    await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toHaveAttribute("aria-selected", "true")
    const target = page.locator("[data-approval-target=\"true\"]")
    await expect(target).toHaveCount(1)
    await expect(target).toHaveAttribute("data-approval-job", jobId)
    await expect(target).toBeFocused()
  })
}

test("restores useful focus when Back closes a Connect handoff stage", async ({ page }) => {
  await page.goto("/#fleet/connect")
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await expect(page.locator("#connect-agent-search")).toBeVisible()
  // A same-origin incoming handoff is outside the product's own selection links.
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "/connect/?agent=agent-1&host=hub&open=stage"
    link.id = "incoming-handoff"
    link.textContent = "Open agent stage"
    document.querySelector(".superapp-main")?.prepend(link)
  })
  await page.locator("#incoming-handoff").click()
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toHaveCount(0)
  // The retained owner returns to the URL-selected row through Sheet's cleanup, without a remount.
  await expect(page.locator(".connect-agent[data-agent-key=\"hub:agent-1\"]")).toBeFocused()
  await expect(page.locator("#connect-agent-search")).toBeVisible()
})

/** A vanished URL-selected row falls back to the page, never a detached modal opener. */
test("a URL-owned stage returns to the page when its agent disappears", async ({ page }) => {
  await page.clock.install()
  await page.goto("/?host=hub&agent=agent-1&open=stage#connect/overview")
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  await page.route(
    "**/v1/connect/agents*",
    (route) => route.fulfill({ json: { agents: [], failures: [], hosts: ["hub"], nextCursor: null } })
  )
  await page.clock.runFor(5_100)
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toHaveCount(0)
  await expect(page.locator("#main")).toBeFocused()
  const history = await page.evaluate(() => window.history.length)
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(await page.evaluate(() => window.history.length)).toBe(history)
})

/** Modal cleanup from a hidden, vanished agent cannot redirect the next local stage's return focus. */
test("a vanished inactive URL stage does not change the next row opener", async ({ page }, info) => {
  await page.clock.install()
  let removed = false
  await page.route("**/v1/connect/agents*", (route) =>
    route.fulfill({
      json: {
        agents: [
          ...(removed
            ? []
            : [{
              id: "agent-1",
              host: "hub",
              name: "Agent",
              kind: "test",
              state: "working",
              work: "npm",
              lastActivityAt: 0
            }]),
          {
            id: "agent-2",
            host: "hub",
            name: "Other agent",
            kind: "test",
            state: "working",
            work: "npm",
            lastActivityAt: 0
          }
        ],
        failures: [],
        nextCursor: null
      }
    }))
  await page.goto("/?host=hub&agent=agent-1&open=stage#connect/overview")
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.location.hash = "#fleet/work"
  })
  await expect(page.locator("[data-module=\"fleet\"]")).toBeVisible()
  removed = true
  await page.clock.runFor(5_100)
  await page.evaluate(() => {
    window.location.hash = "#connect/overview"
  })
  const row = page.locator(".connect-agent[data-agent-key=\"hub:agent-2\"]")
  await expect(row).toBeVisible()
  await page.clock.runFor(50)
  await row.click()
  const stage = page.getByRole("dialog", { name: "Other agent", exact: true })
  await expect(stage).toBeVisible()
  await stage.getByRole("button", { name: info.project.name === "phone" ? "Back to Connect" : "Close", exact: true })
    .click()
  await expect(stage).toHaveCount(0)
  await page.clock.runFor(50)
  await expect(row).toBeFocused()
})

test("opens the exact Work goal, hands off to embedded Connect, and goes Back", async ({ page }) => {
  await page.goto("/?tab=work&goal=goal-1")
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toBeFocused()
  await expect(page.getByRole("heading", { name: "Check the module navigation", exact: true })).toBeVisible()
  await page.getByRole("link", { name: /Open .* in Connect/ }).click()
  await expect(page.locator("[data-module=\"connect\"]")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#connect/overview")
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("agent")).toBe("agent-1")
  expect(new URL(page.url()).searchParams.get("host")).toBe("hub")
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Goal details", exact: true })).toBeFocused()
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toHaveAttribute("aria-selected", "true")
  expect(new URL(page.url()).searchParams.get("goal")).toBe("goal-1")
  await expect(page.getByRole("heading", { name: "Check the module navigation", exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".superapp-shell")).not.toHaveAttribute("aria-hidden", "true")
  await expect(page.locator(".superapp-shell")).not.toHaveAttribute("inert")
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe("hidden")
  await page.goForward()
  const stage = page.getByRole("dialog", { name: "Agent", exact: true })
  await expect(stage).toBeVisible()
  await expect.poll(() => stage.evaluate((element) => element.contains(document.activeElement))).toBe(true)
})

test("keeps the standalone Connect stage link working", async ({ page }) => {
  await page.goto("/connect/?agent=agent-1&host=hub&open=stage")
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/connect/")
  await expect(page.locator(".superapp-shell")).toHaveCount(0)
})

test("mounts one Relay launcher and conversation across every page", async ({ page }) => {
  const before = Number(await page.request.get("/__fixture/relay-subscriptions").then((response) => response.text()))
  await page.goto("/")
  const launcher = page.locator("[data-rly-relay-launcher]")
  await expect(launcher).toHaveAccessibleName("Ask Relay")
  await expect(launcher.locator(":scope > span:not([aria-hidden])")).toHaveText(
    "Ask Relay"
  )
  await launcher.click()
  const panel = page.locator("[data-rly-relay-panel]")
  await expect(panel).toHaveCount(1)
  const composer = panel.getByRole("textbox")
  await composer.fill("Keep this draft")
  for (const [destination, label] of fleetPages) {
    await page.evaluate((destination) => {
      window.location.hash = `#fleet/${destination}`
    }, destination)
    await expect(page.getByRole("tab", { name: label, exact: true, includeHidden: true })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await expect(launcher).toHaveCount(1)
    await expect(panel).toHaveCount(1)
    await expect(composer).toHaveValue("Keep this draft")
  }
  for (
    const destination of [
      "connect/overview",
      "code/pull-requests",
      "code/reviews",
      "code/diffs",
      "usage/limits",
      "usage/tokens",
      "usage/by-tool"
    ]
  ) {
    await page.evaluate((destination) => {
      window.location.hash = `#${destination}`
    }, destination)
    await expect.poll(() => new URL(page.url()).hash).toBe(`#${destination}`)
    await expect(launcher).toHaveCount(1)
    await expect(panel).toHaveCount(1)
    await expect(composer).toHaveValue("Keep this draft")
  }
  expect(await page.request.get("/__fixture/relay-subscriptions").then((response) => response.text())).toBe(
    String(before + 1)
  )
})

test("shows a route notice for an unregistered page", async ({ page }) => {
  await page.goto("/#fleet/missing")
  await expect(page.getByText("This page doesn't exist in Relay.", { exact: true })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toHaveCount(0)
  expect(new URL(page.url()).hash).toBe("#fleet/missing")
  await page.getByRole("link", { name: "Back to Connect", exact: true }).click()
  await expect(page.locator("[data-module=\"connect\"]")).toBeVisible()
})

test("keeps focus when selecting a Work window and restores that window on Back", async ({ page }) => {
  await page.goto("/?tab=work&goal=goal-1")
  const previousWeek = page.getByRole("link", { name: "7 days ago", exact: true })
  await previousWeek.focus()
  const historyLength = await page.evaluate(() => window.history.length)
  await previousWeek.click()
  await expect(previousWeek).toBeFocused()
  await expect(previousWeek).toHaveAttribute("aria-current", "page")
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength)
  const workSearch = new URL(page.url()).search
  await page.getByRole("link", { name: /Open .* in Connect/ }).click()
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1)
  await page.goBack()
  await expect(previousWeek).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("heading", { name: "Goal details", exact: true })).toBeFocused()
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toHaveAttribute("aria-selected", "true")
  expect(new URL(page.url()).search).toBe(workSearch)
})

test("keeps Relay summon and Connect search shortcuts", async ({ page }) => {
  await page.goto("/")
  await page.keyboard.press("Control+j")
  await expect(page.locator("[data-rly-relay-panel]")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator("[data-rly-relay-panel]")).toHaveCount(0)
  await page.keyboard.press("Control+k")
  await expect(page.locator("#connect-agent-search")).toBeFocused()
  await page.keyboard.press("Control+j")
  // Home search is not a connected terminal and therefore does not reserve Relay's summon key.
  await expect(page.locator("[data-rly-relay-panel]")).toBeVisible()
})

test("fits the host chrome and opens each shared panel", async ({ page }, info) => {
  await page.goto("/")
  await expect(page.locator(".superapp-shell")).toHaveCount(1)
  const nav = page.getByRole("navigation", {
    name: info.project.name === "phone" ? "Mobile modules" : "Modules",
    exact: true
  })
  await expect(nav).toBeVisible()
  for (const [button, dialog] of sharedPanels) {
    const trigger = await openSharedPanel(page, button)
    await expect(page.getByRole("dialog", { name: dialog, exact: true })).toBeVisible()
    await page
      .getByRole("dialog", { name: dialog, exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click()
    await expect(trigger).toBeFocused()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0
  )
})

/** The Home header owns navigation only; each close route restores the exact directory position. */
test("Home stage header has one visible close control and restores scroll and focus", async ({ page }, info) => {
  const reading = connectFixture(1_791_721_200_000, "ready")
  const agents = Array.from({ length: 5 }, (_, index) =>
    reading.agents.map((agent) => {
      const copy = { ...agent, id: `${agent.id}-${index}` }
      return agent.relationship === undefined ? copy : {
        ...copy,
        relationship: { ...agent.relationship, parentAgentId: `${agent.relationship.parentAgentId}-${index}` }
      }
    })).flat()
  const fixture = Schema.decodeUnknownSync(FleetConnectAgentPage)({ ...reading, agents }, { onExcessProperty: "error" })
  await page.route("**/v1/connect/agents", (route) => route.fulfill({ json: fixture }))
  await page.goto("/")
  const rows = page.locator(".connect-home-agent")
  await expect(rows).toHaveCount(45)
  const opener = rows.nth(20)
  await opener.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(0)
  const agentName = await opener.locator(".connect-home-agent-title strong").textContent()
  for (const dismiss of ["control", "escape"]) {
    await opener.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toHaveAccessibleName(agentName ?? "")
    const header = dialog.locator(".connect-home-stage-header")
    await expect(header.getByRole("heading", { level: 2 })).toHaveText(`Connect${agentName ?? ""}`)
    const builtInHeader = dialog.locator(":scope > div:first-child")
    await expect(builtInHeader).toBeHidden()
    expect(
      await builtInHeader.evaluate((element) => {
        const titleId = element.parentElement?.getAttribute("aria-labelledby")
        return titleId !== null && titleId !== undefined && element.contains(document.getElementById(titleId))
      })
    ).toBe(true)
    const body = dialog.locator(".connect-stage")
    await expect(body).toBeVisible()
    expect((await body.boundingBox())?.height).toBeGreaterThan(0)
    const closeName = info.project.name === "phone" ? "Back to Connect" : "Close"
    await expect(header.getByRole("button")).toHaveCount(1)
    const close = header.getByRole("button", { name: closeName, exact: true })
    await expect(close).toBeVisible()
    expect((await header.boundingBox())?.height).toBe(64)
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    if (info.project.name === "phone") {
      expect(bounds?.x).toBe(0)
      expect(bounds?.y).toBe(0)
      expect(bounds?.width).toBe(390)
      expect(bounds?.height).toBe(844)
    } else {
      expect(bounds?.width).toBe(460)
      expect(bounds?.y).toBe(16)
      expect(1280 - (bounds?.x ?? 0) - (bounds?.width ?? 0)).toBe(16)
    }
    if (dismiss === "escape") await page.keyboard.press("Escape")
    else await close.click()
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll)
  }
})

/** Home keeps its document flow while the existing terminal owner temporarily locks that document. */
test("a scrolled Home terminal fills the viewport, reserves summon keys and restores the directory scroll", async ({ page }) => {
  const reading = connectFixture(1_791_721_200_000, "ready")
  const agents = Array.from({ length: 5 }, (_, index) =>
    reading.agents.map((agent) => {
      const copy = { ...agent, id: `${agent.id}-${index}` }
      return agent.relationship === undefined ? copy : {
        ...copy,
        relationship: { ...agent.relationship, parentAgentId: `${agent.relationship.parentAgentId}-${index}` }
      }
    })).flat()
  const fixture = Schema.decodeUnknownSync(FleetConnectAgentPage)({ ...reading, agents }, { onExcessProperty: "error" })
  await page.route("**/v1/connect/agents", (route) => route.fulfill({ json: fixture }))
  const sockets: Array<WebSocketRoute> = []
  await page.routeWebSocket("**/v1/connect/session?*", (socket) => sockets.push(socket))
  await page.goto("/")
  const rows = page.locator(".connect-home-agent")
  await expect(rows).toHaveCount(45)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight))
    .toBeGreaterThan(400)
  const opener = rows.nth(20)
  await opener.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(0)
  await opener.click()
  await page.getByRole("dialog").getByRole("button", { name: "Open terminal", exact: true }).click()
  await expect.poll(() => sockets.length).toBe(1)
  await expect(page.locator(".ghostty-terminal canvas")).toHaveCount(1)
  const socket = sockets[0]
  if (socket === undefined) throw new Error("Missing fixture terminal socket")
  socket.send(JSON.stringify({ type: "terminal.ready" }))
  const terminal = page.locator(".connect-terminal-screen")
  await expect(terminal).toBeVisible()
  await expect(terminal.getByText("connected", { exact: true })).toBeVisible()
  const geometry = await terminal.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const viewport = window.visualViewport
    if (viewport === null) throw new Error("Missing visual viewport")
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      viewportTop: viewport.offsetTop,
      viewportBottom: viewport.offsetTop + viewport.height,
      viewportWidth: viewport.width,
      rootOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow
    }
  })
  expect(geometry.top).toBeCloseTo(geometry.viewportTop, 0)
  expect(geometry.bottom).toBeCloseTo(geometry.viewportBottom, 0)
  expect(geometry.left).toBe(0)
  expect(geometry.right).toBeCloseTo(geometry.viewportWidth, 0)
  expect(geometry.rootOverflow).toBe("hidden")
  expect(geometry.bodyOverflow).toBe("hidden")
  for (const selector of [".superapp-header", ".superapp-sidebar", ".superapp-bottom"]) {
    await expect(page.locator(selector)).toBeHidden()
    await expect(page.locator(selector)).toHaveAttribute("inert", "")
  }
  await expect(page.getByRole("navigation", { name: "Mobile modules", exact: true })).toHaveCount(0)
  expect(
    await terminal.evaluate((element) => element.contains(document.elementFromPoint(innerWidth / 2, innerHeight - 10)))
  ).toBe(true)
  await page.mouse.wheel(0, 300)
  await page.evaluate(() =>
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
  await page.keyboard.press("Control+j")
  await expect(page.locator("[data-rly-relay-panel]")).toHaveCount(0)
  await terminal.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(terminal).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden")
  await expect(opener).toBeFocused()
  await expect(page.getByRole("navigation", { name: /^(Modules|Mobile modules)$/ }).filter({ visible: true }))
    .toBeVisible()
})

test("a terminal connection settles an open Relay panel without leaving an orphan modal", async ({ page }, info) => {
  const sockets: Array<WebSocketRoute> = []
  await page.routeWebSocket("**/v1/connect/session?*", (socket) => sockets.push(socket))
  await page.goto("/")
  await page.locator(".connect-home-agent").first().click()
  await page.getByRole("dialog").getByRole("button", { name: "Open terminal", exact: true }).click()
  await expect.poll(() => sockets.length).toBe(1)
  await expect(page.locator(".ghostty-terminal canvas")).toHaveCount(1)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "Ask Relay", exact: true }).click()
  const panel = page.locator("[data-rly-relay-panel]")
  await expect(panel).toBeVisible()
  const socket = sockets[0]
  if (socket === undefined) throw new Error("Missing fixture terminal socket")
  socket.send(JSON.stringify({ type: "terminal.ready" }))
  const terminal = page.locator(".connect-terminal-screen")
  if (info.project.name === "phone") {
    // The fullscreen Relay modal owns focus: Connect refuses entry rather than stealing it.
    await expect(panel).toBeVisible()
    await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    const refusal = page.locator(".connect-directory-screen .connect-home-failure")
    await expect(refusal).toHaveAttribute("role", "alert")
    await expect(refusal).toHaveText(
      "Couldn’t open Agent’s terminalCouldn’t switch views while another panel has focus. Close it and try again."
    )
    await expect(refusal).not.toContainText(/\b[a-z]+_[a-z_]+\b/)
    await expect(panel.getByRole("button", { name: "Close Relay", exact: true })).toBeVisible()
    await panel.getByRole("button", { name: "Close Relay", exact: true }).click()
    await expect(panel).toBeHidden()
    await expect(refusal).toBeVisible()
    expect(
      await refusal.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      })
    ).toBe(true)
    // Refused entry left Home active. Retry with Relay closed, then the usual Agents exit is reachable.
    await expect(terminal).toBeHidden()
    await page.locator(".connect-home-agent").first().click()
    await page.getByRole("dialog").getByRole("button", { name: "Open terminal", exact: true }).click()
    await expect.poll(() => sockets.length).toBe(2)
    await expect(page.locator(".ghostty-terminal canvas")).toHaveCount(1)
    const retry = sockets[1]
    if (retry === undefined) throw new Error("Missing retry terminal socket")
    retry.send(JSON.stringify({ type: "terminal.ready" }))
    await expect(terminal.getByText("connected", { exact: true })).toBeVisible()
    const exit = terminal.getByRole("button", { name: "Agents", exact: true })
    await expect(exit).toBeVisible()
    await exit.focus()
    await expect(exit).toBeFocused()
  } else {
    await expect(terminal.getByText("connected", { exact: true })).toBeVisible()
    await expect(panel).toBeHidden()
  }
  await terminal.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(page.getByRole("button", { name: "Ask Relay", exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.activeElement?.closest("[hidden], [inert], [aria-hidden=true]"))).toBeNull()
})

test("measures the embedded terminal inset beneath the ordinary 64px design header as tabs scroll", async ({ page }) => {
  await page.goto("/?tab=work&goal=goal-1")
  const tabs = page.getByRole("tablist", { name: "Relay applications", exact: true })
  await expect(tabs).toBeVisible()
  const initial = await tabs.evaluate((element) => {
    const shell = element.closest<HTMLElement>(".fleet-shell")
    const header = document.querySelector(".superapp-header")
    if (shell === null || header === null) throw new Error("Missing embedded shell or header")
    return {
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      headerBottom: header.getBoundingClientRect().bottom,
      headerHeight: header.getBoundingClientRect().height,
      inset: Number.parseFloat(shell.style.getPropertyValue("--fleet-shell-tab-bottom"))
    }
  })
  expect(initial.headerBottom).toBeGreaterThan(0)
  expect(initial.headerHeight).toBe(64)
  expect(initial.top).toBeGreaterThanOrEqual(initial.headerBottom)
  expect(initial.inset).toBeGreaterThan(0)
  expect(initial.inset).toBeCloseTo(initial.bottom, 0)
  await page.evaluate(() => window.scrollTo(0, 200))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect
    .poll(() =>
      tabs.evaluate((element) => {
        const shell = element.closest<HTMLElement>(".fleet-shell")
        if (shell === null) throw new Error("Missing embedded shell")
        const measured = Number.parseFloat(shell.style.getPropertyValue("--fleet-shell-tab-bottom"))
        return Math.abs(measured - Math.max(0, element.getBoundingClientRect().bottom))
      })
    )
    .toBeLessThan(1)
  const headerBottom = await page
    .locator(".superapp-header")
    .evaluate((element) => element.getBoundingClientRect().bottom)
  expect(headerBottom).toBeLessThan(initial.headerBottom)
})

test("keeps the shared panel inside the viewport during entry and exit motion", async ({ page }, info) => {
  const focusWarnings: Array<string> = []
  page.on("console", (message) => {
    if (message.text().includes("Blocked aria-hidden")) focusWarnings.push(message.text())
  })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  const navSelector = info.project.name === "phone" ? ".superapp-bottom" : ".superapp-sidebar"
  await page.locator(`${navSelector} > button`).focus()
  // Sample inside the frame that starts the transition, before a short exit can finish.
  const sample = async (operation: "open" | "close") =>
    page.evaluate(
      async ({ navSelector, operation }) => {
        const trigger = document.querySelector<HTMLElement>(
          operation === "open" ? `${navSelector} > button` : ".superapp-dialog-close"
        )
        if (trigger === null) throw new Error("Missing panel trigger")
        trigger.click()
        const deadline = performance.now() + 2_000
        while (performance.now() < deadline) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
          const element = document.querySelector<HTMLElement>(
            `.superapp-dialog[data-state="${operation === "open" ? "open" : "closed"}"]`
          )
          if (element === null) continue
          const animations = element.getAnimations()
          if (animations.length === 0) continue
          for (const animation of animations) {
            animation.pause()
            const duration = Number(animation.effect?.getTiming().duration)
            if (!Number.isFinite(duration)) throw new Error("Missing panel motion duration")
            animation.currentTime = duration / 2
          }
          if (operation === "close") {
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
          }
          const rect = element.getBoundingClientRect()
          const label = element.getAttribute("aria-labelledby")
          const layer = element.parentElement
          if (layer === null) throw new Error("Missing dialog presence layer")
          const result = {
            focusInside: element.contains(document.activeElement),
            animations: animations.length,
            layerDuration: parseFloat(getComputedStyle(layer).animationDuration),
            surfaceDuration: parseFloat(getComputedStyle(element).animationDuration),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: window.innerWidth,
            height: window.innerHeight,
            title: label === null ? null : (document.getElementById(label)?.textContent ?? null)
          }
          for (const animation of animations) animation.finish()
          return result
        }
        throw new Error("Panel did not start its transition")
      },
      { operation, navSelector }
    )
  const entry = await sample("open")
  expect(entry.animations).toBeGreaterThan(0)
  expect(entry.title).toBe("More")
  expect(entry.left).toBeGreaterThanOrEqual(0)
  expect(entry.right).toBeLessThanOrEqual(entry.width)
  expect(entry.top).toBeGreaterThanOrEqual(0)
  expect(entry.bottom).toBeLessThanOrEqual(entry.height)
  // Export 41 centres Settings on desktop; phone More remains flush with the viewport.
  if (info.project.name === "desktop") expect(entry.left).toBeCloseTo(entry.width - entry.right, 0)
  else expect(entry.right).toBeCloseTo(entry.width, 0)
  const exit = await sample("close")
  expect(exit.animations).toBeGreaterThan(0)
  expect(exit.layerDuration).toBeGreaterThanOrEqual(exit.surfaceDuration)
  expect(exit.title).toBe("More")
  expect(exit.focusInside).toBe(true)
  expect(exit.left).toBeGreaterThanOrEqual(0)
  expect(exit.right).toBeLessThanOrEqual(exit.width)
  expect(exit.top).toBeGreaterThanOrEqual(0)
  expect(exit.bottom).toBeLessThanOrEqual(exit.height)
  if (info.project.name === "desktop") expect(exit.left).toBeCloseTo(exit.width - exit.right, 0)
  else expect(exit.right).toBeCloseTo(exit.width, 0)
  await expect(page.locator(".superapp-dialog")).toHaveCount(0)
  await expect(page.locator(`${navSelector} > button`)).toBeFocused()
  // Let a real close run to completion too; finishing the sampled animation can hide early focus restoration.
  await page.locator(`${navSelector} > button`).click()
  await expect(page.getByRole("dialog", { name: "More", exact: true })).toBeVisible()
  await page
    .getByRole("dialog", { name: "More", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click()
  await expect(page.locator(".superapp-dialog")).toHaveCount(0)
  await expect(page.locator(`${navSelector} > button`)).toBeFocused()
  await page.locator(`${navSelector} > button`).click()
  await expect(page.getByRole("dialog", { name: "More", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator(".superapp-dialog")).toHaveCount(0)
  await expect(page.locator(`${navSelector} > button`)).toBeFocused()
  expect(focusWarnings).toEqual([])
})

test("keeps the noncanonical listener's existing dashboard", async ({ page }) => {
  await page.goto("/?noncanonical")
  await expect(page.locator(".app")).toBeVisible()
  await expect(page.locator(".superapp-shell")).toHaveCount(0)
})

/** Export 41 centres desktop Settings; phone More ends at the installed bar rather than covering it. */
test("More matches the installed Settings geometry", async ({ page }, info) => {
  await page.goto("/")
  const opener = moreOpener(page)
  await opener.click()
  const more = page.getByRole("dialog", { name: "More", exact: true })
  await expect(more).toBeVisible()
  const geometry = await more.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const bar = document.querySelector(".superapp-bottom")?.getBoundingClientRect()
    const heading = element.querySelector("h2")
    const rows = [...element.querySelectorAll(".superapp-more section > button")]
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      bottom: box.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      barTop: bar?.top,
      headingSize: heading === null ? null : getComputedStyle(heading).fontSize,
      closeGlyph: element.querySelector(".superapp-dialog-close svg")?.getBoundingClientRect().width,
      rows: rows.map((row) => ({ height: row.getBoundingClientRect().height, font: getComputedStyle(row).fontSize })),
      grab: getComputedStyle(element, "::before").content
    }
  })
  expect(geometry.headingSize).toBe("20px")
  expect(geometry.closeGlyph).toBe(16)
  expect(geometry.rows).toEqual([{ height: 48, font: "15px" }, { height: 48, font: "15px" }])
  if (info.project.name === "phone") {
    expect(geometry.left).toBe(0)
    expect(geometry.width).toBe(390)
    expect(geometry.bottom).toBe(geometry.barTop)
    expect(geometry.grab).toBe("\"\"")
  } else {
    expect(geometry.width).toBe(420)
    expect(geometry.left + geometry.width / 2).toBeCloseTo(geometry.viewportWidth / 2)
    expect(geometry.top + geometry.height / 2).toBeCloseTo(geometry.viewportHeight / 2)
    await expect(page.locator(".superapp-settings")).toHaveAttribute("aria-expanded", "true")
  }
  await page.keyboard.press("Escape")
  await expect(opener).toBeFocused()
})

/** The fixture must preload exactly the Geist faces production serves before optional font display chooses a fallback. */
test("the built shell fixture includes the production font preloads", async ({ page }) => {
  await page.goto("/")
  const fonts = page.locator("head link[rel=\"preload\"][as=\"font\"]")
  await expect(fonts).toHaveCount(2)
  for (const font of await fonts.all()) await expect(font).toHaveAttribute("crossorigin", "")
  const hrefs = await fonts.evaluateAll((elements) => elements.map((element) => element.getAttribute("href")))
  expect(hrefs).toEqual(["/assets/geist-latin-wght-normal.woff2", "/assets/geist-mono-latin-wght-normal.woff2"])
})

/** Design rule 45: the phone header names the product and one line under it names module and page. */
test("phone breadcrumb names the module and page under a product header", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Phone breadcrumb")
  for (
    const { crumb, route } of [
      { route: "fleet/approvals", crumb: "Fleet / Approvals" },
      { route: "fleet/work", crumb: "Fleet / Work" },
      { route: "usage/limits", crumb: "Usage / Limits" },
      { route: "usage/tokens", crumb: "Usage / Tokens" },
      { route: "usage/by-tool", crumb: "Usage / By tool" },
      { route: "code/pull-requests", crumb: "Code / Pull requests" },
      { route: "connect/overview", crumb: "Connect" }
    ]
  ) {
    await page.goto(`/#${route}`)
    await expect(page.locator(".superapp-phone-title")).toHaveText("Relay")
    const line = page.locator(".superapp-breadcrumb")
    await expect(line).toBeVisible()
    await expect(line).toHaveText(crumb, { useInnerText: true })
    const geometry = await line.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      top: element.getBoundingClientRect().top,
      headerBottom: document.querySelector(".superapp-header")?.getBoundingClientRect().bottom,
      position: getComputedStyle(element).position,
      background: getComputedStyle(element).backgroundColor,
      canvas: (() => {
        const shell = document.querySelector(".superapp-shell")
        return shell === null ? null : getComputedStyle(shell).backgroundColor
      })()
    }))
    expect(geometry.height).toBeLessThanOrEqual(32)
    expect(geometry.top).toBe(geometry.headerBottom)
    // In flow, so it scrolls away with the page; never pinned.
    expect(["sticky", "fixed"]).not.toContain(geometry.position)
    // Opaque canvas over main's top edge, as the header is on desktop: the page-arrival focus ring stays covered.
    expect(geometry.canvas).not.toBeNull()
    expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)")
    expect(geometry.background).toBe(geometry.canvas)
  }
  await page.goto("/#nowhere/at-all")
  await expect(page.locator(".superapp-breadcrumb")).toBeHidden()
})

/** A page that draws its own breadcrumb (the review canvas does) owns that line: the shell's stays hidden. */
test("phone breadcrumb yields to a page's own breadcrumb", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Phone breadcrumb")
  await page.goto("/#code/pull-requests")
  const line = page.locator(".superapp-breadcrumb")
  await expect(line).toBeVisible()
  // The fixture serves no canvas: stand in for its header with the same landmark inside the shown module.
  await page.locator("[data-module=\"code\"]:not([hidden])").evaluate((module) => {
    const nav = document.createElement("nav")
    nav.setAttribute("aria-label", "Breadcrumb")
    nav.dataset.testOwnCrumb = ""
    nav.textContent = "Code / Review"
    module.prepend(nav)
  })
  await expect(line).toBeHidden()
  await page.locator("[data-test-own-crumb]").evaluate((nav) => nav.remove())
  await expect(line).toBeVisible()
})

/** Arrival focus on a cold load lands on the page without a ring nobody asked for; the next Tab shows one. */
test("cold-load arrival focus paints no focus ring until the keyboard is used", async ({ page }) => {
  await page.goto("/#fleet/approvals")
  const tab = page.getByRole("tab", { name: "Approvals", exact: true })
  await expect(tab).toBeFocused()
  expect(await tab.evaluate((element) => element.matches(":focus-visible"))).toBe(false)
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(true)
})

/** The Fleet heading shows at every width (design rule 45 refs) and stays outside the tab order. */
test("Fleet heading is visible at every width and remains outside the tab order", async ({ page }) => {
  await page.goto("/#fleet/approvals")
  const heading = page.locator("[data-module=\"fleet\"] .superapp-module-heading")
  await expect(heading).toHaveCount(1)
  const metrics = await heading.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return {
      width: box.width,
      height: box.height,
      tabIndex: element.tabIndex,
      focusable: element.querySelectorAll("a,button,input,select,textarea,[tabindex=\"0\"]").length
    }
  })
  expect(metrics.tabIndex).toBe(-1)
  expect(metrics.focusable).toBe(0)
  expect(metrics.width).toBeGreaterThan(1)
  expect(metrics.height).toBeGreaterThan(1)
})

/** Presentation locks follow visibility; the terminal worker remains owned until the active surface leaves. */
for (const readyWhileHidden of [false, true]) {
  test(`a retained terminal releases hidden locks and restores guarded focus, ready while hidden=${String(readyWhileHidden)}`, async ({ page }) => {
    const sockets: Array<WebSocketRoute> = []
    let closed = 0
    await page.routeWebSocket("**/v1/connect/session?*", (socket) => {
      sockets.push(socket)
      socket.onClose(() => {
        closed += 1
      })
    })
    await page.goto("/#fleet/work")
    await page.locator(".superapp-sidebar, .superapp-bottom").filter({ visible: true })
      .getByRole("link", { name: "Connect", exact: true }).click()
    await page.locator(".connect-home-agent").first().click()
    await page.getByRole("dialog").getByRole("button", { name: "Open terminal", exact: true }).click()
    await expect.poll(() => sockets.length).toBe(1)
    await expect(page.locator(".ghostty-terminal canvas")).toHaveCount(1)
    const socket = sockets[0]
    if (socket === undefined) throw new Error("Missing fixture socket")
    if (!readyWhileHidden) {
      socket.send(JSON.stringify({ type: "terminal.ready" }))
      await expect(page.locator(".connect-terminal-screen")).toBeVisible()
    }
    await page.goBack()
    await expect(page.locator("[data-module=\"fleet\"]")).toBeVisible()
    if (readyWhileHidden) socket.send(JSON.stringify({ type: "terminal.ready" }))
    await expect.poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("connect-terminal-document-lock"))
    )
      .toBe(false)
    await page.evaluate(() => {
      const module = document.querySelector("[data-module=\"fleet\"]")
      const probe = document.createElement("div")
      probe.style.blockSize = "2000px"
      module?.append(probe)
    })
    await page.mouse.wheel(0, 300)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    expect(closed).toBe(0)
    await page.goForward()
    const terminal = page.locator(".connect-terminal-screen")
    await expect(terminal).toBeVisible()
    await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.classList.contains("connect-terminal-document-lock")))
      .toBe(true)
    expect(sockets).toHaveLength(1)
    expect(closed).toBe(0)
    await terminal.getByRole("button", { name: "Agents", exact: true }).click()
    await page.locator(".superapp-sidebar, .superapp-bottom").filter({ visible: true })
      .getByRole("link", { name: "Usage", exact: true }).click()
    // The Limits tab sits in the header outlet Usage owns.
    await expect(page.locator("[data-module-owner=\"usage\"] [data-module-page=\"limits\"]")).toBeFocused()
  })
}

/** Archive replaces Active, releasing its terminal ownership rather than leaving a connected shell predicate. */
test("Back from a terminal to Archived restores chrome and Relay keys", async ({ page }) => {
  const sockets: Array<WebSocketRoute> = []
  await page.routeWebSocket("**/v1/connect/session?*", (socket) => sockets.push(socket))
  await page.goto("/?view=archived#connect/overview")
  await page.getByRole("navigation", { name: "Agent directory view" }).getByRole("link", {
    name: "Active",
    exact: true
  }).click()
  await page.locator(".connect-home-agent").first().click()
  await page.getByRole("dialog").getByRole("button", { name: "Open terminal", exact: true }).click()
  await expect.poll(() => sockets.length).toBe(1)
  await expect(page.locator(".ghostty-terminal canvas")).toHaveCount(1)
  const socket = sockets[0]
  if (socket === undefined) throw new Error("Missing fixture socket")
  socket.send(JSON.stringify({ type: "terminal.ready" }))
  await expect(page.locator(".connect-terminal-screen")).toBeVisible()
  await page.goBack()
  await expect(page.locator(".connect-home-archive")).toBeVisible()
  await expect(page.locator(".superapp-header")).toBeVisible()
  await expect(page.locator(".superapp-header")).not.toHaveAttribute("inert", "")
  await page.keyboard.press("Control+j")
  await expect(page.locator("[data-rly-relay-panel]")).toBeVisible()
})

/** Selector removal is a replace within one owner; host casing does not change its close contract. */
for (const urlHost of ["hub", "HuB"]) {
  test(
    `closing a URL-selected Home stage preserves its owner and makes reload stay closed, host=${urlHost}`,
    async ({ page }, info) => {
      const entry = `/?host=${urlHost}&agent=agent-1&open=stage#connect/overview`
      await page.goto(entry)
      await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
      await page.evaluate(() => document.querySelector(".connect-shell")?.setAttribute("data-owner-probe", "kept"))
      const historyLength = await page.evaluate(() => window.history.length)
      await page.getByRole("dialog").getByRole("button", {
        name: info.project.name === "phone" ? "Back to Connect" : "Close",
        exact: true
      }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      for (const key of ["host", "agent", "open"]) expect(new URL(page.url()).searchParams.has(key)).toBe(false)
      await expect(page.locator(".connect-shell")).toHaveAttribute("data-owner-probe", "kept")
      expect(await page.evaluate(() => window.history.length)).toBe(historyLength)
      await expect(page.locator(".connect-agent[data-agent-key=\"hub:agent-1\"]")).toBeFocused()
      await page.reload()
      await expect(page.locator(".connect-home-agent")).not.toHaveCount(0)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.evaluate((href) => {
        const link = document.createElement("a")
        link.href = href
        document.body.append(link)
        link.click()
        link.remove()
      }, entry)
      await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
      await page.getByRole("dialog").getByRole("button", {
        name: info.project.name === "phone" ? "Back to Connect" : "Close",
        exact: true
      }).click()
      expect(new URL(page.url()).searchParams.has("open")).toBe(false)
      await page.goBack()
      await expect(page.getByRole("dialog")).toHaveCount(0)
    }
  )
}

/** Query changes outside the normalized selection cannot dispose a working terminal or create a new socket. */
test("a direct terminal keeps its socket across unrelated queries and host casing", async ({ page }) => {
  const sockets: Array<WebSocketRoute> = []
  let closed = 0
  await page.routeWebSocket("**/v1/connect/session?*", (socket) => {
    sockets.push(socket)
    socket.onClose(() => {
      closed += 1
    })
  })
  await page.goto("/?host=hub&agent=agent-1#connect/overview")
  await expect.poll(() => sockets.length).toBe(1)
  await expect(page.locator(".ghostty-terminal canvas")).toHaveCount(1)
  const socket = sockets[0]
  if (socket === undefined) throw new Error("Missing fixture terminal socket")
  socket.send(JSON.stringify({ type: "terminal.ready" }))
  await expect(page.locator(".connect-terminal-screen")).toBeVisible()
  const canvas = await page.locator(".ghostty-terminal canvas").elementHandle()
  expect(canvas).not.toBeNull()
  for (const host of ["hub", "HuB"]) {
    await page.evaluate((host) => {
      const href = new URL(window.location.href)
      href.searchParams.set("keep", host)
      href.searchParams.set("host", host)
      const link = document.createElement("a")
      link.href = href.href
      document.body.append(link)
      link.click()
      link.remove()
    }, host)
    await expect.poll(() => new URL(page.url()).searchParams.get("keep")).toBe(host)
    await page.evaluate(() =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await expect(page.locator(".connect-terminal-screen")).toBeVisible()
    expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true)
    expect(sockets).toHaveLength(1)
    expect(closed).toBe(0)
  }
})

/** Standalone uses the same replace-close mode without creating a shell entry or reopening on Back. */
test("standalone URL-selected stage close replaces its selectors before Back", async ({ page }) => {
  await page.goto("/#fleet/work")
  await page.goto("/connect/?host=hub&agent=agent-1&open=stage")
  const dialog = page.getByRole("dialog", { name: "Agent", exact: true })
  await expect(dialog).toBeVisible()
  const length = await page.evaluate(() => window.history.length)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => window.history.length)).toBe(length)
  for (const key of ["host", "agent", "open"]) expect(new URL(page.url()).searchParams.has(key)).toBe(false)
  await expect(page.locator(".connect-agent[data-agent-key=\"hub:agent-1\"]")).toBeFocused()
  await page.goBack()
  expect(new URL(page.url()).hash).toBe("#fleet/work")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

/**
 * The Usage Limits design places every sidebar row at the same glyph column: 19px glyphs for primary modules,
 * 17px for secondary modules and Settings, a 12px gap to the label, and the Relay wordmark as its own line box.
 * Host resources draws the design's `host` chip glyph.
 */
test("sidebar rows, Settings and the wordmark follow the design geometry", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/#fleet/approvals")
  await page.evaluate(() => document.fonts.ready)
  const sidebar = page.locator(".superapp-sidebar")
  await expect(sidebar.getByRole("link", { name: "Host resources" })).toBeVisible()
  const geometry = await sidebar.evaluate((element) => {
    const box = (node: Element | Range | null | undefined) => {
      const rect = node?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const label = (row: Element) => {
      const range = document.createRange()
      const text = [...row.childNodes].find((node) => (node.textContent ?? "").trim() !== "" && node.nodeName !== "svg")
      if (text === undefined) return null
      range.selectNodeContents(text)
      return box(range)
    }
    const rows = [...element.querySelectorAll(".superapp-module-nav > a, .superapp-settings")].map((row) => ({
      name: (row.querySelector(":scope > span") ?? row).textContent?.trim() ?? "",
      secondary: row.hasAttribute("data-secondary") || row.classList.contains("superapp-settings"),
      glyph: box(row.querySelector("svg")),
      label: label(row)
    }))
    const resources = element.querySelector("a[aria-label=\"Host resources\"] svg path")?.getAttribute("d")
    const sandboxes = element.querySelector("a[aria-label=\"Sandboxes\"] svg path")?.getAttribute("d")
    return {
      rows,
      resources,
      sandboxes,
      wordmark: box(element.querySelector(".superapp-sidebar-brand strong")),
      weight: getComputedStyle(element.querySelector(".superapp-module-nav") ?? element).fontWeight
    }
  })
  expect(geometry.rows.map((row) => row.name)).toEqual([
    "Connect",
    "Fleet",
    "Code",
    "Usage",
    "Host resources",
    "Sandboxes",
    "Stacks",
    "Settings"
  ])
  for (const row of geometry.rows) {
    const size = row.secondary ? 17 : 19
    expect(row.glyph, row.name).toMatchObject({ width: size, height: size })
    expect(row.glyph?.x, row.name).toBeCloseTo(27.2, 1)
    expect(row.label?.x, row.name).toBeCloseTo(27.2 + size + 12, 1)
  }
  expect(geometry.sandboxes).toBe("m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5l8-3M8 11l3 3 5-6")
  expect(geometry.resources).toBe("M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4")
  expect(geometry.wordmark?.x).toBeCloseTo(65.6, 1)
  expect(geometry.wordmark?.y).toBeCloseTo(31.52, 1)
  expect(geometry.wordmark?.height).toBeCloseTo(24.96, 1)
  expect(geometry.weight).toBe("430")
})

/** The phone bar shares the design's 430 navigation text weight outside the empty Usage layout too. */
test("the phone module bar uses the design's navigation text weight", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Phone bar")
  await page.goto("/#fleet/approvals")
  await expect(page.locator(".superapp-bottom")).toHaveCSS("font-weight", "430")
})

test("a hub without the sandbox pool leaves the Sandboxes row out", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/?nosandboxes#fleet/approvals")
  const sidebar = page.locator(".superapp-sidebar")
  await expect(sidebar.getByRole("link", { name: "Stacks" })).toBeVisible()
  await expect(sidebar.getByRole("link", { name: "Sandboxes" })).toHaveCount(0)
})

test("the Sandboxes row opens the pool read-only", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/#fleet/approvals")
  await page.locator(".superapp-sidebar").getByRole("link", { name: "Sandboxes" }).click()
  await expect(page).toHaveURL(/#sandboxes\/overview$/)
  await expect(page.getByRole("heading", { level: 1, name: "Sandboxes" })).toBeVisible()
  await expect(page.locator("[data-account]")).toHaveCount(2)
  await expect(page.getByText("Only the owner can lease or reset sandboxes here. Agents lease through Fleet jobs."))
    .toBeVisible()
  await expect(page.getByRole("button", { name: "Lease an account" })).toHaveCount(0)
})
