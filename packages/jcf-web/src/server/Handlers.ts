/**
 * Authenticated endpoint handlers.
 *
 * Week reads, retained descriptions, and write decisions live in their owning modules.
 * These handlers translate their outcomes and coordinate configuration changes.
 *
 * @module
 */
import { ConfigService, FetchTicket, IssueFacts, ReconcileService } from "@knpkv/jira-clockify"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { ReadProgress, WeekScopeName } from "../shared/contracts.js"
import { ApiError, JcfWebApi, PlanExpiredError, ProposalRejectedError } from "./Api.js"
import { confirmProposal, logManualEntry } from "./Confirm.js"
import { WeekPlans } from "./WeekPlans.js"
import { readRecordedWeekPlan, readWeekPlan, refreshWeekPlan, savedWeekPlan, streamWeekRead } from "./WeekRead.js"

const failed = (message: string) => new ApiError({ message })

export const WeekLive = HttpApiBuilder.group(JcfWebApi, "week", (handlers) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    const issues = yield* IssueFacts.IssueFacts
    const config = yield* ConfigService.ConfigService
    const plans = yield* WeekPlans

    const read = (
      query: { readonly monday?: string | undefined; readonly only?: WeekScopeName | undefined },
      report: (progress: ReadProgress) => Effect.Effect<void>
    ) => readWeekPlan({ query, report, reconcile, issues, config, plans })

    return handlers
      .handle("saved", ({ query }) => savedWeekPlan({ query, plans }))
      .handle("read", ({ query }) => read(query, () => Effect.void))
      .handle("stream", ({ query }) => Effect.succeed(streamWeekRead((report) => read(query, report))))
      .handle("recordedOnly", ({ query }) =>
        Effect.succeed(streamWeekRead((report) =>
          readRecordedWeekPlan({ query, report, reconcile, config, plans })
        )))
      .handle("recorded", ({ query }) =>
        Effect.succeed(streamWeekRead((report) =>
          refreshWeekPlan({ planId: query.planId, report, reconcile, plans })
        )))
  }))

export const RowsLive = HttpApiBuilder.group(JcfWebApi, "rows", (handlers) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    const plans = yield* WeekPlans
    const ticketSummary = yield* FetchTicket.ticketSummaryReader

    return handlers
      .handle("describe", ({ payload }) => plans.describe(payload))
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
    const plans = yield* WeekPlans

    return handlers
      .handle("agent", () => config.get.pipe(Effect.map((settings) => settings.sessionAgent)))
      .handle("saveAgent", ({ payload }) =>
        Effect.gen(function*() {
          yield* plans.invalidateDescriptions
          yield* config.set({ sessionAgent: payload }).pipe(Effect.ensuring(plans.invalidateDescriptions))
          const stored = (yield* config.get).sessionAgent
          if (
            stored.provider !== payload.provider || stored.model !== payload.model || stored.effort !== payload.effort
          ) {
            return yield* failed("Agent settings could not be saved. Retry the save.")
          }
          return stored
        }))
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

export const EntriesLive = HttpApiBuilder.group(JcfWebApi, "entries", (handlers) =>
  Effect.gen(function*() {
    const plans = yield* WeekPlans
    return handlers
      .handle("update", ({ payload }) => plans.updateSaved(payload))
      .handle("describe", ({ payload }) => plans.describeSaved(payload))
  }))
