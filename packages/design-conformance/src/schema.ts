import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/u))
export const RelativeFile = Schema.String.check(
  Schema.isPattern(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/u)
)
const Route = Schema.String.check(Schema.isPattern(/^\/(?!\/)[^\s\\]*$/u))
const Instant = Schema.String.check(Schema.makeFilter((value) => {
  const day = value.slice(0, 10)
  const parsed = DateTime.make(`${day}T00:00:00.000Z`)
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value).slice(0, 10) === day ||
    "Expected a valid ISO calendar date"
})).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString))
export const Theme = Schema.Literals(["light", "dark"])
export const Viewport = Schema.Literals([360, 390, 1280])
export type Viewport = typeof Viewport.Type
/** Phone widths share the phone layout and its tighter geometry tolerance. */
export const isPhoneViewport = (viewport: Viewport): boolean => viewport !== 1280
/** The browser window each viewport captures in. */
export interface ViewportSize {
  readonly width: Viewport
  readonly height: number
}
export const viewportSize = (viewport: Viewport): ViewportSize => ({
  width: viewport,
  height: viewport === 360 ? 780 : viewport === 390 ? 844 : 800
})
const Themes = Schema.Array(Theme).check(Schema.isMinLength(1), Schema.isUnique())
const Viewports = Schema.Array(Viewport).check(Schema.isMinLength(1), Schema.isUnique())
// PNG exports allow modest renderer drift; larger deviations require explicit review waivers.
const PngRatio = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.05 }))
// The whole-frame diff reserves its key and path; other names remain constrained by Name.
const RegionName = Name.check(
  Schema.makeFilter((name) => name !== "frame" || "Region name frame is reserved for whole-frame artifacts")
)

export const Identity = Schema.Struct({ screen: Name, state: Name, viewport: Viewport, theme: Theme })
export interface Identity extends Schema.Schema.Type<typeof Identity> {}
export const LiveState = Schema.Struct({
  screen: Name,
  state: Name,
  route: Route,
  viewports: Viewports,
  themes: Themes
})
export interface LiveState extends Schema.Schema.Type<typeof LiveState> {}
export const Inventory = Schema.Struct({
  routes: Schema.Array(Route).check(Schema.isUnique()),
  states: Schema.Array(LiveState)
})
  .check(
    Schema.makeFilter((value) =>
      new Set(value.states.map((state) => `${state.screen}/${state.state}`)).size === value.states.length ||
      "Duplicate live state"
    )
  )
export interface Inventory extends Schema.Schema.Type<typeof Inventory> {}

export const BaseComparison = Schema.Struct({ referenceOnly: Schema.Boolean })

const RegionList = Schema.Array(RegionName).check(Schema.isMinLength(1), Schema.isUnique())
const StateFields = {
  ...LiveState.fields,
  status: Schema.Literals(["designed", "implemented"]),
  regions: Schema.Union([
    RegionList,
    Schema.Struct({ phone: RegionList, desktop: RegionList })
  ])
}
const PngRef = Schema.Struct({ viewport: Viewport, theme: Theme, image: RelativeFile, metadata: RelativeFile })
export const State = Schema.Union([
  Schema.Struct({ ...StateFields, source: Schema.Literal("html"), ref: RelativeFile }),
  Schema.Struct({
    ...StateFields,
    source: Schema.Literal("png"),
    refs: Schema.Array(PngRef).check(Schema.isMinLength(1)),
    pixelMaxDiffRatio: PngRatio
  })
])
export type State = Schema.Schema.Type<typeof State>

/** The regions a state declares for one capture: one list for every width, or one per phone and desktop layout. */
export const declaredRegions = (
  state: {
    readonly regions: ReadonlyArray<string> | {
      readonly phone: ReadonlyArray<string>
      readonly desktop: ReadonlyArray<string>
    }
  },
  viewport: Viewport
): ReadonlyArray<string> =>
  "phone" in state.regions ? (isPhoneViewport(viewport) ? state.regions.phone : state.regions.desktop) : state.regions
export const Enforcement = Schema.Struct({
  touched: Schema.Literal("required"),
  legacy: Schema.Union([
    Schema.Literal("required"),
    Schema.Struct({ mode: Schema.Literal("report-only"), until: Instant })
  ])
})
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  product: Name,
  fixture: RelativeFile,
  live: Schema.Struct({
    package: Schema.String.check(Schema.isPattern(/^@knpkv\/[a-z0-9-]+$/u)),
    adapter: RelativeFile
  }),
  enforcement: Enforcement,
  files: Schema.Record(RelativeFile, Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  states: Schema.Array(State).check(Schema.isMinLength(1))
}).check(Schema.makeFilter((manifest) => {
  const packageRoot = `packages/${manifest.live.package.slice("@knpkv/".length)}/`
  if (!manifest.live.adapter.startsWith(packageRoot)) return "Live adapter must belong to its product package"
  if (new Set(manifest.states.map((state) => `${state.screen}/${state.state}`)).size !== manifest.states.length) {
    return "Duplicate manifest state"
  }
  const required = [
    manifest.fixture,
    ...manifest.states.flatMap((state) =>
      state.source === "html" ? [state.ref] : state.refs.flatMap((ref) => [ref.image, ref.metadata])
    )
  ]
  if (required.some((file) => manifest.files[file] === undefined)) return "Every reference and fixture needs a SHA256"
  for (const state of manifest.states) {
    if (state.source === "png") {
      const keys = state.refs.map((ref) => `${ref.viewport}/${ref.theme}`)
      if (new Set(keys).size !== keys.length) return "Duplicate PNG shot"
      if (state.viewports.some((width) => state.themes.some((theme) => !keys.includes(`${width}/${theme}`)))) {
        return "PNG image and metadata required for every viewport and theme"
      }
    }
  }
  return true
}))
export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}

/** A product with no implemented state is refs-only: it has never had a live inventory. */
export const hasImplementedState = (manifest: Manifest): boolean =>
  manifest.states.some((state) => state.status === "implemented")

/** Product adapters decode their own domain data after this shared JSON boundary. */
export const Fixture = Schema.Struct({ version: Schema.Literal(1), data: Schema.Record(Schema.String, Schema.Json) })
export interface Fixture extends Schema.Schema.Type<typeof Fixture> {}
export const Rule = Schema.Literals(["coverage", "copy", "geometry", "tokens", "pixels", "integrity", "stale-waiver"])
export const Waiver = Schema.Struct({
  screen: Name,
  state: Name,
  viewport: Schema.optionalKey(Viewport),
  theme: Schema.optionalKey(Theme),
  region: Schema.Union([Name, Schema.Literal("*")]),
  rule: Schema.Literals(["copy", "geometry", "tokens", "pixels"]),
  reason: Schema.Literals(["design-impossible", "owner-decision"]),
  detail: Schema.NonEmptyString,
  decisionLink: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/u))
})
export interface Waiver extends Schema.Schema.Type<typeof Waiver> {}
export const Waivers = Schema.Array(Waiver)

export const Box = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})
export const Region = Schema.Struct({
  name: Name,
  copy: Schema.String,
  box: Box,
  parent: Schema.NullOr(Name),
  styles: Schema.Record(Schema.String, Schema.String),
  overflow: Schema.Boolean
})
export interface Region extends Schema.Schema.Type<typeof Region> {}
export const Snapshot = Schema.Struct({ regions: Schema.Array(Region), overflow: Schema.Boolean })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Failure = Schema.Struct({ ...Identity.fields, region: Schema.String, rule: Rule, detail: Schema.String })
export interface Failure extends Schema.Schema.Type<typeof Failure> {}
export const Finding = Schema.Struct({
  ...Failure.fields,
  disposition: Schema.Literals(["required", "report-only", "waived"]),
  waiver: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})
export interface Finding extends Schema.Schema.Type<typeof Finding> {}
export const ShotArtifacts = Schema.Record(Schema.String, RelativeFile)
export interface ShotArtifacts extends Schema.Schema.Type<typeof ShotArtifacts> {}
export const ShotResult = Schema.Struct({
  ...Identity.fields,
  touched: Schema.Boolean,
  touchedRegions: Schema.Array(Schema.Union([Name, Schema.Literal("*")])),
  outsidePixelsChanged: Schema.Boolean,
  artifacts: ShotArtifacts
})
export interface ShotResult extends Schema.Schema.Type<typeof ShotResult> {}
export const Result = Schema.Struct({
  product: Name,
  passed: Schema.Boolean,
  findings: Schema.Array(Finding),
  shots: Schema.Array(ShotResult)
})
export interface Result extends Schema.Schema.Type<typeof Result> {}

export class InvalidContract
  extends Schema.TaggedError<InvalidContract>()("InvalidContract", { file: Schema.String, cause: Schema.Defect() })
{}
export class ReferenceFailure
  extends Schema.TaggedError<ReferenceFailure>()("ReferenceFailure", { file: Schema.String, detail: Schema.String })
{}
export class BrowserFailure
  extends Schema.TaggedError<BrowserFailure>()("BrowserFailure", { operation: Schema.String, cause: Schema.Defect() })
{}
export class CaptureNavigationFailure extends Schema.TaggedError<CaptureNavigationFailure>()(
  "CaptureNavigationFailure",
  { shot: Schema.NonEmptyString, event: Schema.Literals(["framenavigated", "load"]), url: Schema.String }
) {
  override get message() {
    return `Shot ${this.shot} ${this.event} during capture: ${this.url}`
  }
}
export class RunnerFailure extends Schema.TaggedError<RunnerFailure>()("RunnerFailure", { detail: Schema.String }) {}
