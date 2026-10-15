import { NodeServices } from "@effect/platform-node"
import { expect, type Page, test as base } from "@playwright/test"
import { Context, Deferred, Effect, FileSystem, Layer, ManagedRuntime, Option, Path, Ref, Schema } from "effect"
import { isBuiltin } from "node:module"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { build, type Plugin, preview } from "vite"
import { CatalogReadError, StackDetail, StackId, StackList } from "../../src/api.js"
import { ResourceSummary, StackState } from "../../src/schema.js"
import { Catalog } from "../../src/server/Catalog.js"
import { requestLoginUrl } from "../../src/server/ControlSocket.js"
import type { ControlError } from "../../src/server/ControlSocket.js"
import { disconnectedLayer } from "../../src/server/PlanReader.js"
import { makeServer } from "../../src/server/Server.js"
import { FixtureSource, fixtureSourceLayer } from "../catalogFixture.js"
import { detailFixtures, detailStack } from "../consumer/detail-fixtures.js"
import { readMobileCellGeometry } from "./cell-geometry.js"
import { type ListFixture, listFixtures, populated } from "./list-fixtures.js"
import { rejectedViewStyles } from "./style-policy.js"

/** Fixture-only credentials stay in the private runtime and browser navigation, never reports or traces. */
class BrowserFixture extends Context.Service<BrowserFixture, {
  readonly url: string
  readonly mint: Effect.Effect<string, ControlError>
  readonly set: (data: ListFixture, failure?: CatalogReadError | null) => Effect.Effect<void>
}>()("AlchemyConsole/BrowserFixture") {}

const browserLayer = Layer.effect(
  BrowserFixture,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-web-" })
    yield* fs.chmod(directory, 0o700)
    const uid = Option.getOrElse((yield* fs.stat(directory)).uid, () => -1)
    const ready = yield* Deferred.make<string>()
    const source = yield* FixtureSource
    yield* Layer.build(makeServer({ directory, port: 0, uid }, ready))
    const url = yield* Deferred.await(ready)
    const mint = requestLoginUrl({ directory, port: Number(new URL(url).port), uid }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.flatMap(Option.match({ onNone: () => Effect.die("fixture server stopped"), onSome: Effect.succeed }))
    )
    const set = (data: ListFixture, failure: CatalogReadError | null = null) =>
      Effect.gen(function*() {
        yield* Ref.set(source.entries, data.stacks)
        yield* Ref.set(source.issues, data.issues)
        yield* Ref.set(source.failure, failure)
      })
    return BrowserFixture.of({ url, mint, set })
  })
).pipe(
  Layer.provide(disconnectedLayer),
  Layer.provide(Catalog.layer.pipe(Layer.provideMerge(fixtureSourceLayer))),
  Layer.provide(NodeServices.layer)
)

type Login = {
  readonly url: string
  readonly mint: () => Promise<string>
  readonly set: (data: ListFixture, failure?: CatalogReadError | null) => Promise<void>
}

const useLogin = async (use: (login: Login) => Promise<void>) => {
  const runtime = ManagedRuntime.make(browserLayer)
  try {
    const fixture = await runtime.runPromise(BrowserFixture)
    await use({
      url: fixture.url,
      mint: () => runtime.runPromise(fixture.mint),
      set: (data, failure) => runtime.runPromise(fixture.set(data, failure))
    })
  } finally {
    await runtime.dispose()
  }
}

const test = base.extend<{ login: Login; otherLogin: Login }>({
  login: async ({ browserName: _browserName }, use) => useLogin(use),
  otherLogin: async ({ browserName: _browserName }, use) => useLogin(use)
})

/** A fresh fragment must restart login after a spent link leaves the page on the same root URL. */
test("a fresh link recovers the failed-login page and removes its fragment", async ({ login, page }) => {
  await page.goto(login.url)
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("")

  await page.goto(login.url)
  await expect(page.getByRole("main")).toHaveCount(1)
  await expect(page.getByRole("heading", { name: "Sign-in failed or link already used." })).toBeVisible()
  await expect(page.getByText("billing prod", { exact: true })).toHaveCount(0)
  await page.waitForLoadState("networkidle", { timeout: 5000 })
  expect(new URL(page.url()).hash).toBe("")

  await page.goto(await login.mint())
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("")
})

/** Cookies share a loopback host across ports; each listener must retain its own authenticated session. */
test("two listeners stay authenticated in one browser, including repeat login", async ({ context, login, otherLogin, page }) => {
  await page.goto(login.url)
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
  const second = await context.newPage()
  try {
    await second.goto(otherLogin.url)
    await expect(second.getByRole("heading", { name: "billing" })).toBeVisible()
    const checkOwner = async (target: Page) => {
      await target.reload()
      await expect(target.getByRole("heading", { name: "billing" })).toBeVisible()
      const origin = new URL(target.url()).origin
      const listResponse = await context.request.get(`${origin}/api/stacks`)
      expect(listResponse.status()).toBe(200)
      const list = Schema.decodeUnknownSync(StackList)(await listResponse.json())
      const id = Schema.decodeUnknownSync(StackId)(list.stacks[0]?.id)
      const detailResponse = await context.request.get(`${origin}/api/stacks/${id}`)
      expect(detailResponse.status()).toBe(200)
      const detail = Schema.decodeUnknownSync(StackDetail)(await detailResponse.json())
      expect(detail.state.app).toBe("billing")
    }
    await checkOwner(page)
    await checkOwner(second)
    await page.goto(await login.mint())
    await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
    await checkOwner(page)
    await checkOwner(second)
    expect(new URL(page.url()).hash).toBe("")
    expect(new URL(second.url()).hash).toBe("")
  } finally {
    await second.close()
  }
})

// Hover remains a text action; only keyboard focus may use the shared focus colour.
for (const colorScheme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
  test(`fine-pointer hover stays distinct from keyboard focus in ${colorScheme}`, async ({ login, page }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.goto(login.url)
    await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
    const observations = []
    for (const surface of ["list", "detail"]) {
      const link = page.locator(surface === "list" ? ".ac-list-link" : ".ac-resource-table .ac-resource-name").first()
      await expect(link).toBeVisible()
      const before = await link.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      })
      await link.hover()
      await link.focus()
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(link).toBeFocused()
      const after = await link.evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return {
          width: rect.width,
          height: rect.height,
          color: style.color,
          outlineColor: style.outlineColor,
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
          hovered: element.matches(":hover")
        }
      })
      observations.push({ surface, before, after })
      expect(after.hovered).toBe(true)
      expect(after.outlineStyle).toBe("solid")
      expect(after.outlineWidth).toBe("2px")
      expect.soft(after.color).not.toBe(after.outlineColor)
      expect({ width: after.width, height: after.height }).toEqual(before)
      if (surface === "list") {
        const response = page.waitForResponse((value) => new URL(value.url()).pathname.startsWith("/api/stacks/"))
        await link.click()
        expect((await response).status()).toBe(200)
      }
    }
    await testInfo.attach("hover-focus-colours", {
      body: JSON.stringify(observations),
      contentType: "application/json"
    })
  })
}

// Every reference state is exercised with real authenticated fixture discovery, in both layouts/themes.
for (const width of [390, 1280]) {
  for (const colorScheme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
    for (const fixture of listFixtures) {
      test(`${fixture.name} at ${width} ${colorScheme}`, async ({ login, page }) => {
        await page.setViewportSize({ width, height: 960 })
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
        await login.set(fixture.data)
        const violations: Array<string> = []
        page.on("console", (message) => {
          if (message.type() === "error") violations.push(message.text())
        })
        await page.goto(login.url)
        await expect(page.getByRole("button", { name: "Read again" })).toBeVisible()
        await expect(page.locator(".ac-stage")).toHaveCount(
          fixture.data.stacks.length
        )
        await expect(page.locator("main a[href^='/api/']")).toHaveCount(0)
        if (fixture.notice !== null) await expect(page.getByText(fixture.notice, { exact: true })).toBeVisible()
        if (fixture.name === "1c empty") {
          await expect(page.getByText("Local discovery and the state bucket returned no stack state.", { exact: true }))
            .toBeVisible()
          await expect(page.locator(".ac-empty-creature")).toBeVisible()
          expect(
            await page.locator(".ac-empty-creature").evaluate(() => {
              const image = document.querySelector<HTMLImageElement>("img.ac-empty-creature")
              return image !== null && image.complete && image.naturalWidth > 0
            })
          ).toBe(true)
        }
        if (fixture.name.startsWith("1d") || fixture.name.startsWith("1e")) {
          await expect(page.getByText("storefront prod", { exact: true })).toBeVisible()
          await expect(page.getByText("billing prod", { exact: true })).toHaveCount(0)
          await expect(page.locator(".ac-notice")).toContainText(
            "Discovery is incomplete — stacks that could be read are listed."
          )
        }
        if (fixture.data.issues.length > 0) {
          await expect(page.locator(".ac-summary")).toHaveText(
            `${fixture.data.stacks.length} stacks found · discovery incomplete`
          )
        }
        if (fixture.name === "1a populated") {
          await expect(page.locator(".ac-summary")).toHaveText("6 stacks · 4 apps")
          await expect(page.locator(".ac-table tbody td:last-child a")).toHaveCount(5)
          await expect(page.getByRole("table", { name: "billing" })).toContainText("Unknown")
          await expect(page.getByRole("table", { name: "docs" })).toContainText("9 Oct · 16:02")
          await expect(
            page.getByRole("row").filter({ has: page.getByText("relay sandbox", { exact: true }) })
          )
            .toContainText("0")
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect(violations.length).toBe(0)
        for (const entry of fixture.data.stacks) await expect(page.locator("body")).not.toContainText(entry.key)
      })
    }

    test(`1b loading at ${width} ${colorScheme}`, async ({ login, page }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      let release: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route("**/api/stacks", async (route) => {
        await barrier
        await route.continue()
      })
      try {
        await page.goto(login.url)
        await expect(page.getByRole("button", { name: "Reading…" })).toBeDisabled()
        await expect(page.locator(".ac-skeleton-group")).toHaveCount(3)
        await expect(page.getByRole("table")).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      } finally {
        release()
      }
      await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
    })

    test(`1g unavailable at ${width} ${colorScheme}`, async ({ login, page }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await login.set({ stacks: [], issues: [] }, new CatalogReadError({ reason: "denied" }))
      await page.goto(login.url)
      await expect(page.getByRole("heading", { name: "Stacks are unavailable right now." })).toBeVisible()
      await expect(page.locator(".ac-state-panel")).toContainText(
        "The stack list couldn’t be read, so no stacks are shown. Nothing was changed."
      )
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Read again" })).toHaveCount(0)
      await expect(page.getByRole("table")).toHaveCount(0)
      await expect(page.getByRole("status")).toHaveText("Stacks are unavailable right now.")
      await expect(page.locator("body")).not.toContainText("denied")
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test(`1h signed out at ${width} ${colorScheme}`, async ({ login, page }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      // This context has no owner cookie and deliberately receives no bootstrap fragment.
      await page.goto(new URL("/", login.url).href)
      await expect(page.getByRole("heading", { name: "Your Alchemy console session has ended." })).toBeVisible()
      await expect(page.locator(".ac-state-panel")).toContainText("Signed out")
      await expect(page.locator(".ac-state-panel")).toContainText("Sign in again to see stacks.")
      await expect(page.locator(".ac-state-panel")).toContainText("Run alchemy-console login for a fresh link.")
      await expect(page.getByRole("button")).toHaveCount(0)
      await expect(page.getByRole("table")).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
}

/** Refresh discards rows; full discovery failure exposes generic copy and Retry, including the live summary. */
test("Read again clears old rows and recovers a full catalog failure", async ({ login, page }) => {
  let reads = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/stacks") reads += 1
  })
  await login.set({ stacks: populated, issues: [] })
  await page.goto(login.url)
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
  await page.waitForLoadState("networkidle")
  expect(reads).toBe(1)
  await login.set({ stacks: [], issues: [] }, new CatalogReadError({ reason: "denied" }))
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/stacks", async (route) => {
    await barrier
    await route.continue()
  })
  try {
    await page.getByRole("button", { name: "Read again" }).click()
    await expect(page.getByRole("button", { name: "Reading…" })).toBeDisabled()
    await expect(page.getByRole("table")).toHaveCount(0)
  } finally {
    release()
  }
  await expect(page.getByRole("heading", { name: "Stacks are unavailable right now." })).toBeVisible()
  await expect(page.getByRole("status")).toHaveText("Stacks are unavailable right now.")
  await expect(page.locator("body")).not.toContainText("denied")
  await expect(page.getByRole("button", { name: "Read again" })).toHaveCount(0)
  await expect(page.getByRole("table")).toHaveCount(0)
  await page.unroute("**/api/stacks")
  await login.set({ stacks: populated, issues: [] })
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.locator(".ac-summary")).toHaveText("6 stacks · 4 apps")
  await page.waitForLoadState("networkidle")
  expect(reads).toBe(3)
})

/** A Node/browser consumer imports the built package by its public name, never a source or dist path. */
test("built views export renders independently of the console runtime", async () => {
  const { StackListView } = await import("@knpkv/alchemy-console/views")
  const html = renderToStaticMarkup(createElement(StackListView, {
    state: { _tag: "Loading" },
    copy: {
      product: "Console",
      signInInstruction: "Run alchemy-console login for a fresh link."
    },
    onReadAgain: () => undefined
  }))
  expect(html).toContain("Stacks")
  expect(html).toContain("Reading")
  const boundary: Plugin = {
    name: "consumer-browser-boundary",
    resolveId(id) {
      if (isBuiltin(id)) this.error("Views consumer imported a Node runtime")
    },
    moduleParsed(module) {
      if (/\/src\/(?:server|client)\//.test(module.id) || /\/dist\/(?:server|client)\//.test(module.id)) {
        this.error("Views consumer imported the application runtime")
      }
    }
  }
  const bundle = await build({
    root: new URL("../..", import.meta.url).pathname,
    configFile: false,
    plugins: [boundary],
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: new URL("../consumer/views.ts", import.meta.url).pathname, formats: ["es"] },
      rollupOptions: { external: (id) => /^(?:react(?:\/|$)|react-dom(?:\/|$)|@knpkv\/rly(?:\/|$))/.test(id) }
    }
  })
  const outputs = Array.isArray(bundle) ? bundle : [bundle]
  expect(
    outputs.some((output) =>
      "output" in output && output.output.some((chunk) => chunk.type === "chunk" && chunk.exports.includes("view"))
    )
  ).toBe(true)
})

interface DetailHeaderMetrics {
  readonly subtitleHeight: number
  readonly lineHeight: number
  readonly lines: number
  readonly flexBasis: string
  readonly endGap: number
}

/** Public assets resolve beneath a consumer's mount, with no dependency on origin-root files. */
test("built views consumer loads creature and both fonts beneath /console/", async ({ browser, page }, testInfo) => {
  // This package-name consumer also visits 44 trusted-host frames. Each individual assertion keeps its normal deadline.
  test.setTimeout(60_000)
  const runtime = ManagedRuntime.make(NodeServices.layer)
  try {
    const fs = await runtime.runPromise(FileSystem.FileSystem)
    const directory = await runtime.runPromise(fs.makeTempDirectory({ prefix: "alchemy-consumer-" }))
    try {
      const root = new URL("../consumer/", import.meta.url).pathname
      await build({
        root,
        configFile: false,
        base: "/console/",
        logLevel: "silent",
        build: { outDir: directory, emptyOutDir: true, assetsInlineLimit: 0 }
      })
      const server = await preview({
        root,
        configFile: false,
        base: "/console/",
        logLevel: "silent",
        build: { outDir: directory },
        preview: { host: "127.0.0.1", port: 0 }
      })
      const requests: Array<string> = []
      const responses: Array<{ readonly path: string; readonly status: number }> = []
      let fontLoads: ReadonlyArray<number> = []
      const headerGeometry: Array<
        {
          readonly fixture: string
          readonly width: number
          readonly theme: string
          readonly metrics: DetailHeaderMetrics
        }
      > = []
      const mobileCellGeometry: Array<
        {
          readonly fixture: string
          readonly width: number
          readonly probe: boolean
          readonly metrics: ReturnType<typeof readMobileCellGeometry>
        }
      > = []
      const desktopColumns: Array<{ readonly fixture: string; readonly ratio: number }> = []
      const frames: Array<{ readonly fixture: string; readonly width: number; readonly theme: string }> = []
      try {
        const url = Option.getOrThrow(Option.fromNullishOr(server.resolvedUrls?.local[0]))
        page.on("request", (request) => requests.push(new URL(request.url()).pathname))
        page.on("response", (response) =>
          responses.push({
            path: new URL(response.url()).pathname,
            status: response.status()
          }))
        await page.goto(url)
        const creature = page.locator("img.ac-empty-creature")
        await expect(creature).toBeVisible()
        await expect.poll(() =>
          creature.evaluate(() => {
            const image = document.querySelector<HTMLImageElement>("img.ac-empty-creature")
            return image !== null && image.complete && image.naturalWidth > 0
          })
        ).toBe(true)
        fontLoads = await page.evaluate(async () => {
          const fonts = await Promise.all([
            document.fonts.load("16px \"Geist Variable\""),
            document.fonts.load("16px \"Geist Mono Variable\"")
          ])
          await document.fonts.ready
          return fonts.map((faces) => faces.length)
        })
        expect(fontLoads).toEqual([1, 1])
        await page.waitForLoadState("networkidle")
        for (const asset of ["empty-creature", "geist-latin-wght-normal", "geist-mono-latin-wght-normal"]) {
          const matching = responses.filter((response) => response.path.includes(asset))
          expect(matching.length).toBeGreaterThan(0)
          expect(matching.every((response) => response.status === 200 && response.path.startsWith("/console/")))
            .toBe(true)
        }
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((request) => request.startsWith("/console/"))).toBe(true)
        // Trusted-host fixtures prove the exported views, including statuses/safe values the persisted reader cannot produce.
        for (const width of [390, 1280]) {
          for (const colorScheme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
            await page.setViewportSize({ width, height: 960 })
            await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
            for (const fixture of detailFixtures) {
              await page.goto(`${url}?fixture=${fixture.name}`)
              await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
              await page.evaluate(() => document.fonts.ready)
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
              await expect(page.getByRole("tab", { name: "Plan", exact: true })).toHaveCount(
                fixture.resource === null ? 1 : 0
              )
              await expect(page.getByRole("button", { name: "Preview changes" })).toHaveCount(0)
              if (fixture.resource === null) {
                await expect(
                  page.getByRole("tab", {
                    name: fixture.tab.slice(0, 1).toUpperCase() + fixture.tab.slice(1),
                    exact: true
                  })
                ).toHaveAttribute("aria-selected", "true")
              }
              if (fixture.name === "6a" || fixture.name === "6e") {
                const metrics = await page.locator(".ac-detail-header").evaluate((header) => {
                  const subtitle = header.querySelector("p")
                  if (subtitle === null) return null
                  const range = document.createRange()
                  range.selectNodeContents(subtitle)
                  const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top * 100))).size
                  const style = getComputedStyle(subtitle)
                  return {
                    subtitleHeight: subtitle.getBoundingClientRect().height,
                    lineHeight: Number.parseFloat(style.lineHeight),
                    lines,
                    flexBasis: style.flexBasis,
                    endGap: header.getBoundingClientRect().bottom - subtitle.getBoundingClientRect().bottom
                  }
                })
                expect(metrics).not.toBeNull()
                if (metrics !== null) {
                  headerGeometry.push({ fixture: fixture.name, width, theme: colorScheme, metrics })
                  expect.soft(
                    metrics.lines > 0 && metrics.flexBasis === "auto" &&
                      Math.abs(metrics.subtitleHeight - metrics.lineHeight * metrics.lines) <= 1 &&
                      Math.abs(metrics.endGap) <= 1,
                    JSON.stringify({ fixture: fixture.name, width, theme: colorScheme, metrics })
                  ).toBe(true)
                }
              }
              if (width === 1280 && (fixture.name === "6a" || fixture.name === "6g")) {
                const ratio = await page.locator(".ac-detail-table").evaluate((table) => {
                  const heading = table.querySelector("thead th")
                  return heading === null
                    ? 0
                    : heading.getBoundingClientRect().width / table.getBoundingClientRect().width
                })
                desktopColumns.push({ fixture: fixture.name, ratio })
                expect.soft(ratio).toBeCloseTo(fixture.name === "6a" ? 0.15 : 0.27, 2)
              }
              if (fixture.name === "6b") {
                await expect(page.locator(".ac-resource-status-cell")).toContainText([
                  "Updated",
                  "Deleting",
                  "Failed",
                  "Unknown",
                  "Created",
                  "Created"
                ])
              }
              if (fixture.name === "6g") {
                await expect(page.locator(".ac-output-table tbody tr")).toHaveCount(4)
                await expect(page.locator(".ac-output-table")).toContainText("https://api.example.com")
                await expect(page.locator(".ac-output-table a")).toHaveCount(0)
                await expect(page.getByText("Hidden", { exact: true })).toHaveCount(2)
              }
              if (fixture.name === "6h") {
                await expect(page.getByText("This stack has no outputs.", { exact: true })).toBeVisible()
              }
              if (fixture.name === "6i") {
                await expect(page.getByText("The outputs in this stack’s state can’t be read yet.", { exact: true }))
                  .toBeVisible()
              }
              if (fixture.name === "6e") await expect(page.locator(".ac-dependencies li")).toHaveCount(3)
              if (fixture.name === "6f") await expect(page.locator(".ac-provider-link")).toHaveCount(0)
              if (fixture.name === "2a" || fixture.name === "2b") {
                await expect(page.locator(".ac-construct")).toHaveCount(fixture.name === "2a" ? 4 : 2)
                expect(await page.locator(".ac-type-group").count()).toBeGreaterThan(0)
                const destination = page.locator(".ac-tree-resource").first()
                await expect(destination).toBeVisible()
                await destination.click()
                await expect(page.getByRole("heading", { name: "api", exact: true })).toBeVisible()
              }
              if (fixture.name === "2c") {
                await expect(page.getByText("No resources in state", { exact: true })).toBeVisible()
                const illustration = page.locator("img.ac-empty-state-creature")
                await expect(illustration).toBeVisible()
                expect(
                  await illustration.evaluate((element) =>
                    element.getAttribute("aria-hidden") === "true" && element.getAttribute("width") === "56"
                  )
                ).toBe(true)
                await expect.poll(() =>
                  illustration.evaluate(() => {
                    const image = document.querySelector<HTMLImageElement>("img.ac-empty-state-creature")
                    return image !== null && image.complete && image.naturalWidth > 0
                  })
                ).toBe(true)
              }
              expect(await page.evaluate(rejectedViewStyles)).toEqual([])
              frames.push({ fixture: fixture.name, width, theme: colorScheme })
            }
          }
        }
        // Plan's design region has a stable header and table rhythm independent of host shell width.
        await page.setViewportSize({ width: 1054, height: 1100 })
        await page.goto(`${url}?fixture=7a`)
        await expect(page.getByRole("table", { name: "Latest CI plan" })).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        const planGeometry = await page.locator(".ac-detail").evaluate((element) => {
          const origin = element.getBoundingClientRect()
          const title = element.querySelector("h1")
          const panel = element.querySelector(".ac-plan")
          const columns = element.querySelector(".ac-plan-table thead tr")
          return {
            width: origin.width,
            panelStart: panel === null ? null : panel.getBoundingClientRect().y - origin.y,
            titleSize: title === null ? null : getComputedStyle(title).fontSize,
            columnHeight: columns?.getBoundingClientRect().height ?? null
          }
        })
        expect(planGeometry.width).toBe(974)
        expect(planGeometry.titleSize).toBe("44px")
        expect(planGeometry.panelStart).toBeCloseTo(259.8, 0)
        expect(planGeometry.columnHeight).toBeCloseTo(36.6, 0)
        await expect(page.getByRole("rowheader")).toHaveCount(6)
        await page.setViewportSize({ width: 388, height: 1100 })
        await page.evaluate(() => document.fonts.ready)
        const mobilePlan = await page.getByRole("table", { name: "Latest CI plan" }).boundingBox()
        const firstPlanRow = await page.getByRole("rowheader").first().locator("..").boundingBox()
        expect(mobilePlan?.height).toBeCloseTo(1052.9, 0)
        expect(firstPlanRow?.y).toBeCloseTo(mobilePlan?.y ?? -1, 0)
        for (const width of [320, 390]) {
          const context = await browser.newContext({
            viewport: { width, height: 960 },
            hasTouch: true,
            isMobile: true,
            colorScheme: "dark"
          })
          try {
            const phone = await context.newPage()
            await phone.goto(`${url}?fixture=7a`)
            const planTable = phone.getByRole("table", { name: "Latest CI plan" })
            await expect(planTable.getByRole("rowheader")).toHaveCount(6)
            await phone.evaluate(() => document.fonts.ready)
            const property = planTable.locator("code").first()
            await property.evaluate((element) => {
              element.textContent = "P".repeat(64)
            })
            await planTable.getByRole("rowheader").first().locator("b").evaluate((element) => {
              element.textContent = `stack/${"unbreakable".repeat(40)}`
            })
            for (const token of [property, planTable.getByRole("rowheader").first().locator("b")]) {
              const geometry = await token.evaluate((element) => ({
                width: element.getBoundingClientRect().width,
                cellWidth: element.closest("th,td")?.getBoundingClientRect().width ?? 0,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth
              }))
              expect(geometry.width).toBeGreaterThan(0)
              expect(geometry.width).toBeLessThanOrEqual(geometry.cellWidth)
              expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
            }
            for (const fixture of ["6a", "6g"]) {
              await phone.goto(`${url}?fixture=${fixture}`)
              await expect(phone.locator(".ac-detail-table tbody th").first()).toBeVisible()
              await phone.evaluate(() => document.fonts.ready)
              expect(await phone.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
              const metrics = await phone.evaluate<ReturnType<typeof readMobileCellGeometry>, "table">(
                readMobileCellGeometry,
                "table"
              )
              mobileCellGeometry.push({ fixture, width, probe: false, metrics })
              expect(metrics?.length).toBeGreaterThan(0)
              expect.soft(
                metrics !== null && metrics.every((cell) =>
                  cell !== null &&
                  Math.abs(cell.cellWidth - cell.rowContentWidth) <= 1 &&
                  (cell.intrinsicWidth > cell.rowContentWidth || cell.textLines === 1)
                ),
                JSON.stringify({ fixture, width, metrics })
              ).toBe(true)
              // A controlled text probe keeps the original public fixture data intact and exercises unbreakable glyphs.
              await phone.locator(".ac-output-key, .ac-resource-name").first().evaluate((element) => {
                element.textContent = "x".repeat(100)
              })
              const longMetrics = await phone.evaluate<ReturnType<typeof readMobileCellGeometry>, "table">(
                readMobileCellGeometry,
                "table"
              )
              mobileCellGeometry.push({ fixture, width, probe: true, metrics: longMetrics })
              const first = longMetrics?.[0]
              expect.soft(
                first !== null && first !== undefined && first.textLines > 1 &&
                  Math.abs(first.cellWidth - first.rowContentWidth) <= 1 &&
                  first.maxLineWidth <= first.rowContentWidth + 1 &&
                  first.maxLineWidth >= first.rowContentWidth - first.twoGlyphWidth - 1,
                JSON.stringify({ fixture, width, first })
              ).toBe(true)
              expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
              expect(await phone.evaluate(rejectedViewStyles)).toEqual([])
            }
            await phone.goto(`${url}?fixture=6e`)
            await expect(phone.locator(".ac-dependencies a")).toHaveCount(3)
            await phone.evaluate(() => document.fonts.ready)
            const dependencies = await phone.evaluate<ReturnType<typeof readMobileCellGeometry>, "dependencies">(
              readMobileCellGeometry,
              "dependencies"
            )
            mobileCellGeometry.push({ fixture: "6e", width, probe: false, metrics: dependencies })
            expect.soft(
              dependencies !== null && dependencies.every((cell) =>
                cell !== null &&
                cell.cellWidth <= cell.rowContentWidth + 1 &&
                (cell.intrinsicWidth > cell.rowContentWidth || cell.textLines === 1)
              ),
              JSON.stringify({ fixture: "6e", width, dependencies })
            ).toBe(true)
            await phone.locator(".ac-dependencies a").first().evaluate((element) => {
              element.textContent = "x".repeat(100)
            })
            const longDependencies = await phone.evaluate<ReturnType<typeof readMobileCellGeometry>, "dependencies">(
              readMobileCellGeometry,
              "dependencies"
            )
            mobileCellGeometry.push({ fixture: "6e", width, probe: true, metrics: longDependencies })
            const dependency = longDependencies?.[0]
            expect.soft(
              dependency !== null && dependency !== undefined && dependency.textLines > 1 &&
                Math.abs(dependency.cellWidth - dependency.rowContentWidth) <= 1 &&
                dependency.maxLineWidth <= dependency.rowContentWidth + 1 &&
                dependency.maxLineWidth >= dependency.rowContentWidth - dependency.twoGlyphWidth - 1,
              JSON.stringify({ fixture: "6e", width, dependency })
            ).toBe(true)
            for (const link of await phone.locator(".ac-dependencies a").all()) {
              await link.evaluate((element) => element.scrollIntoView({ block: "center" }))
              expect(
                await link.evaluate((element) => {
                  const rect = element.getBoundingClientRect()
                  return [[0, 0], [21, 0], [-21, 0], [0, 21], [0, -21]].every(([dx = 0, dy = 0]) => {
                    const hit = document.elementFromPoint(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy)
                    return hit !== null && element.contains(hit)
                  })
                })
              ).toBe(true)
            }
            expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          } finally {
            await context.close()
          }
        }
        expect(frames).toHaveLength(44)
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.httpServer.close((error) => error === undefined ? resolve() : reject(error))
        })
        await testInfo.attach("nested-consumer-assets", {
          body: JSON.stringify(
            { requests, responses, fontLoads, frames, headerGeometry, mobileCellGeometry, desktopColumns },
            null,
            2
          ),
          contentType: "application/json"
        })
      }
    } finally {
      await runtime.runPromise(fs.remove(directory, { recursive: true }))
    }
  } finally {
    await runtime.dispose()
  }
})

/** Owner expiry is distinct from provider sign-in failure and cannot keep authenticated data on screen. */
test("a refused owner read removes rows and asks for a fresh login", async ({ context, login, page }) => {
  await page.goto(login.url)
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
  await context.clearCookies()
  await page.getByRole("button", { name: "Read again" }).click()
  await expect(page.getByRole("heading", { name: "Your Alchemy console session has ended." })).toBeVisible()
  await expect(page.getByRole("table")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Read again" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
  await page.goto(await login.mint())
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
})

/** One provider failure does not erase a second provider's returned rows or claim all remote state failed. */
test("mixed-success discovery keeps remote rows with generic partial-source copy", async ({ login, page }) => {
  await login.set({
    stacks: populated,
    issues: [{ source: "s3", reason: "denied" }, { source: "local", reason: "invalid-state" }]
  })
  await page.goto(login.url)
  await expect(page.locator(".ac-summary")).toHaveText("6 stacks found · discovery incomplete")
  await expect(page.getByText("billing prod", { exact: true })).toBeVisible()
  await expect(page.getByText("storefront prod", { exact: true })).toBeVisible()
  await expect(page.getByText("docs preview", { exact: true })).toBeVisible()
  await expect(page.locator(".ac-notice")).toHaveCount(2)
  await expect(page.locator(".ac-notice").first()).toContainText(
    "Discovery is incomplete — stacks that could be read are listed."
  )
  await expect(page.locator(".ac-notice").first()).not.toContainText("can't be listed")
})

/** The phone list supports keyboard refresh and real UI stage navigation without API JSON targets. */
test("phone keyboard refresh has no API navigation targets", async ({ login, page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(login.url)
  await expect(page.getByText("billing prod", { exact: true })).toBeVisible()
  await expect(page.locator("main a[href^='/api/']")).toHaveCount(0)
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Skip to stacks" })).toBeFocused()
  await page.keyboard.press("Tab")
  const readAgain = page.getByRole("button", { name: "Read again" })
  await expect(readAgain).toBeFocused()
  expect(await readAgain.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/stacks")
  await page.keyboard.press("Enter")
  expect((await response).status()).toBe(200)
  await expect(page.getByText("billing prod", { exact: true })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/")
  expect(new URL(page.url()).hash).toBe("")
})

/** Fragment removal precedes the POST; neither navigation history, storage nor browser logs retains it. */
test("bootstrap is scrubbed before POST and UI assets stay same-origin without CSP errors", async ({ login, page }) => {
  const token = new URLSearchParams(new URL(login.url).hash.slice(1)).get("bootstrap_token")
  expect(token !== null).toBe(true)
  const messages: Array<string> = []
  const urls: Array<string> = []
  page.on("console", (message) => messages.push(message.text()))
  page.on("pageerror", (error) => messages.push(error.message))
  page.on("request", (request) => urls.push(request.url()))
  let scrubbedBeforePost = false
  await page.route("**/auth/bootstrap", async (route) => {
    scrubbedBeforePost = await page.evaluate(() =>
      window.location.hash === "" && window.location.search === "" && window.history.state === null
    )
    await route.continue()
  })
  await page.goto(login.url)
  await expect(page.getByRole("heading", { name: "billing" })).toBeVisible()
  await page.waitForLoadState("networkidle")
  expect(scrubbedBeforePost).toBe(true)
  expect(
    urls.every((url) =>
      new URL(url).origin === new URL(page.url()).origin && !url.includes("bootstrap_token") &&
      (token === null || !url.includes(token))
    )
  ).toBe(true)
  expect(
    messages.some((message) =>
      (token !== null && message.includes(token)) || message.includes("Content Security Policy")
    )
  ).toBe(false)
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0)
  const styles = await page.locator("link[rel=\"stylesheet\"]").count()
  expect(styles).toBeGreaterThan(0)
  const inlineStyles = await page.locator("[style]").evaluateAll((elements) =>
    elements.map((element) => ({
      tag: element.tagName,
      role: element.getAttribute("role"),
      value: element.getAttribute("style"),
      declarations: element.getAttribute("style")
    }))
  )
  expect(inlineStyles, JSON.stringify(inlineStyles)).toHaveLength(0)
})

/** Compact rows retain metadata and stage text metrics even when the host supplies real detail links. */
test("390px compact rows keep metadata and stage text metrics", async ({ login, page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login.set({ stacks: populated, issues: [] })
  await page.goto(login.url)
  await expect(page.getByText("billing prod", { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  const metrics = await page.locator(".ac-table tbody tr").first().evaluate((row) => {
    const stage = row.querySelector(".ac-stage")
    const metadata = row.querySelector("td")
    if (stage === null || metadata === null) return null
    const rowStyle = getComputedStyle(row)
    const stageStyle = getComputedStyle(stage)
    const metadataStyle = getComputedStyle(metadata)
    return {
      rowLine: Number.parseFloat(rowStyle.lineHeight),
      metadataLine: Number.parseFloat(metadataStyle.lineHeight),
      stageLine: Number.parseFloat(stageStyle.lineHeight),
      stageFont: Number.parseFloat(stageStyle.fontSize),
      stageHeight: stage.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height
    }
  })
  expect(metrics).not.toBeNull()
  if (metrics !== null) {
    expect(metrics.rowLine).toBeCloseTo(metrics.metadataLine, 2)
    expect(metrics.stageLine / metrics.stageFont).toBeCloseTo(4 / 3, 2)
    expect(metrics.stageHeight).toBeLessThanOrEqual(metrics.stageLine + 1)
  }
  const radius = await page.getByRole("button", { name: "Read again" }).evaluate((button) => {
    const style = getComputedStyle(button)
    return { actual: style.borderStartStartRadius, dense: style.getPropertyValue("--rly-radius-tag").trim() }
  })
  expect(radius.actual).toBe(radius.dense)
  await test.info().attach("compact-row-geometry", {
    body: JSON.stringify({ metrics, radius }),
    contentType: "application/json"
  })
})

/** Long returned values must wrap at the smallest phone width without losing keyboard or touch access. */
for (const width of [320, 390]) {
  test(`${width}px touch targets survive long synthetic metadata`, async ({ browser, login }) => {
    const app = "storefront-with-a-long-synthetic-app-name"
    const stage = "staging-with-a-long-synthetic-stage-name"
    await login.set({
      stacks: [{
        key: "synthetic-long-values",
        summary: {
          app,
          stage,
          backend: "local",
          alchemyVersion: "2.0.0-beta.77-synthetic-long-version",
          lastDeploy: "9 Oct · 16:02 UTC",
          resourceCount: 12345
        },
        read: Effect.succeed({
          app,
          stage,
          backend: "local",
          alchemyVersion: null,
          lastDeploy: null,
          resources: [],
          outputs: null
        })
      }],
      issues: []
    })
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
      reducedMotion: "reduce"
    })
    try {
      const page = await context.newPage()
      await page.goto(login.url)
      await expect(page.getByText(`${app} ${stage}`, { exact: true })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const assertControls = async () => {
        const controls = page.locator("main button, main a.ac-list-link")
        expect(await page.locator(".ac-read").count()).toBeGreaterThan(0)
        for (const control of await controls.all()) {
          await control.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }))
          const reachability = await control.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const centerX = rect.x + rect.width / 2
            const centerY = rect.y + rect.height / 2
            const points = [[0, 0], [21, 0], [-21, 0], [0, 21], [0, -21]].map(([dx = 0, dy = 0]) => {
              const hit = document.elementFromPoint(centerX + dx, centerY + dy)
              return hit !== null && element.contains(hit)
            })
            return {
              className: element.className,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              points
            }
          })
          expect(reachability.points.every(Boolean), JSON.stringify(reachability)).toBe(true)
        }
        const disjoint = await controls.evaluateAll((elements) => {
          const areas = elements.map((element) => {
            const rect = element.getBoundingClientRect()
            const width = Math.max(44, rect.width)
            const height = Math.max(44, rect.height)
            const centerX = rect.x + rect.width / 2
            const centerY = rect.y + rect.height / 2
            return {
              start: centerX - width / 2,
              end: centerX + width / 2,
              top: centerY - height / 2,
              bottom: centerY + height / 2
            }
          })
          return areas.every((a, index) =>
            areas.slice(index + 1).every((b) =>
              a.end <= b.start || b.end <= a.start || a.bottom <= b.top || b.bottom <= a.top
            )
          )
        })
        expect(disjoint).toBe(true)
      }
      await assertControls()
      const readAgain = page.getByRole("button", { name: "Read again" })
      await readAgain.focus()
      expect(await readAgain.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
      await login.set({ stacks: populated, issues: [] })
      await page.getByRole("button", { name: "Read again" }).click()
      await expect(page.locator(".ac-stage")).toHaveCount(6)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await assertControls()
      await expect(page.locator("main a[href^='/api/']")).toHaveCount(0)
      await login.set({ stacks: [], issues: [] }, new CatalogReadError({ reason: "denied" }))
      await page.getByRole("button", { name: "Read again" }).click()
      const retry = page.getByRole("button", { name: "Retry", exact: true })
      await expect(retry).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await assertControls()
      await retry.focus()
      await page.keyboard.press("Shift+Tab")
      await page.keyboard.press("Tab")
      await expect(retry).toBeFocused()
      expect(await retry.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
    } finally {
      await context.close()
    }
  })
}

const productionDetail = StackState.make({
  ...detailStack,
  resources: detailStack.resources.map((resource) =>
    ResourceSummary.make({ ...resource, status: "created", updatedAt: null })
  ),
  outputs: [{ key: "apiUrl", value: { _tag: "Hidden" }, description: null }, {
    key: "signingKey",
    value: { _tag: "Hidden" },
    description: null
  }]
})
const detailEntry = {
  key: "synthetic-detail-private-locator",
  summary: {
    app: productionDetail.app,
    stage: productionDetail.stage,
    backend: productionDetail.backend,
    alchemyVersion: productionDetail.alchemyVersion,
    lastDeploy: null,
    resourceCount: productionDetail.resources.length
  },
  read: Effect.succeed(productionDetail)
}

/** Real owner API reads drive list/count navigation, tabs, inverted dependencies and Back. Production values stay Hidden. */
test(
  "owner navigates stacks, resources, State and Hidden outputs through real UI routes",
  async ({ login, page }, testInfo) => {
    const cspErrors: Array<string> = []
    const failedAssets: Array<string> = []
    page.on("requestfailed", (request) => failedAssets.push(new URL(request.url()).pathname))
    page.on("response", (response) => {
      if (response.status() >= 400) failedAssets.push(new URL(response.url()).pathname)
    })
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) cspErrors.push(message.text())
    })
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", () => {
        document.documentElement.dataset.cspViolation = "true"
      })
    })
    await login.set({ stacks: [detailEntry], issues: [] })
    await page.goto(login.url)
    const stage = page.getByRole("link", { name: "storefront prod", exact: true })
    await expect(stage).toBeVisible()
    const count = page.getByRole("link", { name: "storefront prod: 15 resources", exact: true })
    await expect(count).toHaveAttribute("href", await stage.getAttribute("href") ?? "")
    const response = page.waitForResponse((value) => new URL(value.url()).pathname.startsWith("/api/stacks/"))
    await count.click()
    expect((await response).status()).toBe(200)
    await expect(page.locator(".ac-resource-table tbody tr")).toHaveCount(15)
    await expect(page.getByRole("tab", { name: "Resources", exact: true })).toHaveAttribute("aria-selected", "true")
    await page.getByRole("tab", { name: "Outputs", exact: true }).click()
    expect(await page.evaluate(rejectedViewStyles)).toEqual([])
    await expect(page.getByText("Hidden", { exact: true })).toHaveCount(2)
    await expect(page.locator(".ac-output-table a")).toHaveCount(0)
    await page.getByRole("tab", { name: "State", exact: true }).click()
    expect(await page.evaluate(rejectedViewStyles)).toEqual([])
    await expect(page.locator(".ac-construct")).toHaveCount(4)
    await expect(page.locator(".ac-tree-type").first()).toContainText("AWS.Lambda.Function")
    await page.locator(".ac-tree-resource").filter({ hasText: /^api$/ }).click()
    await expect(page.getByRole("heading", { name: "api", exact: true })).toBeVisible()
    await expect(page.locator(".ac-dependencies li")).toHaveCount(3)
    await expect(page.locator(".ac-provider-link")).toHaveAttribute(
      "href",
      /^https:\/\/console\.aws\.amazon\.com\/go\/view\?arn=/
    )
    await expect(page.locator(".ac-provider-link")).toHaveAttribute("rel", "noopener noreferrer")
    await page.locator(".ac-dependencies a").filter({ hasText: "api-role" }).click()
    await expect(page.getByRole("heading", { name: "api-role", exact: true })).toBeVisible()
    await expect(page.locator(".ac-dependencies")).toHaveCount(0)
    const backRead = page.waitForResponse((value) => new URL(value.url()).pathname.startsWith("/api/stacks/"))
    await page.goBack()
    expect((await backRead).status()).toBe(200)
    await expect(page.getByRole("heading", { name: "api", exact: true })).toBeVisible()
    await expect(page.locator("main a[href^='/api/']")).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText(detailEntry.key)
    expect(new URL(page.url()).hash).toBe("")
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
    expect(cspErrors).toEqual([])
    expect(failedAssets).toEqual([])
    expect(await page.evaluate(rejectedViewStyles)).toEqual([])
    expect(await page.locator("html").getAttribute("data-csp-violation")).toBeNull()
    await testInfo.attach("production-tabs-cssom", {
      body: JSON.stringify(
        await page.locator("[style]").evaluateAll((elements) =>
          elements.map((element) => ({
            role: element.getAttribute("role"),
            css: element.getAttribute("style")
          }))
        )
      ),
      contentType: "application/json"
    })
  }
)

/** A failure replaces detail content; retry, removed stack and owner expiry each take their real typed boundary. */
test("detail retry and owner expiry remove old resources, with real 404 after stack removal", async ({ context, login, page }) => {
  await login.set({ stacks: [detailEntry], issues: [] })
  await page.goto(login.url)
  await page.getByRole("link", { name: "storefront prod", exact: true }).click()
  await expect(page.locator(".ac-resource-table tbody tr")).toHaveCount(15)
  await login.set({ stacks: [], issues: [] }, new CatalogReadError({ reason: "denied" }))
  await page.getByRole("button", { name: "Read again" }).click()
  await expect(page.getByRole("heading", { name: "Stack state is unavailable right now." })).toBeVisible()
  await expect(page.locator(".ac-resource-table")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("denied")
  await login.set({ stacks: [detailEntry], issues: [] })
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.locator(".ac-resource-table tbody tr")).toHaveCount(15)
  await context.clearCookies()
  await page.getByRole("button", { name: "Read again" }).click()
  await expect(page.getByRole("heading", { name: "Your Alchemy console session has ended." })).toBeVisible()
  await expect(page.locator(".ac-resource-table")).toHaveCount(0)
  const destination = page.url()
  await page.goto(await login.mint())
  await expect(page.getByRole("link", { name: "storefront prod", exact: true })).toBeVisible()
  await login.set({ stacks: [], issues: [] })
  await page.goto(destination)
  await expect(page.getByRole("heading", { name: "This stack is no longer available." })).toBeVisible()
  await expect(page.locator(".ac-resource-table")).toHaveCount(0)
})

/** A validated UI destination survives login, while the credential fragment is gone before the exchange. */
test("owner bootstrap restores only the validated detail destination after POST", async ({ login, page }) => {
  await login.set({ stacks: [detailEntry], issues: [] })
  await page.goto(login.url)
  const target = await page.getByRole("link", { name: "storefront prod", exact: true }).getAttribute("href")
  expect(target).not.toBeNull()
  const link = new URL(await login.mint())
  link.search = `${new URL(target ?? "/", link).search}&tab=outputs&extra=synthetic-discarded`
  let stripped = false
  await page.route("**/auth/bootstrap", async (route) => {
    stripped = await page.evaluate(() => location.hash === "" && location.search === "" && history.state === null)
    await route.continue()
  })
  await page.goto(link.href)
  await expect(page.getByText("Hidden", { exact: true })).toHaveCount(2)
  expect(stripped).toBe(true)
  expect(new URL(page.url()).hash).toBe("")
  expect(new URL(page.url()).searchParams.get("extra")).toBeNull()
  expect(new URL(page.url()).searchParams.get("tab")).toBe("outputs")
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
})

/** Returned resource identity is bounded but may be long; coarse-pointer targets and tree disclosures must stay reachable. */
for (const width of [320, 390]) {
  test(`${width}px detail touch/navigation handles long resource metadata without overlap`, async ({ browser, login }) => {
    const resource = ResourceSummary.make({
      fqn: "NotificationFanoutOrchestrator/notification-fanout-retry-queue-with-exponential-backoff",
      logicalId: "notification-fanout-retry-queue-with-exponential-backoff",
      resourceType: "AWS.SQS.Queue",
      parent: "NotificationFanoutOrchestrator",
      status: "created",
      downstream: [],
      providerId: "storefront-notification-fanout-retry-queue-with-exponential-backoff",
      account: "123456789012",
      region: "eu-west-1",
      updatedAt: null,
      consoleUrl:
        "https://console.aws.amazon.com/go/view?arn=arn%3Aaws%3Asqs%3Aeu-west-1%3A123456789012%3Astorefront-notification-fanout-retry-queue-with-exponential-backoff"
    })
    await login.set({
      stacks: [{
        ...detailEntry,
        summary: { ...detailEntry.summary, resourceCount: 1 },
        read: Effect.succeed({ ...productionDetail, resources: [resource] })
      }],
      issues: []
    })
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: "dark",
      reducedMotion: "reduce"
    })
    try {
      const page = await context.newPage()
      await page.goto(login.url)
      await page.getByRole("link", { name: "storefront prod", exact: true }).click()
      await expect(page.locator(".ac-resource-table tbody tr")).toHaveCount(1)
      const assertReachable = async () => {
        await page.evaluate(() => document.fonts.ready)
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const controls = page.locator("main a, main button, main summary")
        expect(await controls.count()).toBeGreaterThan(0)
        for (const control of await controls.all()) {
          if (!await control.isVisible()) continue
          await control.scrollIntoViewIfNeeded()
          const hits = await control.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return [[0, 0], [21, 0], [-21, 0], [0, 21], [0, -21]].map(([dx = 0, dy = 0]) => {
              const hit = document.elementFromPoint(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy)
              return hit !== null && element.contains(hit)
            })
          })
          expect(
            hits.every(Boolean),
            JSON.stringify(
              await control.evaluate((element) => {
                const rect = element.getBoundingClientRect()
                return {
                  label: element.textContent,
                  role: element.getAttribute("role"),
                  className: element.className,
                  box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  points: [[0, 0], [21, 0], [-21, 0], [0, 21], [0, -21]].map(([dx = 0, dy = 0]) => {
                    const hit = document.elementFromPoint(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy)
                    return { dx, dy, hit: hit?.outerHTML.slice(0, 400), matches: hit !== null && element.contains(hit) }
                  })
                }
              })
            )
          ).toBe(true)
        }
        expect(
          await controls.evaluateAll((elements) => {
            const areas = elements.filter((element) => element.getClientRects().length > 0).map((element) => {
              const r = element.getBoundingClientRect()
              const w = Math.max(44, r.width), h = Math.max(44, r.height)
              return { x: r.x + r.width / 2 - w / 2, y: r.y + r.height / 2 - h / 2, w, h }
            })
            return areas.every((a, i) =>
              areas.slice(i + 1).every((b) =>
                a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
              )
            )
          })
        ).toBe(true)
      }
      await assertReachable()
      const resourceLink = page.locator(".ac-resource-table a.ac-resource-name")
      await resourceLink.focus()
      expect(await resourceLink.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
      await resourceLink.click()
      await expect(page.getByRole("heading", { name: resource.logicalId, exact: true })).toBeVisible()
      await assertReachable()
      await page.locator(".ac-resource-back").click()
      await page.getByRole("tab", { name: "State", exact: true }).click()
      await expect(page.locator(".ac-construct summary")).toContainText(resource.parent ?? "")
      await assertReachable()
      const disclosure = page.locator(".ac-construct summary")
      await disclosure.focus()
      await page.keyboard.press("Enter")
      await expect(page.locator(".ac-construct")).not.toHaveAttribute("open")
      await page.keyboard.press("Enter")
      await expect(page.locator(".ac-tree-resource")).toBeVisible()
      await expect(page.locator("main a[href^='/api/']")).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
}

/** Framework CSSOM effects are bounded; authored serialized styles remain blocked by the real listener policy. */
test(
  "detail style guard rejects extra declarations and CSP refuses serialized markup",
  async ({ login, page }, testInfo) => {
    await login.set({ stacks: [detailEntry], issues: [] })
    await page.goto(login.url)
    await page.getByRole("link", { name: "storefront prod", exact: true }).click()
    await expect(page.getByRole("tab", { name: "Resources", exact: true })).toBeVisible()
    expect(await page.evaluate(rejectedViewStyles)).toEqual([])
    const list = page.locator(".ac-detail-tabs [role='tablist']")
    await testInfo.attach("radix-outline-cssom", {
      body: JSON.stringify(
        await page.evaluate(() => {
          const target = document.querySelector<HTMLDivElement>(".ac-detail-tabs [role='tablist']")
          return target === null ? null : {
            cssText: target.style.cssText,
            properties: Array.from({ length: target.style.length }, (_, index) => target.style.item(index))
          }
        })
      ),
      contentType: "application/json"
    })
    try {
      await list.evaluate((element) => {
        const target = element.querySelector<HTMLButtonElement>("button")?.parentElement
        if (target !== undefined && target !== null) target.style.color = "rgb(1, 2, 3)"
      })
      expect((await page.evaluate(rejectedViewStyles)).some((style) => style.includes("color:"))).toBe(true)
    } finally {
      await list.evaluate((element) => {
        const target = element.querySelector<HTMLButtonElement>("button")?.parentElement
        target?.style.removeProperty("color")
      })
    }
    expect(await page.evaluate(rejectedViewStyles)).toEqual([])
    const probe = await page.evaluate(async () => {
      const element = document.createElement("span")
      element.textContent = "CSP style probe"
      document.body.append(element)
      try {
        const before = getComputedStyle(element).color
        const refused = new Promise<boolean>((resolve) => {
          const observe = (event: SecurityPolicyViolationEvent) => {
            if (event.blockedURI === "inline" && event.effectiveDirective === "style-src-attr") {
              document.removeEventListener("securitypolicyviolation", observe)
              resolve(true)
            }
          }
          document.addEventListener("securitypolicyviolation", observe)
        })
        element.setAttribute("style", "color: rgb(1, 2, 3)")
        return { refused: await refused, unchanged: getComputedStyle(element).color === before }
      } finally {
        element.remove()
      }
    })
    expect(probe).toEqual({ refused: true, unchanged: true })
  }
)
