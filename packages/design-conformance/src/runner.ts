import { type Browser, chromium, type Page } from "@playwright/test"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { Mutable } from "effect/Types"
import { PNG } from "pngjs"

import { browserCall, type Capture, capturePage } from "./browser.js"
import { captureContext, installCaptureClock } from "./capture.js"
import { comparePixels, compareSnapshots, coverageFailures, shotKey, stateKey, stateShots } from "./compare.js"
import { LiveProduct } from "./live.js"
import type { loadReferences } from "./references.js"
import { readJson } from "./references.js"
import { writeReport } from "./report.js"
import {
  BrowserFailure,
  type Failure,
  Identity,
  Inventory,
  RunnerFailure,
  type ShotArtifacts,
  type ShotResult,
  Snapshot
} from "./schema.js"
import { serveFiles } from "./server.js"
import { verdict } from "./verdict.js"

export interface RunnerOptions {
  readonly output: string
  readonly base?: string
  readonly captureOnly?: boolean
  readonly state?: string
}
const CaptureIndex = Schema.Array(Identity)
type References = Effect.Success<ReturnType<typeof loadReferences>>

const withPage = Effect.fn("DesignConformance.withPage")(
  function*(
    browser: Browser,
    identity: Identity,
    origin: string,
    use: (page: Page) => Effect.Effect<Capture, BrowserFailure | RunnerFailure>
  ) {
    const context = yield* Effect.acquireRelease(
      browserCall("create context", () =>
        browser.newContext({
          ...captureContext,
          viewport: { width: identity.viewport, height: identity.viewport === 390 ? 844 : 800 },
          colorScheme: identity.theme
        })),
      (context) => browserCall("close context", () => context.close()).pipe(Effect.orDie)
    )
    const blocked: Array<string> = []
    yield* browserCall("restrict capture network", () =>
      context.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) {
          await route.continue()
        } else {
          blocked.push(url.origin)
          await route.abort("blockedbyclient")
        }
      }))
    const page = yield* browserCall("new page", () => context.newPage())
    yield* browserCall("fixed clock", () => installCaptureClock(page))
    const result = yield* use(page)
    if (blocked.length > 0) return yield* new BrowserFailure({ operation: "external capture network", cause: blocked })
    return result
  },
  Effect.scoped
)

const crop = (bytes: Uint8Array, region: Snapshot["regions"][number]): Uint8Array => {
  const source = PNG.sync.read(Buffer.from(bytes))
  const x = Math.floor(region.box.x)
  const y = Math.floor(region.box.y)
  const width = Math.ceil(region.box.x + region.box.width) - x
  const height = Math.ceil(region.box.y + region.box.height) - y
  const target = new PNG({ width, height })
  PNG.bitblt(source, target, x, y, width, height, 0, 0)
  return PNG.sync.write(target)
}

/** Each state gets fresh equal contexts. Base captures determine touched status independently of refs. */
export const runConformance = Effect.fn("DesignConformance.run")(function*(refs: References, options: RunnerOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const live = yield* LiveProduct
  const inventory = yield* Schema.decodeUnknownEffect(Inventory)(live.inventory)
  if (
    options.state !== undefined && !inventory.states.some((state) => stateKey(state) === options.state) &&
    !refs.manifest.states.some((state) => stateKey(state) === options.state)
  ) {
    return yield* new RunnerFailure({ detail: `Unknown requested state: ${options.state}` })
  }
  if (options.base !== undefined && path.resolve(options.base) === path.resolve(options.output)) {
    return yield* new RunnerFailure({ detail: "Base and current capture directories must differ" })
  }
  const browser = yield* Effect.acquireRelease(
    browserCall("launch Chromium", () => chromium.launch()),
    (browser) => browserCall("close Chromium", () => browser.close()).pipe(Effect.orDie)
  )
  yield* fs.makeDirectory(options.output, { recursive: true })
  const refOrigin = options.captureOnly === true
    ? undefined
    : yield* serveFiles(
      refs.root,
      Object.fromEntries(Object.keys(refs.manifest.files).map((file) => [`/${file}`, file]))
    )
  const baseIndex = options.base === undefined
    ? []
    : yield* readJson(path.join(options.base, "captures.json"), CaptureIndex)
  const captured: Array<Identity> = []
  const shots: Array<ShotResult> = []
  const failures: Array<Failure> = []
  const write = Effect.fn("DesignConformance.writeShot")(function*(name: string, bytes: Uint8Array) {
    yield* fs.writeFile(path.join(options.output, name), bytes)
    return name
  })
  for (const state of inventory.states) {
    if (options.state !== undefined && stateKey(state) !== options.state) continue
    for (const identity of stateShots(state)) {
      const key = shotKey(identity)
      const actual = yield* withPage(browser, identity, live.origin, (page) =>
        Effect.gen(function*() {
          yield* live.seed(page, refs.fixture, identity)
          const url = new URL(state.route, live.origin)
          url.searchParams.set("state", identity.state)
          url.searchParams.set("theme", identity.theme)
          yield* browserCall("live navigation", () => page.goto(url.href).then(() => undefined))
          yield* live.ready(page, identity)
          return yield* capturePage(page)
        }))
      captured.push(identity)
      const artifacts: Mutable<ShotArtifacts> = { live: yield* write(`${key}-live.png`, actual.frame) }
      // Base pixels are decoded only when this identity existed in its authoritative capture index.
      let changed = true
      if (options.base !== undefined && baseIndex.some((base) => shotKey(base) === key)) {
        const base = yield* fs.readFile(path.join(options.base, `${key}-live.png`))
        changed = yield* Effect.try({
          try: () => comparePixels(base, actual.frame).ratio > 0.001,
          catch: (cause) => new BrowserFailure({ operation: "compare base pixels", cause })
        })
      }
      if (options.captureOnly !== true && refOrigin !== undefined) {
        const reference = refs.manifest.states.find((ref) =>
          stateKey(ref) === stateKey(state) && ref.status === "implemented" &&
          ref.viewports.includes(identity.viewport) && ref.themes.includes(identity.theme)
        )
        if (reference !== undefined) {
          let expected: Capture
          if (reference.source === "html") {
            expected = yield* withPage(browser, identity, refOrigin, (page) =>
              Effect.gen(function*() {
                const url = new URL(reference.ref, `${refOrigin}/`)
                url.searchParams.set("state", identity.state)
                url.searchParams.set("theme", identity.theme)
                yield* browserCall("reference navigation", () => page.goto(url.href).then(() => undefined))
                yield* browserCall("reference fixture readiness", () =>
                  page.locator("html[data-design-ready=\"true\"]").waitFor())
                return yield* capturePage(page)
              }))
          } else {
            const ref = reference.refs.find((shot) =>
              shot.viewport === identity.viewport && shot.theme === identity.theme
            )
            if (ref === undefined) continue
            const snapshot = yield* readJson(path.join(refs.root, ref.metadata), Snapshot)
            const frame = yield* fs.readFile(path.join(refs.root, ref.image))
            const regions = yield* Effect.try({
              try: () => new Map(snapshot.regions.map((region) => [region.name, crop(frame, region)])),
              catch: (cause) => new BrowserFailure({ operation: "crop PNG reference", cause })
            })
            expected = { snapshot, frame, regions }
          }
          for (const failure of compareSnapshots(identity, reference, expected.snapshot, actual.snapshot)) {
            failures.push(failure)
          }
          artifacts.ref = yield* write(`${key}-ref.png`, expected.frame)
          const limit = reference.source === "html" ? 0.001 : reference.pixelMaxDiffRatio
          for (const name of ["*", ...reference.regions]) {
            const ref = name === "*" ? expected.frame : expected.regions.get(name)
            const liveBytes = name === "*" ? actual.frame : actual.regions.get(name)
            if (ref === undefined || liveBytes === undefined) continue
            const pixels = yield* Effect.try({
              try: () => comparePixels(ref, liveBytes),
              catch: (cause) => new BrowserFailure({ operation: "compare reference pixels", cause })
            })
            const suffix = name === "*" ? "frame" : name
            artifacts[`diff-${suffix}`] = yield* write(`${key}-${suffix}-diff.png`, pixels.diff)
            if (name !== "*") {
              artifacts[`ref-${name}`] = yield* write(`${key}-${name}-ref.png`, ref)
              artifacts[`live-${name}`] = yield* write(`${key}-${name}-live.png`, liveBytes)
            }
            if (pixels.ratio > limit) {
              failures.push({
                ...identity,
                region: name,
                rule: "pixels",
                detail: `Different pixels ${pixels.ratio}; maximum ${limit}`
              })
            }
          }
        }
      }
      shots.push({ ...identity, touched: changed, artifacts })
    }
  }
  yield* fs.writeFileString(
    path.join(options.output, "captures.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(CaptureIndex))(captured)
  )
  if (options.captureOnly === true) return undefined
  const scopedManifest = options.state === undefined
    ? refs.manifest
    : { ...refs.manifest, states: refs.manifest.states.filter((state) => stateKey(state) === options.state) }
  const scopedInventory = options.state === undefined
    ? inventory
    : {
      routes: inventory.states.filter((state) => stateKey(state) === options.state).map((state) => state.route),
      states: inventory.states.filter((state) => stateKey(state) === options.state)
    }
  for (
    const failure of coverageFailures(
      scopedManifest,
      scopedInventory,
      new Set(captured.map(shotKey)),
      baseIndex.filter((identity) => options.state === undefined || stateKey(identity) === options.state)
    )
  ) failures.push(failure)
  const waivers = options.state === undefined
    ? refs.waivers
    : refs.waivers.filter((waiver) => stateKey(waiver) === options.state)
  const now = DateTime.formatIso(yield* DateTime.now)
  const result = verdict(refs.manifest, failures, waivers, shots, now)
  yield* writeReport(options.output, result)
  return result
}, Effect.scoped)
