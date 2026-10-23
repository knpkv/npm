import { Context, type Effect, Schema } from "effect"
import { AccountId, type PoolAccount } from "./pool.js"

/** Dollars, finite and not negative. */
const Usd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** One account's month-to-date spend in USD, as read at `asOf` (epoch milliseconds). */
export const SpendReading = Schema.Struct({
  accountId: AccountId,
  usd: Usd,
  asOf: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export interface SpendReading extends Schema.Schema.Type<typeof SpendReading> {}

/** The account has no budget to read spend from. */
export class NoBudget extends Schema.TaggedError<NoBudget>()("NoBudget", { accountId: Schema.String }) {}

/** The reader may not read that account's budget. */
export class SpendAccessDenied extends Schema.TaggedError<SpendAccessDenied>()("SpendAccessDenied", {
  accountId: Schema.String
}) {}

/** The budgets API throttled the read. The next sweep reads again. */
export class SpendThrottled extends Schema.TaggedError<SpendThrottled>()("SpendThrottled", {
  accountId: Schema.String
}) {}

/** Any other failure to read spend. `detail` stays in the host's log. */
export class SpendUnavailable extends Schema.TaggedError<SpendUnavailable>()("SpendUnavailable", {
  accountId: Schema.String,
  detail: Schema.String
}) {}

export type SpendReadError = NoBudget | SpendAccessDenied | SpendThrottled | SpendUnavailable

/**
 * Reads one pool account's actual spend this month, in USD. Supplied by the host, like `Nuke`; read-only.
 * The sweep calls it for each pool account and keeps the last good reading when a read fails.
 */
export class SpendReader extends Context.Service<
  SpendReader,
  { readonly monthToDate: (account: PoolAccount) => Effect.Effect<number, SpendReadError> }
>()("SandboxPool/SpendReader") {}
