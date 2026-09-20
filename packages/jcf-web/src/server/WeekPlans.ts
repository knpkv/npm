/** Server-held evidence for six recent week/scope pairs. Restoring it never reads sessions. */
import { ConfigService, ReconcileService, SavedEntries, SessionAttributor, WatchLease } from "@knpkv/jira-clockify"
import { Cache, Context, Crypto, Effect, FileSystem, Layer, Path, Ref, Semaphore } from "effect"
import type { PlatformError } from "effect"
import { ApiError, PlanExpiredError, ProposalRejectedError } from "../shared/contracts.js"
import type {
  DescribeRowRequest,
  DescribeRowResponse,
  DescribeSavedEntryRequest,
  DescribeSavedEntryResponse,
  UpdateSavedEntryRequest,
  UpdateSavedEntryResponse,
  WeekScopeName
} from "../shared/contracts.js"
import { agentSettingsKey, makeRowDescriptions } from "./RowDescriptions.js"
import type { DescriptionKey } from "./RowDescriptions.js"
import {
  describeSavedEntry,
  findSavedEntry,
  replaceSavedEntry,
  savedEntryFailure,
  validateSavedUpdate
} from "./SavedEntryOperations.js"
import { type HeldPlan, reconcileConsumption, withProjectedConsumption } from "./WeekPlan.js"

/** Weeks kept at once. Enough for stepping back through a month one week at a time. */
const RETAINED_PLANS = 6

export interface WeekPlansContract {
  readonly nextPlanId: Effect.Effect<string, PlatformError.PlatformError>
  /** Capture before reading provider state; a save invalidates every in-flight provider snapshot. */
  readonly readGeneration: Effect.Effect<number>
  /** Retain a plan, returning the existing scan if a recorded-only read raced with it. */
  readonly keep: (plan: HeldPlan, generation: number) => Effect.Effect<HeldPlan, PlanExpiredError>
  /** Compare-and-set for provider refreshes; an older read cannot replace an edited or rescanned plan. */
  readonly replace: (
    expected: HeldPlan,
    replacement: HeldPlan,
    generation: number
  ) => Effect.Effect<HeldPlan, PlanExpiredError>
  readonly forWeek: (monday: string, scope: WeekScopeName) => Effect.Effect<HeldPlan | undefined>
  readonly find: (planId: string) => Effect.Effect<HeldPlan | undefined>
  readonly describe: (request: DescribeRowRequest) => Effect.Effect<DescribeRowResponse, ApiError | PlanExpiredError>
  readonly describeSaved: (
    request: DescribeSavedEntryRequest
  ) => Effect.Effect<DescribeSavedEntryResponse, ApiError | PlanExpiredError>
  readonly updateSaved: (
    request: UpdateSavedEntryRequest
  ) => Effect.Effect<UpdateSavedEntryResponse, ApiError | PlanExpiredError | ProposalRejectedError>
  /** Call before and after changing agent settings so even pending lookups cannot reuse old results. */
  readonly invalidateDescriptions: Effect.Effect<void>
  /** Serialize a live provider tally and the writes it authorizes. */
  readonly withConfirmationPermit: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ProposalRejectedError, R>
}

interface RetainedPlan {
  readonly plan: HeldPlan
  readonly descriptions: Cache.Cache<DescriptionKey, string | null, ApiError | PlanExpiredError>
}

export class WeekPlans extends Context.Service<WeekPlans, WeekPlansContract>()("@knpkv/jcf-web/WeekPlans") {}

export const layer = Layer.effect(
  WeekPlans,
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    const config = yield* ConfigService.ConfigService
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const reconcile = yield* ReconcileService.ReconcileService
    const savedEntries = yield* SavedEntries.SavedEntries
    const attributor = yield* SessionAttributor.SessionAttributor
    const mutations = yield* Semaphore.make(1)
    const revision = yield* Ref.make(0)
    const readGeneration = yield* Ref.make(0)
    const plans = yield* Ref.make<ReadonlyArray<RetainedPlan>>([])
    const find = (planId: string) =>
      Ref.get(plans).pipe(Effect.map((held) => held.find(({ plan }) => plan.planId === planId)?.plan))
    const provideGuard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ConfigService.ConfigService, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path)
      )
    const withProviderPermit = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | ProposalRejectedError, R> =>
      mutations.withPermits(1)(
        Effect.acquireUseRelease(
          provideGuard(WatchLease.acquire({ intervalSeconds: 300 })),
          (lease): Effect.Effect<A, E | ProposalRejectedError, R> =>
            lease._tag === "Held"
              ? effect
              : Effect.fail(
                new ProposalRejectedError({
                  message: lease._tag === "Taken"
                    ? "jcf watch is writing time. Stop it before changing provider entries in the browser."
                    : `Could not take the machine writer guard: ${lease.reason}.`
                })
              ),
          (lease) => lease._tag === "Held" ? provideGuard(WatchLease.releaseGuard(lease)) : Effect.void
        )
      )
    return WeekPlans.of({
      withConfirmationPermit: withProviderPermit,
      readGeneration: Ref.get(readGeneration),
      forWeek: (monday, scope) =>
        Ref.get(plans).pipe(
          Effect.map((held) => held.find(({ plan }) => plan.plan.monday === monday && plan.plan.scope === scope)?.plan)
        ),
      find,
      replace: Effect.fn("WeekPlans.replace")(function*(expected, replacement, generation) {
        const current = yield* find(expected.planId)
        if (current === undefined) {
          return yield* new PlanExpiredError({ message: "This week was replaced while refreshing. Reload it." })
        }
        if (current !== expected || (yield* Ref.get(readGeneration)) !== generation) {
          return yield* new PlanExpiredError({ message: "Saved entries changed during refresh. Retry Refresh totals." })
        }
        yield* Ref.update(
          plans,
          (held) => held.map((retained) => retained.plan === expected ? { ...retained, plan: replacement } : retained)
        )
        return replacement
      }, mutations.withPermit),
      updateSaved: Effect.fn("WeekPlans.updateSaved")(function*(request) {
        const plan = yield* find(request.planId)
        const expected = plan === undefined ? undefined : findSavedEntry(plan, request)
        if (plan === undefined || expected === undefined) {
          return yield* new PlanExpiredError({ message: "That saved entry is not part of a retained week. Reload it." })
        }
        if (expected.revision !== request.revision) {
          return yield* new PlanExpiredError({
            message: "That saved entry changed since you opened it. Reload before saving."
          })
        }
        yield* validateSavedUpdate(plan, expected, request)
        const nextRevision = yield* cryptoService.randomUUIDv4.pipe(
          Effect.mapError(() => new ApiError({ message: "Could not create an entry revision. Retry the save." }))
        )
        const saved = yield* savedEntries.update({
          expected,
          startMs: request.startMs,
          endMs: request.endMs,
          description: request.description
        }).pipe(Effect.mapError(savedEntryFailure))
        const entry = { ...saved, revision: nextRevision }
        const replacement = replaceSavedEntry(plan, entry)
        const descriptions = yield* makeRowDescriptions({
          plan: find(replacement.planId),
          config,
          reconcile,
          revision: Ref.get(revision)
        })
        yield* Ref.update(
          plans,
          (held) => held.map((retained) => retained.plan === plan ? { plan: replacement, descriptions } : retained)
        )
        yield* Ref.update(readGeneration, (value) => value + 1)
        return { planId: request.planId, entry }
      }, withProviderPermit),
      describeSaved: Effect.fn("WeekPlans.describeSaved")(function*(request) {
        const plan = yield* find(request.planId)
        const entry = plan === undefined ? undefined : findSavedEntry(plan, request)
        if (plan === undefined || entry === undefined) {
          return yield* new PlanExpiredError({ message: "That saved entry is not part of a retained week. Reload it." })
        }
        const currentRevision = yield* Ref.get(revision)
        const settings = agentSettingsKey((yield* config.get).sessionAgent)
        const result = yield* describeSavedEntry({ plan, entry, attributor })
        const current = yield* find(request.planId)
        if (current === undefined || findSavedEntry(current, request)?.revision !== entry.revision) {
          return yield* new PlanExpiredError({
            message: "The saved entry changed while generating its description. Reload it."
          })
        }
        if (
          (yield* Ref.get(revision)) !== currentRevision ||
          agentSettingsKey((yield* config.get).sessionAgent) !== settings
        ) {
          return yield* new ApiError({ message: "Agent settings changed while generating the description. Retry." })
        }
        return { ...request, ...result }
      }),
      describe: Effect.fn("WeekPlans.describe")(function*(request) {
        const retained = (yield* Ref.get(plans)).find(({ plan }) => plan.planId === request.planId)
        if (retained === undefined || !retained.plan.evidence.has(request.rowId)) {
          return yield* new PlanExpiredError({ message: "That row is not part of a retained week — reload it" })
        }
        const currentRevision = yield* Ref.get(revision)
        const settings = (yield* config.get).sessionAgent
        const note = yield* Cache.get(retained.descriptions, {
          rowId: request.rowId,
          settings: agentSettingsKey(settings),
          revision: currentRevision
        })
        if (!(yield* Ref.get(plans)).some(({ plan }) => plan.planId === request.planId)) {
          return yield* new PlanExpiredError({ message: "This week was replaced while generating the description" })
        }
        return { ...request, note }
      }),
      invalidateDescriptions: Effect.gen(function*() {
        yield* Ref.update(revision, (value) => value + 1)
        yield* Effect.forEach(yield* Ref.get(plans), ({ descriptions }) => Cache.invalidateAll(descriptions))
      }),
      keep: Effect.fn("WeekPlans.keep")(function*(plan, generation) {
        if ((yield* Ref.get(readGeneration)) !== generation) {
          return yield* new PlanExpiredError({
            message: "Saved entries changed during this read. Retry the week read."
          })
        }
        const descriptions = yield* makeRowDescriptions({
          plan: find(plan.planId),
          config,
          reconcile,
          revision: Ref.get(revision)
        })
        return yield* Ref.modify(plans, (held) => {
          const scanned = held.find(({ plan: existing }) =>
            existing.plan.monday === plan.plan.monday && existing.plan.scope === plan.plan.scope &&
            existing.plan.sessionScanAvailable !== false
          )
          const consumptionOwner = held.find(({ plan: existing }) =>
            existing.plan.monday === plan.plan.monday && existing.plan.sessionScanAvailable !== false
          )
          if (plan.plan.sessionScanAvailable === false && scanned !== undefined) return [scanned.plan, held]
          const previous = held.find(({ plan: existing }) => existing.planId === plan.planId)
          // A new session scan changes the plan id, not which source blocks this server already
          // wrote under a corrected ticket. Carry that consumption across the replacement.
          const retainedPlan = consumptionOwner === undefined
            ? plan
            : {
              ...withProjectedConsumption(plan, reconcileConsumption(plan.report, consumptionOwner.plan.consumption)),
              jiraReceiptIssueKeys: consumptionOwner.plan.jiraReceiptIssueKeys
            }
          return [
            retainedPlan,
            [
              { plan: retainedPlan, descriptions: previous?.descriptions ?? descriptions },
              // Re-reading the same week replaces its plan rather than filling the window with copies.
              ...held.filter(({ plan: existing }) =>
                existing.planId !== plan.planId &&
                (existing.plan.monday !== plan.plan.monday || existing.plan.scope !== plan.plan.scope)
              )
            ].slice(0, RETAINED_PLANS)
          ]
        })
      }, mutations.withPermit),
      nextPlanId: cryptoService.randomUUIDv4
    })
  })
)
