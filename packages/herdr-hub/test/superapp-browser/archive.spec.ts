import { expect, test } from "@playwright/test"
import { archiveFixture } from "./archive-fixture.js"

/** Dismissal consumes a shell-owned selection, and a reloaded selection replaces its current entry. */
for (const reloaded of [false, true]) {
  test(`archived-stage Close does not create a reopening Back entry, reloaded=${String(reloaded)}`, async ({ page }) => {
    await page.route("**/v1/connect/archive*", (route) => route.fulfill({ json: archiveFixture() }))
    await page.goto("/#connect/overview")
    await page.getByRole("navigation", { name: "Agent directory view" }).getByRole("link", {
      name: "Archived",
      exact: true
    }).click()
    const before = await page.evaluate(() => history.length)
    await page.locator(".connect-home-archive-row").first().click()
    const stage = page.getByRole("dialog", { name: "fix-pins", exact: true })
    await expect(stage).toBeVisible()
    expect(await page.evaluate(() => history.length)).toBe(before + 1)
    if (reloaded) {
      await page.reload()
      await expect(stage).toBeVisible()
    }
    await stage.getByRole("button", { name: "Close", exact: true }).click()
    await expect(stage).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has("closed")).toBe(false)
    expect(await page.evaluate(() => history.length)).toBe(before + 1)
    await page.goBack()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has("closed")).toBe(false)
    expect(new URL(page.url()).searchParams.get("view")).toBe(reloaded ? "archived" : null)
  })
}

/** A direct archived selection replaces its URL, so Back reaches the page before the deep link. */
test("direct archived-stage Close replaces before Back leaves Connect", async ({ page }) => {
  await page.route("**/v1/connect/archive*", (route) => route.fulfill({ json: archiveFixture() }))
  await page.goto("/?view=archived#connect/overview")
  await page.locator(".connect-home-archive-row").first().click()
  const selectedHref = page.url()
  await page.goto("/#fleet/work")
  await page.goto(selectedHref)
  const stage = page.getByRole("dialog", { name: "fix-pins", exact: true })
  await expect(stage).toBeVisible()
  const before = await page.evaluate(() => history.length)
  await stage.getByRole("button", { name: "Close", exact: true }).click()
  await expect(stage).toHaveCount(0)
  expect(await page.evaluate(() => history.length)).toBe(before)
  expect(new URL(page.url()).searchParams.has("closed")).toBe(false)
  await page.goBack()
  await expect(page.locator("[data-module=\"fleet\"]")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

/** The real shell retains closure/history while a hidden Connect owner stays mounted. */
test(
  "Home Archived preserves shell history, paging and the selected closure through Fleet and Back",
  async ({ page }, info) => {
    let reads = 0
    await page.route("**/v1/connect/archive*", async (route) => {
      reads += 1
      await route.fulfill({ json: archiveFixture(new URL(route.request().url()).searchParams.has("cursor")) })
    })
    await page.goto("/#connect/overview")
    await page.evaluate(() => history.replaceState({ ...history.state, foreign: "kept" }, ""))
    const switcher = page.getByRole("navigation", { name: "Agent directory view" })
    const archived = switcher.getByRole("link", { name: "Archived", exact: true })
    if (info.project.name === "phone") await archived.tap()
    else {
      await archived.focus()
      await page.keyboard.press("Enter")
    }
    await expect(page.locator(".connect-home-archive-row")).toHaveCount(7)
    await expect(page.locator(".connect-home-archive-count")).toHaveText("7+ closed agents in the last 90 days")
    await page.getByRole("button", { name: "Show older", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(page.locator(".connect-home-archive-row")).toHaveCount(8)
    await expect(page.locator(".connect-home-archive-row").nth(7)).toBeFocused()
    const row = page.locator(".connect-home-archive-row").first()
    await row.click()
    await expect(page.getByRole("dialog", { name: "fix-pins", exact: true })).toBeVisible()
    expect(new URL(page.url()).searchParams.get("closed")).not.toBeNull()
    await page.goBack()
    await expect(page.getByRole("dialog")).not.toBeVisible()
    const nav = page.locator(info.project.name === "phone" ? ".superapp-bottom" : ".superapp-sidebar")
    await nav.getByRole("link", { name: /^Fleet(?:,|$)/ }).click()
    await expect(page.locator("[data-module=\"fleet\"]")).toBeVisible()
    await page.goBack()
    await expect(page.locator(".connect-home-archive-row")).toHaveCount(8)
    await page.goForward()
    await expect(page.locator("[data-module=\"fleet\"]")).toBeVisible()
    await page.goBack()
    await switcher.getByRole("link", { name: "Active", exact: true }).click()
    await expect(page.locator(".connect-home-directory")).toBeVisible()
    expect(reads).toBe(2)
    expect(await page.evaluate(() => history.state.foreign)).toBe("kept")
    expect(await page.evaluate(() => document.scrollingElement?.scrollWidth === document.scrollingElement?.clientWidth))
      .toBe(true)
  }
)

/** No periodic status churn may re-read the archive after its first bounded page. */
test("Home archive reads stay at one across three directory poll cycles", async ({ page }) => {
  let reads = 0
  await page.route("**/v1/connect/archive*", async (route) => {
    reads += 1
    await route.fulfill({ json: archiveFixture() })
  })
  await page.goto("/?view=archived#connect/overview")
  await expect(page.locator(".connect-home-archive-row")).toHaveCount(7)
  await page.clock.install()
  await page.clock.runFor(15_100)
  expect(reads).toBe(1)
})

/** Initial failure and older-page failure use different copy while preserving any loaded rows. */
test("Home archive retries initial and older-page failures without discarding loaded rows", async ({ page }) => {
  let fail = true
  await page.route("**/v1/connect/archive*", async (route) => {
    if (fail) return route.fulfill({ status: 503, body: "unavailable" })
    await route.fulfill({ json: archiveFixture() })
  })
  await page.goto("/?view=archived#connect/overview")
  await expect(page.getByRole("alert")).toContainText("Couldn’t load archived agents")
  const initialFailureStyle = await page.getByText("Couldn’t load archived agents", { exact: true }).evaluate(
    (element) => {
      const style = getComputedStyle(element)
      return { color: style.color, size: style.fontSize, weight: style.fontWeight }
    }
  )
  fail = false
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.locator(".connect-home-archive-row")).toHaveCount(7)
  fail = true
  await page.getByRole("button", { name: "Show older", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Couldn’t load older agents.")
  const olderFailureStyle = await page.getByText("Couldn’t load older agents.", { exact: true }).evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, size: style.fontSize, weight: style.fontWeight }
  })
  expect(olderFailureStyle).toEqual(initialFailureStyle)
  await expect(page.locator(".connect-home-archive-row")).toHaveCount(7)
  fail = false
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.getByRole("alert")).not.toBeVisible()
})

/** Export51 row metrics resist the inherited Connect line height and phone switch gutter. */
test("Home archive matches the designed switch, reading line and row geometry", async ({ page }, info) => {
  await page.route("**/v1/connect/archive*", (route) => route.fulfill({ json: archiveFixture() }))
  await page.goto("/?view=archived#connect/overview")
  const first = page.locator(".connect-home-archive-row").first()
  await expect(first).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const metrics = await first.evaluate((element) => {
    const count = document.querySelector(".connect-home-archive-count")
    const switcher = document.querySelector(".connect-home-switch")
    if (count === null || switcher === null) throw new TypeError("Archive chrome missing")
    const inactive = switcher.querySelector("a:not([aria-current=\"page\"])")
    const current = switcher.querySelector("a[aria-current=\"page\"]")
    if (inactive === null || current === null) throw new TypeError("Archive switch missing")
    return {
      row: element.getBoundingClientRect().height,
      count: count.getBoundingClientRect().height,
      switchX: switcher.getBoundingClientRect().x,
      inactiveColor: getComputedStyle(inactive).color,
      currentColor: getComputedStyle(current).color,
      mutedColor: getComputedStyle(count).color,
      rowColor: getComputedStyle(element).color
    }
  })
  expect(metrics.row).toBeCloseTo(info.project.name === "phone" ? 114 : 92.5, 1)
  expect(metrics.count).toBeCloseTo(21, 1)
  expect(metrics.switchX).toBe(info.project.name === "phone" ? 16 : 264)
  expect(metrics.inactiveColor).toBe(metrics.mutedColor)
  expect(metrics.currentColor).toBe(metrics.rowColor)
})

/** A held first response exposes five skeletons without adding another archive request. */
test("Home archive shows five skeletons while its first bounded response is held", async ({ page }) => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/v1/connect/archive*", async (route) => {
    await held
    await route.fulfill({ json: archiveFixture() })
  })
  try {
    await page.goto("/?view=archived#connect/overview")
    await expect(page.locator(".connect-home-archive-skeleton")).toHaveCount(5)
    await expect(page.locator(".connect-home-archive-loading")).toContainText("Loading archived agents")
    release?.()
    await expect(page.locator(".connect-home-archive-row")).toHaveCount(7)
  } finally {
    release?.()
    await page.unrouteAll({ behavior: "wait" })
  }
})

/** The paging status keeps the approved foot geometry while the next page is held. */
test("Home archive loading-older status matches its design height and spinner", async ({ page }, info) => {
  let reads = 0
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/v1/connect/archive*", async (route) => {
    reads += 1
    if (reads > 1) await held
    await route.fulfill({ json: archiveFixture(reads > 1) })
  })
  try {
    await page.goto("/?view=archived#connect/overview")
    await page.getByRole("button", { name: "Show older", exact: true }).click()
    const status = page.locator(".connect-home-archive-paging[role=status]")
    await expect(status).toBeVisible()
    const geometry = await status.evaluate((element) => {
      const spinner = element.querySelector(".connect-home-archive-spinner")
      if (spinner === null) throw new TypeError("Paging spinner missing")
      return { height: element.getBoundingClientRect().height, spinner: spinner.getBoundingClientRect().width }
    })
    expect(geometry.height).toBe(info.project.name === "phone" ? 44 : 40)
    expect(geometry.spinner).toBe(14)
  } finally {
    release?.()
    await page.unrouteAll({ behavior: "wait" })
  }
})

/** The empty archive keeps the export54 surface card in both themes and viewport sizes. */
for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
  test(`Home archive empty state keeps its bordered surface card in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.route("**/v1/connect/archive*", (route) => route.fulfill({ json: { agents: [], nextCursor: null } }))
    await page.goto("/?view=archived#connect/overview")
    const empty = page.locator(".connect-home-archive-empty")
    await expect(empty).toHaveText("No closed agents in the last 90 days")
    await page.evaluate(() => document.fonts.ready)
    const card = await empty.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        height: element.getBoundingClientRect().height
      }
    })
    expect(card.border).toBe("1px")
    expect(card.radius).toBe("20px")
    expect(card.background).not.toBe("rgba(0, 0, 0, 0)")
    expect(card.height).toBe(90)
  })
}
