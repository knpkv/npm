/** CI publication metadata and property names cross only the authenticated owner API. No provider values or artifact locators. */
import { Schema } from "effect"

const ShortSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{7}$/))
const RunHref = Schema.String.check(
  Schema.isPattern(/^https:\/\/github\.com\/knpkv\/infra\/actions\/runs\/[1-9][0-9]*$/)
)
export const PlanSource = Schema.Struct({
  pr: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  head: ShortSha,
  base: Schema.NullOr(ShortSha),
  publishedAt: Schema.String,
  ageDays: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runHref: RunHref
})
export type PlanSource = typeof PlanSource.Type
export const PlanRow = Schema.Struct({
  fqn: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  resourceType: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  action: Schema.Literals(["noop", "update"]),
  changedKeys: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/))).check(
    Schema.isMaxLength(32)
  )
})
export type PlanRow = typeof PlanRow.Type
export const PublishedPlan = Schema.Struct({
  source: PlanSource,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{4}…[a-f0-9]{4}$/)),
  rows: Schema.Array(PlanRow).check(Schema.isMaxLength(6)),
  stale: Schema.NullOr(Schema.Literals(["age", "base", "failed"]))
})
export type PublishedPlan = typeof PublishedPlan.Type

export const PlanState = Schema.TaggedUnion({
  Loading: {},
  Ready: { plan: PublishedPlan },
  NotPublished: {},
  NotPublishing: {},
  NotConnected: {},
  Expired: { source: Schema.NullOr(PlanSource) },
  Failed: { runHref: RunHref, lastPublished: Schema.NullOr(PublishedPlan) },
  Unverified: {
    reason: Schema.Literals(["metadata", "provenance", "archive", "digest", "receipt"]),
    source: Schema.NullOr(PlanSource)
  },
  Unreachable: {},
  Refused: {}
})
export type PlanState = typeof PlanState.Type
