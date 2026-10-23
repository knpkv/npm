import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  CodeCommitSummaryResult,
  CodeDiffContentQuery,
  CodeDiffContentResult,
  type CodeQueue,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { expect, type Page, test } from "@playwright/test"
import { Crypto, Effect, Schema } from "effect"
import { Hex } from "effect/encoding"
import { ok } from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { canonicalCodeSelection } from "../../src/code-selection.js"
import {
  CODE_OTHER_REF,
  CODE_PRIMARY_CLAIM,
  CODE_REF,
  CODE_SECONDARY_CLAIM,
  codeReviewFixture
} from "./code-fixture.js"

const route = (page: string, ref?: string) =>
  `/?filter=open&search=&offset=0${ref === undefined ? "" : `&ref=${ref}`}#code/${page}`

/** The fixture caches dist at startup. An old fixture after a rebuild is a setup refusal, never RED. */
test.beforeEach(async ({ request }, testInfo) => {
  const hashes: Record<string, string> = {}
  for (const name of ["index.css", "approval.js", "connect.js"]) {
    const disk = await readFile(new URL(`../../dist/${name}`, import.meta.url))
    const served = await request.get(`/assets/${name}`)
    expect(served.status(), `required built asset ${name}`).toBe(200)
    const digest = Effect.fn("CodeBrowser.assetDigest")(function*(bytes: Uint8Array) {
      const cryptoService = yield* Crypto.Crypto
      return Hex.encode(yield* cryptoService.digest("SHA-256", bytes))
    })
    const diskHash = await Effect.runPromise(digest(disk).pipe(Effect.provide(NodeServices.layer)))
    const servedHash = await Effect.runPromise(digest(await served.body()).pipe(Effect.provide(NodeServices.layer)))
    expect(servedHash, `fixture must serve current complete ${name}`).toBe(diskHash)
    hashes[name] = diskHash
  }
  await testInfo.attach("served-build-hashes", { body: JSON.stringify(hashes), contentType: "application/json" })
})

const reviewPage = (page: Page) => page.locator("[data-code-review-page]")
const returnToQueue = (page: Page) =>
  page.getByRole("navigation", { name: "Code pages" }).locator("a[aria-current=\"page\"]")
const owner = (page: Page) => page.locator("[data-code-review-owner]")
const card = (page: Page, claim: string) =>
  owner(page).getByRole("article").filter({ has: page.getByRole("heading", { name: claim, exact: true }) })
const selected = (view: "review" | "conversation", extra = "") =>
  route("pull-requests", CODE_REF).replace("#", `&view=${view}${extra}#`)
const secondaryTarget = encodeURIComponent(JSON.stringify({ source: "agent", id: "secondary" }))
const primaryTarget = encodeURIComponent(JSON.stringify({ source: "agent", id: "primary" }))
const gate = () => Promise.withResolvers<void>()
const fixtureBody = (ref: string, state = "normal") => {
  const value = codeReviewFixture(ref, 1_700_000_000_000, state)
  ok(value, "fixture must name a real synthetic PR")
  return Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(value)
}

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

/** Arriving on Diffs with a pull request chosen lands on its diff, above the queue, not under every cached row. */
test("arriving on Diffs with a pull request chosen focuses its diff above the queue", async ({ page }) => {
  await page.goto(route("pull-requests", CODE_REF))
  await expect(reviewPage(page).getByRole("heading", { name: "Make the queue reading explicit" })).toBeVisible()
  await page.getByRole("navigation", { name: "Code pages" }).getByRole("link", { name: "Diffs", exact: true }).click()
  const diff = page.locator(".code-host-diff")
  await expect(diff).toContainText("Revision revision-752")
  await expect(diff).toBeFocused()
  const diffTop = await diff.evaluate((element) => element.getBoundingClientRect().top)
  const queueTop = await page.locator(".code-host-queue").evaluate((element) => element.getBoundingClientRect().top)
  expect(diffTop).toBeLessThan(queueTop)
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
  const canvas = reviewPage(page)
  await expect(canvas.getByRole("heading", { name: "Make the queue reading explicit" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".code-host-queue")).toHaveCount(0)
  const moduleBounds = await page.locator("[data-module=\"code\"]").boundingBox()
  const canvasBounds = await canvas.boundingBox()
  ok(moduleBounds)
  ok(canvasBounds)
  expect(canvasBounds.width).toBe(moduleBounds.width)
  const viewport = page.viewportSize()
  ok(viewport)
  if (viewport.width >= 640) expect(canvasBounds.width).toBeGreaterThan(460)
  await expect(canvas.getByRole("navigation", { name: "Review views" }).getByRole("link")).toHaveText([
    "Review",
    "Conversation"
  ])
  await expect(canvas.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await expect(canvas.locator("[data-code-review-header]")).toContainText("Cached approval waiting")
  await expect(canvas.locator("[data-code-review-header]")).toContainText("Checks unknown")
  const queueLink = returnToQueue(page)
  const hit = await queueLink.boundingBox()
  ok(hit)
  expect(hit.height).toBeGreaterThanOrEqual(44)
  expect(warnings).toEqual([])
  expect(diffs).toBe(0)
  await queueLink.click()
  await expect(canvas).toHaveCount(0)
  await page.getByRole("navigation", { name: "Code pages" }).getByRole("link", { name: "Diffs", exact: true }).click()
  const diffRow = page.locator(".code-host-row").first()
  await diffRow.click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".code-host-diff")).toContainText("Revision revision-752")
  // Choosing a diff on the same page keeps focus on the row the reader activated.
  await expect(diffRow).toBeFocused()
  expect(diffs).toBe(1)
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("link", { name: "src/reading.ts modified" })
    .click()
  await expect(page.locator(".code-host-file pre").last()).toContainText("'explicit'")
  await expect(page.locator(".code-host-diff")).toContainText("Read ")
  await expect(page.locator(".code-host-diff")).toContainText("Base “Read the queue on request, ")
  await expect(page.locator(".code-host-diff")).toContainText("Head “Make the queue reading explicit, ")
  await expect(page.locator(".code-host-diff")).not.toContainText("head-commit")
  await expect(page.locator(".code-host-diff").getByRole("button", { name: "Copy commit id" })).toHaveCount(2)
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

test("keyboard targets focus their full page and deliberate targets add one history entry each", async ({ page }) => {
  await page.goto(route("pull-requests"))
  const first = page.locator(".code-host-row").first()
  await expect(first).toBeVisible()
  await first.focus()
  await page.keyboard.press("Enter")
  const canvas = reviewPage(page)
  await expect(canvas).toBeVisible()
  expect(await canvas.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.goBack()
  await expect(canvas).toHaveCount(0)
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
  // Leaving the last selection through history restores the row that opened it.
  await expect(first).toBeFocused()
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
  const canvas = reviewPage(page)
  await expect(canvas).toContainText("reference is no longer available")
  await returnToQueue(page).click()
  await expect(canvas).toHaveCount(0)
  // Shipped behaviour: an unknown target has no opener row, so focus lands on the queue's page heading. This also
  // fails if focus is lost to <body>.
  await expect(page.getByRole("heading", { name: "Pull requests", exact: true })).toBeFocused()
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

/**
 * A commit label is "Title, 14:18" on the queue reading's day and "Title, 22 Oct 14:18" before it. The
 * fixture commits an hour before the reading, so the day depends on when the suite runs; each case moves
 * the commit relative to the reading, in UTC, so both labels are covered at any hour.
 */
const commitDays = [
  { day: "same day", shift: 3_600_000, words: /, \d{2}:\d{2}”/u },
  { day: "previous day", shift: -23 * 3_600_000, words: /, \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}”/u }
]

test.describe("maximum-length cached text and file paths fit the narrowest viewport", () => {
  test.use({ timezoneId: "UTC" })
  for (const { day, shift, words } of commitDays) {
    test(`with a ${day} commit`, async ({ context, page }) => {
      await page.route(/\/v1\/modules\/code\/commit\?/, async (request) => {
        const response = await request.fetch()
        const reading = Schema.decodeUnknownSync(Schema.fromJsonString(CodeCommitSummaryResult))(await response.text())
        await request.fulfill({
          response,
          body: Schema.encodeSync(Schema.fromJsonString(CodeCommitSummaryResult))(
            reading._tag === "Ready"
              ? { ...reading, commit: { ...reading.commit, committedAt: reading.commit.committedAt + shift } }
              : reading
          )
        })
      })
      await page.setViewportSize({ width: 320, height: 844 })
      await page.goto("/")
      await context.addCookies([{ name: "code-fixture", value: "long", url: new URL(page.url()).origin }])
      for (const destination of ["pull-requests", "diffs"]) {
        await page.goto(route(destination, CODE_REF))
        if (destination === "pull-requests") {
          await expect(reviewPage(page).locator("[data-code-review-header]")).toContainText("r".repeat(256))
          await expect(reviewPage(page).locator("[data-commit-label]").first()).toHaveText(words)
        } else {await expect(page.getByRole("navigation", { name: "Changed files" }).getByRole("link").first())
            .toContainText("p".repeat(4092))}
        await page.evaluate(() => document.fonts.ready)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (destination === "pull-requests") {
          expect(await reviewPage(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true
          )
        }
      }
    })
  }
})

test("the full-page Code canvas stays in document flow without modal entry or exit locks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(route("pull-requests"))
  await page.locator(".code-host-row").first().click()
  const canvas = reviewPage(page)
  await expect(canvas).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const bounds = await canvas.boundingBox()
  ok(bounds)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.width).toBeGreaterThan(0)
  expect(await canvas.evaluate((element) => element.closest("[inert],[aria-hidden=\"true\"]"))).toBeNull()
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe("hidden")
  expect(await canvas.evaluate((element) => element.getAnimations().length)).toBe(0)
  await returnToQueue(page).click()
  await expect(canvas).toHaveCount(0)
  await expect(page.locator(".code-host-row").first()).toBeFocused()
})

/** The Code page stays inside its module and the shell retains normal page-arrival focus. */
for (const reducedMotion of ["no-preference", "reduce"] satisfies ReadonlyArray<"no-preference" | "reduce">) {
  test(`returning from Diffs to cached details keeps focus inside the full Code page with ${reducedMotion} motion`, async ({ page }) => {
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
    const canvas = reviewPage(page)
    await expect(canvas).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(await canvas.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.evaluate(async () => {
      await Promise.allSettled(
        document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((
          animation
        ) => animation.finished)
      )
    })
    expect(await page.evaluate(() => document.documentElement.dataset.hiddenFocusAttempt)).toBeUndefined()
    expect(warnings).toEqual([])
    await returnToQueue(page).click()
    await expect(canvas).toHaveCount(0)
    await expect(page.locator(".code-host-row").filter({ hasText: "Make the queue reading explicit" })).toBeFocused()
  })
}

/** The preflight padding revert is Usage's alone: Code's Read again keeps its design's zero block padding, Usage's Retry the browser's. */
test("preflight padding revert stays inside Usage views", async ({ page }) => {
  await page.goto(route("pull-requests"))
  const readAgain = page.locator(".code-host-controls").getByRole("button", { name: "Read again", exact: true })
  await expect(readAgain).toBeVisible()
  await expect(readAgain).toHaveCSS("padding-top", "0px")
  await expect(readAgain).toHaveCSS("padding-bottom", "0px")

  await page.route(/\/v1\/connect\/limits(\?|$)/, (request) => request.fulfill({ status: 503, body: "unavailable" }))
  await page.goto("/?range=7d&timeZone=UTC#usage/limits")
  const retry = page.locator("[data-module=\"usage\"]").getByRole("button", { name: "Retry", exact: true })
  await expect(retry).toBeVisible()
  await expect(retry).toHaveCSS("padding-top", "1px")
  await expect(retry).toHaveCSS("padding-bottom", "1px")
})

/** HI2: consume the actual complete hub CSS, not an isolated component sheet or source declaration. */
test("full-bundle preflight stays below Rly and Connect controls without removing intentional zero padding", async ({ page }) => {
  await page.goto(route("pull-requests"))
  const control = page.locator(".code-host-controls").getByRole("button", { name: "Read again", exact: true })
  await expect(control).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const metrics = await control.evaluate((element) => {
    const probe = document.createElement("span")
    const zero = document.createElement("span")
    probe.style.font =
      "var(--rly-type-label-weight) var(--rly-type-label-size) / var(--rly-type-label-line-height) var(--rly-type-label-font)"
    probe.style.paddingInline = "var(--rly-space-16)"
    zero.style.paddingInline = "0px"
    document.body.append(probe, zero)
    try {
      const actual = getComputedStyle(element)
      const expected = getComputedStyle(probe)
      return {
        border: actual.borderInlineStartWidth,
        padding: actual.paddingInlineStart,
        size: actual.fontSize,
        weight: actual.fontWeight,
        lineHeight: actual.lineHeight,
        tokenPadding: expected.paddingInlineStart,
        tokenSize: expected.fontSize,
        tokenWeight: expected.fontWeight,
        tokenLineHeight: expected.lineHeight,
        zero: getComputedStyle(zero).paddingInlineStart
      }
    } finally {
      probe.remove()
      zero.remove()
    }
  })
  expect(metrics.border).toBe("1px")
  expect(metrics.padding).toBe(metrics.tokenPadding)
  expect(Number.parseFloat(metrics.padding)).toBeGreaterThan(0)
  expect(metrics.size).toBe(metrics.tokenSize)
  expect(metrics.weight).toBe(metrics.tokenWeight)
  expect(metrics.lineHeight).toBe(metrics.tokenLineHeight)
  expect(metrics.zero).toBe("0px")

  await page.goto("/#connect/overview")
  const filters = page.getByRole("button", { name: "Filters", exact: true })
  await expect(filters).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const connect = await filters.evaluate((element) => {
    const probe = document.createElement("span")
    probe.style.paddingInline = innerWidth >= 701 ? "var(--rly-space-16)" : "var(--rly-space-12)"
    document.body.append(probe)
    try {
      const style = getComputedStyle(element)
      return {
        border: style.borderInlineStartWidth,
        padding: style.paddingInlineStart,
        tokenPadding: getComputedStyle(probe).paddingInlineStart,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight
      }
    } finally {
      probe.remove()
    }
  })
  // Home's group-header action intentionally removes the older directory button border.
  expect(connect.border).toBe("0px")
  expect(connect.padding).toBe(connect.tokenPadding)
  expect(Number.parseFloat(connect.padding)).toBeGreaterThan(0)
  expect(connect.size).toBe("16px")
  expect(connect.weight).toBe("430")
  expect(connect.lineHeight).toBe("24px")
})

/** Phone (rule 45 refs): product name in the mast, breadcrumb line, then the title block, full-width tabs and body gutters. */
test("Code review phone chrome shows the title block under the breadcrumb", async ({ page }) => {
  await page.goto(selected("review"))
  await expect(owner(page)).toHaveAttribute("data-code-review-read-state", "Ready")
  await expect(reviewPage(page)).toHaveAttribute("data-code-detail-state", "Ready")
  await page.evaluate(() => document.fonts.ready)
  const geometry = await reviewPage(page).evaluate((element) => {
    element.ownerDocument.defaultView?.scrollTo(0, 0)
    const heading = element.querySelector(":scope > header")
    const tabs = element.querySelector("[aria-label=\"Code pages\"]")
    const detail = element.querySelector("[data-code-review-header]")
    const mast = document.querySelector(".superapp-phone-title")
    const mobile = document.querySelector(".superapp-bottom")
    const brand = element.ownerDocument.querySelector(".superapp-header > .superapp-brand")
    if (heading === null || tabs === null || detail === null || mast === null || mobile === null || brand === null) {
      throw new Error("Code review chrome is incomplete")
    }
    const box = (node: Element) => {
      const { height, width, x, y } = node.getBoundingClientRect()
      return { x, y, width, height }
    }
    return {
      width: innerWidth,
      heading: { ...box(heading), clip: getComputedStyle(heading).clipPath },
      headingCount: element.querySelectorAll("h1").length,
      mast: { text: mast.textContent, visible: mast.checkVisibility() },
      mastBox: box(mast),
      mastLineHeight: getComputedStyle(mast).lineHeight,
      brandBox: box(brand),
      tabs: box(tabs),
      tabPadding: Array.from(tabs.querySelectorAll("a"), (link) => getComputedStyle(link).paddingInlineStart),
      pageBottomPadding: getComputedStyle(element).paddingBlockEnd,
      detail: box(detail),
      mobileWeight: getComputedStyle(mobile).fontWeight,
      overflow: document.documentElement.scrollWidth > innerWidth
    }
  })
  expect(geometry.headingCount).toBe(1)
  expect(geometry.overflow).toBe(false)
  if (geometry.width < 600) {
    expect(geometry.mast).toEqual({ text: "Relay", visible: true })
    expect(geometry.heading.clip).toBe("none")
    expect(geometry.heading.x).toBe(16)
    expect(geometry.heading.y).toBe(108)
    expect(geometry.heading.width).toBe(geometry.width - 32)
    expect(geometry.tabs.x).toBe(8)
    expect(geometry.tabs.y).toBeCloseTo(182.5, 0)
    expect(geometry.tabs.width).toBe(geometry.width - 16)
    expect(geometry.tabs.height).toBe(44)
    expect(geometry.tabPadding).toEqual(["12px", "12px", "12px"])
    expect(geometry.pageBottomPadding).toBe("20px")
    expect(geometry.detail.x).toBe(16)
    expect(geometry.detail.y).toBeCloseTo(242.5, 0)
    expect(geometry.detail.width).toBe(geometry.width - 32)
    expect(geometry.mobileWeight).toBe("430")
    expect(geometry.mastBox.x).toBeCloseTo(52.8, 0)
    expect(geometry.mastBox.width).toBeLessThan(80)
    expect(geometry.mastLineHeight).toBe("20.16px")
    expect(geometry.brandBox.x).toBe(8)
    expect(geometry.brandBox.width).toBeGreaterThanOrEqual(44)
    expect(geometry.brandBox.height).toBeGreaterThanOrEqual(44)
  } else {
    expect(geometry.mast.visible).toBe(false)
    expect(geometry.heading.clip).toBe("none")
    expect(geometry.heading.x).toBe(264)
    expect(geometry.heading.y).toBe(88)
    expect(geometry.heading.height).toBeGreaterThan(50)
    expect(geometry.tabs.x).toBe(264)
    expect(geometry.tabPadding).toEqual(["4px", "4px", "4px"])
    expect(geometry.pageBottomPadding).toBe("32px")
  }
})

/** Phone paint stays40px under coarse input;44px targets use the outer gutter, never a neighbouring filter. */
for (const state of ["normal", "commentsfailed"]) {
  test(`phone thread filters keep44px reach on both axes with ${state} counts`, async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 600, "Phone-only compact target layout")
    await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
      await request.fulfill({ contentType: "application/json", body: fixtureBody(CODE_REF, state) })
    })
    await page.goto(selected("review"))
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    const filters = owner(page).getByRole("group", { name: "Thread list filters" })
    const buttons = filters.getByRole("button")
    await expect(buttons).toHaveCount(3)
    if (state === "commentsfailed") await expect(buttons.first()).toHaveText("All")
    else await expect(buttons.first()).toHaveText(/^All \d+$/u)
    for (const button of await buttons.all()) {
      // Measure the button clear of the fixed bottom bar: at the initial scroll the last row sits partly under it,
      // and scrollIntoViewIfNeeded leaves an already-visible target there.
      await button.evaluate((element) => element.scrollIntoView({ block: "center" }))
      const target = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const pseudo = getComputedStyle(element, "::after")
        const centerX = rect.x + rect.width / 2
        const centerY = rect.y + rect.height / 2
        const owns = (x: number, y: number) =>
          element.ownerDocument.elementFromPoint(x, y)?.closest("button") === element
        const start = rect.x + Number.parseFloat(pseudo.insetInlineStart)
        const end = rect.right - Number.parseFloat(pseudo.insetInlineEnd)
        const inlineHits = Array.from({ length: Math.ceil(rect.width) + 16 }, (_, i) => rect.x - 8 + i)
          .filter((x) => owns(x, centerY))
        return {
          width: rect.width,
          height: rect.height,
          hitWidth: inlineHits.length,
          block: [rect.top - 1.5, centerY, rect.bottom + 1.5].map((y) => owns(centerX, y)),
          inline: [start + 1, centerX, end - 1].map((x) => owns(x, centerY)),
          outside: [start - 1, end + 1].map((x) => owns(x, centerY))
        }
      })
      expect(target.height).toBe(40)
      expect(target.hitWidth).toBeGreaterThanOrEqual(44)
      expect(target.block).toEqual([true, true, true])
      expect(target.inline).toEqual([true, true, true])
      expect(target.outside).toEqual([false, false])
      if (state === "commentsfailed" && await button.textContent() === "All") {
        expect(target.width).toBeLessThan(44)
      }
    }
  })
}

/** Scrolling clips outward rings, so only the Review views links own an inward token ring. */
test("keyboard focus stays painted inside scrolling Review and Conversation subtabs", async ({ page }) => {
  await page.goto(selected("review"))
  const tabs = owner(page).getByRole("navigation", { name: "Review views" })
  const links = tabs.getByRole("link")
  await expect(links).toHaveCount(2)
  await links.first().focus()
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key)
    const ring = await tabs.evaluate((element) => {
      const focused = element.ownerDocument.activeElement
      if (focused === null || !element.contains(focused)) throw new Error("Keyboard focus left review views")
      const style = getComputedStyle(focused)
      return {
        visible: focused.matches(":focus-visible"),
        width: Number.parseFloat(style.outlineWidth),
        offset: Number.parseFloat(style.outlineOffset),
        color: style.outlineColor,
        overflow: getComputedStyle(element).overflowX
      }
    })
    expect(ring.visible).toBe(true)
    expect(ring.width).toBeGreaterThan(0)
    expect(ring.offset + ring.width).toBeLessThanOrEqual(0)
    expect(ring.color).not.toBe("rgba(0, 0, 0, 0)")
    expect(ring.overflow).toBe("auto")
  }
  const legacy = page.getByRole("navigation", { name: "Code pages" }).getByRole("link").first()
  await legacy.focus()
  expect(await legacy.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineOffset)))
    .toBeGreaterThan(0)
})

/** DOM geometry and update semantics, not a claim about native screen-reader delivery. */
test("the host read announcement stays clipped, non-focusable and outside the changing body", async ({ page }) => {
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) =>
    request.fulfill({
      status: 200,
      json: { _tag: "Unavailable", reason: "cache_unavailable", host: null }
    }))
  await page.goto(route("pull-requests", CODE_REF))
  const region = page.locator("[data-code-review-announcement]")
  await expect(region).toHaveText("Code unavailable")
  await expect(region).toHaveAttribute("role", "status")
  await expect(region).toHaveAttribute("aria-live", "polite")
  await expect(region).toHaveAttribute("aria-atomic", "true")
  expect(
    await region.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        width: rect.width,
        height: rect.height,
        tabIndex: element.tabIndex,
        clipPath: getComputedStyle(element).clipPath,
        focusable: element.querySelectorAll("a[href],button,input,select,textarea,[tabindex]").length
      }
    })
  ).toEqual({ width: 1, height: 1, tabIndex: -1, clipPath: "inset(50%)", focusable: 0 })
})

/** Restored bundle interaction group. Counterfactual builds use the identical named guards. */
test("review retries keep one retained focus owner and announce accepted completions only", async ({ page }) => {
  let reads = 0
  const held = gate()
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    reads += 1
    if (reads === 2) await held.promise
    await request.fulfill(
      reads >= 3 ? { status: 503 } : {
        status: 200,
        body: reads === 1
          ? Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))({
            _tag: "Unavailable",
            reason: "cache_unavailable",
            host: null
          })
          : fixtureBody(CODE_REF),
        contentType: "application/json"
      }
    )
  })
  try {
    await page.goto(selected("review"))
    const section = owner(page)
    const region = section.locator("[data-code-review-announcement]")
    await expect(section).toContainText("Code unavailable")
    await expect(section.getByRole("button", { name: "Read again", exact: true })).toHaveCount(1)
    const retainedOwner = await section.elementHandle()
    const retainedRegion = await region.elementHandle()
    ok(retainedOwner)
    ok(retainedRegion)
    await section.getByRole("button", { name: "Read again", exact: true }).click()
    await expect.poll(() => reads).toBe(2)
    await expect(section).toBeFocused()
    await expect(region).toHaveText("Reading cached details…")
    await section.evaluate((element) => {
      const input = document.createElement("input")
      input.setAttribute("aria-label", "Proof editor")
      element.append(input)
      input.focus()
    })
    held.resolve()
    await expect(region).toHaveText(/^Read /)
    await expect(page.getByLabel("Proof editor")).toBeFocused()
    expect(await section.evaluate((element, prior) => element === prior, retainedOwner)).toBe(true)
    expect(await region.evaluate((element, prior) => element === prior, retainedRegion)).toBe(true)
    expect(await section.evaluate((element) => element.querySelectorAll("[role=status]").length)).toBe(1)
  } finally {
    held.resolve()
  }
})

for (const state of ["historyfailed", "bothfailed"]) {
  test(`Conversation ${state} has exactly one reachable retry after a retained transport failure`, async ({ context, page }) => {
    await page.goto("/")
    await context.addCookies([{ name: "code-fixture", value: state, url: new URL(page.url()).origin }])
    await page.goto(selected("conversation"))
    const section = owner(page)
    await expect(section.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible()
    const held = gate()
    let started = false
    await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
      started = true
      await held.promise
      await request.fulfill({ status: 503 })
    })
    try {
      // The retained controller explicitly re-reads once when the module becomes active again.
      // Reactivation is the documented retained-controller read trigger.
      await page.evaluate(() => {
        const link = document.createElement("a")
        link.href = "/#usage/by-tool"
        document.body.append(link)
        link.click()
        link.remove()
      })
      await expect(page.locator("[data-module=\"usage\"]")).toBeVisible()
      await page.goBack()
      await expect.poll(() => started).toBe(true)
      held.resolve()
      await expect(section).toContainText("The hub could not complete this read.")
      const retry = section.getByRole("button", { name: "Read again", exact: true })
      await expect(retry).toHaveCount(1)
      await expect(retry).toBeVisible()
      await retry.click()
      await expect(section).toBeFocused()
    } finally {
      held.resolve()
    }
  })
}

test("a direct secondary target waits for the exact selected file then mounts and focuses once", async ({ page }) => {
  const review = gate()
  const content = gate()
  let reviewStarted = false
  let contentStarted = false
  const queries: Array<CodeDiffContentQuery> = []
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    reviewStarted = true
    await review.promise
    await request.fulfill({ status: 200, contentType: "application/json", body: fixtureBody(CODE_REF) })
  })
  await page.route(/\/v1\/modules\/code\/diff-content\?/, async (request) => {
    queries.push(Schema.decodeUnknownSync(CodeDiffContentQuery)(new URL(request.request().url()).searchParams))
    contentStarted = true
    await content.promise
    const response = await request.fetch()
    const reading = Schema.decodeUnknownSync(CodeDiffContentResult)(await response.json())
    await request.fulfill({ response, body: Schema.encodeSync(Schema.fromJsonString(CodeDiffContentResult))(reading) })
  })
  try {
    await page.goto(selected("review", `&file=1&thread=${secondaryTarget}`))
    await expect.poll(() => reviewStarted).toBe(true)
    await expect(card(page, CODE_SECONDARY_CLAIM)).toHaveCount(0)
    review.resolve()
    await expect.poll(() => contentStarted).toBe(true)
    await expect(card(page, CODE_SECONDARY_CLAIM)).toHaveCount(0)
    content.resolve()
    await expect(card(page, CODE_SECONDARY_CLAIM)).toHaveCount(1)
    await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
    const rendered = owner(page).getByRole("table", { name: "Changes in src/bounds.ts", exact: true })
    await expect(rendered).toBeVisible()
    await expect(rendered.getByRole("article").filter({ hasText: CODE_SECONDARY_CLAIM })).toHaveCount(1)
    await expect(rendered.locator("[id$=\"-new-1\"]")).toHaveText("1")
    expect(
      await card(page, CODE_SECONDARY_CLAIM).evaluate((element) =>
        element.closest("[data-rly-patch-diff] table") !== null
      )
    ).toBe(true)
    await expect(owner(page)).not.toContainText("The hub returned an unexpected reading.")
    expect(queries).toEqual([{
      ref: CODE_REF,
      revisionId: "revision-752",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      fileIndex: 1
    }])
    await expect(owner(page).getByRole("button", { name: "P2 and below (1)", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    await owner(page).getByRole("button", { name: "P2 and below (1)", exact: true }).click()
    await expect(card(page, CODE_SECONDARY_CLAIM)).toHaveCount(0)
    const hiddenGroup = owner(page).locator("[hidden]")
    await expect(hiddenGroup.getByRole("link", { name: /Keep the bound visible/, includeHidden: true })).toHaveCount(1)
    expect(await hiddenGroup.evaluate((element) => element.getClientRects().length)).toBe(0)
  } finally {
    review.resolve()
    content.resolve()
  }
})

test("Conversation finding links preserve the Code route, secondary focus and native href across Back", async ({ context, page }) => {
  let reviews = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/modules/code/review") reviews += 1
  })
  await page.goto(selected("conversation", "&file=1"))
  const discussion = owner(page).getByRole("link", { name: /Keep the bound visible/ })
  await expect(discussion).toBeVisible()
  const href = await discussion.getAttribute("href")
  ok(href)
  const destination = new URL(href, page.url())
  expect(destination.hash).toBe("#code/pull-requests")
  expect(destination.searchParams.get("ref")).toBe(CODE_REF)
  const canonical = canonicalCodeSelection(destination.searchParams, "pull-requests")
  expect(canonical.selection.view).toBe("review")
  expect(canonical.selection.thread).toEqual({ source: "agent", id: "secondary" })
  expect(destination.searchParams.toString()).toBe(canonical.search.toString())
  expect(destination.searchParams.get("file")).toBe("1")
  const before = page.url()
  const history = await page.evaluate(() => window.history.length)
  await discussion.focus()
  await page.keyboard.press("Enter")
  await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
  expect(page.url()).toBe(destination.href)
  expect(await page.evaluate(() => window.history.length)).toBe(history + 1)
  expect(reviews).toBe(1)
  await page.goBack()
  await expect(discussion).toBeVisible()
  expect(page.url()).toBe(before)
  // A complete copied/new-tab URL must work without the delegated click handler.
  const native = await context.newPage()
  try {
    await native.goto(destination.href)
    await expect(card(native, CODE_SECONDARY_CLAIM)).toBeFocused()
    expect(native.url()).toBe(destination.href)
  } finally {
    await native.close()
  }
  await page.goForward()
  await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
  await owner(page).getByRole("link", { name: /Keep the bound visible/ }).focus()
  await page.keyboard.press("Enter")
  await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
  expect(await page.evaluate(() => window.history.length)).toBe(history + 1)
  expect(
    await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id)
      return new Set(ids).size === ids.length
    })
  ).toBe(true)
})

test("unsupported Guide replaces only incompatible selectors and leaves no Back ghost", async ({ page }) => {
  const calls: Array<string> = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith("/v1/modules/code/")) calls.push(path)
  })
  await page.goto(route("pull-requests"))
  const previous = page.url()
  const length = await page.evaluate(() => history.length)
  await page.evaluate((href) => {
    const link = document.createElement("a")
    link.href = href
    document.body.append(link)
    link.click()
    link.remove()
  }, selected("review", `&file=1&thread=${primaryTarget}`).replace("view=review", "view=guide"))
  await expect(owner(page).getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  const repaired = new URL(page.url())
  expect(repaired.hash).toBe("#code/pull-requests")
  expect(repaired.searchParams.get("ref")).toBe(CODE_REF)
  expect(repaired.searchParams.get("file")).toBe("1")
  expect(repaired.searchParams.get("filter")).toBe("open")
  expect(repaired.searchParams.get("search")).toBe("")
  expect(repaired.searchParams.get("offset")).toBe("0")
  expect(repaired.searchParams.get("thread")).toBeNull()
  expect(repaired.searchParams.get("view")).not.toBe("guide")
  await expect(owner(page).getByRole("link", { name: "Guide", exact: true })).toHaveCount(0)
  expect(calls.some((path) => path.includes("guide"))).toBe(false)
  expect(await page.evaluate(() => history.length)).toBe(length + 1)
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(page.url()).toBe(previous)
})

test("late old-ref reading cannot steal focus or expose the wrong PR after subject navigation", async ({ page }) => {
  const held = gate()
  const settled = gate()
  let started = false
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    const ref = new URL(request.request().url()).searchParams.get("ref")
    if (ref === CODE_REF) {
      started = true
      await held.promise
    }
    ok(ref)
    try {
      await request.fulfill({ status: 200, contentType: "application/json", body: fixtureBody(ref) })
    } finally {
      if (ref === CODE_REF) settled.resolve()
    }
  })
  try {
    await page.goto(selected("review", `&thread=${primaryTarget}`))
    await expect.poll(() => started).toBe(true)
    await page.evaluate((href) => {
      const link = document.createElement("a")
      link.href = href
      document.body.append(link)
      link.click()
      link.remove()
    }, route("pull-requests", CODE_OTHER_REF))
    await expect(owner(page)).toContainText("The other saved review is independent.")
    const close = returnToQueue(page)
    await close.focus()
    held.resolve()
    await settled.promise
    await expect(close).toBeFocused()
    await expect(owner(page)).not.toContainText("Keep the cached reading and bound explicit.")
    await close.click()
    await expect(reviewPage(page)).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
    expect(await page.evaluate(() => document.querySelector("[data-module=\"code\"]")?.closest("[inert]"))).toBeNull()
  } finally {
    held.resolve()
  }
})

test("inactive held review neither announces nor steals the arriving module focus", async ({ page }) => {
  const held = gate()
  const settled = gate()
  let reads = 0
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    const number = ++reads
    if (number === 1) await held.promise
    try {
      await request.fulfill({ status: 200, contentType: "application/json", body: fixtureBody(CODE_REF) })
    } finally {
      if (number === 1) settled.resolve()
    }
  })
  await page.addInitScript(() => {
    const focus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function(options) {
      if (this.closest("[hidden],[inert],[aria-hidden=\"true\"]") !== null) {
        document.documentElement.dataset.hiddenReviewFocusAttempt = "true"
      }
      focus.call(this, options)
    }
  })
  try {
    await page.goto(selected("review", `&thread=${primaryTarget}`))
    await expect.poll(() => reads).toBe(1)
    await page.evaluate(() => {
      const link = document.createElement("a")
      link.href = "/#usage/by-tool"
      document.body.append(link)
      link.click()
      link.remove()
    })
    const usage = page.locator("[data-module=\"usage\"]")
    await expect(usage).toBeVisible()
    await expect.poll(() => usage.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    held.resolve()
    await settled.promise
    await expect(usage).toBeVisible()
    expect(await usage.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.dataset.hiddenReviewFocusAttempt)).toBeUndefined()
    await expect(page.locator("[data-code-review-announcement]:visible")).toHaveCount(0)
    await page.goBack()
    await expect.poll(() => reads).toBe(2)
    await expect(card(page, CODE_PRIMARY_CLAIM)).toBeFocused()
  } finally {
    held.resolve()
  }
})

test("Back and Forward restore the exact PR discussion, file and target without other-subject carryover", async ({ page }) => {
  await page.goto(route("pull-requests"))
  const other = page.locator(".code-host-row").filter({ hasText: "Keep the file reader bounded" })
  await expect(other).toBeVisible()
  const otherHref = await other.getAttribute("href")
  ok(otherHref)
  await page.goto(selected("conversation", "&file=1"))
  const original = page.url()
  const discussion = owner(page).getByRole("link", { name: /Keep the bound visible/ })
  await expect(discussion).toBeVisible()
  await discussion.click()
  await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
  const targeted = page.url()
  const otherURL = new URL(otherHref, page.url())
  expect(otherURL.searchParams.get("view")).not.toBe("conversation")
  expect(otherURL.searchParams.get("thread")).toBeNull()
  expect(otherURL.searchParams.get("file")).toBeNull()
  // Activate the actual queue href saved before entering the full-page PR.
  await page.evaluate((href) => {
    const link = document.createElement("a")
    link.href = href
    document.body.append(link)
    link.click()
    link.remove()
  }, otherHref)
  await expect(owner(page)).toContainText("The other saved review is independent.")
  const otherLocation = page.url()
  await page.goBack()
  await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
  expect(page.url()).toBe(targeted)
  await expect(owner(page)).not.toContainText("The other saved review is independent.")
  await page.goBack()
  await expect(owner(page).getByRole("heading", { name: "Conversation", exact: true })).toBeVisible()
  expect(page.url()).toBe(original)
  await page.goForward()
  await expect(card(page, CODE_SECONDARY_CLAIM)).toBeFocused()
  expect(page.url()).toBe(targeted)
  await page.goForward()
  await expect(owner(page)).toContainText("The other saved review is independent.")
  expect(page.url()).toBe(otherLocation)
  await returnToQueue(page).click()
  await expect(reviewPage(page)).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has("ref")).toBe(false)
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
})

test("identical completed failures update one mounted region through its reachable local retry", async ({ page }) => {
  let reads = 0
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    reads += 1
    await request.fulfill({ status: 503 })
  })
  await page.goto(selected("review"))
  const section = owner(page)
  const region = section.locator("[data-code-review-announcement]")
  await expect(region).toHaveText("The hub could not complete this read.")
  const original = await region.elementHandle()
  ok(original)
  await expect(region.locator("[data-completed-read]")).toHaveAttribute("data-completed-read", /^\d+$/)
  const completions = [await region.locator("[data-completed-read]").getAttribute("data-completed-read")]
  for (const count of [2, 3]) {
    const retry = section.getByRole("button", { name: "Read again", exact: true })
    await expect(retry).toHaveCount(1)
    await expect(retry).toBeVisible()
    await expect(retry).toBeEnabled()
    const retrySize = await retry.evaluate((element) => {
      const content = element.firstElementChild
      if (content === null) throw new Error("Rly retry content is missing")
      const style = getComputedStyle(element)
      return {
        width: element.getBoundingClientRect().width,
        intrinsicWidth: content.getBoundingClientRect().width +
          Number.parseFloat(style.paddingInlineStart) + Number.parseFloat(style.paddingInlineEnd) +
          Number.parseFloat(style.borderInlineStartWidth) + Number.parseFloat(style.borderInlineEndWidth)
      }
    })
    expect(retrySize.width).toBeCloseTo(retrySize.intrinsicWidth, 1)
    const previous = completions.at(-1)
    ok(previous)
    await retry.click()
    await expect.poll(() => reads).toBe(count)
    await expect(section).toBeFocused()
    await expect(region).toHaveText("The hub could not complete this read.")
    await expect(region.locator("[data-completed-read]")).not.toHaveAttribute("data-completed-read", previous)
    completions.push(await region.locator("[data-completed-read]").getAttribute("data-completed-read"))
    expect(await region.evaluate((element, prior) => element === prior, original)).toBe(true)
  }
  expect(completions.every((value) => value !== null)).toBe(true)
  expect(new Set(completions).size).toBe(3)
})

/** Pending prose uses the page rhythm even while its accepted request is still held. */
test("pending Code review panel keeps its15px22.5px prose rhythm", async ({ page }) => {
  const held = gate()
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    await held.promise
    await request.fulfill({ contentType: "application/json", body: fixtureBody(CODE_REF) })
  })
  try {
    await page.goto(selected("review"))
    const panel = owner(page).locator("[data-code-read-notice='loading']")
    await expect(panel).toBeVisible()
    const prose = await panel.locator("p").evaluate((element) => ({
      size: getComputedStyle(element).fontSize,
      line: getComputedStyle(element).lineHeight
    }))
    expect(prose).toEqual({ size: "15px", line: "22.5px" })
    held.resolve()
    await expect(owner(page)).toHaveAttribute("data-code-review-read-state", "Ready")
  } finally {
    held.resolve()
  }
})

/** Inline and outside outdated annotations own their rhythm; Conversation restores feed defaults. */
for (const outdated of [false, true]) {
  test(`${outdated ? "separate outdated" : "inline"} human annotation typography does not change the Conversation feed`, async ({ page }) => {
    const value = codeReviewFixture(CODE_REF, 1_700_000_000_000, "normal")
    ok(value?._tag === "Ready")
    const conversations = value.reading.workspace.conversations
    ok(conversations._tag === "Ready")
    const first = conversations.threads[0]?.messages[0]
    ok(first)
    const reading = Schema.decodeUnknownSync(CodeReviewResult)({
      ...value,
      reading: {
        ...value.reading,
        workspace: {
          ...value.reading.workspace,
          conversations: {
            ...conversations,
            threads: conversations.threads.map((thread) => ({
              ...thread,
              anchor: { _tag: "Line", path: "src/bounds.ts", line: 1, side: "after", outdated },
              messages: [...thread.messages, {
                ...first,
                id: "provider-reply",
                author: "Contributor",
                text: "Recorded reply."
              }]
            }))
          }
        }
      }
    })
    await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
      await request.fulfill({
        contentType: "application/json",
        body: Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(reading)
      })
    })
    await page.goto(selected("review", "&file=1"))
    const inline = owner(page).locator(
      outdated
        ? "[data-review-presentation='review'] > div > article[data-review-thread-outdated]"
        : "[data-rly-patch-diff] td > article"
    )
    await expect(inline).toHaveCount(1)
    await expect(inline).toBeVisible()
    await expect(inline.locator("[data-review-message-id]")).toHaveCount(2)
    const phases = [
      { article: inline, size: "15px", line: outdated ? "22.5px" : "24px", author: "620", time: "13px" },
      {
        // The feed also carries the agent finding's own discussion (shipped Conversation design); judge the human thread.
        article: owner(page).locator("[data-review-presentation='conversation'] article:has([data-review-message-id])")
          .filter({ has: page.getByRole("heading", { name: "CodeCommit", exact: true }) }),
        size: "14px",
        line: "21px",
        author: "600",
        time: "12px"
      }
    ]
    for (const [index, phase] of phases.entries()) {
      if (index > 0) await owner(page).getByRole("link", { name: "Conversation", exact: true }).click()
      await expect(phase.article).toHaveCount(1)
      if (outdated && index === 0) {
        await expect(phase.article.locator("header code")).toHaveCSS("font-size", "13.3333px")
        await expect(phase.article.locator("header code")).toHaveCSS("line-height", "20px")
      }
      const metrics = await phase.article.locator("[data-review-message-id]").evaluateAll((posts) =>
        posts.map((post) => {
          const body = post.lastElementChild
          const author = post.querySelector("strong")
          const time = post.querySelector("time")
          if (body === null || author === null || time === null) throw new Error("Recorded message is incomplete")
          return {
            size: getComputedStyle(body).fontSize,
            line: getComputedStyle(body).lineHeight,
            family: getComputedStyle(body).fontFamily,
            author: getComputedStyle(author).fontWeight,
            time: getComputedStyle(time).fontSize,
            padding: getComputedStyle(post).paddingBlockStart
          }
        })
      )
      expect(metrics).toHaveLength(2)
      for (const metric of metrics) {
        expect(metric).toMatchObject({
          size: phase.size,
          line: phase.line,
          author: phase.author,
          time: phase.time,
          padding: "0px"
        })
        expect(metric.family).toContain("Geist")
        expect(metric.family).not.toContain("Mono")
      }
    }
  })
}

/** A recorded note keeps the inline prose rhythm while the StateLabel and separate-card defaults stay compact. */
test("dismissed notes use their actual inline or separate card rhythm", async ({ page }) => {
  const value = codeReviewFixture(CODE_REF, 1_700_000_000_000, "normal")
  ok(value?._tag === "Ready")
  const run = value.reading.workspace.run
  ok(run._tag === "Ready")
  const reading = Schema.decodeUnknownSync(CodeReviewResult)({
    ...value,
    reading: {
      ...value.reading,
      workspace: {
        ...value.reading.workspace,
        run: {
          ...run,
          run: {
            ...run.run,
            threads: run.run.threads.map((thread) => ({
              ...thread,
              finding: thread.finding === null ? null : {
                ...thread.finding,
                disposition: { _tag: "Dismissed", reason: "false_positive", note: "Recorded evidence" }
              }
            }))
          }
        }
      }
    }
  })
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    await request.fulfill({
      contentType: "application/json",
      body: Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(reading)
    })
  })
  await page.goto(selected("review", "&file=0"))
  const finding = card(page, CODE_PRIMARY_CLAIM)
  const status = finding.locator("[data-review-disposition=Dismissed]")
  await expect(finding.locator("xpath=ancestor::table")).toHaveCount(1)
  await expect(status).toHaveCSS("font-size", "14px")
  await expect(status).toHaveCSS("line-height", "22.4px")
  await expect(status.locator(":scope > span").first()).toHaveCSS("font-size", "12px")
  await expect(status.locator(":scope > span").first()).toHaveCSS("line-height", "16px")
  await expect(status.locator(":scope > span").last()).toHaveCSS("line-height", "22.4px")
  await expect(status).toHaveText("Dismissed: False positive, ‘Recorded evidence’")
  await page.goto(selected("review", "&file=1"))
  await expect(finding.locator("xpath=ancestor::table")).toHaveCount(0)
  await expect(status).toHaveCSS("line-height", "21px")
})

/** Refused parsing preserves complete raw bytes and wraps only the display, including leading blank lines. */
test("rejected raw review files retain source lines without horizontal overflow", async ({ page }) => {
  const before = "\n".repeat(20) + "before source\n"
  const after = "\n".repeat(20) + "long recorded source ".repeat(30) + "\n"
  // The Review view takes its file inventory from the review reading, not the Diffs page's diff read.
  await page.route(/\/v1\/modules\/code\/review\?/, async (route) => {
    const value = codeReviewFixture(CODE_REF, 1_700_000_000_000, "normal")
    ok(value?._tag === "Ready")
    const invalid = Schema.decodeUnknownSync(CodeReviewResult)({
      ...value,
      reading: {
        ...value.reading,
        diff: {
          ...value.reading.diff,
          files: value.reading.diff.files.map((file) => ({ ...file, beforeMode: "invalid-mode" }))
        }
      }
    })
    await route.fulfill({
      contentType: "application/json",
      body: Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(invalid)
    })
  })
  await page.route(/\/v1\/modules\/code\/diff-content\?/, async (route) => {
    const response = await route.fetch()
    const value = Schema.decodeUnknownSync(CodeDiffContentResult)(await response.json())
    ok(value._tag === "Ready")
    const content = Schema.decodeUnknownSync(CodeDiffContentResult)({
      ...value,
      content: { ...value.content, before, after }
    })
    await route.fulfill({ response, body: Schema.encodeSync(Schema.fromJsonString(CodeDiffContentResult))(content) })
  })
  await page.goto(selected("review", "&file=0"))
  const raw = owner(page).locator("[data-code-review-diff] > section").filter({
    has: page.getByRole("heading", { name: "src/reading.ts", exact: true })
  })
  await expect(raw.locator("pre")).toHaveCount(2)
  const metrics = await raw.locator("pre").evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent,
      width: node.clientWidth,
      scroll: node.scrollWidth,
      size: getComputedStyle(node).fontSize,
      line: getComputedStyle(node).lineHeight,
      whitespace: getComputedStyle(node).whiteSpace,
      borders: [
        getComputedStyle(node).borderBlockStartWidth,
        getComputedStyle(node).borderInlineEndWidth,
        getComputedStyle(node).borderBlockEndWidth,
        getComputedStyle(node).borderInlineStartWidth
      ]
    }))
  )
  expect(metrics.map((value) => value.text)).toEqual([before, after])
  for (const metric of metrics) {
    expect(metric.scroll).toBeLessThanOrEqual(metric.width)
    expect(metric).toMatchObject({
      size: "12px",
      line: "19.2px",
      whitespace: "pre-wrap",
      borders: ["1px", "1px", "1px", "1px"]
    })
  }
  const sections = raw.locator(".code-host-file-columns > section")
  await expect(sections.first()).toHaveCSS("padding-block-start", "0px")
  await expect(sections.last()).toHaveCSS("padding-block-start", "8px")
  for (const heading of await sections.locator("h3").all()) {
    await expect(heading).toHaveCSS("margin-inline-start", "16px")
    await expect(heading).toHaveCSS("margin-inline-end", "16px")
    await expect(heading).toHaveCSS("padding-inline-start", "0px")
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(raw.locator("[data-code-read-notice=failure]")).toContainText("The hub returned an unexpected reading.")
  await expect(owner(page).getByRole("region", { name: "Not tied to a line", exact: true })).toBeVisible()
  const blocks = raw.locator("pre")
  for (const forcedColors of ["none", "active"] satisfies ReadonlyArray<"none" | "active">) {
    await page.emulateMedia({ forcedColors })
    await blocks.first().focus()
    for (const [key, index] of [["Tab", 1], ["Shift+Tab", 0]] satisfies ReadonlyArray<readonly [string, number]>) {
      await page.keyboard.press(key)
      await expect(blocks.nth(index)).toBeFocused()
      const ring = await blocks.nth(index).evaluate((element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        const width = Number.parseFloat(style.outlineWidth)
        const offset = Number.parseFloat(style.outlineOffset)
        const reach = Math.max(0, width + offset)
        const clipped: Array<string> = []
        for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          const clip = getComputedStyle(ancestor)
          const bounds = ancestor.getBoundingClientRect()
          if (
            ["auto", "scroll", "hidden", "clip"].includes(clip.overflowX) &&
            (box.left - reach < bounds.left + Number.parseFloat(clip.borderLeftWidth) - 0.5 ||
              box.right + reach > bounds.right - Number.parseFloat(clip.borderRightWidth) + 0.5)
          ) clipped.push("inline")
          if (
            ["auto", "scroll", "hidden", "clip"].includes(clip.overflowY) &&
            (box.top - reach < bounds.top + Number.parseFloat(clip.borderTopWidth) - 0.5 ||
              box.bottom + reach > bounds.bottom - Number.parseFloat(clip.borderBottomWidth) + 0.5)
          ) clipped.push("block")
        }
        return { visible: element.matches(":focus-visible"), width, offset, color: style.outlineColor, clipped }
      })
      expect(ring.visible).toBe(true)
      expect(ring.width).toBeGreaterThan(0)
      expect(ring.offset + ring.width).toBeLessThanOrEqual(0)
      expect(ring.color).not.toBe("rgba(0, 0, 0, 0)")
      expect(ring.clipped).toEqual([])
    }
  }
  await returnToQueue(page).click()
  await page.getByRole("navigation", { name: "Code pages" }).getByRole("link", { name: "Diffs", exact: true }).click()
  await page.locator(".code-host-row").first().click()
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("link", { name: "src/reading.ts modified" })
    .click()
  const legacy = page.locator(".code-host-file pre")
  await expect(legacy).toHaveCount(2)
  await legacy.first().focus()
  await page.keyboard.press("Tab")
  await expect(legacy.last()).toBeFocused()
  expect(await legacy.last().evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineOffset)))
    .toBeGreaterThan(0)
})

/** Recorded Explain prose is paragraphs, not a derived verdict or an empty quote. */
test("Explain preserves recorded paragraphs without a phantom verdict line", async ({ page }) => {
  const value = codeReviewFixture(CODE_REF, 1_700_000_000_000, "normal")
  ok(value?._tag === "Ready")
  const run = value.reading.workspace.run
  ok(run._tag === "Ready")
  const paragraphs = ["First recorded paragraph.", "Second recorded paragraph.", "Third recorded paragraph."]
  const reading = Schema.decodeUnknownSync(CodeReviewResult)({
    ...value,
    reading: {
      ...value.reading,
      workspace: {
        ...value.reading.workspace,
        run: {
          ...run,
          run: {
            ...run.run,
            kind: "explain",
            summary: "",
            explanation: paragraphs.join("\n\n"),
            threads: [],
            profile: run.run.profile === null ? null : { ...run.run.profile, kind: "explain" }
          }
        }
      }
    }
  })
  await page.route(/\/v1\/modules\/code\/review\?/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(reading)
    })
  })
  await page.goto(selected("review", "&file=0"))
  const summary = owner(page).locator("[data-review-summary=recorded]")
  await expect(summary).toBeVisible()
  await expect(summary.locator("blockquote")).toHaveCount(0)
  await expect(summary.locator("h3 ~ p")).toHaveText(paragraphs)
  await expect(summary.getByRole("heading", { name: "Change explanation", exact: true })).toHaveCSS("font-size", "18px")
  await expect(summary.getByRole("heading", { name: "Change explanation", exact: true })).toHaveCSS(
    "letter-spacing",
    "-0.18px"
  )
  await expect(summary.getByRole("heading", { name: "Change explanation", exact: true })).toHaveCSS(
    "line-height",
    "27px"
  )
})

/** A revision mismatch panel shares the ordinary notice prose rhythm rather than inheriting page leading. */
test("revision notice prose keeps its scoped paragraph rhythm", async ({ page }) => {
  const revision = codeReviewFixture(CODE_REF, 1_700_000_000_000, "different")
  ok(revision?._tag === "Ready")
  await page.route(/\/v1\/modules\/code\/review\?/, async (request) => {
    await request.fulfill({
      contentType: "application/json",
      body: Schema.encodeSync(Schema.fromJsonString(CodeReviewResult))(revision)
    })
  })
  await page.goto(selected("review"))
  const notice = owner(page).locator("[data-review-revision=different]")
  await expect(notice).toBeVisible()
  await expect(notice.locator("p")).toHaveCSS("font-size", "14px")
  await expect(notice.locator("p")).toHaveCSS("line-height", "21px")
})
