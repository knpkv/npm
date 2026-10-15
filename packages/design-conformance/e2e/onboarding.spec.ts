import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { platform } from "node:os"

import { start } from "../scripts/fixture.js"
import { captureBaseProduct, isReferenceOnlyChange } from "../scripts/product.js"
import { browserCall } from "../src/browser.js"
import { LiveProduct } from "../src/live.js"
import { loadReferences } from "../src/references.js"
import { runConformance } from "../src/runner.js"
import { type Manifest, RunnerFailure } from "../src/schema.js"
import { serveFiles } from "../src/server.js"
import { readyHtml, testLive, testReferences } from "./fixtures.js"

test("aliased output cannot overwrite base captures; sibling and distinct symlink targets remain valid", async () => {
  test.skip(
    platform() === "win32",
    "Creating directory symlinks requires additional Windows privileges; CI runs this regression on Linux"
  )
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const base = path.join(root, "base")
      yield* fs.makeDirectory(base)
      yield* fs.writeFileString(path.join(base, "captures.json"), "[]")
      const alias = path.join(root, "alias")
      yield* fs.symlink(base, alias)
      const refs = yield* testReferences(readyHtml)
      let seeds = 0
      const origin = yield* serveFiles(refs.root, { "/page.html": "page.html" })
      const live = {
        ...testLive(origin),
        seed: () =>
          Effect.sync(() => {
            seeds += 1
          })
      }
      const invalid = yield* runConformance(refs, { output: alias, base, captureOnly: true }).pipe(
        Effect.provideService(LiveProduct, live),
        Effect.flip
      )
      expect(invalid).toMatchObject({
        _tag: "RunnerFailure",
        detail: "Base and current capture directories must differ"
      })
      expect(seeds).toBe(0)
      expect(yield* fs.readFileString(path.join(base, "captures.json"))).toBe("[]")
      expect(yield* fs.readDirectory(base)).toEqual(["captures.json"])
      const sibling = path.join(root, "sibling")
      yield* runConformance(refs, { output: sibling, base, captureOnly: true }).pipe(
        Effect.provideService(LiveProduct, live)
      )
      const target = path.join(root, "target")
      yield* fs.makeDirectory(target)
      const distinct = path.join(root, "distinct")
      yield* fs.symlink(target, distinct)
      yield* runConformance(refs, { output: distinct, base, captureOnly: true }).pipe(
        Effect.provideService(LiveProduct, live)
      )
      expect(seeds).toBe(2)
      expect(yield* fs.exists(path.join(target, "captures.json"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

test("onboarding uses base live UI; one live change is required; refs-only changes stay untouched", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repository = yield* path.fromFileUrl(new URL("../../../", import.meta.url))
      const root = yield* fs.makeTempDirectoryScoped()
      const checkout = path.join(root, "checkout")
      const app = "packages/design-conformance/test/fixtures"
      yield* fs.makeDirectory(path.dirname(path.join(checkout, app)), { recursive: true })
      yield* fs.copy(path.join(repository, app), path.join(checkout, app))
      // Only live assets exist on the base. Its refs, adapter and gate code do not.
      expect(yield* fs.exists(path.join(checkout, "design-refs/_fixture/manifest.json"))).toBe(false)
      expect(yield* fs.exists(path.join(checkout, "packages/design-conformance/scripts/fixture.ts"))).toBe(false)
      const base = path.join(root, "base")
      yield* captureBaseProduct(repository, checkout, "_fixture", base)
      const loaded = yield* loadReferences(path.join(repository, "design-refs/_fixture"))
      const refs = {
        ...loaded,
        manifest: {
          ...loaded.manifest,
          enforcement: {
            touched: "required",
            legacy: { mode: "report-only", until: DateTime.add(yield* DateTime.now, { days: 7 }) }
          }
        } satisfies Manifest
      }
      const live = yield* start(refs.fixture, repository)
      const unchanged = yield* runConformance(refs, { base, output: path.join(root, "unchanged") }).pipe(
        Effect.provideService(LiveProduct, live)
      )
      if (unchanged === undefined) return yield* new RunnerFailure({ detail: "Onboarding returned no verdict" })
      expect(unchanged.shots.every((shot) => !shot.touched)).toBe(true)
      const drift = unchanged.findings.filter((finding) => ["copy", "legacy"].includes(finding.state))
      expect(drift.length).toBeGreaterThan(0)
      expect(drift.every((finding) => finding.disposition === "report-only")).toBe(true)

      // Modify exactly one live state, while leaving its ref and the legacy state alone.
      const script = yield* fs.readFileString(path.join(repository, app, "screen.js"))
      const changedScript =
        `${script}\nif (state === "copy") document.querySelector("main").style.transform = "translateX(40px)"`
      const changed = LiveProduct.of({
        ...live,
        seed: (page, fixture, identity) =>
          Effect.gen(function*() {
            yield* live.seed(page, fixture, identity)
            yield* browserCall("change one onboarding state", () =>
              page.route("**/screen.js", (route) =>
                route.fulfill({ body: changedScript, contentType: "text/javascript" })))
          })
      })
      const implementation = yield* runConformance(refs, { base, output: path.join(root, "implementation") }).pipe(
        Effect.provideService(LiveProduct, changed)
      )
      if (implementation === undefined) {
        return yield* new RunnerFailure({ detail: "Implementation returned no verdict" })
      }
      expect(implementation.shots.filter((shot) => shot.touched).map((shot) => shot.state)).toEqual([
        "copy",
        "copy",
        "copy",
        "copy"
      ])
      expect(implementation.findings.some((finding) => finding.state === "copy" && finding.disposition === "required"))
        .toBe(true)
      expect(
        implementation.findings.filter((finding) => finding.state === "legacy").every((finding) =>
          finding.disposition === "report-only"
        )
      ).toBe(true)

      // Ref fixture changes can alter pixels; the actual PR diff still contains no live-code changes.
      yield* fs.writeFileString(
        path.join(base, "comparison.json"),
        JSON.stringify({
          referenceOnly: isReferenceOnlyChange(["design-refs/_fixture/fixture.json"], [refs.manifest])
        })
      )
      const refOnly = yield* runConformance(
        { ...refs, fixture: { ...refs.fixture, data: { ...refs.fixture.data, heading: "Reference fixture change" } } },
        { base, output: path.join(root, "refs-only") }
      ).pipe(Effect.provideService(LiveProduct, live))
      if (refOnly === undefined) return yield* new RunnerFailure({ detail: "Ref-only PR returned no verdict" })
      expect(refOnly.shots.every((shot) => !shot.touched)).toBe(true)
      expect(refOnly.findings.some((finding) => finding.state === "passing" && finding.disposition === "report-only"))
        .toBe(true)
      expect(refOnly.findings.some((finding) => finding.rule === "coverage" && finding.disposition === "required"))
        .toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
