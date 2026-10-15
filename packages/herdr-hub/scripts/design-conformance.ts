import {
  browserCall,
  type Fixture,
  type Identity,
  Inventory,
  LiveProduct,
  RunnerFailure,
  serveFiles,
  type StartProduct
} from "@knpkv/design-conformance"
import type { Page } from "@playwright/test"
import { Console, Effect, FileSystem, Path, Predicate, Result, Schema } from "effect"
import type { DashboardSnapshot } from "../src/dashboard-model.js"
import { designDashboard, designReadings, UsageDesignFixture } from "./design-fixture.js"
import { assertUsageFonts, usageChartsReady } from "./design-fonts.js"

interface BuiltAssetMap {
  [route: string]: string
}

const BuiltInventory = Schema.Struct({ usageLimitsInventory: Inventory })
const BuiltPage = Schema.Struct({
  dashboardPage: Schema.declare((value): value is (snapshot: DashboardSnapshot, fonts: string) => string =>
    Predicate.isFunction(value)
  )
})
const BuiltFontPreload = Schema.Struct({
  PRELOADED_FONTS: Schema.Array(Schema.String),
  fontPreloadLink: Schema.declare((value): value is (fonts: ReadonlyMap<string, Uint8Array>) => string =>
    Predicate.isFunction(value)
  )
})

/** Seed the supplied app's document before parsing, without relying on PR-only client code or init-script DOM timing. */
export const seedDashboardHtml = (html: string, identity: Identity): Result.Result<string, RunnerFailure> => {
  const replacements = [
    [
      "<html lang=\"en\">",
      `<html lang="en" data-design-state="${identity.state}" data-design-theme="${identity.theme}">`
    ],
    ["<meta name=\"color-scheme\" content=\"dark\">", `<meta name="color-scheme" content="${identity.theme}">`],
    ["<body data-rly-root data-rly-theme=\"dark\">", `<body data-rly-root data-rly-theme="${identity.theme}">`]
  ] satisfies ReadonlyArray<readonly [string, string]>
  let seeded = html
  for (const [marker, replacement] of replacements) {
    if (!seeded.includes(marker)) {
      return Result.fail(
        new RunnerFailure({ detail: `Cannot seed ${JSON.stringify(identity)}: missing HTML marker ${marker}` })
      )
    }
    seeded = seeded.replace(marker, replacement)
  }
  return Result.succeed(seeded)
}

interface ReadinessValues {
  readonly designState: string | null
  readonly designTheme: string | null
  readonly rlyTheme: string | null
  readonly headingFound: boolean
  readonly limitsPageCurrent: boolean
}

/** Keep the failing identity, all readiness terms and the original browser cause in the adapter's typed failure. */
export const readinessFailure = (identity: Identity, values: ReadinessValues, cause: unknown): RunnerFailure =>
  new RunnerFailure({
    detail: `Usage Limits readiness failed ${JSON.stringify(identity)}: ${JSON.stringify(values)}; cause: ${
      String(cause)
    }`
  })

/** Import only the supplied checkout's emitted application code. Invalid exports fail decoding. */
const builtModule = Effect.fn("SuperappDesign.builtModule")(function*<A>(
  file: string,
  schema: Schema.Codec<A, unknown, never, never>
) {
  const path = yield* Path.Path
  const url = yield* path.toFileUrl(file).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built module path: ${String(cause)}` }))
  )
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(url.href),
    catch: (cause) => new RunnerFailure({ detail: `Cannot load built application module ${file}: ${String(cause)}` })
  })
  return yield* Schema.decodeUnknownEffect(schema)(module).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid built module ${file}: ${cause.message}` }))
  )
})

/** Use the supplied app's production preload helper and fail before navigation when its required fonts are absent. */
export const usageFontPreload = Effect.fn("SuperappDesign.usageFontPreload")(function*(dist: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const module = yield* builtModule(path.join(dist, "font-preload.js"), BuiltFontPreload)
  if (module.PRELOADED_FONTS.length === 0) {
    return yield* new RunnerFailure({ detail: `No production font preloads in ${dist}` })
  }
  const fonts = new Map<string, Uint8Array>()
  for (const file of module.PRELOADED_FONTS) {
    if (path.basename(file) !== file || !file.endsWith(".woff2")) {
      return yield* new RunnerFailure({ detail: `Invalid production font asset ${dist}: ${file}` })
    }
    const asset = path.join(dist, file)
    const bytes = yield* fs.readFile(asset).pipe(
      Effect.mapError((cause) => new RunnerFailure({ detail: `Missing production font ${asset}: ${cause.message}` }))
    )
    if (bytes.length === 0) return yield* new RunnerFailure({ detail: `Empty production font ${asset}` })
    fonts.set(file, bytes)
  }
  return yield* Effect.try({
    try: () => module.fontPreloadLink(fonts),
    catch: (cause) => new RunnerFailure({ detail: `Production font preload failed ${dist}: ${String(cause)}` })
  })
})

/** Only a checkout predating this product manifest may borrow the PR's onboarding inventory. */
export const usageInventoryFile = Effect.fn("SuperappDesign.usageInventoryFile")(function*(repository: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const inventoryFile = path.join(repository, "packages/herdr-hub/dist/internal/usage-limits-inventory.js")
  if (yield* fs.exists(inventoryFile)) return inventoryFile
  if (yield* fs.exists(path.join(repository, "design-refs/super-app/manifest.json"))) {
    return yield* new RunnerFailure({ detail: `Missing built Usage inventory: ${inventoryFile}` })
  }
  yield* Console.log("pre-inventory base: using PR inventory")
  const packageRoot = yield* path.fromFileUrl(new URL("../", import.meta.url)).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid PR inventory path: ${String(cause)}` }))
  )
  return path.join(packageRoot, "dist/internal/usage-limits-inventory.js")
})

/** Serve the real built hub client; browser transport is fulfilled entirely from the shared fixture. */
export const start: StartProduct = Effect.fn("SuperappDesign.start")(function*(fixture, repository) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const data = yield* Schema.decodeUnknownEffect(UsageDesignFixture)(fixture.data).pipe(
    Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid Usage fixture: ${cause.message}` }))
  )
  const initialState = data.usageLimits.states.populated
  if (initialState === undefined) return yield* new RunnerFailure({ detail: "Missing populated bootstrap fixture" })
  const snapshot = designDashboard(data, initialState)
  const dist = path.join(repository, "packages/herdr-hub/dist")
  const inventorySource = yield* usageInventoryFile(repository)
  const inventory = yield* builtModule(inventorySource, BuiltInventory)
  const pageModule = yield* builtModule(path.join(dist, "internal/dashboard-page.js"), BuiltPage)
  const fontPreload = yield* usageFontPreload(dist)
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "superapp-design-" })
  const files: BuiltAssetMap = { "/": "index.html" }
  yield* fs.writeFileString(path.join(temporary, "index.html"), pageModule.dashboardPage(snapshot, fontPreload))
  for (const name of yield* fs.readDirectory(dist)) {
    if (!/\.(css|js|woff2|png|svg)$/u.test(name)) continue
    yield* fs.copy(path.join(dist, name), path.join(temporary, name))
    files[`/assets/${name}`] = name
  }
  const origin = yield* serveFiles(temporary, files)
  return LiveProduct.of({
    origin,
    inventory: inventory.usageLimitsInventory,
    seed: Effect.fn("SuperappDesign.seed")(function*(page: Page, seededFixture: Fixture, identity: Identity) {
      const seeded = yield* Schema.decodeUnknownEffect(UsageDesignFixture)(seededFixture.data).pipe(
        Effect.mapError((cause) => new RunnerFailure({ detail: `Invalid seeded Usage fixture: ${cause.message}` }))
      )
      const state = seeded.usageLimits.states[identity.state]
      if (state === undefined) {
        return yield* new RunnerFailure({ detail: `Missing fixture state ${identity.state}` })
      }
      const readings = designReadings(seeded, state)
      const bootstrap = designDashboard(seeded, state)
      const dashboard = { ...bootstrap, approvalApp: { ...bootstrap.approvalApp, canonicalUrl: `${origin}/` } }
      const html = yield* Effect.fromResult(
        seedDashboardHtml(pageModule.dashboardPage(dashboard, fontPreload), identity)
      )
      const responses = new Map<string, unknown>([
        ["/v1/dashboard", dashboard],
        ["/v1/dashboard-pending", dashboard.pendingApprovals],
        ["/v1/dashboard-history", { records: [], nextCursor: null }],
        ["/v1/modules/today/needs-you", { _tag: "Complete", items: [] }],
        ["/v1/connect/agents", { agents: [], failures: [], nextCursor: null }],
        ["/v1/connect/archive", { agents: [], nextCursor: null }],
        ["/v1/connect/limits", readings.limits],
        ["/v1/connect/usage", readings.usage],
        ["/v1/relay/session", { tools: [], backend: "codex-cli", cancel: false }],
        ["/v1/relay/backends", [{ _tag: "Ready", backend: "codex-cli", label: "Fixture backend", version: "1" }]],
        ["/manifest.webmanifest", { name: "Relay", start_url: "/", display: "standalone" }]
      ])
      yield* browserCall("seed Usage Limits", async () => {
        await page.route(`${origin}/**`, async (route) => {
          const url = new URL(route.request().url())
          if (url.pathname === "/") {
            await route.fulfill({ contentType: "text/html", body: html })
            return
          }
          if (url.pathname.startsWith("/assets/")) {
            if (files[url.pathname] !== undefined) await route.continue()
            else await route.abort("failed")
            return
          }
          if (url.pathname === "/v1/relay/events") {
            await route.fulfill({
              contentType: "text/event-stream",
              body: `data: ${
                JSON.stringify({
                  _tag: "Snapshot",
                  session: "123456789012",
                  seq: 0,
                  messages: [],
                  runIds: [],
                  queued: []
                })
              }\n\n`
            })
            return
          }
          if (url.pathname === "/v1/connect/limits" || url.pathname === "/v1/connect/usage") {
            if (state.kind === "loading") return
            if (state.kind === "error") {
              await route.fulfill({ status: 503, json: { error: "unavailable" } })
              return
            }
          }
          const response = responses.get(url.pathname)
          if (response === undefined) await route.abort("failed")
          else await route.fulfill({ json: response })
        })
      })
    }),
    ready: (page, identity) =>
      browserCall("settle Usage Limits", async () => {
        const module = page.locator("[data-module=\"usage\"]:visible")
        if (identity.state === "empty") {
          await page.locator(
            ".usage-empty-notice, [data-module=\"usage\"] .usage-tab-panel[aria-busy=\"false\"]"
          ).first().waitFor()
        } else {
          await module.getByRole("heading", { name: "Usage", exact: true }).waitFor()
        }
        await page.locator("[data-module-page=\"limits\"][aria-current=\"page\"]:visible").waitFor()
        await page.waitForFunction(({ state, theme }) =>
          document.documentElement.dataset.designState === state &&
          document.documentElement.dataset.designTheme === theme &&
          document.body.dataset.rlyTheme === theme, { state: identity.state, theme: identity.theme })
        if (identity.state === "loading") {
          await module.getByLabel("Loading limits", { exact: true }).waitFor()
          await module.getByLabel("Loading usage", { exact: true }).waitFor()
        } else if (identity.state === "unavailable") {
          await module.getByText("Couldn't load limits. Trying again every minute.", { exact: true }).waitFor()
          await module.getByText("Couldn't load usage. Trying again in five minutes.", { exact: true }).waitFor()
        } else if (identity.state !== "empty") {
          await module.locator(".usage-tab-now .usage-limits-now").waitFor({
            state: "visible"
          })
          await module.locator(".usage-tab-panel[aria-busy=\"false\"]").first().waitFor()
        }
        await page.evaluate(() => document.fonts.ready)
        await page.waitForFunction(usageChartsReady, undefined, { timeout: 5_000 })
      }).pipe(
        Effect.andThen(assertUsageFonts(page, identity)),
        Effect.asVoid,
        Effect.catchTag("BrowserFailure", (failure) =>
          Effect.gen(function*() {
            const inspection = yield* browserCall("inspect Usage Limits readiness", async () => {
              const module = page.locator("[data-module=\"usage\"]:visible")
              const headingFound = await module.getByRole("heading", { name: "Usage", exact: true }).isVisible()
              const limitsPageCurrent = await page.locator(
                "[data-module-page=\"limits\"][aria-current=\"page\"]:visible"
              )
                .isVisible()
              const values = await page.evaluate(() => ({
                designState: document.documentElement?.dataset.designState ?? null,
                designTheme: document.documentElement?.dataset.designTheme ?? null,
                rlyTheme: document.body?.dataset.rlyTheme ?? null
              }))
              return { ...values, headingFound, limitsPageCurrent }
            }).pipe(Effect.result)
            if (Result.isFailure(inspection)) {
              return yield* new RunnerFailure({
                detail: `Usage Limits readiness failed ${JSON.stringify(identity)}; cause: ${
                  String(failure.cause)
                }; readiness inspection failed: ${String(inspection.failure.cause)}`
              })
            }
            return yield* readinessFailure(identity, inspection.success, failure.cause)
          }))
      )
  })
})
