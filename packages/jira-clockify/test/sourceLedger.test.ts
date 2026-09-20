import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { type SourceIdentity, SourceLedger, type SourceWindow } from "../src/services/SourceLedger.js"
import { FAKE_HOME, FAKE_USER_ID, FAKE_WORKSPACE_ID, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

const file = `${FAKE_HOME}/.jcf/source-consumption.v1.json`
const identity: SourceIdentity = {
  provider: "clockify",
  scope: JSON.stringify([FAKE_WORKSPACE_ID, FAKE_USER_ID]),
  rowId: "2026-07-01:PROJ-1",
  sourceStartMs: 1_000,
  startMs: 1_000,
  endMs: 1_801_000,
  seconds: 1_800,
  ticketKey: "PROJ-2"
}

const withLedger = <A, E>(
  fake: ReturnType<typeof makeFakeHeadless>,
  use: (ledger: SourceLedger["Service"]) => Effect.Effect<A, E>
) =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(fake.sourceLedgerLayer)
    return yield* use(Context.get(context, SourceLedger))
  }))

it.effect("persists a pending write and its provider binding across service restarts", () => {
  const first = makeFakeHeadless()
  return Effect.gen(function*() {
    yield* withLedger(first, (ledger) =>
      Effect.gen(function*() {
        yield* ledger.reserve(identity)
        expect((yield* ledger.read).pending).toHaveLength(1)
        yield* ledger.bind(identity, "provider-entry-1")
      }))

    const restarted = makeFakeHeadless({ writtenFiles: first.world.writtenFiles })
    yield* withLedger(restarted, (ledger) =>
      Effect.gen(function*() {
        const stored = yield* ledger.read
        expect(stored.pending).toEqual([])
        expect(stored.bindings).toEqual([{ ...identity, entryId: "provider-entry-1" }])
      }))
  })
})

it.effect("does not repeat a pending remote write or treat malformed storage as empty", () => {
  const fake = makeFakeHeadless()
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      yield* ledger.reserve(identity)
      expect((yield* Effect.flip(ledger.reserve(identity)))._tag).toBe("SourceLedgerError")
      fake.world.writtenFiles[file] = "{invalid"
      expect((yield* Effect.flip(ledger.read))._tag).toBe("SourceLedgerError")
    }))
})

it.effect("first-run migration refuses unmarked provider history and accepts only verified markers", () => {
  const fake = makeFakeHeadless({ writtenFiles: {} })
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      const window: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 10_000_000 }
      expect((yield* Effect.flip(ledger.ensureWindow(window, 1, [])))._tag).toBe("SourceLedgerError")
      expect(fake.world.writtenFiles[file]).toBeUndefined()
      expect(
        (yield* Effect.flip(ledger.ensureWindow(window, 1, [{
          ...identity,
          seconds: 1,
          entryId: "invalid-duration"
        }]))).message
      ).toContain("Invalid consumption ledger update")
      expect(fake.world.writtenFiles[file]).toBeUndefined()
      yield* ledger.ensureWindow(window, 1, [{ ...identity, entryId: "legacy-entry" }])
      expect((yield* ledger.read).bindings).toEqual([{ ...identity, entryId: "legacy-entry" }])
      expect((yield* ledger.read).reviewedWindows).toEqual([window])
    }))
})

it.effect("carries an unresolved intent across process restart without authorizing a retry", () => {
  const first = makeFakeHeadless()
  return Effect.gen(function*() {
    yield* withLedger(first, (ledger) => ledger.reserve(identity))
    const restarted = makeFakeHeadless({ writtenFiles: first.world.writtenFiles })
    yield* withLedger(restarted, (ledger) =>
      Effect.gen(function*() {
        expect((yield* ledger.read).pending).toEqual([identity])
        expect((yield* Effect.flip(ledger.reserve(identity))).message).toContain("unresolved remote write")
      }))
  })
})

it.effect("rejects an unknown ledger version and conflicting provider identities", () => {
  const fake = makeFakeHeadless()
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      fake.world.writtenFiles[file] = JSON.stringify({ version: 2, reviewedWindows: [], pending: [], bindings: [] })
      expect((yield* Effect.flip(ledger.read))._tag).toBe("SourceLedgerError")
      fake.world.writtenFiles[file] = JSON.stringify({
        version: 1,
        reviewedWindows: [],
        pending: [],
        bindings: [
          { ...identity, entryId: "same-entry" },
          { ...identity, rowId: "2026-07-01:PROJ-3", entryId: "same-entry" }
        ]
      })
      expect((yield* Effect.flip(ledger.read))._tag).toBe("SourceLedgerError")
    }))
})
