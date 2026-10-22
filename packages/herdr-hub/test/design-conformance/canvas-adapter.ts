/** Capture the built Hub's review canvas, reached through the same Code route and controls a reviewer uses. @module */
import { CodeDiffContentQuery, CodeTargetQuery } from "@knpkv/codecommit-web/host"
import type { Page } from "@playwright/test"
import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect"
import { browserCall } from "../../../design-conformance/src/browser.js"
import { LiveProduct, type StartProduct } from "../../../design-conformance/src/live.js"
import { RunnerFailure } from "../../../design-conformance/src/schema.js"
import { serveFiles } from "../../../design-conformance/src/server.js"
import { checkoutDashboard, type CheckoutPage } from "../../scripts/design-checkout-status.js"
import type { fontPreloadLink } from "../../src/font-preload.js"
import type { loadUiAssets } from "../../src/internal/ui-assets.js"
import { CANVAS_REFERENCE, CanvasState, makeCanvasReadings } from "./canvas-fixtures.js"
import { canvasInventory, readCanvasCapability } from "./canvas-inventory.js"
import { designCommitResult } from "./fixtures.js"

const PageModule = Schema.Struct({
  dashboardPage: Schema.declare((value): value is CheckoutPage["dashboardPage"] => Predicate.isFunction(value))
})
const FontModule = Schema.Struct({
  fontPreloadLink: Schema.declare((value): value is typeof fontPreloadLink => Predicate.isFunction(value))
})
const AssetsModule = Schema.Struct({
  loadUiAssets: Schema.declare((value): value is typeof loadUiAssets => Predicate.isFunction(value))
})

type Readings = ReturnType<typeof makeCanvasReadings>

/** Annotate existing nodes only; a missing region stays missing evidence for the gate. */
const markActualRegions = (page: Page) =>
  browserCall("mark actual canvas regions", async () => {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("[data-region]")) element.removeAttribute("data-region")
    })
    const phone = await page.evaluate(() => matchMedia("(max-width: 599px)").matches)
    const canvas = page.locator("[data-review-canvas]")
    const phoneDiff = canvas.locator(".rc-pdiff")
    const regions = new Map([
      [
        "nav",
        page.locator(".superapp-module-nav").or(page.getByRole("navigation", { name: "Mobile modules", exact: true }))
      ],
      ["header", canvas.locator("[data-review-canvas-header]")],
      ["tabs", canvas.locator("[data-review-canvas-tabs]")],
      ["toolbar", canvas.locator("[data-review-canvas-toolbar]")],
      ["canvas", canvas.locator("[data-canvas-frame]")],
      ["legend", canvas.locator("[data-canvas-part=legend]")],
      [
        "minimap",
        phone ? canvas.locator("[data-review-canvas-minimap]") : canvas.locator("[data-canvas-part=minimap]")
      ],
      ["card", canvas.locator(phone ? "[data-canvas-part=finding]" : "[data-canvas-part=keys]")],
      ["action", canvas.locator("[data-canvas-part=action]")],
      [
        "list",
        phone
          ? (await phoneDiff.count()) > 0 ? phoneDiff : canvas.locator("[data-review-canvas-list]")
          : canvas.locator("[data-canvas-part=files]")
      ],
      [
        "notice",
        phone ? canvas.locator("[data-review-canvas-notice]") : canvas.locator("[data-review-canvas-notice] > *")
      ]
    ])
    for (const [name, candidate] of regions) {
      const node = candidate.filter({ visible: true })
      const count = await node.count()
      if (count > 1) throw new RunnerFailure({ detail: `Ambiguous actual canvas region ${name}: ${count} nodes` })
      if (count === 1 && await node.isVisible()) {
        await node.evaluate((element, region) => element.setAttribute("data-region", region), name)
      }
    }
  })

/** Reject selectors this synthetic reading does not own rather than returning another subject's data. */
export const resolveCanvasRead = (readings: Readings, url: URL) => {
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
    case "/v1/modules/code/queue":
      return readings.queue
    case "/v1/modules/code/detail":
    case "/v1/modules/code/review":
    case "/v1/modules/code/diff":
    case "/v1/modules/code/canvas": {
      const query = Schema.decodeUnknownResult(CodeTargetQuery)(url.searchParams)
      if (Result.isFailure(query) || query.success.ref !== CANVAS_REFERENCE) return undefined
      const route = url.pathname.slice("/v1/modules/code/".length)
      return route === "detail"
        ? readings.detail
        : route === "review"
        ? readings.review
        : route === "diff"
        ? readings.diff
        : readings.canvas
    }
    case "/v1/modules/code/commit":
      return url.searchParams.get("ref") === CANVAS_REFERENCE
        ? designCommitResult(readings.commits, url.searchParams.get("commit"))
        : undefined
    case "/v1/modules/code/diff-content": {
      const query = Schema.decodeUnknownResult(CodeDiffContentQuery)(url.searchParams)
      if (Result.isFailure(query) || readings.diff._tag !== "Ready") return undefined
      const { diff } = readings.diff
      const value = query.success
      return value.ref === CANVAS_REFERENCE && value.revisionId === diff.revisionId &&
          value.baseCommit === diff.baseCommit && value.headCommit === diff.headCommit &&
          value.fileIndex === readings.diffFile
        ? readings.content
        : undefined
    }
  }
  return undefined
}

const loadBuilt = <A, I>(
  path: Path.Path,
  file: string,
  schema: Schema.Codec<A, I, never, never>,
  what: string
) =>
  Effect.gen(function*() {
    const url = yield* path.toFileUrl(file).pipe(
      Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub ${what} path: ${cause.message}` }))
    )
    const module: unknown = yield* Effect.tryPromise({
      try: () => import(url.href),
      catch: (cause) => new RunnerFailure({ detail: `Cannot load built Hub ${what}: ${String(cause)}` })
    })
    return yield* Schema.decodeUnknownEffect(schema)(module).pipe(
      Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built Hub ${what} module: ${cause.message}` }))
    )
  })

/** Drive the canvas to a state with the controls a reviewer would use. */
const reach = (page: Page, state: CanvasState) =>
  browserCall("reach the canvas state", async () => {
    const phone = await page.evaluate(() => matchMedia("(max-width: 599px)").matches)
    const root = page.locator("[data-review-canvas]")
    await root.waitFor()
    if (state === "map-building") {
      await page.locator(".code-canvas[data-code-canvas-state=\"Building\"]").waitFor()
      return
    }
    await page.locator(".code-canvas[data-code-canvas-state=\"Ready\"]").waitFor()
    if (phone) {
      if (state === "diff") {
        await root.locator(".rc-prow[aria-current=\"true\"]").click()
        await root.locator(".rc-pdl").first().waitFor()
      }
      return
    }
    const ladder = root.getByRole("group", { name: "Zoom level", exact: true })
    if (state === "cluster" || state === "file" || state === "diff") {
      await ladder.getByRole("button", { name: state[0]?.toUpperCase() + state.slice(1), exact: false }).click()
      await ladder.locator(`button[aria-current="true"]`).filter({ hasText: state[0]?.toUpperCase() + state.slice(1) })
        .waitFor()
    }
    if (state === "diff") await root.locator(".rc-dl").first().waitFor()
    if (state === "keyboard") {
      await root.locator("[data-canvas-node][tabindex=\"0\"]").focus()
      await page.keyboard.press("f")
      await root.locator("[data-canvas-part=keys]").waitFor()
    }
  })

export const start: StartProduct = Effect.fn("CanvasConformance.start")(function*(fixture, repository) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const capability = yield* readCanvasCapability(repository)
  const dist = path.join(repository, "packages/herdr-hub/dist")
  const app = yield* loadBuilt(path, path.join(dist, "internal/dashboard-page.js"), PageModule, "page")
  const preloads = yield* loadBuilt(path, path.join(dist, "font-preload.js"), FontModule, "preloads")
  const assets = yield* loadBuilt(path, path.join(dist, "internal/ui-assets.js"), AssetsModule, "assets")
  const uiAssets = yield* assets.loadUiAssets(dist)
  const served = yield* checkoutDashboard(repository)
  const initial = yield* Effect.try({
    try: () => makeCanvasReadings(fixture.data),
    catch: (cause) => new RunnerFailure({ detail: `Invalid canvas reference fixture: ${String(cause)}` })
  })
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "review-canvas-conformance-" })
  const html = path.join(temporary, "index.html")
  const files = new Map([["/", path.relative(repository, html)]])
  for (const name of yield* fs.readDirectory(dist)) {
    if (/^[a-zA-Z0-9_.-]+\.(?:js|css|woff2|png|svg)$/u.test(name)) {
      files.set(`/assets/${name}`, path.relative(repository, path.join(dist, name)))
    }
  }
  yield* fs.writeFileString(html, app.dashboardPage(served(initial.snapshot), preloads.fontPreloadLink(uiAssets.fonts)))
  const origin = yield* serveFiles(repository, Object.fromEntries(files))
  const sessions = new WeakMap<Page, { readonly state: CanvasState; readonly errors: Array<string> }>()
  return LiveProduct.of({
    origin,
    inventory: capability === "canvas" ? canvasInventory() : { routes: [], states: [] },
    seed: (page, _fixture, identity) =>
      browserCall("seed canvas reads", async () => {
        const errors: Array<string> = []
        const state = Schema.decodeUnknownSync(CanvasState)(identity.state)
        const readings = makeCanvasReadings(fixture.data, state)
        sessions.set(page, { state, errors })
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
          const json = url.pathname === "/v1/dashboard" ? served(readings.snapshot) : resolveCanvasRead(readings, url)
          if (json !== undefined) return route.fulfill({ json })
          errors.push(`Unseeded GET ${url.pathname}`)
          return route.fulfill({ status: 404, json: { error: "unseeded_fixture_request" } })
        })
      }),
    ready: (page) =>
      Effect.gen(function*() {
        const session = sessions.get(page)
        if (session === undefined) return yield* new RunnerFailure({ detail: "Canvas capture has no seeded session" })
        yield* reach(page, session.state)
        if (session.errors.length > 0) {
          return yield* new RunnerFailure({
            detail: `Canvas capture has unseeded requests: ${session.errors.join(", ")}`
          })
        }
        yield* markActualRegions(page)
      })
  })
})
