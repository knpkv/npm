import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { start } from "../scripts/fixture.js"
import { browserCall, capturePage } from "../src/browser.js"
import { installCaptureClock } from "../src/capture.js"
import { comparePixels } from "../src/compare.js"
import { LiveProduct } from "../src/live.js"
import { loadReferences, readJson } from "../src/references.js"
import { runConformance } from "../src/runner.js"
import { Identity, Manifest, Result, RunnerFailure, Snapshot, type State } from "../src/schema.js"
import { serveFiles } from "../src/server.js"
import { verdict } from "../src/verdict.js"
import { localServer, testLive, testReferences } from "./fixtures.js"

test("a scoped state preserves missing-route coverage from the authoritative live route table", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      const refs = yield* loadReferences(path.join(repository, "design-refs/_fixture"))
      const live = yield* start(refs.fixture, repository)
      const selected = {
        ...live,
        inventory: { ...live.inventory, states: live.inventory.states.filter((state) => state.state === "passing") }
      }
      for (const routes of [[], live.inventory.routes]) {
        const result = yield* runConformance(refs, {
          state: "toy/passing",
          output: yield* fs.makeTempDirectoryScoped()
        }).pipe(Effect.provideService(LiveProduct, { ...selected, inventory: { ...selected.inventory, routes } }))
        if (result === undefined) return yield* new RunnerFailure({ detail: "Scoped route check returned no verdict" })
        const missing = result.findings.filter((finding) =>
          finding.rule === "coverage" && finding.detail === "State route missing from live route table"
        )
        expect(missing.length).toBe(routes.length === 0 ? 1 : 0)
        if (routes.length === 0) expect(missing.every((finding) => finding.disposition === "required")).toBe(true)
        else expect(result.passed).toBe(true)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

test("hashed external SVG assets render with their intrinsic dimensions in reference and live captures", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const refs = yield* testReferences(
        "<html data-design-ready=true><body><main data-region=content><img src='/probe.svg?cache=fixture#shape' alt='Fixture square'></main></body></html>",
        {
          "probe.svg":
            "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='red'/></svg>"
        }
      )
      const origin = yield* serveFiles(refs.root, { "/page.html": "page.html", "/probe.svg": "probe.svg" })
      const live = testLive(origin)
      const result = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
        Effect.provideService(LiveProduct, {
          ...live,
          ready: (page, identity) =>
            live.ready(page, identity).pipe(Effect.andThen(browserCall("assert rendered SVG", async () => {
              const dimensions = await page.evaluate(async () => {
                const image = document.querySelector("img")
                if (image === null) return { width: 0, height: 0 }
                await image.decode()
                return { width: image.naturalWidth, height: image.naturalHeight }
              })
              expect(dimensions).toEqual({ width: 64, height: 64 })
            })))
        })
      )
      if (result === undefined) return yield* new RunnerFailure({ detail: "SVG check returned no verdict" })
      expect(result.passed).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

test("hash-route navigation preserves query and fragment and waits for adapter settlement", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      const refs = yield* loadReferences(path.join(repository, "design-refs/_fixture"))
      const live = yield* start(refs.fixture, repository)
      const route = "/screen.html?state=fixture-nonce&theme=application-theme&range=7d&timeZone=UTC#usage/limits"
      const hashRouted = LiveProduct.of({
        ...live,
        inventory: {
          routes: [route],
          states: [{ screen: "toy", state: "passing", route, viewports: [390], themes: ["light"] }]
        },
        seed: (page, fixture, identity) =>
          Effect.gen(function*() {
            yield* live.seed(page, fixture, identity)
            yield* browserCall("assert hash settlement before screenshot", async () => {
              const screenshot = page.screenshot.bind(page)
              page.screenshot = async (options) => {
                expect(await page.locator("h1").textContent()).toBe("Hash route settled")
                return screenshot(options)
              }
            })
          }),
        ready: (page, identity) =>
          Effect.gen(function*() {
            yield* live.ready(page, identity)
            yield* browserCall("settle toy hash route", async () => {
              const expected = new URL(route, live.origin)
              expect(page.url()).toBe(expected.href)
              await page.locator("h1").evaluate((heading) =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => {
                    heading.textContent = "Hash route settled"
                    resolve()
                  })
                })
              )
            })
          })
      })
      const output = yield* fs.makeTempDirectoryScoped()
      yield* runConformance(refs, { output, captureOnly: true }).pipe(Effect.provideService(LiveProduct, hashRouted))
      expect(yield* readJson(path.join(output, "captures.json"), Schema.Array(Identity)))
        .toEqual([{ screen: "toy", state: "passing", viewport: 390, theme: "light" }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

test("toy refs prove required, waived, stale, coverage, legacy and touched decisions", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      const refs = yield* loadReferences(path.join(repository, "design-refs/_fixture"))
      const live = yield* start(refs.fixture, repository)
      const base = path.join(repository, "test-results/design-conformance/base/_fixture")
      const output = path.join(repository, "test-results/design-conformance/current/_fixture")
      yield* runConformance(refs, { output: base, captureOnly: true }).pipe(Effect.provideService(LiveProduct, live))
      const clock = yield* Clock.Clock
      const fixed = Clock.Clock.of({
        sleep: (duration) => clock.sleep(duration),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        currentTimeMillis: Effect.succeed(1792195200000),
        currentTimeMillisUnsafe: () => 1792195200000,
        currentTimeNanos: Effect.succeed(1792195200000000000n),
        currentTimeNanosUnsafe: () => 1792195200000000000n
      })
      const result = yield* runConformance(refs, { output, base }).pipe(
        Effect.provideService(LiveProduct, live),
        Effect.provideService(Clock.Clock, fixed)
      )
      expect(result).toBeDefined()
      if (result === undefined) return yield* new RunnerFailure({ detail: "Toy comparison returned no verdict" })
      expect(result.findings.filter((finding) => finding.state === "passing")).toEqual([])
      for (
        const [state, rule] of [["copy", "copy"], ["geometry", "geometry"], ["token", "tokens"], ["pixel", "pixels"]]
      ) {
        expect(result.findings.some((finding) => finding.state === state && finding.rule === rule)).toBe(true)
      }
      const waived = result.findings.filter((finding) => finding.state === "waived")
      expect(waived.length).toBeGreaterThan(0)
      expect(waived.every((finding) => finding.disposition === "waived")).toBe(true)
      expect(
        result.findings.some((finding) =>
          finding.state === "stale" && finding.rule === "stale-waiver" && finding.disposition === "required"
        )
      ).toBe(true)
      expect(
        result.findings.some((finding) =>
          finding.state === "unreferenced" && finding.rule === "coverage" && finding.disposition === "required"
        )
      ).toBe(true)
      const legacy = result.findings.filter((finding) => finding.state === "legacy")
      expect(legacy.length).toBeGreaterThan(0)
      expect(legacy.every((finding) => finding.disposition === "report-only")).toBe(true)
      expect(result.shots.every((shot) => !shot.touched)).toBe(true)
      const rawFailures = result.findings.filter((finding) => finding.rule !== "stale-waiver")
      const expired = verdict(
        refs.manifest,
        rawFailures,
        refs.waivers,
        result.shots,
        DateTime.makeUnsafe("2026-10-18T00:00:00.000Z")
      )
      expect(
        expired.findings.filter((finding) => finding.state === "legacy").every((finding) =>
          finding.disposition === "required"
        )
      ).toBe(true)
      const touched = verdict(
        refs.manifest,
        rawFailures,
        refs.waivers,
        result.shots.map((shot) => ({
          ...shot,
          touched: true,
          touchedRegions: ["*", "content"],
          outsidePixelsChanged: true
        })),
        DateTime.makeUnsafe("2026-10-17T00:00:00.000Z")
      )
      expect(touched.findings.some((finding) => finding.state === "copy" && finding.disposition === "required")).toBe(
        true
      )
      const passing = verdict(
        refs.manifest,
        [],
        [],
        result.shots.filter((shot) => shot.state === "passing"),
        DateTime.makeUnsafe("2026-10-17T00:00:00.000Z")
      )
      expect(passing.passed).toBe(true)
      const pixels = yield* fs.readFile(path.join(output, "toy--passing--390--light-live.png"))
      const reference = yield* fs.readFile(path.join(output, "toy--passing--390--light-ref.png"))
      expect(comparePixels(reference, pixels).ratio).toBe(0)
      expect(yield* fs.exists(path.join(output, "index.html"))).toBe(true)
      expect(yield* fs.exists(path.join(output, "result.json"))).toBe(true)

      const rejected = yield* runConformance(refs, { output: path.join(output, "rejected"), state: "toy/copy" }).pipe(
        Effect.provideService(LiveProduct, live)
      )
      expect(rejected?.passed).toBe(false)
      expect(rejected?.findings.some((finding) => finding.rule === "copy" && finding.disposition === "required")).toBe(
        true
      )
      const referenceScript = yield* fs.readFileString(path.join(refs.root, "screens/screen.js"))
      const repaired = LiveProduct.of({
        ...live,
        seed: (page, fixture, identity) =>
          Effect.gen(function*() {
            yield* live.seed(page, fixture, identity)
            yield* browserCall("repair toy copy", () =>
              page.route(
                "**/screen.js",
                (route) =>
                  route.fulfill({
                    body: referenceScript.replace(
                      "new URLSearchParams(location.search)",
                      "new URLSearchParams(globalThis.__designFixtureIdentity)"
                    ),
                    contentType: "text/javascript"
                  })
              ))
          })
      })
      const accepted = yield* runConformance(refs, { output: path.join(output, "repaired"), state: "toy/copy" }).pipe(
        Effect.provideService(LiveProduct, repaired)
      )
      expect(accepted?.passed).toBe(true)
      expect(accepted?.findings).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** Off-frame regions are drift evidence, rather than a renderer exception that prevents reports. */
test("fully off-frame live regions retain metadata findings and obey legacy grace in written reports", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const html = `<html data-design-ready=true><body>
        <style>body { margin: 0; font-size: 16px; } main { inline-size: 40px; block-size: 40px; background: rgb(255, 0, 0); transform: none; }</style>
        <main data-region=content>Box</main>
      </body></html>`
      const loaded = yield* testReferences(html)
      const refs = {
        ...loaded,
        manifest: {
          ...loaded.manifest,
          enforcement: {
            ...loaded.manifest.enforcement,
            legacy: { mode: "report-only", until: DateTime.add(yield* DateTime.now, { days: 7 }) }
          }
        }
      } satisfies Effect.Success<ReturnType<typeof loadReferences>>
      const liveHtml = html.replace("transform: none", "transform: translateX(-40px)").replace(
        ">Box</main>",
        ">Drift</main>"
      )
      const origin = yield* localServer(() => HttpServerResponse.html(liveHtml))
      const live = testLive(origin)
      const output = yield* fs.makeTempDirectoryScoped()
      const required = yield* runConformance(refs, { output }).pipe(Effect.provideService(LiveProduct, live))
      expect(required?.passed).toBe(false)
      for (const rule of ["geometry", "copy", "pixels"]) {
        expect(
          required?.findings.some((finding) =>
            finding.region === "content" && finding.rule === rule && finding.disposition === "required"
          )
        ).toBe(true)
      }
      expect(
        required?.findings.some((finding) => finding.rule === "pixels" && finding.detail.includes("Off-frame region"))
      ).toBe(true)
      expect(yield* readJson(path.join(output, "result.json"), Result)).toEqual(required)
      expect(yield* fs.exists(path.join(output, "index.html"))).toBe(true)
      expect(yield* fs.exists(path.join(output, "toy--passing--390--light-content-live.png"))).toBe(false)
      expect(yield* fs.exists(path.join(output, "toy--passing--390--light-content-ref.png"))).toBe(true)
      const base = yield* fs.makeTempDirectoryScoped()
      yield* runConformance(refs, { output: base, captureOnly: true }).pipe(Effect.provideService(LiveProduct, live))
      const graceOutput = yield* fs.makeTempDirectoryScoped()
      const grace = yield* runConformance(refs, { output: graceOutput, base }).pipe(
        Effect.provideService(LiveProduct, live)
      )
      expect(grace?.passed).toBe(true)
      expect(grace?.findings.length).toBeGreaterThan(0)
      expect(grace?.findings.every((finding) => finding.disposition === "report-only")).toBe(true)
      expect(grace?.shots.every((shot) => !shot.touched)).toBe(true)
      expect(yield* readJson(path.join(graceOutput, "result.json"), Result)).toEqual(grace)
      expect(yield* fs.exists(path.join(graceOutput, "index.html"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** A visible empty live region must reach normal findings and grace instead of aborting the report. */
test("zero-height live regions retain membership findings and obey legacy grace in written reports", async ({ page }) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const html = `<html data-design-ready=true><body>
        <style>body { margin: 0; } main { inline-size: 2.5em; block-size: 2.5em; } [data-region=cards] { inline-size: 2.5em; block-size: 0; }</style>
        <main data-region=content>Box</main>
      </body></html>`
      const loaded = yield* testReferences(html)
      const refs = {
        ...loaded,
        manifest: {
          ...loaded.manifest,
          enforcement: {
            ...loaded.manifest.enforcement,
            legacy: { mode: "report-only", until: DateTime.add(yield* DateTime.now, { days: 7 }) }
          }
        }
      } satisfies Effect.Success<ReturnType<typeof loadReferences>>
      const liveHtml = html.replace("</main>", "</main><div data-region=cards></div>")
      const origin = yield* localServer(() => HttpServerResponse.html(liveHtml))
      const live = testLive(origin)
      yield* browserCall("zero-height fixture viewport", () => page.setViewportSize({ width: 390, height: 844 }))
      yield* browserCall("zero-height fixture clock", () => installCaptureClock(page))
      yield* browserCall("zero-height fixture navigation", () => page.goto(`${origin}/page.html`))
      expect(
        yield* browserCall(
          "zero-height fixture visibility",
          () =>
            page.locator("[data-region=cards]").evaluate((element) =>
              element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
            )
        )
      ).toBe(true)
      const captured = yield* capturePage(page)
      expect(captured.snapshot.regions.find((region) => region.name === "cards")?.box).toEqual({
        x: 0,
        y: 40,
        width: 40,
        height: 0
      })
      expect(captured.regions.get("cards")).toMatchObject({ _tag: "OffFrame" })
      const output = yield* fs.makeTempDirectoryScoped()
      const required = yield* runConformance(refs, { output }).pipe(Effect.provideService(LiveProduct, live))
      expect(required?.passed).toBe(false)
      // The extra region is reported once, as its own finding; shared regions keep their order, so no order finding.
      expect(
        required?.findings.some((finding) =>
          finding.rule === "geometry" && finding.region === "*" && finding.detail === "Region order differs"
        )
      ).toBe(false)
      expect(
        required?.findings.some((finding) =>
          finding.rule === "geometry" && finding.region === "cards" && finding.disposition === "required"
        )
      ).toBe(true)
      expect(yield* readJson(path.join(output, "result.json"), Result)).toEqual(required)
      expect(yield* fs.exists(path.join(output, "index.html"))).toBe(true)
      expect(yield* fs.exists(path.join(output, "toy--passing--390--light-cards-live.png"))).toBe(false)
      const base = yield* fs.makeTempDirectoryScoped()
      yield* runConformance(refs, { output: base, captureOnly: true }).pipe(Effect.provideService(LiveProduct, live))
      const graceOutput = yield* fs.makeTempDirectoryScoped()
      const grace = yield* runConformance(refs, { output: graceOutput, base }).pipe(
        Effect.provideService(LiveProduct, live)
      )
      expect(grace?.passed).toBe(true)
      expect(grace?.findings.length).toBeGreaterThan(0)
      expect(grace?.findings.every((finding) => finding.disposition === "report-only")).toBe(true)
      expect(grace?.shots.every((shot) => !shot.touched)).toBe(true)
      expect(yield* readJson(path.join(graceOutput, "result.json"), Result)).toEqual(grace)
      expect(yield* fs.exists(path.join(graceOutput, "index.html"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** Compare real PNG evidence with identical metadata, so tolerance cannot hide arbitrary pixels. */
test("PNG refs reject a disabled pixel threshold, accept drift within 2% and require unrelated pixels", async ({ page }) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const html = `<html data-design-ready=true><body>
        <style>body { margin: 0; } main { inline-size: 40px; block-size: 40px; background: rgb(255, 0, 0); }</style>
        <main data-region=content></main>
      </body></html>`
      const initial = yield* testReferences(html)
      const origin = yield* localServer(() => HttpServerResponse.html(html))
      yield* browserCall("PNG fixture navigation", async () => {
        await page.setViewportSize({ width: 390, height: 844 })
        await installCaptureClock(page)
        await page.goto(`${origin}/page.html`)
      })
      const reference = yield* capturePage(page)
      const pngState: State = {
        screen: "toy",
        state: "passing",
        route: "/page.html",
        status: "implemented",
        source: "png",
        viewports: [390],
        themes: ["light"],
        regions: ["content"],
        pixelMaxDiffRatio: 0.02,
        refs: [{ viewport: 390, theme: "light", image: "shot.png", metadata: "shot.json" }]
      }
      const metadata = new TextEncoder().encode(
        yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(reference.snapshot)
      )
      const writeRefs = Effect.fn("PngTest.writeReferences")(function*(pixels: Uint8Array, ratio: number) {
        const files = { ...initial.manifest.files }
        for (
          const [file, bytes] of [["shot.png", pixels], ["shot.json", metadata]] satisfies ReadonlyArray<
            readonly [string, Uint8Array]
          >
        ) {
          yield* fs.writeFile(path.join(initial.root, file), bytes)
          const hash = yield* cryptoService.digest("SHA-256", bytes)
          files[file] = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
        }
        const encoded = yield* Schema.encodeEffect(Manifest)({ ...initial.manifest, files, states: [pngState] })
        yield* fs.writeFileString(
          path.join(initial.root, "manifest.json"),
          JSON.stringify({
            ...encoded,
            states: encoded.states.map((state) => ({ ...state, pixelMaxDiffRatio: ratio }))
          })
        )
        return yield* loadReferences(initial.root)
      })
      const unrelated = PNG.sync.read(Buffer.from(reference.frame))
      for (let index = 0; index < unrelated.data.length; index += 4) {
        unrelated.data[index] = 0
        unrelated.data[index + 1] = 0
        unrelated.data[index + 2] = 255
        unrelated.data[index + 3] = 255
      }
      const arbitrary = PNG.sync.write(unrelated)
      expect(yield* writeRefs(arbitrary, 1).pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidContract",
        cause: { _tag: "SchemaError" }
      })
      const nearby = PNG.sync.read(Buffer.from(reference.frame))
      for (let y = 10; y < 14; y += 1) {
        for (let x = 10; x < 14; x += 1) {
          const pixel = (y * nearby.width + x) * 4
          nearby.data[pixel] = 0
          nearby.data[pixel + 1] = 255
        }
      }
      const nearbyBytes = PNG.sync.write(nearby)
      const ratio = comparePixels(nearbyBytes, reference.frame).ratio
      expect(ratio).toBeGreaterThan(0)
      expect(ratio).toBeLessThanOrEqual(0.02)
      const refs = yield* writeRefs(nearbyBytes, 0.02)
      const accepted = yield* runConformance(refs, { output: yield* fs.makeTempDirectoryScoped() }).pipe(
        Effect.provideService(LiveProduct, testLive(origin))
      )
      expect(accepted?.passed).toBe(true)
      expect(accepted?.findings).toEqual([])
      const rejected = yield* runConformance(yield* writeRefs(arbitrary, 0.02), {
        output: yield* fs.makeTempDirectoryScoped()
      }).pipe(
        Effect.provideService(LiveProduct, testLive(origin))
      )
      expect(rejected?.passed).toBe(false)
      for (const region of ["*", "content"]) {
        expect(
          rejected?.findings.some((finding) =>
            finding.region === region && finding.rule === "pixels" && finding.disposition === "required"
          )
        ).toBe(true)
      }
      expect(rejected?.findings.every((finding) => finding.rule === "pixels")).toBe(true)
      const artifacts = rejected?.shots[0]?.artifacts
      expect(artifacts?.["diff-frame"]).toBeDefined()
      expect(artifacts?.["diff-content"]).toBeDefined()
      expect(artifacts?.["diff-frame"]).not.toBe(artifacts?.["diff-content"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
