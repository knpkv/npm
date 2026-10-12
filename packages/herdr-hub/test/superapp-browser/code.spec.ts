import type { CodeQueue } from "@knpkv/codecommit-web/host"
import { expect, test } from "@playwright/test"
import { ok } from "node:assert/strict"
import { CODE_OTHER_REF, CODE_REF } from "./code-fixture.js"

const route = (page: string, ref?: string) =>
  `/?filter=open&search=&offset=0${ref === undefined ? "" : `&ref=${ref}`}#code/${page}`

test("owner links follow the queue's bound origin without a port fallback or another endpoint", async ({ page }) => {
  let ownerUi: string | undefined = "http://127.0.0.1:4780"
  let failed = false
  const requests: Array<string> = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith("/v1/modules/code/")) requests.push(path)
  })
  await page.route(/\/v1\/modules\/code\/queue\?/, async (request) => {
    const unavailable: CodeQueue = {
      _tag: "Unavailable",
      reason: "cache_unavailable",
      host: null
    }
    const status = ownerUi === undefined ? unavailable : { ...unavailable, ownerUi }
    await request.fulfill({ status: failed ? 503 : 200, json: status })
  })
  await page.goto(route("pull-requests"))
  const link = page.getByRole("link", { name: "Open Code owner UI on this machine" })
  const refresh = page.getByRole("button", { name: "Read again", exact: true })
  await expect(link).toHaveAttribute("href", "http://127.0.0.1:4780")
  await expect(page.locator(".code-host-notice")).toContainText("Code owner service and hub log")
  ownerUi = "http://127.0.0.1:4781"
  await refresh.click()
  await expect(link).toHaveAttribute("href", "http://127.0.0.1:4781")
  failed = true
  await refresh.click()
  await expect(page.locator(".code-host-problem")).toContainText("Showing the previous reading")
  await expect(link).toHaveCount(0)
  failed = false
  ownerUi = undefined
  await refresh.click()
  await expect(page.locator(".code-host-problem")).toHaveCount(0)
  await expect(link).toHaveCount(0)
  await expect(page.locator(".code-host-notice")).not.toContainText("cannot be opened from this device")
  expect(requests).toEqual(Array(4).fill("/v1/modules/code/queue"))
})

test("Code is a registered mobile module with a cache-only queue and readable controls", async ({ page }) => {
  const requests: Array<string> = []
  page.on("request", (request) => {
    if (request.url().includes("/v1/modules/code/")) requests.push(new URL(request.url()).pathname)
  })
  await page.goto(route("pull-requests"))
  await expect(page.getByRole("heading", { name: "Pull requests", exact: true })).toBeVisible()
  await expect(page.locator(".code-host-row")).toHaveCount(2)
  await expect(page.locator(".code-host-row").first()).toContainText("Cached")
  await expect(page.locator(".superapp-bottom [aria-current=\"page\"]")).toHaveText("Code")
  expect(requests).toEqual(["/v1/modules/code/queue"])
  const search = page.getByRole("searchbox", { name: "Find a pull request" })
  expect(await search.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)))
    .toBeGreaterThanOrEqual(16)
  expect(await search.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("search and queue filters replace selectors while retaining field focus", async ({ page }) => {
  await page.goto(route("pull-requests"))
  await expect(page.locator(".code-host-row")).toHaveCount(2)
  const search = page.getByRole("searchbox", { name: "Find a pull request" })
  await search.fill("bounded")
  await expect.poll(() => new URL(page.url()).searchParams.get("search")).toBe("bounded")
  await expect(search).toBeFocused()
  await expect(page.locator(".code-host-row")).toHaveCount(1)
  await page.getByRole("combobox", { name: "Cached queue" }).focus()
  await page.getByRole("combobox", { name: "Cached queue" }).selectOption("reviews")
  await expect.poll(() => new URL(page.url()).searchParams.get("filter")).toBe("reviews")
  await expect(page.getByRole("combobox", { name: "Cached queue" })).toBeFocused()
  await expect(page.getByRole("heading", { name: "No cached pull requests match" })).toBeVisible()
})

test("Reviews name cached approvals rather than personal review requests", async ({ page }) => {
  await page.goto(route("reviews"))
  await expect(page.locator(".code-host-row")).toHaveCount(1)
  await expect(page.locator(".code-host-intro")).toContainText("Cached approvals waiting")
  await expect(page.locator(".code-host-intro")).toContainText("does not identify reviews requested of you")
  await expect.poll(() => new URL(page.url()).searchParams.get("filter")).toBe("reviews")
  await expect(page.getByRole("combobox", { name: "Cached queue" })).toHaveCount(0)
})

test("exact cached details need no provider read, then intentional diff navigation keeps page focus", async ({ page }) => {
  const warnings: Array<string> = []
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") warnings.push(message.text())
  })
  let diffs = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/modules/code/diff") diffs += 1
  })
  await page.goto(route("pull-requests", CODE_REF))
  const dialog = page.getByRole("dialog", { name: "Cached pull request" })
  await expect(dialog.getByRole("heading", { name: "Make the queue reading explicit" })).toBeVisible()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  ok(viewport)
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    viewport.width < 640 ? viewport.width : 460
  )
  await expect(dialog.getByRole("navigation", { name: "Pull request views" })).toContainText("Summary")
  await expect(dialog.locator("dt")).toHaveText(["Repository", "Branch", "Review", "Read"])
  const closeBounds = await dialog.getByRole("button", { name: "Close pull request" }).boundingBox()
  const panelBounds = await dialog.boundingBox()
  const titleBounds = await dialog.getByRole("heading", { name: "Cached pull request", exact: true }).boundingBox()
  ok(closeBounds)
  ok(panelBounds)
  ok(titleBounds)
  expect(closeBounds.width).toBeGreaterThanOrEqual(44)
  expect(closeBounds.height).toBeGreaterThanOrEqual(44)
  expect(closeBounds.x + closeBounds.width).toBeGreaterThanOrEqual(panelBounds.x + panelBounds.width - 40)
  expect(closeBounds.y).toBeLessThanOrEqual(panelBounds.y + 40)
  expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(closeBounds.x)
  await expect(dialog.getByRole("button", { name: "Close pull request" })).toBeFocused()
  expect(warnings).toEqual([])
  await expect(dialog).toContainText("<script> remains text")
  expect(diffs).toBe(0)
  await dialog.getByRole("link", { name: "Read diff" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  await expect(page.locator(".code-host-tabs [data-module-page=\"diffs\"]")).toBeFocused()
  expect(diffs).toBe(1)
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("link", { name: "src/reading.ts modified" })
    .click()
  await expect(page.locator(".code-host-file pre").last()).toContainText("'explicit'")
  await expect(page.locator(".code-host-diff")).toContainText("Read ")
  await expect(page.locator(".code-host-diff")).toContainText("Base base-commit. Head head-commit.")
})

test("Back/Forward reuses explicit diffs and only Read again authorizes another read", async ({ page }) => {
  const reads: Array<string | null> = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/v1/modules/code/diff") reads.push(url.searchParams.get("ref"))
  })
  await page.goto(route("diffs", CODE_REF))
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  await page.locator(".code-host-row").filter({ hasText: "Keep the file reader bounded" }).click()
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-748")
  await page.goBack()
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  await expect(page.locator(".code-host-tabs [data-module-page=\"diffs\"]")).toBeFocused()
  expect(reads).toEqual([CODE_REF, CODE_OTHER_REF])
  await page.getByRole("button", { name: "Read again", exact: true }).click()
  await expect.poll(() => reads).toEqual([CODE_REF, CODE_OTHER_REF, CODE_REF])
})

test("keyboard targets focus their dialog and deliberate targets add one history entry each", async ({ page }) => {
  await page.goto(route("pull-requests"))
  const first = page.locator(".code-host-row").first()
  await expect(first).toBeVisible()
  await first.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Cached pull request" })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.goBack()
  await expect(dialog).toHaveCount(0)
  await expect(first).toBeFocused()
  await page.goto(route("diffs"))
  await expect(first).toBeVisible()
  const initial = await page.evaluate(() => history.length)
  await first.click()
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  expect(await page.evaluate(() => history.length)).toBe(initial + 1)
  await first.click()
  expect(await page.evaluate(() => history.length)).toBe(initial + 1)
  await page.locator(".code-host-row").last().click()
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-748")
  expect(await page.evaluate(() => history.length)).toBe(initial + 2)
  await page.goBack()
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  await page.goBack()
  await expect(page.getByText("Choose a pull request to read its diff.")).toBeVisible()
  await expect(page.locator(".code-host-tabs [data-module-page=\"diffs\"]")).toBeFocused()
})

test("changing cached PR data marks a retained diff as possibly outdated without a provider call", async ({ context, page }) => {
  let reads = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/modules/code/diff") reads += 1
  })
  await page.goto(route("diffs", CODE_REF))
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  await context.addCookies([{ name: "code-fixture", value: "changed", url: new URL(page.url()).origin }])
  await page.getByRole("combobox", { name: "Cached queue" }).selectOption("all")
  await expect(page.locator(".code-host-diff")).toContainText("This diff may be outdated")
  expect(reads).toBe(1)
  await page.getByRole("button", { name: "Read again", exact: true }).click()
  await expect.poll(() => reads).toBe(2)
  await expect(page.locator(".code-host-diff")).not.toContainText("This diff may be outdated")
})

for (const state of ["permission", "signin", "unavailable", "otherhost"]) {
  test(`${state} gives truthful instructions and no grant or publication controls`, async ({ context, page }) => {
    await page.goto("/")
    await context.addCookies([{ name: "code-fixture", value: state, url: new URL(page.url()).origin }])
    await page.goto(route("pull-requests"))
    await expect(page.getByRole("heading", { name: "Code unavailable", exact: true })).toBeVisible()
    await expect(page.locator(".code-host-notice")).toContainText(
      state === "otherhost" ? "Code lives on cedar" : "Code owner UI"
    )
    await expect(page.locator(".code-host").getByRole("button")).toHaveCount(1)
    await expect(page.getByRole("button", { name: /Grant|Publish|Approve|Sign in/ })).toHaveCount(0)
  })
}

test("unknown opaque targets return a closed not-found state with a working close action", async ({ page }) => {
  await page.goto(route("pull-requests", "00000000-0000-4000-8000-000000000099"))
  const dialog = page.getByRole("dialog", { name: "Cached pull request" })
  await expect(dialog).toContainText("reference is no longer available")
  await dialog.getByRole("button", { name: "Close pull request" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(".code-host-tabs [data-module-page=\"pull-requests\"]")).toBeFocused()
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
})

test("large diff files never mount an unbounded text DOM", async ({ context, page }) => {
  await page.goto("/")
  await context.addCookies([{ name: "code-fixture", value: "large", url: new URL(page.url()).origin }])
  await page.goto(`${route("diffs", CODE_REF).replace("#", "&file=0#")}`)
  await expect(page.locator(".code-host-file")).toContainText("exceeds the display limit")
  await expect(page.locator(".code-host-file pre")).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("failed refresh preserves the previous reading with explicit failure words", async ({ context, page }) => {
  await page.goto(route("pull-requests"))
  await expect(page.locator(".code-host-row")).toHaveCount(2)
  await context.addCookies([{ name: "code-fixture", value: "failed", url: new URL(page.url()).origin }])
  await page.getByRole("button", { name: "Read again", exact: true }).click()
  await expect(page.locator(".code-host-problem")).toContainText("Showing the previous reading")
  await expect(page.locator(".code-host-row")).toHaveCount(2)
})

test("inactive Code stops polling while Fleet approval selectors keep their exact target", async ({ page }) => {
  let reads = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/modules/code/")) reads += 1
  })
  await page.clock.install()
  await page.goto(route("pull-requests"))
  await expect(page.getByRole("heading", { name: "Pull requests", exact: true })).toBeVisible()
  await page.clock.runFor(300)
  await expect(page.locator(".code-host-row")).toHaveCount(2)
  const count = reads
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = "?approvalHost=ALPHA&approvalJob=alpha-off-page#fleet/approvals"
    document.body.append(link)
    link.click()
    link.remove()
  })
  await expect(page.locator("[data-approval-target]")).toContainText("Peer requester")
  await page.clock.fastForward(61_000)
  expect(reads).toBe(count)
  expect(new URL(page.url()).searchParams.get("approvalHost")).toBe("ALPHA")
  expect(new URL(page.url()).searchParams.get("approvalJob")).toBe("alpha-off-page")
})

test("switching files interrupts the old read and cannot display its late answer", async ({ page }) => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  await page.route(/\/v1\/modules\/code\/diff-content\?/, async (request) => {
    if (new URL(request.request().url()).searchParams.get("fileIndex") === "0") {
      started = true
      await pending
    }
    await request.continue()
  })
  try {
    await page.goto(route("diffs", CODE_REF).replace("#", "&file=0#"))
    await expect.poll(() => started).toBe(true)
    await page.getByRole("navigation", { name: "Changed files" }).getByRole("link", { name: "src/bounds.ts added" })
      .click()
    await expect(page.locator(".code-host-file pre").last()).toContainText("bound = 100")
    release()
    await expect(page.locator(".code-host-file pre").last()).not.toContainText("reading = 'explicit'")
    expect(new URL(page.url()).searchParams.get("file")).toBe("1")
  } finally {
    release()
  }
})

test("maximum-length cached text and file paths fit the narrowest viewport", async ({ context, page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto("/")
  await context.addCookies([{ name: "code-fixture", value: "long", url: new URL(page.url()).origin }])
  for (const destination of ["pull-requests", "diffs"]) {
    await page.goto(route(destination, CODE_REF))
    if (destination === "pull-requests") {
      await expect(page.getByRole("dialog").locator("dd").first()).toHaveText("r".repeat(256))
    } else {await expect(page.getByRole("navigation", { name: "Changed files" }).getByRole("link").first())
        .toContainText("p".repeat(4092))}
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (destination === "pull-requests") {
      expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      )
    }
  }
})

test("the Code panel stays inside the viewport halfway through entry and exit", async ({ page }) => {
  const warnings: Array<string> = []
  page.on("console", (message) => {
    if (message.text().includes("Blocked aria-hidden")) warnings.push(message.text())
  })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(route("pull-requests"))
  await expect(page.locator(".code-host-row").first()).toBeVisible()
  await page.locator(".code-host-row").first().click()
  const sample = async () =>
    page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".code-host-panel")
      if (panel === null) throw new Error("Code panel missing")
      const animations = panel.getAnimations()
      for (const animation of animations) {
        const duration = Number(animation.effect?.getComputedTiming().duration)
        if (Number.isFinite(duration)) {
          animation.pause()
          animation.currentTime = duration / 2
        }
      }
      const rect = panel.getBoundingClientRect()
      const layer = panel.parentElement
      const result = {
        count: animations.length,
        name: getComputedStyle(panel).animationName,
        duration: Number.parseFloat(getComputedStyle(panel).animationDuration),
        layerDuration: layer === null ? 0 : Number.parseFloat(getComputedStyle(layer).animationDuration),
        start: rect.y,
        end: rect.bottom,
        left: rect.x,
        right: rect.right,
        width: innerWidth,
        height: innerHeight
      }
      for (const animation of animations) animation.play()
      return result
    })
  for (const action of ["enter", "exit"]) {
    if (action === "exit") await page.keyboard.press("Escape")
    const bounds = await sample()
    expect(bounds.count).toBeGreaterThan(0)
    expect(bounds.name).toBe(action === "enter" ? "code-panel-in" : "code-panel-out")
    if (action === "exit") expect(bounds.layerDuration).toBeGreaterThanOrEqual(bounds.duration)
    expect(bounds.start).toBeGreaterThanOrEqual(0)
    expect(bounds.end).toBeLessThanOrEqual(bounds.height)
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(bounds.width)
  }
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".code-host-row").first()).toBeFocused()
  expect(warnings).toEqual([])
})

/** Portal dialogs own focus even though they are mounted outside the module slot. */
for (const reducedMotion of ["no-preference", "reduce"] satisfies ReadonlyArray<"no-preference" | "reduce">) {
  test(`returning from Diffs to cached details lets the portal dialog own focus with ${reducedMotion} motion`, async ({ page }) => {
    await page.addInitScript(() => {
      const focus = HTMLElement.prototype.focus
      HTMLElement.prototype.focus = function(options) {
        if (this.closest("[aria-hidden=\"true\"]") !== null) {
          document.documentElement.dataset.hiddenFocusAttempt = "true"
        }
        focus.call(this, options)
      }
    })
    const warnings: Array<string> = []
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") warnings.push(message.text())
    })
    await page.emulateMedia({ reducedMotion })
    await page.goto(route("diffs", CODE_REF))
    await expect(page.getByRole("heading", { name: "Read-only diff" })).toBeVisible()
    await page.getByRole("navigation", { name: "Code pages" }).getByRole("link", { name: "Pull requests", exact: true })
      .click()
    const close = page.getByRole("button", { name: "Close pull request" })
    await expect(close).toBeFocused()
    await expect(page.getByRole("dialog", { name: "Cached pull request" })).toBeVisible()
    await page.evaluate(async () => {
      await Promise.allSettled(
        document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((
          animation
        ) => animation.finished)
      )
    })
    expect(await page.evaluate(() => document.documentElement.dataset.hiddenFocusAttempt)).toBeUndefined()
    expect(warnings).toEqual([])
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(
      page.getByRole("navigation", { name: "Code pages" }).getByRole("link", { name: "Pull requests", exact: true })
    ).toBeFocused()
  })
}
