/**
 * Contracts for hosting the sandbox read model inside another server.
 *
 * A card persists the account id, name, state tag, holder id, lease end, run id, current step and a
 * redacted blocker. `label` is `"left the pool"` when that id is absent from the current contract; the
 * state tag stays, including Leased. Version, cleaning reason, quarantine time and reset time stay in
 * the store. Role names, ARNs and raw aws-nuke lines are not part of this view.
 *
 * @module
 */
import { Schema } from "effect"
import { Holder, RunId } from "./lease.js"
import { AccountId, SandboxName } from "./pool.js"
import { RunStep } from "./run-log.js"

const Instant = Schema.DateTimeUtcFromString

/** Ten minutes. A missing sweep, or one older than this, makes the quarantine badge stale. */
export const sweepStaleAfterMillis = 10 * 60 * 1000

/** `asOf` is the sweep's epoch milliseconds, or null when this store has never recorded one. */
export const sweepIsStale = (asOf: number | null, nowMillis: number): boolean =>
  asOf === null || nowMillis - asOf > sweepStaleAfterMillis

const arnPattern = /arn:[a-z0-9-]+:[^\s]+/gi
/** A removal line, a scan summary, or a discovery log that names a resource type. */
const nukeCue = /would remove|scan complete:|resource_type=/i
/** `region - ResourceType - id`, including a step prefix such as `nuke:`. */
const nukeListing = /(?:^|[\s:])(?:global|[a-z]{2}-[a-z]+-\d) - [A-Z][A-Za-z0-9]+ - /
/** `S3Bucket ephemeral-a - failed: BucketNotEmpty`, with or without a step prefix. */
const nukeFailure = /(?:^|:\s)[A-Z][A-Za-z0-9]+ \S+ - failed:/

/** Identity Center and service-linked role names. The contract's own roles are passed in. */
const stripGeneratedRoleNames = (line: string): string =>
  line.replace(/AWSReservedSSO_[A-Za-z0-9_-]*|AWSServiceRole[A-Za-z0-9]*/g, "")

const isRawNukeLine = (line: string): boolean => nukeCue.test(line) || nukeListing.test(line) || nukeFailure.test(line)

/**
 * Remove role names, ARNs and raw aws-nuke lines from text that is about to be served.
 * A raw line is a listing, a `would remove` or `Scan complete` line, a `resource_type=`
 * discovery line, or a resource `failed:` line. Longer contract roles are removed first.
 * Account ids and the budget-hold policy name stay.
 */
export const redactSandboxText = (text: string, roles: ReadonlyArray<string>): string => {
  const ordered = [...roles].filter((role) => role.length > 0).sort((left, right) => right.length - left.length)
  const kept: Array<string> = []
  for (const line of text.split("\n")) {
    if (isRawNukeLine(line)) continue
    let next = stripGeneratedRoleNames(line.replace(arnPattern, ""))
    for (const role of ordered) next = next.split(role).join("")
    const collapsed = next.replace(/[ \t]{2,}/g, " ").trim()
    if (collapsed.length > 0) kept.push(collapsed)
  }
  return kept.join("\n")
}

/**
 * Why this process can't read sandboxes: the host setting is missing, it names another machine, this
 * process isn't the hub, the hub has no pool, or the reader failed to start.
 */
export const SandboxesUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: Schema.Literals(["not_configured", "other_host", "not_hub", "pool_mismatch", "unavailable"]),
  host: Schema.NullOr(Schema.String),
  message: Schema.String
})
export type SandboxesUnavailable = typeof SandboxesUnavailable.Type

/** The store or the run log could not be read. This is not an empty pool. */
export const SandboxesReadFailed = Schema.TaggedStruct("Failed", {
  reason: Schema.Literal("unavailable")
})

const EpochMillis = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/** Quarantined rows in the store, including accounts that have left the pool. `partial` follows `stale`. */
export const SandboxBadge = Schema.Struct({
  quarantined: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stale: Schema.Boolean,
  partial: Schema.Boolean,
  asOf: Schema.NullOr(EpochMillis)
})
export interface SandboxBadge extends Schema.Schema.Type<typeof SandboxBadge> {}

/** Sidebar badge for a later view. Fresh and empty has none; a stale zero names the uncertainty. */
export const sandboxNavigationBadge = (badge: {
  readonly quarantined: number
  readonly stale: boolean
  readonly partial: boolean
}): { readonly text: string; readonly label: string } | undefined => {
  const uncertain = badge.stale || badge.partial
  if (badge.quarantined === 0 && !uncertain) return undefined
  if (badge.quarantined === 0) {
    return { text: "", label: "Quarantine count is stale; the last sweep is over 10 minutes old" }
  }
  const accounts = badge.quarantined === 1 ? "account" : "accounts"
  const base = `${badge.quarantined} quarantined ${accounts}`
  return uncertain
    ? { text: String(badge.quarantined), label: `${base}; the last sweep is over 10 minutes old` }
    : { text: String(badge.quarantined), label: base }
}

export const SandboxCardState = Schema.TaggedUnion({
  Available: {},
  Leased: { holder: Holder, endsAt: Instant },
  Cleaning: { runId: RunId, step: Schema.NullOr(RunStep) },
  Quarantined: { runId: RunId, blocker: Schema.String, step: Schema.NullOr(RunStep) }
})
export type SandboxCardState = typeof SandboxCardState.Type

export const SandboxCard = Schema.Struct({
  accountId: AccountId,
  name: SandboxName,
  label: Schema.NullOr(Schema.Literal("left the pool")),
  state: SandboxCardState
})
export interface SandboxCard extends Schema.Schema.Type<typeof SandboxCard> {}

export const SandboxesOverview = Schema.Union([
  SandboxesUnavailable,
  SandboxesReadFailed,
  Schema.TaggedStruct("Ready", {
    sandboxes: Schema.Array(SandboxCard),
    badge: SandboxBadge
  })
])
export type SandboxesOverview = typeof SandboxesOverview.Type

/** One run on the public page. `step` is the step in progress; `outcome` is null until the run finishes. */
export const SandboxRunView = Schema.Struct({
  runId: RunId,
  step: Schema.NullOr(RunStep),
  blocker: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.Literals(["Available", "Quarantined"]))
})
export interface SandboxRunView extends Schema.Schema.Type<typeof SandboxRunView> {}

export const SandboxRuns = Schema.Union([
  SandboxesUnavailable,
  SandboxesReadFailed,
  Schema.TaggedStruct("Ready", {
    accountId: AccountId,
    runs: Schema.Array(SandboxRunView),
    next: Schema.NullOr(RunId)
  })
])
export type SandboxRuns = typeof SandboxRuns.Type

/** The overview takes no selectors. */
export const SandboxesOverviewQuery = Schema.fromURLSearchParams(Schema.Struct({}))
export type SandboxesOverviewQuery = typeof SandboxesOverviewQuery.Type

const RunPageLimit = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 50 })
)

/** One account's runs, newest first. `limit` defaults to 20 when the caller omits it, and stops at 50. */
export const SandboxRunsQuery = Schema.fromURLSearchParams(Schema.Struct({
  id: AccountId,
  limit: Schema.optionalKey(RunPageLimit),
  before: Schema.optionalKey(RunId)
}))
export type SandboxRunsQuery = typeof SandboxRunsQuery.Type
