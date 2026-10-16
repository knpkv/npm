/** Capture the built canonical Hub, never an alternate component gallery. @module */
import { CodeDiffContentQuery, CodeQueueQuery, CodeTargetQuery } from "@knpkv/codecommit-web/host"
import type { Page } from "@playwright/test"
import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect"
import { browserCall } from "../../../design-conformance/src/browser.js"
import { LiveProduct, type StartProduct } from "../../../design-conformance/src/live.js"
import { RunnerFailure } from "../../../design-conformance/src/schema.js"
import { serveFiles } from "../../../design-conformance/src/server.js"
import type { fontPreloadLink } from "../../src/font-preload.js"
import type { dashboardPage } from "../../src/internal/dashboard-page.js"
import type { loadUiAssets } from "../../src/internal/ui-assets.js"
import { CODE_REFERENCE, makeCodeReadings } from "./fixtures.js"
import { isConversationState, readReviewCapability, reviewInventory, ReviewState } from "./inventory.js"

const PageModule = Schema.Struct({
  dashboardPage: Schema.declare((value): value is typeof dashboardPage => Predicate.isFunction(value))
})

const FontModule = Schema.Struct({
  fontPreloadLink: Schema.declare((value): value is typeof fontPreloadLink => Predicate.isFunction(value))
})

const AssetsModule = Schema.Struct({
  loadUiAssets: Schema.declare((value): value is typeof loadUiAssets => Predicate.isFunction(value))
})

/** Render the actual shell with the same served-font inputs as the Hub. */
export const renderCaptureDocument = (
  snapshot: Parameters<typeof dashboardPage>[0],
  fonts: ReadonlyMap<string, Uint8Array>,
  app: typeof PageModule.Type,
  preloads: typeof FontModule.Type
): string => app.dashboardPage(snapshot, preloads.fontPreloadLink(fonts))

/**
 * Annotate existing semantic nodes only. Missing regions remain missing evidence for the gate.
 * The shell tags its own regions for other products; this product's catalog replaces them, so each region
 * occurs exactly once.
 */
const markActualRegions = (page: Page, state: ReviewState) =>
  browserCall("mark actual Code regions", async () => {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("[data-region]")) element.removeAttribute("data-region")
    })
    const codePage = page.locator("[data-code-review-page]")
    const owner = codePage.locator("[data-code-review-owner]")
    const conversation = owner.locator(
      "[data-review-presentation=\"conversation\"] > section[aria-label=\"Conversation\"]"
    )
    const index = owner.getByRole("region", { name: "Threads", exact: true }).filter({
      has: page.getByRole("group", { name: "Thread list filters", exact: true })
    })
    const threads = await index.count() > 0 ?
      index :
      owner.locator("[data-review-threads-fallback][aria-label=Threads]")
    const list = await conversation.count() === 0 ? threads : conversation
    const summary = owner.locator(
      "[data-review-summary=\"recorded\"], [data-review-presentation=\"review\"] [data-review-run-fallback]"
    )
    const runNotice = owner.locator("[data-review-run-fallback]").getByRole("status")
    const threadsNotice = owner.locator("[data-review-threads-fallback]").getByRole("status")
    const combinedNotices = await runNotice.count() > 0 && await threadsNotice.count() > 0
    const revisionNotice = owner.locator("[data-review-revision=different]")
    const diffNotice = owner.locator(
      "[data-code-review-diff] [data-code-read-notice=failure], [data-code-review-diff] [data-code-read-notice=unavailable]"
    )
    const notice = state === "code-owner-unavailable"
      ? owner.locator(":scope > [data-code-read-notice=unavailable]")
      : state === "review-transport-failed"
      ? owner.locator(":scope > [data-code-read-notice=failure]")
      : combinedNotices
      ? threadsNotice
      : await runNotice.count() > 0 ?
      runNotice :
      await threadsNotice.count() > 0 ?
      threadsNotice :
      await revisionNotice.count() > 0 ?
      revisionNotice :
      await diffNotice.count() > 0 ?
      diffNotice :
      owner.locator(":scope > p.code-host-problem").filter({ hasNotText: /^Previous reading/u })
    const status = state === "read-pending"
      ? owner.locator(":scope > [data-code-read-notice=loading]")
      : state === "read-retained"
      ? codePage.locator("[data-code-review-retained]")
      : owner.locator("[data-code-review-diff] [data-code-read-notice=loading] > p")
    const phone = await page.evaluate(() => matchMedia("(max-width: 599px)").matches)
    const regions = new Map([
      [
        "nav",
        page.locator(".superapp-module-nav").or(page.getByRole("navigation", { name: "Mobile modules", exact: true }))
      ],
      ["header", page.locator(phone ? ".superapp-phone-title" : "[data-code-review-page] > header")],
      ["tabs", page.getByRole("navigation", { name: "Code pages", exact: true })],
      ["detail", page.locator("[data-code-review-header]")],
      ["subtabs", owner.getByRole("navigation", { name: "Review views", exact: true })],
      ["summary", summary],
      ["list", list],
      ["notice", notice],
      ["status", status],
      ["recorded", owner.getByRole("region", { name: "Recorded findings", exact: true })],
      ["action", codePage.getByRole("button", { name: "Read again", exact: true })],
      ["diff", owner.locator("[data-code-review-diff]")],
      ["unanchored", owner.getByRole("region", { name: "Not tied to a line", exact: true })]
    ])
    if (combinedNotices) regions.set("history-notice", runNotice)
    for (const [name, candidate] of regions) {
      const node = candidate.filter({ visible: true })
      const count = await node.count()
      if (count > 1) throw new RunnerFailure({ detail: `Ambiguous actual Code region ${name}: ${count} nodes` })
      if (count === 1 && await node.isVisible()) {
        await node.evaluate((element, region) => element.setAttribute("data-region", region), name)
      }
    }
  })

/** Reject selectors this synthetic reading does not own rather than returning another subject's data. */
export const resolveFixtureRead = (readings: ReturnType<typeof makeCodeReadings>, url: URL) => {
  switch (url.pathname) {
    case "/v1/dashboard":
      return readings.snapshot
    case "/v1/pending-approvals":
      return readings.snapshot.pendingApprovals
    case "/v1/modules/connect/needs-you":
      return readings.needsYou
    case "/v1/connect/limits":
      return readings.limits
    case "/v1/connect/usage":
      return readings.usage
    case "/v1/connect/agents":
      return readings.agents
    case "/v1/push/blocked-settings":
      return readings.blockedSettings
    case "/v1/work":
      return readings.work
    case "/v1/relay/session":
      return readings.session
    case "/v1/relay/backends":
      return readings.backends
    case "/v1/modules/code/queue": {
      const query = Schema.decodeUnknownResult(CodeQueueQuery)(url.searchParams)
      return Result.isSuccess(query) && query.success.filter === "open" && query.success.search === "" &&
          query.success.offset === 0
        ? readings.queue
        : undefined
    }
    case "/v1/modules/code/detail":
    case "/v1/modules/code/review": {
      const query = Schema.decodeUnknownResult(CodeTargetQuery)(url.searchParams)
      if (Result.isFailure(query) || query.success.ref !== CODE_REFERENCE) return undefined
      return url.pathname.endsWith("/detail") ? readings.detail : readings.review
    }
    case "/v1/modules/code/diff-content": {
      const query = Schema.decodeUnknownResult(CodeDiffContentQuery)(url.searchParams)
      if (Result.isFailure(query) || readings.review._tag !== "Ready") return undefined
      const { diff } = readings.review.reading
      const value = query.success
      return value.ref === CODE_REFERENCE && value.revisionId === diff.revisionId &&
          value.baseCommit === diff.baseCommit &&
          value.headCommit === diff.headCommit
        ? readings.contents[value.fileIndex]
        : undefined
    }
  }
  return undefined
}

/** Source and capture errors remain failures instead of becoming a screenshot of a fixture error. */
export const start: StartProduct = Effect.fn("CodeReviewConformance.start")(function*(fixture, repository) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const capability = yield* readReviewCapability(repository)
  const dist = path.join(repository, "packages/herdr-hub/dist")
  const pageUrl = yield* path.toFileUrl(path.join(dist, "internal/dashboard-page.js")).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub page path: ${cause.message}` }))
  )
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(pageUrl.href),
    catch: (cause) => new RunnerFailure({ detail: `Cannot load built Hub page: ${String(cause)}` })
  })
  const app = yield* Schema.decodeUnknownEffect(PageModule)(module).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub page module: ${cause.message}` }))
  )
  const fontUrl = yield* path.toFileUrl(path.join(dist, "font-preload.js")).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub preload path: ${cause.message}` }))
  )
  const fontModule: unknown = yield* Effect.tryPromise({
    try: () => import(fontUrl.href),
    catch: (cause) => new RunnerFailure({ detail: `Cannot load built Hub preloads: ${String(cause)}` })
  })
  const preloads = yield* Schema.decodeUnknownEffect(FontModule)(fontModule).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub preload module: ${cause.message}` }))
  )
  const assetsUrl = yield* path.toFileUrl(path.join(dist, "internal/ui-assets.js")).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub assets path: ${cause.message}` }))
  )
  const assetsModule: unknown = yield* Effect.tryPromise({
    try: () => import(assetsUrl.href),
    catch: (cause) => new RunnerFailure({ detail: `Cannot load built Hub assets: ${String(cause)}` })
  })
  const assets = yield* Schema.decodeUnknownEffect(AssetsModule)(assetsModule).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub assets module: ${cause.message}` }))
  )
  const uiAssets = yield* assets.loadUiAssets(dist)
  const readings = yield* Effect.try({
    try: () => makeCodeReadings(fixture.data),
    catch: (cause) => new RunnerFailure({ detail: `Invalid Code reference fixture: ${String(cause)}` })
  })
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "code-review-conformance-" })
  const html = path.join(temporary, "index.html")
  const files = new Map([["/", path.relative(repository, html)]])
  for (const name of yield* fs.readDirectory(dist)) {
    if (/^[a-zA-Z0-9_.-]+\.(?:js|css|woff2|png|svg)$/u.test(name)) {
      files.set(`/assets/${name}`, path.relative(repository, path.join(dist, name)))
    }
  }
  yield* fs.writeFileString(html, renderCaptureDocument(readings.snapshot, uiAssets.fonts, app, preloads))
  const origin = yield* serveFiles(repository, Object.fromEntries(files))
  const sessions = new WeakMap<Page, {
    readonly readings: ReturnType<typeof makeCodeReadings>
    readonly state: ReviewState
    readonly errors: Array<string>
  }>()
  return LiveProduct.of({
    origin,
    inventory: capability === "review" ? reviewInventory() : { routes: [], states: [] },
    seed: (page, _fixture, identity) =>
      browserCall("seed Code cached reads", async () => {
        const errors: Array<string> = []
        const state = Schema.decodeUnknownSync(ReviewState)(identity.state)
        const readings = makeCodeReadings(fixture.data, state)
        let reviewReads = 0
        sessions.set(page, { state, readings, errors })
        await page.route("**/v1/**", async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          if (request.method() !== "GET") {
            errors.push(`${request.method()} ${url.pathname}`)
            return route.abort("blockedbyclient")
          }
          if (url.pathname === "/v1/relay/events") {
            return route.fulfill({ contentType: "text/event-stream", body: `data: ${readings.relayEvent}\n\n` })
          }
          const json = resolveFixtureRead(readings, url)
          if (json !== undefined) {
            if (url.pathname === "/v1/modules/code/detail" || url.pathname === "/v1/modules/code/review") {
              if (state === "read-pending") return
              if (state === "review-transport-failed") return route.abort("failed")
              if (url.pathname.endsWith("/review")) {
                reviewReads += 1
                if (state === "read-retained" && reviewReads > 1) return route.abort("failed")
              }
            }
            if (url.pathname === "/v1/modules/code/diff-content" && state === "diff-reading") return
            return route.fulfill({ json })
          }
          errors.push(`Unseeded GET ${url.pathname}`)
          return route.fulfill({ status: 404, json: { error: "unseeded_fixture_request" } })
        })
      }),
    ready: (page) =>
      Effect.gen(function*() {
        const session = sessions.get(page)
        if (session === undefined) return yield* new RunnerFailure({ detail: "Code capture has no seeded session" })
        const { errors, readings, state } = session
        yield* browserCall("Code review state and actual content readiness", async () => {
          const detailState = state === "read-pending" ?
            "Loading"
            : state === "review-transport-failed" ?
            "Failed"
            : state === "code-owner-unavailable"
            ? "Unavailable"
            : "Ready"
          await page.locator(`[data-code-review-page][data-code-detail-state="${detailState}"]`).waitFor()
          const owner = page.locator(`[data-code-review-owner][data-code-review-ref="${CODE_REFERENCE}"]`)
          const readState = state === "read-pending"
            ? "Loading"
            : state === "review-transport-failed"
            ? "Failed"
            : "Ready"
          await owner.locator(`:scope[data-code-review-read-state="${readState}"]`).waitFor()
          if (state === "read-retained") {
            await owner.locator(":scope[data-code-review-files-state=\"Ready\"]").waitFor()
            await page.getByRole("link", { name: "Usage", exact: true }).filter({ visible: true }).click()
            await page.goBack()
            await owner.locator(":scope[data-code-review-read-state=\"Retained\"]").waitFor()
            await page.locator("[data-code-review-page] [data-code-review-retained]")
              .getByText(/^Previous reading [0-2][0-9]:[0-5][0-9]\.$/u).waitFor()
            // Back navigation restarts the independent detail read as well as the retained review read.
            await page.locator("[data-code-review-page][data-code-detail-state=\"Ready\"]").waitFor()
          }
          const conversation = isConversationState(state)
          const filesState =
            state === "read-pending" || state === "review-transport-failed" || state === "code-owner-unavailable" ||
              conversation
              ? "Idle" :
              state === "diff-reading"
              ? "Loading"
              : "Ready"
          await owner.locator(`:scope[data-code-review-files-state="${filesState}"]`).waitFor()
          if (state === "review-p2-expanded-readonly") {
            await owner.getByRole("button", { name: /^P2 and below/u }).click()
          }
          const reading = readings.review
          if (
            readState === "Ready" && reading._tag === "Ready" && reading.reading.workspace.run._tag === "Ready" &&
            reading.reading.workspace.run.run.summary.length > 0 && !conversation
          ) {
            await owner.getByText(reading.reading.workspace.run.run.summary, { exact: true }).first().waitFor()
          }
          if (filesState === "Ready" && state !== "diff-unavailable" && state !== "diff-rejected") {
            const file = reading._tag === "Ready" ? reading.reading.diff.files.at(-1) : undefined
            if (file !== undefined) await owner.getByRole("heading", { name: file.path, exact: true }).last().waitFor()
          }
        })
        if (errors.length > 0) {
          return yield* new RunnerFailure({ detail: `Code capture has unseeded requests: ${errors.join(", ")}` })
        }
        yield* markActualRegions(page, state)
      })
  })
})
