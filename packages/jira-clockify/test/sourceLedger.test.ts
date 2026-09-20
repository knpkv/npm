import { expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { type SourceIdentity, SourceLedger, type SourceWindow } from "../src/services/SourceLedger.js"
import { FAKE_HOME, FAKE_USER_ID, FAKE_WORKSPACE_ID, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

const file = `${FAKE_HOME}/.jcf/source-consumption.v1.json`
const lock = `${file}.lock`
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
      const observed = [{ entryId: "legacy-entry", startMs: identity.startMs }]
      expect((yield* Effect.flip(ledger.ensureWindow(window, observed, [])))._tag).toBe("SourceLedgerError")
      expect(fake.world.writtenFiles[file]).toBeUndefined()
      expect(
        (yield* Effect.flip(ledger.ensureWindow(window, [{ entryId: "invalid-duration", startMs: identity.startMs }], [{
          ...identity,
          seconds: 1,
          entryId: "invalid-duration"
        }]))).message
      ).toContain("Invalid consumption ledger update")
      expect(fake.world.writtenFiles[file]).toBeUndefined()
      yield* ledger.ensureWindow(window, observed, [{ ...identity, entryId: "legacy-entry" }])
      expect((yield* ledger.read).bindings).toEqual([{ ...identity, entryId: "legacy-entry" }])
      expect((yield* ledger.read).reviewedWindows).toEqual([window])
    }))
})

it.effect("extends verified coverage for later ordinary entries but rejects new unmarked old-prefix history", () => {
  const fake = makeFakeHeadless({ writtenFiles: {} })
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      const first: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
      const extended: SourceWindow = { ...first, toMs: 4_000_000 }
      const marker = { ...identity, entryId: "legacy-entry" }
      const prior = { entryId: marker.entryId, startMs: identity.startMs }
      yield* ledger.ensureWindow(first, [prior], [marker])
      expect(
        (yield* Effect.flip(ledger.ensureWindow({ ...first, fromMs: -1_000_000 }, [
          prior,
          { entryId: "older-unmarked-entry", startMs: -500_000 }
        ], [marker]))).message
      ).toContain("manual review")
      const later = { entryId: "ordinary-later-entry", startMs: 3_000_000 }
      yield* ledger.ensureWindow(extended, [prior, later], [marker])
      expect((yield* ledger.read).reviewedWindows).toEqual([first, extended])
      expect((yield* ledger.read).observedUnbound).toEqual([{
        provider: "clockify",
        scope: identity.scope,
        ...later
      }])
      expect(
        (yield* Effect.flip(ledger.ensureWindow({ ...first, fromMs: 5_000_000, toMs: 7_000_000 }, [
          { entryId: "unreviewed-gap-tail", startMs: 6_000_000 }
        ], []))).message
      ).toContain("manual review")
      const another = { ...extended, toMs: 5_000_000 }
      yield* ledger.ensureWindow(another, [prior, later], [marker])
      yield* ledger.ensureWindow({ ...first, fromMs: 1_000_000 }, [prior, later], [marker])
      expect(
        (yield* Effect.flip(ledger.ensureWindow({ ...another, toMs: 6_000_000 }, [
          prior,
          later,
          { entryId: "ambiguous-old-entry", startMs: 1_500_000 }
        ], [marker]))).message
      ).toContain("manual review")
    }))
})

it.effect("remembers an ordinary tail across restart and overlapping extensions without admitting a backdated entry", () => {
  const first = makeFakeHeadless({ writtenFiles: {} })
  const marker = { ...identity, entryId: "marked-entry" }
  const marked = { entryId: marker.entryId, startMs: identity.startMs }
  const ordinary = { entryId: "ordinary-entry", startMs: 3_000_000 }
  const initial: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
  return Effect.gen(function*() {
    yield* withLedger(first, (ledger) =>
      Effect.gen(function*() {
        yield* ledger.ensureWindow(initial, [marked], [marker])
        yield* ledger.ensureWindow({ ...initial, toMs: 4_000_000 }, [marked, ordinary], [marker])
      }))
    const restarted = makeFakeHeadless({ writtenFiles: first.world.writtenFiles })
    yield* withLedger(restarted, (ledger) =>
      Effect.gen(function*() {
        yield* ledger.ensureWindow({ ...initial, fromMs: 1_000_000, toMs: 5_000_000 }, [marked, ordinary], [marker])
        expect((yield* ledger.read).observedUnbound).toEqual([{
          provider: "clockify",
          scope: identity.scope,
          ...ordinary
        }])
        const before = restarted.world.writtenFiles[file]
        const newlyBackdated = { entryId: "new-backdated-entry", startMs: 3_500_000 }
        expect(
          (yield* Effect.flip(ledger.ensureWindow({ ...initial, toMs: 6_000_000 }, [
            marked,
            ordinary,
            newlyBackdated
          ], [marker]))).message
        ).toContain("manual review")
        expect(restarted.world.writtenFiles[file]).toBe(before)
        expect(
          (yield* Effect.flip(ledger.ensureWindow({ ...initial, toMs: 6_000_000 }, [
            marked,
            { ...ordinary, startMs: 3_100_000 }
          ], [marker]))).message
        ).toContain("manual review")
        expect(restarted.world.writtenFiles[file]).toBe(before)
        yield* ledger.ensureWindow({ ...initial, toMs: 6_000_000 }, [marked, ordinary, {
          entryId: "new-forward-tail",
          startMs: 5_500_000
        }], [marker])
        expect((yield* ledger.read).observedUnbound).toHaveLength(2)
      }))
  })
})

it.effect("keeps ordinary observations separate by provider and account", () => {
  const fake = makeFakeHeadless({ writtenFiles: {} })
  const clockify: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
  const anotherAccount: SourceWindow = { ...clockify, scope: "synthetic-other-account" }
  const jira: SourceWindow = { ...clockify, provider: "jira", scope: "synthetic-jira-account" }
  const prior = { entryId: "shared-provider-id", startMs: 1_000 }
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      yield* ledger.ensureWindow(clockify, [prior], [{ ...identity, entryId: prior.entryId }])
      yield* ledger.ensureWindow({ ...clockify, toMs: 4_000_000 }, [prior, {
        entryId: "ordinary-tail",
        startMs: 3_000_000
      }], [{ ...identity, entryId: prior.entryId }])
      for (const other of [anotherAccount, jira]) {
        expect((yield* Effect.flip(ledger.ensureWindow(other, [prior], []))).message).toContain("manual review")
      }
      expect((yield* ledger.read).observedUnbound).toEqual([{
        provider: "clockify",
        scope: identity.scope,
        entryId: "ordinary-tail",
        startMs: 3_000_000
      }])
    }))
})

it.effect("migrates strict v1 state on a successful write without inventing earlier ordinary IDs", () => {
  const initial: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
  const marker = { ...identity, entryId: "marked-entry" }
  const v1 = JSON.stringify({ version: 1, reviewedWindows: [initial], pending: [identity], bindings: [marker] })
  const fake = makeFakeHeadless({ writtenFiles: { [file]: v1 } })
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      const loaded = yield* ledger.read
      expect(loaded.version).toBe(2)
      expect(loaded.observedUnbound).toEqual([])
      expect(fake.world.writtenFiles[file]).toBe(v1)
      expect(
        (yield* Effect.flip(ledger.ensureWindow({ ...initial, toMs: 4_000_000 }, [
          { entryId: marker.entryId, startMs: identity.startMs },
          { entryId: "unknown-old-entry", startMs: 1_500_000 }
        ], [marker]))).message
      ).toContain("manual review")
      expect(fake.world.writtenFiles[file]).toBe(v1)
      yield* ledger.ensureWindow({ ...initial, toMs: 4_000_000 }, [
        { entryId: marker.entryId, startMs: identity.startMs },
        { entryId: "ordinary-tail", startMs: 3_000_000 }
      ], [marker])
      const migrated = yield* ledger.read
      expect(migrated.version).toBe(2)
      expect(migrated.pending).toEqual([identity])
      expect(migrated.bindings).toEqual([marker])
      expect(migrated.observedUnbound).toEqual([{
        provider: "clockify",
        scope: identity.scope,
        entryId: "ordinary-tail",
        startMs: 3_000_000
      }])
    }))
})

it.effect("does not admit a forward tail if the version migration cannot persist", () => {
  const initial: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
  const marker = { ...identity, entryId: "marked-entry" }
  const v1 = JSON.stringify({ version: 1, reviewedWindows: [initial], pending: [], bindings: [marker] })
  const fake = makeFakeHeadless({
    writtenFiles: { [file]: v1 },
    unwritablePaths: [`${file}.tmp`]
  })
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      const result = yield* Effect.flip(ledger.ensureWindow({ ...initial, toMs: 4_000_000 }, [
        { entryId: marker.entryId, startMs: identity.startMs },
        { entryId: "ordinary-tail", startMs: 3_000_000 }
      ], [marker]))
      expect(result._tag).toBe("SourceLedgerError")
      expect(fake.world.writtenFiles[file]).toBe(v1)
      expect(fake.world.writtenFiles[`${file}.tmp`]).toBeUndefined()
      expect((yield* Effect.flip(ledger.reserve({ ...identity, startMs: 3_000_000, endMs: 4_800_000 })))._tag)
        .toBe("SourceLedgerError")
    }))
})

it.effect("leaves an interrupted migration for manual recovery instead of trusting its temporary bytes", () => {
  const initial: SourceWindow = { provider: "jira", scope: "synthetic-account", fromMs: 0, toMs: 2_000_000 }
  const v1 = JSON.stringify({ version: 1, reviewedWindows: [initial], pending: [], bindings: [] })
  const fake = makeFakeHeadless({ writtenFiles: { [file]: v1 }, unwritablePaths: [file] })
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      expect(
        (yield* Effect.flip(ledger.ensureWindow({ ...initial, toMs: 4_000_000 }, [
          { entryId: "ordinary-tail", startMs: 3_000_000 }
        ], [])))._tag
      ).toBe("SourceLedgerError")
      expect(fake.world.writtenFiles[file]).toBe(v1)
      expect(fake.world.writtenFiles[`${file}.tmp`]).toBeDefined()
      expect((yield* Effect.flip(ledger.ensureWindow({ ...initial, toMs: 4_000_000 }, [], [])))._tag)
        .toBe("SourceLedgerError")
      expect(fake.world.writtenFiles[file]).toBe(v1)
    }))
})

it.effect("recovers a dead lock holder without clearing pending source intent", () => {
  const pending = { version: 1, reviewedWindows: [], pending: [identity], bindings: [] }
  const fake = makeFakeHeadless({
    pidNamespaceInode: 777,
    writtenFiles: {
      [file]: JSON.stringify(pending),
      [lock]: JSON.stringify({ version: 1, pid: 123, namespace: 777 }),
      "/proc/self/stat": "456 (synthetic) R",
      "/proc/456/stat": "456 (synthetic) R"
    }
  })
  return withLedger(fake, (ledger) =>
    Effect.gen(function*() {
      yield* ledger.ensureWindow({ provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }, [], [])
      expect((yield* ledger.read).pending).toEqual([identity])
      expect(fake.world.writtenFiles[lock]).toBeUndefined()
      expect(fake.world.writtenFiles[`${lock}.recovery`]).toBeUndefined()
    }))
})

it.effect("never evicts a live or unverified lock owner", () => {
  const window: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
  const owner = JSON.stringify({ version: 1, pid: 123, namespace: 777 })
  return Effect.gen(function*() {
    for (const live of [true, false]) {
      const fake = makeFakeHeadless({
        pidNamespaceInode: 777,
        writtenFiles: {
          [lock]: live ? owner : "held",
          "/proc/self/stat": "456 (synthetic) R",
          "/proc/456/stat": "456 (synthetic) R",
          ...(live && { "/proc/123/stat": "123 (synthetic) R" })
        }
      })
      yield* withLedger(fake, (ledger) =>
        Effect.gen(function*() {
          expect((yield* Effect.flip(ledger.ensureWindow(window, [], [])))._tag).toBe("SourceLedgerError")
          expect(fake.world.writtenFiles[lock]).toBe(live ? owner : "held")
          expect(fake.world.writtenFiles[`${lock}.recovery`]).toBeUndefined()
        }))
    }
    const denied = makeFakeHeadless({
      pidNamespaceInode: 777,
      unreadableTranscripts: ["/proc/123/stat"],
      writtenFiles: {
        [lock]: owner,
        "/proc/self/stat": "456 (synthetic) R",
        "/proc/456/stat": "456 (synthetic) R"
      }
    })
    yield* withLedger(denied, (ledger) =>
      Effect.gen(function*() {
        expect((yield* Effect.flip(ledger.ensureWindow(window, [], [])))._tag).toBe("SourceLedgerError")
        expect(denied.world.writtenFiles[lock]).toBe(owner)
      }))
  })
})

it.effect("allows only one recovery writer while a stale lock is replaced", () =>
  Effect.gen(function*() {
    const created = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const fake = makeFakeHeadless({
      pidNamespaceInode: 777,
      writtenFiles: {
        [lock]: JSON.stringify({ version: 1, pid: 123, namespace: 777 }),
        "/proc/self/stat": "456 (synthetic) R",
        "/proc/456/stat": "456 (synthetic) R"
      },
      afterFileWrite: (path) =>
        path === lock
          ? Deferred.succeed(created, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
    })
    const window: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000_000 }
    const first = yield* withLedger(fake, (ledger) => ledger.ensureWindow(window, [], [])).pipe(Effect.forkChild)
    yield* Deferred.await(created)
    const second = yield* withLedger(fake, (ledger) => Effect.flip(ledger.ensureWindow(window, [], [])))
    expect(second._tag).toBe("SourceLedgerError")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    expect(fake.world.writtenFiles[lock]).toBeUndefined()
  }))

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
        bindings: [],
        observedUnbound: []
      })
      expect((yield* Effect.flip(ledger.read))._tag).toBe("SourceLedgerError")
      const reviewed: SourceWindow = { provider: "clockify", scope: identity.scope, fromMs: 0, toMs: 2_000 }
      for (
        const invalid of [
          {
            reviewedWindows: [],
            observedUnbound: [{ provider: "clockify", scope: identity.scope, entryId: "unreviewed", startMs: 1_000 }]
          },
          {
            reviewedWindows: [reviewed],
            observedUnbound: [
              { provider: "clockify", scope: identity.scope, entryId: "duplicate", startMs: 1_000 },
              { provider: "clockify", scope: identity.scope, entryId: "duplicate", startMs: 1_000 }
            ]
          },
          {
            reviewedWindows: [reviewed],
            observedUnbound: [{ provider: "clockify", scope: identity.scope, entryId: "   ", startMs: 1_000 }]
          }
        ]
      ) {
        fake.world.writtenFiles[file] = JSON.stringify({
          version: 2,
          pending: [],
          bindings: [],
          ...invalid
        })
        expect((yield* Effect.flip(ledger.read))._tag).toBe("SourceLedgerError")
      }
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
