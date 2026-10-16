import { type Browser, chromium, type Page } from "@playwright/test"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { Mutable } from "effect/Types"

import { browserCall, type Capture, capturePage, cropRegions, RegionPixels } from "./browser.js"
import { captureContext, installCaptureClock } from "./capture.js"
import {
  compareLiveRegions,
  comparePixels,
  compareSnapshots,
  coverageFailures,
  LIVE_CHANGE_MAX_DIFF_RATIO,
  shotKey,
  stateKey,
  stateShots
} from "./compare.js"
import { LiveProduct } from "./live.js"
import { restrictContextNetwork, restrictPageNetwork } from "./network.js"
import type { loadReferences } from "./references.js"
import { readJson, readVerifiedJson, verifiedBody } from "./references.js"
import { writeReport } from "./report.js"
import {
  BaseComparison,
  BrowserFailure,
  type CaptureNavigationFailure,
  declaredRegions,
  type Failure,
  Identity,
  Inventory,
  RunnerFailure,
  type ShotArtifacts,
  type ShotResult,
  Snapshot,
  viewportSize
} from "./schema.js"
import { serveVerifiedFiles } from "./server.js"
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
    use: (page: Page) => Effect.Effect<Capture, BrowserFailure | CaptureNavigationFailure | RunnerFailure>,
    referenceFiles?: ReadonlySet<string>
  ) {
    const context = yield* Effect.acquireRelease(
      browserCall("create context", () =>
        browser.newContext({
          ...captureContext,
          serviceWorkers: "block",
          viewport: viewportSize(identity.viewport),
          colorScheme: identity.theme
        })),
      (context) => browserCall("close context", () => context.close()).pipe(Effect.orDie)
    )
    const blocked: Array<string> = []
    const contextNetwork = yield* restrictContextNetwork(context, origin, blocked, referenceFiles)
    const page = yield* browserCall("new page", () => context.newPage())
    const network = yield* restrictPageNetwork(context, page, contextNetwork.permits)
    yield* browserCall("fixed clock", () => installCaptureClock(page))
    const result = yield* use(page).pipe(Effect.exit)
    yield* network.settle()
    yield* contextNetwork.settle()
    if (blocked.length > 0) return yield* new BrowserFailure({ operation: "external capture network", cause: blocked })
    return yield* result
  },
  Effect.scoped
)

/** Each shot gets fresh equal contexts. Base region evidence determines touched status independently of refs. */
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
  yield* fs.makeDirectory(options.output, { recursive: true })
  if (options.base !== undefined && (yield* fs.realPath(options.base)) === (yield* fs.realPath(options.output))) {
    return yield* new RunnerFailure({ detail: "Base and current capture directories must differ" })
  }
  const browser = yield* Effect.acquireRelease(
    browserCall("launch Chromium", () => chromium.launch()),
    (browser) => browserCall("close Chromium", () => browser.close()).pipe(Effect.orDie)
  )
  const refOrigin = options.captureOnly === true
    ? undefined
    : yield* serveVerifiedFiles(refs.bodies)
  const baseIndex = options.base === undefined
    ? []
    : yield* readJson(path.join(options.base, "captures.json"), CaptureIndex)
  const comparisonFile = options.base === undefined ? undefined : path.join(options.base, "comparison.json")
  const referenceOnly = comparisonFile !== undefined && (yield* fs.exists(comparisonFile))
    ? (yield* readJson(comparisonFile, BaseComparison)).referenceOnly
    : false
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
          yield* browserCall("live navigation", () => page.goto(url.href).then(() => undefined))
          yield* live.ready(page, identity)
          return yield* capturePage(page, key)
        }))
      captured.push(identity)
      const artifacts: Mutable<ShotArtifacts> = { live: yield* write(`${key}-live.png`, actual.frame) }
      artifacts.metadata = `${key}-live.json`
      yield* fs.writeFileString(
        path.join(options.output, artifacts.metadata),
        yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(actual.snapshot)
      )
      const reference = refs.manifest.states.find((ref) =>
        stateKey(ref) === stateKey(state) && ref.status === "implemented" &&
        ref.viewports.includes(identity.viewport) && ref.themes.includes(identity.theme)
      )
      // Indexed base evidence must include metadata; missing evidence fails instead of making drift new.
      let base: Capture | undefined
      if (options.base !== undefined && baseIndex.some((base) => shotKey(base) === key)) {
        const frame = yield* fs.readFile(path.join(options.base, `${key}-live.png`))
        const snapshot = yield* readJson(path.join(options.base, `${key}-live.json`), Snapshot)
        const regions = yield* Effect.try({
          try: () => cropRegions(frame, snapshot),
          catch: (cause) => new BrowserFailure({ operation: "crop base regions", cause })
        })
        base = { frame, snapshot, regions }
      }
      const changes = referenceOnly ? { touchedRegions: [], outsidePixelsChanged: false } : yield* Effect.try({
        try: () =>
          compareLiveRegions(
            identity,
            base,
            actual,
            reference === undefined ? [] : declaredRegions(reference, identity.viewport)
          ),
        catch: (cause) => new BrowserFailure({ operation: "compare base regions", cause })
      })
      if (options.captureOnly !== true && refOrigin !== undefined) {
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
                return yield* capturePage(page, key)
              }), new Set(Object.keys(refs.manifest.files)))
          } else {
            const ref = reference.refs.find((shot) =>
              shot.viewport === identity.viewport && shot.theme === identity.theme
            )
            if (ref === undefined) continue
            const snapshot = yield* readVerifiedJson(refs.bodies, ref.metadata, Snapshot)
            const frame = yield* verifiedBody(refs.bodies, ref.image)
            const regions = yield* Effect.try({
              try: () => cropRegions(frame, snapshot),
              catch: (cause) => new BrowserFailure({ operation: "crop PNG reference", cause })
            })
            expected = { snapshot, frame, regions }
          }
          for (const failure of compareSnapshots(identity, reference, expected.snapshot, actual.snapshot)) {
            failures.push(failure)
          }
          artifacts.ref = yield* write(`${key}-ref.png`, expected.frame)
          const limit = reference.source === "html" ? LIVE_CHANGE_MAX_DIFF_RATIO : reference.pixelMaxDiffRatio
          for (const name of ["*", ...declaredRegions(reference, identity.viewport)]) {
            const ref = name === "*" ? RegionPixels.Image({ bytes: expected.frame }) : expected.regions.get(name)
            const livePixels = name === "*" ? RegionPixels.Image({ bytes: actual.frame }) : actual.regions.get(name)
            if (ref === undefined || livePixels === undefined) continue
            if (ref._tag === "OffFrame" || livePixels._tag === "OffFrame") {
              failures.push({
                ...identity,
                region: name,
                rule: "pixels",
                detail:
                  `Off-frame region or zero-size region: reference=${ref._tag}, live=${livePixels._tag}; no region image`
              })
              if (ref._tag === "Image") artifacts[`ref-${name}`] = yield* write(`${key}-${name}-ref.png`, ref.bytes)
              if (livePixels._tag === "Image") {
                artifacts[`live-${name}`] = yield* write(`${key}-${name}-live.png`, livePixels.bytes)
              }
              continue
            }
            const pixels = yield* Effect.try({
              try: () => comparePixels(ref.bytes, livePixels.bytes),
              catch: (cause) => new BrowserFailure({ operation: "compare reference pixels", cause })
            })
            const suffix = name === "*" ? "frame" : name
            artifacts[`diff-${suffix}`] = yield* write(`${key}-${suffix}-diff.png`, pixels.diff)
            if (name !== "*") {
              artifacts[`ref-${name}`] = yield* write(`${key}-${name}-ref.png`, ref.bytes)
              artifacts[`live-${name}`] = yield* write(`${key}-${name}-live.png`, livePixels.bytes)
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
      shots.push({ ...identity, touched: changes.touchedRegions.length > 0, ...changes, artifacts })
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
      routes: inventory.routes.filter((route) =>
        inventory.states.some((state) => stateKey(state) === options.state && state.route === route)
      ),
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
  const now = yield* DateTime.now
  const result = verdict(refs.manifest, failures, waivers, shots, now)
  yield* writeReport(options.output, result)
  return result
}, Effect.scoped)
