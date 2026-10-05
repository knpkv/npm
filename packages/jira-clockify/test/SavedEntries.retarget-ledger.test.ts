import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ReconcileService } from "../src/services/ReconcileService.js"
import { layer as savedLayer, type RecordedEntry, SavedEntries } from "../src/services/SavedEntries.js"
import { type LedgerFile, SourceLedger, SourceLedgerError } from "../src/services/SourceLedger.js"
import { FAKE_HOME, FAKE_USER_ID, FAKE_WORKSPACE_ID, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

const startMs = new Date("2026-06-23T10:00:00Z").getTime()
const endMs = startMs + 300_000
const period = { from: new Date("2026-06-22T00:00:00Z"), to: new Date("2026-06-26T00:00:00Z") }
const scope = JSON.stringify(["clockify-v3", "https://api.clockify.me/api", FAKE_WORKSPACE_ID, FAKE_USER_ID])
const original: RecordedEntry = {
  id: "existing-0",
  source: "clockify",
  ticketKey: "PROJ-1",
  startMs,
  endMs,
  description: "[PROJ-1] ordinary work"
}
const reviewed: LedgerFile = {
  version: 5,
  reviewedWindows: [{ provider: "clockify", scope, fromMs: period.from.getTime(), toMs: period.to.getTime() }],
  pending: [],
  bindings: [],
  replacementIntents: [],
  observedUnbound: [{ provider: "clockify", scope, entryId: original.id, startMs }]
}

const fixture = (deletesFail = false) => {
  const cwd = `${FAKE_HOME}/dev/work`
  return makeFakeHeadless({
    writtenFiles: { [`${FAKE_HOME}/.jcf/source-consumption.v1.json`]: JSON.stringify(reviewed) },
    config: { sessionRoots: [cwd] },
    transcripts: {
      "work/session.jsonl": JSON.stringify({
        type: "user",
        sessionId: "worked",
        cwd,
        gitBranch: "feat/PROJ-1",
        timestamp: new Date(startMs).toISOString(),
        message: { role: "user", content: "Implemented validation" }
      })
    },
    clockifyEntries: [{
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      description: original.description ?? ""
    }],
    clockifyDeletesFail: deletesFail
  })
}

const update = {
  expected: original,
  expectedScopes: { clockify: scope, jira: null },
  startMs,
  endMs,
  description: original.description ?? "",
  ticketKey: "PROJ-2"
}

describe("ordinary saved-entry replacement ledger", () => {
  it.effect("does not repeat replacement creation when deleting the original failed", () => {
    const fake = fixture(true)
    return Effect.gen(function*() {
      const saved = yield* SavedEntries
      const first = yield* saved.update(update).pipe(Effect.result)
      expect(Result.isFailure(first) && first.failure.reason).toBe("partial")
      const retry = yield* saved.update(update).pipe(Effect.result)
      expect(Result.isFailure(retry) && retry.failure.reason).toBe("conflict")
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("retains the create intent across restart if the remote ID could not be persisted", () => {
    const fake = fixture()
    return Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const ledger = yield* SourceLedger
        const fault = SourceLedger.of({
          ...ledger,
          identifyReplacement: () =>
            Effect.fail(new SourceLedgerError({ message: "synthetic identity persist failure" }))
        })
        const outcome = yield* Effect.gen(function*() {
          const saved = yield* SavedEntries
          return yield* saved.update(update).pipe(Effect.result)
        }).pipe(Effect.provide(savedLayer.pipe(Layer.provide(Layer.succeed(SourceLedger, fault)), Layer.fresh)))
        expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("partial")
        expect(fake.world.createdClockifyEntries).toHaveLength(1)
        expect(fake.world.deletedClockifyEntries).toEqual([])
        expect((yield* ledger.read).replacementIntents).toMatchObject([{
          _tag: "Pending",
          entryId: original.id,
          ticketKey: "PROJ-2"
        }])
      }).pipe(Effect.provide(fake.layer))
      const restarted = makeFakeHeadless({
        writtenFiles: fake.world.writtenFiles,
        clockifyEntries: [
          {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            description: original.description ?? ""
          },
          ...fake.world.createdClockifyEntries.map((entry) => ({
            start: entry.start,
            end: entry.end,
            description: entry.description
          }))
        ]
      })
      yield* Effect.gen(function*() {
        const saved = yield* SavedEntries
        const ledger = yield* SourceLedger
        const retry = yield* saved.update(update).pipe(Effect.result)
        expect(Result.isFailure(retry) && retry.failure.reason).toBe("conflict")
        expect((yield* ledger.read).replacementIntents).toHaveLength(1)
        expect(restarted.world.createdClockifyEntries).toEqual([])
      }).pipe(Effect.provide(restarted.layer))
    })
  })

  it.effect("does not POST when persisting the replacement reservation fails", () => {
    const fake = fixture()
    return Effect.gen(function*() {
      const ledger = yield* SourceLedger
      const fault = SourceLedger.of({
        ...ledger,
        reserveReplacement: () => Effect.fail(new SourceLedgerError({ message: "synthetic reserve failure" }))
      })
      yield* Effect.gen(function*() {
        const saved = yield* SavedEntries
        const result = yield* saved.update(update).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.reason).toBe("conflict")
      }).pipe(Effect.provide(savedLayer.pipe(Layer.provide(Layer.succeed(SourceLedger, fault)), Layer.fresh)))
      expect(fake.world.createdClockifyEntries).toEqual([])
      expect((yield* ledger.read).replacementIntents).toEqual([])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("allows explicit deletion of a verified replacement to resolve a partial move", () => {
    const first = fixture(true)
    return Effect.gen(function*() {
      const outcome = yield* Effect.gen(function*() {
        const saved = yield* SavedEntries
        return yield* saved.update(update).pipe(Effect.result)
      }).pipe(Effect.provide(first.layer))
      expect(Result.isFailure(outcome) && outcome.failure.replacement).toBeDefined()
      if (Result.isSuccess(outcome) || outcome.failure.replacement === undefined) {
        return yield* new SourceLedgerError({ message: "test requires a partial replacement" })
      }
      const replacement = outcome.failure.replacement
      const restarted = makeFakeHeadless({
        writtenFiles: first.world.writtenFiles,
        clockifyEntries: [{
          id: original.id,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          description: original.description ?? ""
        }, {
          id: replacement.id,
          start: new Date(replacement.startMs).toISOString(),
          end: new Date(replacement.endMs).toISOString(),
          description: replacement.description ?? ""
        }]
      })
      yield* Effect.gen(function*() {
        const saved = yield* SavedEntries
        const ledger = yield* SourceLedger
        expect((yield* ledger.read).replacementIntents[0]?._tag).toBe("Verified")
        yield* saved.remove({ expected: replacement, expectedScopes: update.expectedScopes })
        const stored = yield* ledger.read
        expect(stored.replacementIntents).toEqual([])
        expect(stored.observedUnbound.map((entry) => entry.entryId)).toEqual([original.id])
        expect(restarted.world.deletedClockifyEntries).toEqual([replacement.id])
      }).pipe(Effect.provide(restarted.layer))
    })
  })

  for (const expand of [false, true]) {
    it.effect(`keeps a verified ordinary replacement writable in an ${expand ? "expanded" : "unchanged"} window`, () => {
      const fake = fixture()
      return Effect.gen(function*() {
        const saved = yield* SavedEntries
        const reconcile = yield* ReconcileService
        const ledger = yield* SourceLedger
        const replacement = yield* saved.update(update)
        expect(replacement.ticketKey).toBe("PROJ-2")
        expect(fake.world.deletedClockifyEntries).toEqual([original.id])
        const bounds = expand ? { ...period, to: new Date("2026-06-27T00:00:00Z") } : period
        yield* TestClock.setTime(bounds.to.getTime())
        const report = yield* reconcile.proposeFromSessions(bounds, { sides: { jira: false, clockify: true } })
        expect(report.attributed).not.toEqual([])
        expect(report.recorded.some((row) => row.ticketKey === "PROJ-2")).toBe(true)
        expect((yield* ledger.read).bindings).toEqual([])
        expect((yield* ledger.read).replacementIntents).toEqual([])
        expect((yield* ledger.read).observedUnbound).toEqual([{
          provider: "clockify",
          scope,
          entryId: replacement.id,
          startMs
        }])
        expect(report.writeBlocked?.clockify).toBeUndefined()
      }).pipe(Effect.provide(fake.layer))
    })
  }
})
