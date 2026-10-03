/**
 * The read handlers: usage per period and Booking, limit series and balances, and status.
 *
 * @module
 */
import { Effect, Ref } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { bookingOf } from "../core/Attribution.js"
import { buildLimitsReport, buildUsageReport, isTimeZone, periodsOf } from "../core/Report.js"
import { type StoreError, UsageStore } from "../core/Store.js"
import { ticketTitles } from "../core/Tickets.js"
import { AgentUsageApi, ApiError } from "./Api.js"
import { RuntimeState } from "./Runtime.js"

/** More periods than any chart can draw legibly; a range that needs more wants a coarser bucket. */
export const MAX_PERIODS = 2_500

const storeUnavailable = (error: StoreError) =>
  new ApiError({ message: `The usage store could not be read (${error.operation})` })

const checkRange = (from: number, to: number) =>
  from < to ? Effect.void : Effect.fail(new ApiError({ message: "The range must end after it starts" }))

export const UsageLive = HttpApiBuilder.group(AgentUsageApi, "usage", (handlers) =>
  Effect.gen(function*() {
    const store = yield* UsageStore
    const state = yield* RuntimeState

    return handlers
      .handle("usage", ({ query }) =>
        Effect.gen(function*() {
          yield* checkRange(query.from, query.to)
          if (!isTimeZone(query.timeZone)) {
            return yield* new ApiError({ message: `Unknown time zone: ${query.timeZone}` })
          }
          if ((query.to - query.from) / (query.bucket === "hour" ? 3_600_000 : 86_400_000) > MAX_PERIODS) {
            return yield* new ApiError({ message: "Too many periods: choose a shorter range or a larger bucket" })
          }
          const periods = periodsOf({ ...query })
          const groups = (yield* store.usageGroups(query)).filter((group) =>
            query.agent === "all" || group.agent === query.agent
          )
          const keys = [
            ...new Set(groups.flatMap((group) => {
              const booking = bookingOf(group.attribution)
              return booking._tag === "Ticket" ? [booking.key] : []
            }))
          ]
          const titles = yield* ticketTitles(keys).pipe(Effect.provideService(UsageStore, store))
          return buildUsageReport(groups, periods, titles, query.to)
        }).pipe(Effect.catchTag("StoreError", (error) => Effect.fail(storeUnavailable(error)))))
      .handle("limits", ({ query }) =>
        Effect.gen(function*() {
          yield* checkRange(query.from, query.to)
          const snapshots = yield* store.limitSnapshots({ from: 0, to: query.to })
          const balances = yield* store.latestBalances
          return { ...buildLimitsReport(snapshots, query), balances }
        }).pipe(Effect.catchTag("StoreError", (error) => Effect.fail(storeUnavailable(error)))))
      .handle("status", () => Ref.get(state.status))
  }))
