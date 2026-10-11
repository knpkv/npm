import { expect, test } from "@playwright/test"

const fleetPages: ReadonlyArray<readonly [string, string]> = [
  ["work", "Work"],
  ["usage", "Usage"],
  ["connect", "Connect"],
  ["approvals", "Approvals"]
]
const sharedPanels: ReadonlyArray<readonly [string, string]> = [
  ["All modules", "Your modules"],
  ["Notifications", "Notifications"],
  ["1 host configured: hub", "Hosts"]
]

const motionPreferences: ReadonlyArray<"no-preference" | "reduce"> = ["no-preference", "reduce"]
for (const reducedMotion of motionPreferences) {
  test(`keeps focus on the destination after a real module-picker navigation finishes closing with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    await page.goto("/#missing/page")
    await page.getByRole("button", { name: "All modules", exact: true }).click()
    const picker = page.getByRole("dialog", { name: "Your modules", exact: true })
    await picker.getByRole("link", { name: "Fleet Approvals, Connect, Work, Usage", exact: true }).click()
    await expect(picker).toHaveCount(0)
    await page.evaluate(() =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toBeFocused()
    expect(new URL(page.url()).hash).toBe("#fleet/approvals")
  })
}

test("restores the opener after navigation close is cancelled by reopening the picker", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/#missing/page")
  const opener = page.getByRole("button", { name: "All modules", exact: true })
  await opener.click()
  const picker = page.getByRole("dialog", { name: "Your modules", exact: true })
  await picker.evaluate((node) => {
    const link = node.querySelector<HTMLAnchorElement>("a[href*=\"#fleet/\"]")
    const trigger = document.querySelector<HTMLButtonElement>(".superapp-sidebar > button")
    if (link === null || trigger === null) throw new Error("Picker actions missing")
    return new Promise<void>((resolve, reject) => {
      link.click()
      requestAnimationFrame(() => {
        const layer = document.querySelector<HTMLElement>("[data-rly-dialog-layer]")
        if (layer?.dataset.state !== "closed") {
          reject(new Error("Navigation did not start closing"))
          return
        }
        trigger.click()
        requestAnimationFrame(() => resolve())
      })
    })
  })
  await expect(page.locator("[data-rly-dialog-layer][data-state=\"open\"]")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
  await expect(opener).toBeFocused()
  await page.evaluate(() =>
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  await expect(opener).toBeFocused()
})

test("returns focus to the picker opener when choosing the already-current module", async ({ page }) => {
  await page.goto("/#fleet/work")
  const opener = page.getByRole("button", { name: "All modules", exact: true })
  await opener.click()
  const picker = page.getByRole("dialog", { name: "Your modules", exact: true })
  await picker.getByRole("link", { name: "Fleet Approvals, Connect, Work, Usage", exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(opener).toBeFocused()
  expect(new URL(page.url()).hash).toBe("#fleet/work")
})

test("keeps later route focus working after shortcuts cancel a picker navigation restoration", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/#missing/page")
  await page.getByRole("button", { name: "All modules", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Your modules", exact: true })
  await page.evaluate(() => {
    const focus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function(this: HTMLElement, options?: FocusOptions): void {
      const dialog = document.querySelector("[role=\"dialog\"][data-state=\"open\"]")
      if (dialog !== null && !dialog.contains(this)) document.body.dataset.outsideModalFocus = "attempted"
      focus.call(this, options)
    }
  })
  await picker.evaluate((node) => {
    const link = node.querySelector<HTMLAnchorElement>("a[href*=\"#fleet/\"]")
    if (link === null) throw new Error("Picker link missing")
    return new Promise<void>((resolve) => {
      link.click()
      requestAnimationFrame(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "?" }))
        requestAnimationFrame(() => resolve())
      })
    })
  })
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true })
  await expect(shortcuts).toBeVisible()
  await expect(picker).toHaveCount(0)
  await expect.poll(() => shortcuts.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await page.evaluate(() =>
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  expect(await page.locator("body").getAttribute("data-outside-modal-focus")).toBeNull()
  const opener = await shortcuts.evaluate(() => document.activeElement?.textContent)
  expect(opener).toBe("Close")
  await page.keyboard.press("Escape")
  await expect(shortcuts).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toBeFocused()
  await page.getByRole("tab", { name: "Work", exact: true }).click()
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "?tab=connect"
    link.textContent = "Open Connect directory"
    document.querySelector("[data-module=\"fleet\"]")?.prepend(link)
  })
  await page.getByRole("link", { name: "Open Connect directory", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Connect", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "Connect", exact: true })).toBeFocused()
  await page.keyboard.press("?")
  await expect(shortcuts).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(shortcuts).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Connect", exact: true })).toBeFocused()
})

test("keeps shared panel headings clear of the close target at the narrowest phone width", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Narrow phone panels")
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto("/#fleet/work")
  for (const [button, title] of sharedPanels) {
    await page.getByRole("button", { name: button, exact: true }).click()
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
    const launcherPose = page.locator("[data-rly-relay-avatar=\"launcher\"] [data-relay-phase]")
    await expect(launcherPose).toHaveAttribute("data-relay-phase", phase === "listening" ? "idle" : phase)
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

test(
  "keeps module and page names readable beside an active Relay at tablet and desktop widths",
  async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "Desktop header allocation")
    for (const width of [768, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto("/?relayFixture=needs-you#fleet/work")
      const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb", exact: true })
      await expect(breadcrumb).toBeVisible()
      await expect(page.locator(".superapp-host")).toHaveAccessibleName("1 host configured: hub")
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      for (const open of [false, true]) {
        if (open) await page.getByRole("button", { name: "Ask Relay", exact: true }).click()
        const textFits = await breadcrumb.evaluate((node) => {
          const labels = [node.querySelector("a > span"), node.querySelector("[aria-current=\"page\"]")]
          return labels.map((label) => {
            if (label === null) throw new Error("Module or page label missing")
            const text = document.createElement("span")
            text.textContent = label.textContent
            text.style.cssText =
              "position:absolute;inline-size:max-content;white-space:pre;visibility:hidden;font:inherit"
            label.append(text)
            const content = text.getBoundingClientRect().width
            text.remove()
            return { width: label.getBoundingClientRect().width, content }
          })
        })
        for (const label of textFits) {
          expect(label.width).toBeGreaterThan(0)
          expect(label.width).toBeGreaterThanOrEqual(label.content)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      }
    }
  }
)

test(
  "sizes the shared character and keeps its motion and forced-colour behavior across launcher, panel and turns",
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
        node: launcher.locator("[data-rly-relay-avatar=\"launcher\"] svg"),
        size: info.project.name === "phone" ? 28 : 20
      },
      { node: panel.locator("[data-rly-relay-avatar=\"panel\"] svg"), size: 32 }
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
    for (const node of [slots[0]?.node, slots[1]?.node, ...(await turns.all())]) {
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
  await expect(page.locator("[data-module=\"today\"]")).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#main")
  await expect(page.getByText("This page doesn't exist in Relay.", { exact: true })).toHaveCount(0)
})

test("keeps the phone breadcrumb below the launcher, scrolls it away and hides it in Ask Relay", async ({
  page
}, info) => {
  test.skip(info.project.name !== "phone", "Phone breadcrumb layout")
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/#fleet/work")
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb", exact: true })
    await expect(breadcrumb).toBeVisible()
    await expect(breadcrumb.getByRole("link", { name: "Fleet", exact: true })).toBeVisible()
    await expect(breadcrumb.locator("[aria-current=\"page\"]")).toHaveText("Work")
    const geometry = await breadcrumb.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      const launcher = document.querySelector("[data-rly-relay-launcher]")?.getBoundingClientRect()
      return { height: bounds.height, top: bounds.top, launcherBottom: launcher?.bottom ?? 0 }
    })
    expect(geometry.height).toBeGreaterThan(0)
    expect(geometry.height).toBeLessThanOrEqual(32)
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.launcherBottom)
    const hitArea = await breadcrumb.getByRole("link", { name: "Fleet", exact: true }).evaluate((link) => {
      const bounds = link.getBoundingClientRect()
      const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.bottom + 6)
      return { expanded: target === link || link.contains(target), coarse: matchMedia("(pointer: coarse)").matches }
    })
    expect(hitArea.coarse).toBe(true)
    expect(hitArea.expanded).toBe(true)
    const chrome = await page.evaluate(() => {
      const read = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)
        if (node === null) throw new Error(`Missing phone chrome ${selector}`)
        const style = getComputedStyle(node)
        return {
          size: parseFloat(style.fontSize),
          line: parseFloat(style.lineHeight),
          weight: style.fontWeight,
          height: node.getBoundingClientRect().height
        }
      }
      return {
        host: read(".superapp-host"),
        nav: read(".superapp-bottom a"),
        crumb: read(".superapp-breadcrumb"),
        body: read(".superapp-main")
      }
    })
    expect(chrome.host).toEqual({ size: 11, line: 13.2, weight: "430", height: 44 })
    expect(chrome.nav).toEqual({ size: 11, line: 16.5, weight: "600", height: 52 })
    expect(chrome.crumb.line).toBeCloseTo(15.6, 1)
    expect(chrome.body.size).toBe(16)
    // The design's narrow specimen exercises overflow without changing the page route.
    const truncated = await breadcrumb.evaluate((node) => {
      node.style.inlineSize = "140px"
      const current = node.querySelector<HTMLElement>("[aria-current=\"page\"]")
      if (current === null) throw new Error("Breadcrumb current page missing")
      const text = current.querySelector("bdi")
      if (text === null) throw new Error("Breadcrumb text isolation missing")
      text.textContent = "Storefront release pipeline / Usage (7d)"
      current.title = text.textContent
      const bounds = node.getBoundingClientRect()
      return {
        direction: getComputedStyle(current).direction,
        textDirection: getComputedStyle(text).direction,
        overflow: current.scrollWidth > current.clientWidth,
        title: current.title,
        end: bounds.right,
        viewport: innerWidth
      }
    })
    expect(truncated.direction).toBe("rtl")
    expect(truncated.textDirection).toBe("ltr")
    expect(truncated.overflow).toBe(true)
    expect(truncated.title).toBe("Storefront release pipeline / Usage (7d)")
    expect(truncated.end).toBeLessThanOrEqual(truncated.viewport)
    await page.evaluate(() => window.scrollTo(0, 200))
    await expect.poll(() => breadcrumb.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThan(0)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.locator("[data-rly-relay-launcher]").click()
    await expect(page.locator("[data-rly-relay-panel=\"fullscreen\"]")).toBeVisible()
    await expect(breadcrumb).toBeHidden()
    await page.keyboard.press("Escape")
    await expect(breadcrumb).toBeVisible()
    await breadcrumb.evaluate((node) => {
      node.style.removeProperty("inline-size")
      const current = node.querySelector<HTMLElement>("[aria-current=\"page\"]")
      if (current === null) throw new Error("Breadcrumb current page missing")
      const text = current.querySelector("bdi")
      if (text === null) throw new Error("Breadcrumb text isolation missing")
      text.textContent = "Work"
      current.title = "Work"
    })
  }
})

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
  await page.goto("/?agent=agent-1&host=hub#fleet/connect")
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
  await expect(page.locator("#connect-agent-search")).toBeFocused()
})

test("opens the exact Work goal, hands off to embedded Connect, and goes Back", async ({ page }) => {
  await page.goto("/?tab=work&goal=goal-1")
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toBeFocused()
  await expect(page.getByRole("heading", { name: "Check the module navigation", exact: true })).toBeVisible()
  await page.getByRole("link", { name: /Open .* in Connect/ }).click()
  await expect(page.getByRole("tab", { name: "Connect", exact: true, includeHidden: true })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("agent")).toBe("agent-1")
  expect(new URL(page.url()).searchParams.get("host")).toBe("hub")
  await page.goBack()
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toBeFocused()
  await expect(page.getByRole("heading", { name: "Check the module navigation", exact: true })).toBeVisible()
})

test("keeps the standalone Connect stage link working", async ({ page }) => {
  await page.goto("/connect/?agent=agent-1&host=hub&open=stage")
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/connect/")
  await expect(page.locator(".superapp-shell")).toHaveCount(0)
})

test("mounts one Relay launcher and conversation across every page", async ({ page }, info) => {
  const before = Number(await page.request.get("/__fixture/relay-subscriptions").then((response) => response.text()))
  await page.goto("/")
  const launcher = page.locator("[data-rly-relay-launcher]")
  await expect(launcher).toHaveAccessibleName("Ask Relay")
  await expect(launcher.locator(":scope > span:not([aria-hidden])")).toHaveText(
    info.project.name === "phone" ? "Relay" : "Ask Relay"
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
    const destination of ["today", "code/pull-requests", "code/reviews", "code/diffs", "usage/limits", "usage/tokens"]
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
  await page.getByRole("link", { name: "Back to Today", exact: true }).click()
  await expect(page.locator("[data-module=\"today\"]")).toBeVisible()
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
  await page.getByRole("link", { name: /Open .* in Connect/ }).click()
  await expect(page.getByRole("dialog", { name: "Agent", exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1)
  await page.goBack()
  await expect(previousWeek).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("tab", { name: "Work", exact: true })).toBeFocused()
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
  await expect(page.locator("[data-rly-relay-panel]")).toHaveCount(0)
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
    const trigger = button === "All modules"
      ? nav.getByRole("button", { name: button, exact: true })
      : page.getByRole("button", { name: button, exact: true })
    await trigger.click()
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

test("measures the embedded terminal inset as the header and tabs scroll", async ({ page }, info) => {
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
      inset: Number.parseFloat(shell.style.getPropertyValue("--fleet-shell-tab-bottom"))
    }
  })
  expect(initial.headerBottom).toBeGreaterThan(0)
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
  if (info.project.name === "desktop") expect(headerBottom).toBeCloseTo(initial.headerBottom, 0)
  else expect(headerBottom).toBeLessThan(initial.headerBottom)
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
  expect(entry.title).toBe("Your modules")
  expect(entry.left).toBeGreaterThanOrEqual(0)
  expect(entry.right).toBeLessThanOrEqual(entry.width)
  expect(entry.top).toBeGreaterThanOrEqual(0)
  expect(entry.bottom).toBeLessThanOrEqual(entry.height)
  if (info.project.name === "desktop") expect(entry.width - entry.right).toBeCloseTo(16, 0)
  else expect(entry.right).toBeCloseTo(entry.width, 0)
  const exit = await sample("close")
  expect(exit.animations).toBeGreaterThan(0)
  expect(exit.layerDuration).toBeGreaterThanOrEqual(exit.surfaceDuration)
  expect(exit.title).toBe("Your modules")
  expect(exit.focusInside).toBe(true)
  expect(exit.left).toBeGreaterThanOrEqual(0)
  expect(exit.top).toBeGreaterThanOrEqual(0)
  expect(exit.bottom).toBeLessThanOrEqual(exit.height)
  if (info.project.name === "desktop") expect(exit.width - exit.right).toBeCloseTo(16, 0)
  else expect(exit.right).toBeCloseTo(exit.width, 0)
  await expect(page.locator(".superapp-dialog")).toHaveCount(0)
  await expect(page.locator(`${navSelector} > button`)).toBeFocused()
  // Let a real close run to completion too; finishing the sampled animation can hide early focus restoration.
  await page.locator(`${navSelector} > button`).click()
  await expect(page.getByRole("dialog", { name: "Your modules", exact: true })).toBeVisible()
  await page
    .getByRole("dialog", { name: "Your modules", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click()
  await expect(page.locator(".superapp-dialog")).toHaveCount(0)
  await expect(page.locator(`${navSelector} > button`)).toBeFocused()
  const closeMethods: ReadonlyArray<"escape" | "host"> = ["escape", "host"]
  for (const close of closeMethods) {
    await page.locator(`${navSelector} > button`).click()
    await expect(page.getByRole("dialog", { name: "Your modules", exact: true })).toBeVisible()
    if (close === "escape") await page.keyboard.press("Escape")
    else {
      const choice = page.getByRole("navigation", { name: "Module picker", exact: true }).locator(
        "a[aria-current=\"page\"]"
      )
      // Choosing the current module closes through the shell owner, without a Radix close request.
      await choice.click()
    }
    await expect(page.locator(".superapp-dialog")).toHaveCount(0)
    await expect(page.locator(`${navSelector} > button`)).toBeFocused()
  }
  expect(focusWarnings).toEqual([])
})

test("keeps the noncanonical listener's existing dashboard", async ({ page }) => {
  await page.goto("/?noncanonical")
  await expect(page.locator(".app")).toBeVisible()
  await expect(page.locator(".superapp-shell")).toHaveCount(0)
})
