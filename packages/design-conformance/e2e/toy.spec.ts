import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

import { start } from "../scripts/fixture.js"
import { browserCall } from "../src/browser.js"
import { comparePixels } from "../src/compare.js"
import { LiveProduct } from "../src/live.js"
import { loadReferences } from "../src/references.js"
import { runConformance } from "../src/runner.js"
import { RunnerFailure } from "../src/schema.js"
import { verdict } from "../src/verdict.js"

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
      const expired = verdict(refs.manifest, rawFailures, refs.waivers, result.shots, "2026-10-18T00:00:00.000Z")
      expect(
        expired.findings.filter((finding) => finding.state === "legacy").every((finding) =>
          finding.disposition === "required"
        )
      ).toBe(true)
      const touched = verdict(
        refs.manifest,
        rawFailures,
        refs.waivers,
        result.shots.map((shot) => ({ ...shot, touched: true })),
        "2026-10-17T00:00:00.000Z"
      )
      expect(touched.findings.some((finding) => finding.state === "copy" && finding.disposition === "required")).toBe(
        true
      )
      const passing = verdict(
        refs.manifest,
        [],
        [],
        result.shots.filter((shot) => shot.state === "passing"),
        "2026-10-17T00:00:00.000Z"
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
                (route) => route.fulfill({ body: referenceScript, contentType: "text/javascript" })
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
