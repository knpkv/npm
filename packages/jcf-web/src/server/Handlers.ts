/**
 * The four endpoints, as thin as they can be.
 *
 * Every decision worth testing lives in `WeekPlan.ts` and `Confirm.ts`; this module only turns
 * their outcomes into status codes, and turns a query string into a week.
 *
 * @module
 */
import { ConfigService, FetchTicket, ReconcileService, Time } from "@knpkv/jira-clockify"
import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, JcfWebApi, PlanExpiredError, ProposalRejectedError } from "./Api.js"
import { confirmProposal, logManualEntry } from "./Confirm.js"
import { buildWeekPlan } from "./WeekPlan.js"
import { WeekPlans } from "./WeekPlans.js"

const failed = (message: string) => new ApiError({ message })

export const WeekLive = HttpApiBuilder.group(JcfWebApi, "week", (handlers) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    const plans = yield* WeekPlans

    return handlers.handle("read", ({ query }) =>
      Effect.gen(function*() {
        const anchor = query.monday === undefined ? new Date() : new Date(`${query.monday}T00:00:00`)
        const period = Time.isoWeekPeriod(anchor)
        const report = yield* reconcile.proposeFromSessions(period).pipe(
          Effect.mapError((error) => failed(error.message))
        )
        const held = buildWeekPlan({
          createdAtMillis: yield* Clock.currentTimeMillis,
          monday: period.from,
          planId: yield* plans.nextPlanId,
          report
        })
        yield* plans.keep(held)
        return held.plan
      }))
  }))

export const RowsLive = HttpApiBuilder.group(JcfWebApi, "rows", (handlers) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    const plans = yield* WeekPlans
    const ticketSummary = yield* FetchTicket.ticketSummaryReader

    return handlers
      .handle("confirm", ({ payload }) =>
        Effect.gen(function*() {
          const plan = yield* plans.find(payload.planId)
          if (plan === undefined) {
            return yield* new PlanExpiredError({ message: "This week was read too long ago — reload it" })
          }
          const outcome = yield* confirmProposal({
            plan,
            request: {
              note: payload.note,
              rowId: payload.rowId,
              seconds: payload.seconds,
              ticketKey: payload.ticketKey
            },
            service: reconcile,
            summaryOf: ticketSummary
          }).pipe(Effect.mapError((error) => failed(error.message)))

          if (outcome._tag === "UnknownRow") {
            return yield* new PlanExpiredError({ message: "That row is not part of this week — reload it" })
          }
          if (outcome._tag === "PastEvidence") {
            return yield* new ProposalRejectedError({
              maxSeconds: outcome.maxSeconds,
              message: "That is more time than the sessions evidence. Log the rest as a manual entry."
            })
          }
          if (outcome._tag === "BelowMinimum") {
            return yield* new ProposalRejectedError({
              message: `Jira floors worklogs to the minute, so ${outcome.minimumSeconds}s is the smallest write.`
            })
          }
          return outcome.result
        }))
      .handle("manual", ({ payload }) =>
        logManualEntry({
          request: {
            day: payload.day,
            note: payload.note,
            seconds: payload.seconds,
            startClock: payload.startClock,
            ticketKey: payload.ticketKey
          },
          service: reconcile,
          summaryOf: ticketSummary
        }))
  }))

export const ConfigLive = HttpApiBuilder.group(JcfWebApi, "config", (handlers) =>
  Effect.gen(function*() {
    const config = yield* ConfigService.ConfigService

    return handlers.handle("standing", ({ payload }) =>
      Effect.gen(function*() {
        const current = yield* config.get
        const next = { ...current.sessionTicketMap, [payload.cwd]: payload.ticketKey }
        yield* config.set({ sessionTicketMap: next })
        // Read back rather than echo: the config service swallows a failed write, so echoing the map
        // we meant to store would report a save that never happened.
        const stored = (yield* config.get).sessionTicketMap
        if (stored[payload.cwd] !== payload.ticketKey) {
          return yield* failed("The Standing Attribution could not be saved to ~/.jcf/config.json")
        }
        return { sessionTicketMap: stored }
      }))
  }))
