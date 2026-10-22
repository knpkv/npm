/**
 * Contracts for hosting the sandbox read model inside another server.
 *
 * A card persists the account id, name, state tag, holder id, lease start and end, last reset, run id and current step.
 * A quarantine blocker is a closed tag with fixed copy; the stored reset line stays in the store.
 * `label` is `"left the pool"` when that id is absent from the current contract; the state tag stays,
 * including Leased. A lease card keeps `startedAt` and `endsAt`. An available card keeps `lastResetAt`.
 * Version, cleaning reason and quarantine time stay in the store.
 * `SandboxRunLog` is the one read that carries stored lines: a run's log tail and its stored failure line. They
 * name the account's resources, so the hosting server serves it to the pool owner only.
 *
 * @module
 */
import { Schema } from "effect"
import { CleaningReason, Holder, leaseCap, leaseDuration, RunId } from "./lease.js"
import { AccountId, type PoolContract, PoolSignIn, SandboxName } from "./pool.js"
import { isBudgetHold } from "./reset.js"
import { RunStep } from "./run-log.js"

const Instant = Schema.DateTimeUtcFromString

/** Eight hours, and the 24-hour cap `extend` clamps to. The sheets name those times. */
export { leaseCap, leaseDuration }

/** Ten minutes. A missing sweep, or one older than this, makes the quarantine badge stale. */
export const sweepStaleAfterMillis = 10 * 60 * 1000

/** `asOf` is the sweep's epoch milliseconds, or null when this store has never recorded one. */
export const sweepIsStale = (asOf: number | null, nowMillis: number): boolean =>
  asOf === null || nowMillis - asOf > sweepStaleAfterMillis

const budgetHoldText = "Budget hold. Lift it with sandbox.budget.lift"
const scanIncompleteText = "The scan did not finish"
const unknownText = "Reset failed"

const resourcesRemainText = (count: number): string =>
  count === 1 ? "1 resource still removable" : `${count} resources still removable`

const nukeFailedText = (resourceType: string | null): string =>
  resourceType === null ? "A resource could not be removed" : `${resourceType} could not be removed`

/** A PascalCase resource type, never a resource name. One to 64 characters. */
const resourceTypePattern = /^[A-Z][A-Za-z0-9]{0,63}$/
const ResourceType = Schema.String.check(Schema.isPattern(resourceTypePattern))
const RemainCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))

const ResourcesRemain = Schema.TaggedStruct("ResourcesRemain", {
  count: RemainCount,
  text: Schema.String
}).check(Schema.makeFilter(
  (value) => value.text === resourcesRemainText(value.count) || "resources-remain copy is fixed"
))

const NukeFailed = Schema.TaggedStruct("NukeFailed", {
  resourceType: Schema.NullOr(ResourceType),
  text: Schema.String
}).check(Schema.makeFilter(
  (value) => value.text === nukeFailedText(value.resourceType) || "nuke-failed copy is fixed"
))

const BudgetHold = Schema.TaggedStruct("BudgetHold", {
  text: Schema.Literal(budgetHoldText)
})

const ScanIncomplete = Schema.TaggedStruct("ScanIncomplete", {
  text: Schema.Literal(scanIncompleteText)
})

const UnknownBlocker = Schema.TaggedStruct("Unknown", {
  text: Schema.Literal(unknownText)
})

/** The only blocker the read routes serve. Anything else in the stored line is dropped. */
export const SandboxBlocker = Schema.Union([
  ResourcesRemain,
  NukeFailed,
  BudgetHold,
  ScanIncomplete,
  UnknownBlocker
])
export type SandboxBlocker = typeof SandboxBlocker.Type

/** ESC, `[`, parameters, `m`. Same shape the guard strips, so a coloured line still classifies. */
const terminalStyle = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
const resourcesRemain = /(\d+) resources still removable/
/** `S3Bucket ephemeral-a - failed:`, with or without a step prefix. The type token is the only kept part. */
const nukeFailure = /(?:^|[\s:])([A-Z][A-Za-z0-9]{0,63}) \S+ - failed:/

const plainBlocker = (stored: string): string => stored.replaceAll("\r", "").replaceAll(terminalStyle, "")

/**
 * Map one stored quarantine line to the closed blocker. Budget hold, then an incomplete scan, then a
 * removable count, then a resource-failure type; everything else is Unknown. The returned text is the
 * fixed copy for that tag, never the stored line.
 */
export const sandboxBlockerFrom = (stored: string): SandboxBlocker => {
  const plain = plainBlocker(stored)
  if (isBudgetHold(plain)) return { _tag: "BudgetHold", text: budgetHoldText }
  if (plain.includes("incomplete scan")) return { _tag: "ScanIncomplete", text: scanIncompleteText }
  const countDigits = resourcesRemain.exec(plain)?.[1]
  if (countDigits !== undefined && countDigits.length <= 7) {
    const count = Number(countDigits)
    if (Number.isInteger(count) && count >= 1 && count <= 1_000_000) {
      return { _tag: "ResourcesRemain", count, text: resourcesRemainText(count) }
    }
  }
  const resourceType = nukeFailure.exec(plain)?.[1]
  if (resourceType !== undefined && resourceTypePattern.test(resourceType)) {
    return { _tag: "NukeFailed", resourceType, text: nukeFailedText(resourceType) }
  }
  if (plain.includes(" - failed:")) return { _tag: "NukeFailed", resourceType: null, text: nukeFailedText(null) }
  return { _tag: "Unknown", text: unknownText }
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
  Available: { lastResetAt: Schema.NullOr(Instant) },
  Leased: { holder: Holder, startedAt: Instant, endsAt: Instant },
  Cleaning: { runId: RunId, step: Schema.NullOr(RunStep) },
  Quarantined: { runId: RunId, blocker: SandboxBlocker, step: Schema.NullOr(RunStep) }
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

/**
 * One run on the public page. `step` is the step in progress; `outcome` and `endedAt` are null until the
 * run finishes. `failedStep` names the step that failed, null for a run with none; its words are `blocker`.
 */
export const SandboxRunView = Schema.Struct({
  runId: RunId,
  step: Schema.NullOr(RunStep),
  blocker: Schema.NullOr(SandboxBlocker),
  outcome: Schema.NullOr(Schema.Literals(["Available", "Quarantined"])),
  reason: CleaningReason,
  startedAt: Instant,
  endedAt: Schema.NullOr(Instant),
  failedStep: Schema.NullOr(RunStep)
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

/** The log shows a run's last 30 lines. */
export const runLogLimit = 30

/** One log line: when its entry was recorded, and its plain text. */
export const SandboxRunLogLine = Schema.Struct({
  at: Instant,
  text: Schema.String
})
export interface SandboxRunLogLine extends Schema.Schema.Type<typeof SandboxRunLogLine> {}

/**
 * One run's log, for the pool owner only. `lines` are the last of `total` lines, oldest first; `raw` is the stored
 * line of the run's failure, null for a run with none.
 */
export const SandboxRunLog = Schema.Union([
  SandboxesUnavailable,
  SandboxesReadFailed,
  Schema.TaggedStruct("Ready", {
    accountId: AccountId,
    runId: RunId,
    raw: Schema.NullOr(Schema.String),
    lines: Schema.Array(SandboxRunLogLine).check(Schema.isMaxLength(runLogLimit)),
    total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  })
])
export type SandboxRunLog = typeof SandboxRunLog.Type

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

/** One run of one account. */
export const SandboxRunLogQuery = Schema.fromURLSearchParams(Schema.Struct({
  id: AccountId,
  run: RunId
}))
export type SandboxRunLogQuery = typeof SandboxRunLogQuery.Type

/** The owner's sign-in for one pool: the contract's portal, session and role, and the pool's first region. */
export const SandboxSignIn = Schema.Struct({
  ...PoolSignIn.fields,
  region: Schema.NonEmptyString
})
export interface SandboxSignIn extends Schema.Schema.Type<typeof SandboxSignIn> {}

/** Sign-in for this pool, or null when its contract has no `access`. */
export const signInOf = (contract: PoolContract): SandboxSignIn | null =>
  contract.access === undefined ? null : { ...contract.access, region: contract.regions[0] }

/** The access portal's console for one account, as the sign-in's role. Opens in a new tab; carries no keys. */
export const consoleUrl = (signIn: SandboxSignIn, accountId: AccountId): string =>
  `${signIn.portalUrl.replace(/\/+$/, "")}/#/console?${new URLSearchParams({
    account_id: accountId,
    role_name: signIn.roleName
  })}`

/** One account's `~/.aws/config` profile, named after the account, signing in through the SSO session. */
export const cliProfile = (signIn: SandboxSignIn, name: SandboxName, accountId: AccountId): string =>
  [
    `[profile ${name}]`,
    `sso_session = ${signIn.ssoSession}`,
    `sso_account_id = ${accountId}`,
    `sso_role_name = ${signIn.roleName}`,
    `region = ${signIn.region}`
  ].join("\n")
