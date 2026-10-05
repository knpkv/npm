/**
 * The read handlers: usage per period and Booking, one Booking's sessions, limit series and
 * balances, and status.
 *
 * @module
 */
import { Effect, SubscriptionRef } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { attribute } from "../core/Attribution.js"
import { buildLimitsReport, buildUsageReport, checkTimeZone, periodsOf } from "../core/Report.js"
import { buildSessionsReport } from "../core/Sessions.js"
import { type StoreError, UsageStore } from "../core/Store.js"
import { ticketTitles } from "../core/Tickets.js"
import { AgentUsageApi, ApiError } from "./Api.js"
import { currentKnownProjects, RuntimeState } from "./Runtime.js"

/** More periods than any chart can draw legibly; a range that needs more wants a coarser bucket. */
export const MAX_PERIODS = 2_500

/**
 * The longest range a sessions read aggregates: a quarter, well past any span the page selects.
 * Bounding the range bounds the store's work before any group is read.
 */
export const MAX_SESSION_RANGE_DAYS = 92

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
          yield* checkTimeZone(query.timeZone).pipe(
            Effect.mapError((error) => new ApiError({ message: `Unknown time zone: ${error.zone}` }))
          )
          if ((query.to - query.from) / (query.bucket === "hour" ? 3_600_000 : 86_400_000) > MAX_PERIODS) {
            return yield* new ApiError({ message: "Too many periods: choose a shorter range or a larger bucket" })
          }
          const periods = periodsOf({ ...query })
          const groups = (yield* store.usageGroups({ ...query, machine: state.machine })).filter((group) =>
            query.agent === "all" || group.agent === query.agent
          )
          const projects = yield* currentKnownProjects.pipe(
            Effect.provideService(UsageStore, store),
            Effect.provideService(RuntimeState, state)
          )
          const keys = [
            ...new Set(groups.flatMap((group) => {
              const { booking } = attribute(group.attribution, projects)
              return booking._tag === "Ticket" ? [booking.key] : []
            }))
          ]
          const titles = yield* ticketTitles(keys).pipe(Effect.provideService(UsageStore, store))
          return buildUsageReport(groups, periods, titles, projects, query.to)
        }).pipe(Effect.catchTag("StoreError", (error) => Effect.fail(storeUnavailable(error)))))
      .handle("limits", ({ query }) =>
        Effect.gen(function*() {
          yield* checkRange(query.from, query.to)
          const snapshots = yield* store.limitSnapshots({ from: query.from, to: query.to, machine: state.machine })
          const balances = yield* store.latestBalances(state.machine)
          return { ...buildLimitsReport(snapshots, query), balances }
        }).pipe(Effect.catchTag("StoreError", (error) => Effect.fail(storeUnavailable(error)))))
      .handle("sessions", ({ query }) =>
        Effect.gen(function*() {
          yield* checkRange(query.from, query.to)
          if (query.to - query.from > MAX_SESSION_RANGE_DAYS * 86_400_000) {
            return yield* new ApiError({
              message: `Sessions cover at most ${MAX_SESSION_RANGE_DAYS} days: choose a shorter range`
            })
          }
          const groups = yield* store.sessionGroups({
            from: query.from,
            to: query.to,
            machine: state.machine,
            agent: query.agent
          })
          const projects = yield* currentKnownProjects.pipe(
            Effect.provideService(UsageStore, store),
            Effect.provideService(RuntimeState, state)
          )
          return buildSessionsReport(groups, projects, query.booking)
        }).pipe(Effect.catchTag("StoreError", (error) => Effect.fail(storeUnavailable(error)))))
      .handle("status", () => SubscriptionRef.get(state.status))
  }))
