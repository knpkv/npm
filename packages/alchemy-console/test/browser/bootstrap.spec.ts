import { NodeServices } from "@effect/platform-node"
import { expect, type Page, test as base } from "@playwright/test"
import { Context, Deferred, Effect, FileSystem, Layer, ManagedRuntime, Option, Path, Ref, Schema } from "effect"
import { isBuiltin } from "node:module"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { build, type Plugin, preview } from "vite"
import { CatalogReadError, StackDetail, StackId, StackList } from "../../src/api.js"
import { Catalog } from "../../src/server/Catalog.js"
import { requestLoginUrl } from "../../src/server/ControlSocket.js"
import type { ControlError } from "../../src/server/ControlSocket.js"
import { makeServer } from "../../src/server/Server.js"
import { FixtureSource, fixtureSourceLayer } from "../catalogFixture.js"
import { type ListFixture, listFixtures, populated } from "./list-fixtures.js"

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
).pipe(Layer.provide(Catalog.layer.pipe(Layer.provideMerge(fixtureSourceLayer))), Layer.provide(NodeServices.layer))

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
          await expect(page.locator(".ac-table tbody td:last-child a")).toHaveCount(0)
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

/** Public assets resolve beneath a consumer's mount, with no dependency on origin-root files. */
test("built views consumer loads creature and both fonts beneath /console/", async ({ page }, testInfo) => {
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
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.httpServer.close((error) => error === undefined ? resolve() : reject(error))
        })
        await testInfo.attach("nested-consumer-assets", {
          body: JSON.stringify({ requests, responses, fontLoads }, null, 2),
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

/** The phone list supports keyboard refresh while stages stay static until the detail UI exists. */
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
  await expect(page.locator("[style]")).toHaveCount(0)
})

/** Static compact rows inherit metadata metrics and keep stage text at its own visible rhythm. */
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
        read: Effect.succeed({ app, stage, backend: "local", alchemyVersion: null, lastDeploy: null, resources: [] })
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
        const controls = page.getByRole("button")
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
