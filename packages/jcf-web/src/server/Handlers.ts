/**
 * The four endpoints, as thin as they can be.
 *
 * Every decision worth testing lives in `WeekPlan.ts` and `Confirm.ts`; this module only turns
 * their outcomes into status codes, and turns a query string into a week.
 *
 * @module
 */
import { ConfigService, FetchTicket, IssueFacts, ReconcileService, Time } from "@knpkv/jira-clockify"
import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, JcfWebApi, PlanExpiredError, ProposalRejectedError } from "./Api.js"
import { confirmProposal, logManualEntry } from "./Confirm.js"
import { buildWeekPlan, type OwnershipInput, sidesOfScope } from "./WeekPlan.js"
import { WeekPlans } from "./WeekPlans.js"

const failed = (message: string) => new ApiError({ message })

export const WeekLive = HttpApiBuilder.group(JcfWebApi, "week", (handlers) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    const issues = yield* IssueFacts.IssueFacts
    const config = yield* ConfigService.ConfigService
    const plans = yield* WeekPlans

    return handlers.handle("read", ({ query }) =>
      Effect.gen(function*() {
        const anchor = query.monday === undefined ? new Date() : new Date(`${query.monday}T00:00:00`)
        const period = Time.isoWeekPeriod(anchor)
        const scope = query.only ?? "both"
        const sides = sidesOfScope(scope)
        const report = yield* reconcile.proposeFromSessions(period, { sides }).pipe(
          Effect.mapError((error) => failed(error.message))
        )
        const settings = yield* config.get

        // Every key on screen, so a row that is only recorded gets its title too. One search covers
        // the week — asking per row would be a request per cell.
        const keys = [
          ...report.proposals.map((proposal) => proposal.ticketKey),
          ...report.recorded.map((row) => row.ticketKey),
          ...report.withheld.map((credit) => credit.ticketKey)
        ]
        // A Clockify-only week must not touch Jira at all, titles included: "only Clockify" is a
        // statement about which systems this run may talk to, not merely which it may write to.
        const looked = sides.jira ? yield* issues.lookup(keys) : { checked: false, facts: new Map() }
        const ownership: OwnershipInput = {
          checked: looked.checked,
          facts: looked.facts,
          mode: settings.sessionOwnership,
          overrides: settings.sessionOwnershipOverrides
        }

        const held = buildWeekPlan({
          createdAtMillis: yield* Clock.currentTimeMillis,
          monday: period.from,
          ownership,
          planId: yield* plans.nextPlanId,
          report,
          scope
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
              blocks: payload.blocks,
              note: payload.note,
              rowId: payload.rowId,
              seconds: payload.seconds,
              targets: payload.targets,
              ticketKey: payload.ticketKey
            },
            service: reconcile,
            summaryOf: ticketSummary
          }).pipe(Effect.mapError((error) => failed(error.message)))

          if (outcome._tag === "UnknownRow") {
            return yield* new PlanExpiredError({ message: "That row is not part of this week — reload it" })
          }
          if (outcome._tag === "UnknownBlocks") {
            return yield* new PlanExpiredError({
              message: "Those blocks are not part of this row any more — reload the week"
            })
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
          if (outcome._tag === "NoTargets") {
            return yield* new ProposalRejectedError({
              message: "Pick at least one of Clockify or Jira — a write to neither is not a write."
            })
          }
          return outcome.result
        }))
      .handle("manual", ({ payload }) =>
        Effect.gen(function*() {
          const targets = payload.targets ?? { clockify: true, jira: true }
          if (!targets.clockify && !targets.jira) {
            return yield* new ProposalRejectedError({
              message: "Pick at least one of Clockify or Jira — a write to neither is not a write."
            })
          }
          return yield* logManualEntry({
            request: {
              day: payload.day,
              note: payload.note,
              seconds: payload.seconds,
              startClock: payload.startClock,
              targets,
              ticketKey: payload.ticketKey
            },
            service: reconcile,
            summaryOf: ticketSummary
          })
        }))
  }))

export const ConfigLive = HttpApiBuilder.group(JcfWebApi, "config", (handlers) =>
  Effect.gen(function*() {
    const config = yield* ConfigService.ConfigService

    return handlers
      .handle("standing", ({ payload }) =>
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
      .handle("mine", ({ payload }) =>
        Effect.gen(function*() {
          const current = yield* config.get
          const next = current.sessionOwnershipOverrides.includes(payload.ticketKey)
            ? current.sessionOwnershipOverrides
            : [...current.sessionOwnershipOverrides, payload.ticketKey].sort()
          yield* config.set({ sessionOwnershipOverrides: next })
          // Read back rather than echo: the config service swallows a failed write, so echoing the
          // list we meant to store would report a decision that did not stick.
          const stored = (yield* config.get).sessionOwnershipOverrides
          if (!stored.includes(payload.ticketKey)) {
            return yield* failed("That ticket could not be saved to ~/.jcf/config.json")
          }
          return { ownershipOverrides: stored }
        }))
  }))
