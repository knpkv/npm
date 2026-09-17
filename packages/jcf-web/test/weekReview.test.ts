import { Deferred, Effect } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { afterEach, expect, it, vi } from "vitest"
import { RequestFailure } from "../src/client/api.js"
import { makeWeekReview, type WeekTransport } from "../src/client/weekReview.js"
import type {
  SavedEntry,
  UpdateSavedEntryResponse,
  WeekPlanResponse,
  WriteResultResponse
} from "../src/shared/contracts.js"
import { fixtureWeek } from "./fixture.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

const gate = <A>() => {
  const deferred = Deferred.makeUnsafe<A, RequestFailure>()
  return {
    promise: Effect.runPromise(Deferred.await(deferred)),
    resolve: (value: A) => Deferred.doneUnsafe(deferred, Effect.succeed(value)),
    reject: (message: string) =>
      Deferred.doneUnsafe(deferred, Effect.fail(new RequestFailure({ status: 503, message })))
  }
}
const written: WriteResultResponse = {
  clockify: { _tag: "Written", seconds: 3600 },
  jira: { _tag: "Written", seconds: 3600 },
  description: "Saved",
  lines: []
}

const setup = (overrides: Partial<WeekTransport> = {}, delay?: (milliseconds: number) => Effect.Effect<void>) => {
  const plan = fixtureWeek()
  let lastSaved = plan
  const transport = {
    bootstrapSession: vi.fn<WeekTransport["bootstrapSession"]>(overrides.bootstrapSession ?? (async () => undefined)),
    readSavedWeek: vi.fn<WeekTransport["readSavedWeek"]>(
      overrides.readSavedWeek ?? (async (week, scope) => {
        lastSaved = fixtureWeek(week, scope)
        return { monday: lastSaved.monday, scope, plan: lastSaved }
      })
    ),
    readRecordedWeek: vi.fn<WeekTransport["readRecordedWeek"]>(
      overrides.readRecordedWeek ?? (async () => ({ ...lastSaved, sessionScanAvailable: false }))
    ),
    readWeek: vi.fn<WeekTransport["readWeek"]>(overrides.readWeek ?? (async () => plan)),
    refreshRecordedTime: vi.fn<WeekTransport["refreshRecordedTime"]>(
      overrides.refreshRecordedTime ?? (async () => lastSaved)
    ),
    confirmRow: vi.fn<WeekTransport["confirmRow"]>(overrides.confirmRow ?? (async () => written)),
    updateSavedEntry: vi.fn<WeekTransport["updateSavedEntry"]>(
      overrides.updateSavedEntry ?? (async (request) => ({
        planId: request.planId,
        entry: {
          id: request.entryId,
          revision: request.revision,
          source: request.source,
          ticketKey: "PROJ-7001",
          startMs: request.startMs,
          endMs: request.endMs,
          description: request.description
        }
      }))
    ),
    logManual: vi.fn<WeekTransport["logManual"]>(overrides.logManual ?? (async () => written)),
    mapStandingAttribution: vi.fn<WeekTransport["mapStandingAttribution"]>(
      overrides.mapStandingAttribution ?? (async () => ({ sessionTicketMap: {} }))
    ),
    markTicketMine: vi.fn<WeekTransport["markTicketMine"]>(
      overrides.markTicketMine ?? (async () => ({ ownershipOverrides: [] }))
    )
  } satisfies WeekTransport
  const registry = AtomRegistry.make()
  cleanups.push(() => registry.dispose())
  const review = makeWeekReview(
    registry,
    {
      week: plan.monday,
      scope: "both",
      now: () => 0,
      rememberWeek: vi.fn(),
      rememberScope: vi.fn()
    },
    transport,
    delay
  )
  cleanups.push(review.dispose)
  cleanups.push(registry.mount(review.state))
  return { review, transport, state: () => registry.get(review.state), registry, plan }
}

// A saved edit replaces only its provider entry immediately and rolls back on failure; success refreshes totals without rescanning.
it("optimistically edits saved entries, rolls back rejection, and settles the actual provider result", async () => {
  const entry: SavedEntry = {
    id: "saved-clockify",
    revision: "entry-revision",
    source: "clockify",
    ticketKey: null,
    startMs: 100000,
    endMs: 200000,
    description: "Original"
  }
  const first = gate<UpdateSavedEntryResponse>()
  const totals = gate<WeekPlanResponse>()
  let succeed = false
  const { plan, review, state, transport } = setup({
    updateSavedEntry: async (request) =>
      succeed
        ? {
          planId: request.planId,
          entry: { ...entry, startMs: request.startMs, endMs: request.endMs, description: "Provider returned text" }
        }
        : first.promise
  })
  await review.initialize()
  const request = {
    planId: plan.planId,
    entryId: entry.id,
    revision: entry.revision,
    source: entry.source,
    startMs: 110000,
    endMs: 210000,
    description: "Changed\nexactly"
  }
  const saving = review.updateSaved({ entry, request })
  await vi.waitFor(() =>
    expect(state().optimisticEntries).toMatchObject([{
      replaces: { source: "clockify", id: entry.id },
      pending: true,
      description: request.description,
      startMs: 110000
    }])
  )
  first.reject("Provider refused the edit")
  expect(await saving).toBe(false)
  expect(state().optimisticEntries).toEqual([])
  expect(state().actionFailure).toContain("Provider refused the edit")
  expect(transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  review.toggleLayer("clockify")
  expect(await review.updateSaved({ entry, request })).toBe(false)
  expect(transport.updateSavedEntry).toHaveBeenCalledTimes(1)
  review.toggleLayer("clockify")
  succeed = true
  transport.refreshRecordedTime.mockImplementationOnce(() => totals.promise)
  expect(await review.updateSaved({ entry, request })).toBe(true)
  expect(state().optimisticEntries).toMatchObject([{ pending: false, description: "Provider returned text" }])
  expect(transport.refreshRecordedTime).toHaveBeenCalledTimes(2)
  expect(transport.readWeek).not.toHaveBeenCalled()
  expect(transport.confirmRow).not.toHaveBeenCalled()
  expect(transport.logManual).not.toHaveBeenCalled()
  totals.resolve(plan)
})

// Suggestion visibility is one choice; provider visibility and write targets remain independent.
it("selects one suggestion filter and keeps saved provider layers independent", () => {
  const { review, state, transport } = setup()
  expect(state().layers).toEqual({ jira: true, clockify: true, available: true, overlapping: false })
  review.toggleLayer("overlapping")
  expect(state().layers).toEqual({ jira: true, clockify: true, available: false, overlapping: true })
  review.toggleLayer("overlapping")
  expect(state().layers.overlapping).toBe(true)
  review.toggleLayer("all")
  expect(state().layers).toEqual({ jira: true, clockify: true, available: true, overlapping: true })
  review.toggleLayer("available")
  review.toggleLayer("clockify")
  expect(state().layers).toEqual({ jira: true, clockify: false, available: true, overlapping: false })
  expect(transport.readWeek).not.toHaveBeenCalled()
})

// A page reload cannot silently launch the coding agent, including when there is no cached evidence.
it("restores saved evidence and refreshes totals, requiring an explicit rescan when no plan exists", async () => {
  const { review, state, transport } = setup()
  await review.initialize()
  expect(transport.readSavedWeek).toHaveBeenCalledTimes(1)
  expect(transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  expect(transport.readWeek).not.toHaveBeenCalled()
  expect(state().unavailable).toBe(false)
  const empty = setup({
    readSavedWeek: async (monday, scope) => ({ monday: monday ?? "2026-09-07", scope, plan: null })
  })
  await empty.review.initialize()
  expect(empty.state().missingPlan).toBe(true)
  expect(empty.state().plan).not.toBeNull()
  expect(empty.state().unavailable).toBe(false)
  expect(empty.transport.readRecordedWeek).toHaveBeenCalledTimes(1)
  expect(empty.transport.readWeek).not.toHaveBeenCalled()
  await empty.review.rescan()
  expect(empty.transport.readWeek).toHaveBeenCalledTimes(1)
})

// Transport cancellation is best effort. Even an adapter completing after abort cannot publish stale output.
it("lets only the newest read publish progress and a plan", async () => {
  const stale = gate<WeekPlanResponse>()
  const started = gate<void>()
  let publish: Parameters<WeekTransport["readWeek"]>[3] | undefined
  const { review, state } = setup({
    readWeek: async (_week, _scope, _signal, progress) => {
      publish = progress
      started.resolve(undefined)
      return stale.promise
    }
  })
  await review.initialize()
  const old = review.rescan()
  await started.promise
  await review.navigate("2026-09-14", "jira")
  publish?.({ stage: "sessions", message: "stale progress" })
  stale.resolve(fixtureWeek())
  await old
  expect(state().monday).toBe("2026-09-14")
  expect(state().scope).toBe("jira")
  expect(state().progress).toEqual([])
  expect(state().unavailable).toBe(false)
})

// Cancel keeps evidence visible but cannot authorize another write against unrefreshed totals.
it("keeps the last calendar read-only after cancellation", async () => {
  const next = gate<WeekPlanResponse>()
  const started = gate<void>()
  const fixture = setup()
  await fixture.review.initialize()
  fixture.transport.refreshRecordedTime.mockImplementationOnce(async () => {
    started.resolve(undefined)
    return next.promise
  })
  const read = fixture.review.refreshRecorded()
  await started.promise
  fixture.review.cancel()
  expect(fixture.state()).toMatchObject({ loading: false, cancelled: true, unavailable: true })
  expect(fixture.state().plan).toEqual(fixture.plan)
  next.resolve(fixtureWeek("2026-09-14"))
  await read
  expect(fixture.state().plan).toEqual(fixture.plan)
})

// A partial write must remain visible if totals refresh fails; retry refresh never repeats the mutation.
it("settles providers independently and retries only totals while retaining the saved side", async () => {
  const mutation = gate<WriteResultResponse>()
  const refresh = gate<WeekPlanResponse>()
  const refreshed = gate<void>()
  const fixture = setup()
  await fixture.review.initialize()
  fixture.transport.confirmRow.mockImplementationOnce(() => mutation.promise)
  fixture.transport.refreshRecordedTime.mockImplementationOnce(async () => {
    refreshed.resolve(undefined)
    return refresh.promise
  })
  const result = fixture.review.confirm({ rowId: "row-one", blocks: [1] })
  expect(fixture.state().optimisticEntries).toHaveLength(2)
  expect(fixture.state().optimisticEntries.every((entry) => entry.pending)).toBe(true)
  expect(await fixture.review.confirm({ rowId: "row-one", blocks: [1] })).toBe(false)
  mutation.resolve({ ...written, jira: { _tag: "Refused", message: "Jira unavailable" } })
  expect(await result).toBe(true)
  await refreshed.promise
  expect(fixture.state()).toMatchObject({ busy: false, loading: true, unavailable: true })
  expect(fixture.state().optimisticEntries).toMatchObject([{ source: "clockify", pending: false }])
  // Observe the actual failure transition rather than sleeping for the background refresh.
  const failed = gate<void>()
  const unsubscribe = fixture.registry.subscribe(fixture.review.state, (state) => {
    if (state.failure !== null) failed.resolve(undefined)
  })
  cleanups.push(unsubscribe)
  refresh.reject("Totals unavailable")
  await failed.promise
  expect(fixture.state().optimisticEntries).toHaveLength(1)
  await fixture.review.retry()
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(3)
  expect(fixture.state().optimisticEntries).toEqual([])
})

// A rejected create cannot leave either a saved or pending calendar entry behind.
it("rolls back failed writes and leaves the existing evidence intact", async () => {
  const mutation = gate<WriteResultResponse>()
  const fixture = setup()
  await fixture.review.initialize()
  fixture.transport.confirmRow.mockImplementationOnce(() => mutation.promise)
  const result = fixture.review.confirm({ rowId: "row-one", blocks: [0] })
  expect(fixture.state().optimisticEntries).toHaveLength(2)
  mutation.reject("Creation failed")
  expect(await result).toBe(false)
  expect(fixture.state().optimisticEntries).toEqual([])
  expect(fixture.state().actionFailure).toContain("Creation failed")
  expect(fixture.state().plan).toEqual(fixture.plan)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
})

// A stale editor payload cannot re-enable a provider that the person hid after opening it.
it.each(["jira", "clockify"] satisfies Array<"jira" | "clockify">)(
  "never posts approval or manual time to the hidden %s layer",
  async (hidden) => {
    const fixture = setup()
    await fixture.review.initialize()
    fixture.review.toggleLayer(hidden)
    expect(await fixture.review.confirm({ rowId: "row-one", blocks: [0], targets: { jira: true, clockify: true } }))
      .toBe(true)
    expect(fixture.transport.confirmRow).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: { jira: hidden !== "jira", clockify: hidden !== "clockify" }
    }))
    await fixture.review.refreshRecorded()
    expect(
      await fixture.review.logManual({
        day: fixture.plan.monday,
        ticketKey: "PROJ-123",
        seconds: 3600,
        targets: { jira: true, clockify: true }
      })
    ).toBe(true)
    expect(fixture.transport.logManual).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: { jira: hidden !== "jira", clockify: hidden !== "clockify" }
    }))
  }
)

// Hiding both providers cannot accidentally turn an omitted target object into a write to both.
it("refuses writes with neither provider layer selected", async () => {
  const fixture = setup()
  await fixture.review.initialize()
  fixture.review.toggleLayer("jira")
  fixture.review.toggleLayer("clockify")
  expect(fixture.state().unavailable).toBe(true)
  expect(await fixture.review.confirm({ rowId: "row-one" })).toBe(false)
  expect(await fixture.review.logManual({ day: fixture.plan.monday, ticketKey: "PROJ-123", seconds: 60 })).toBe(false)
  expect(fixture.transport.confirmRow).not.toHaveBeenCalled()
  expect(fixture.transport.logManual).not.toHaveBeenCalled()
})

/** Each grace period is an owned Effect fiber blocked on a test-controlled Deferred. */
const timer = () => {
  const waits: Array<{ readonly milliseconds: number; readonly release: () => void }> = []
  const cancelled: Array<number> = []
  const delay = (milliseconds: number) => {
    const deferred = Deferred.makeUnsafe<void>()
    const index = waits.length
    waits.push({ milliseconds, release: () => Deferred.doneUnsafe(deferred, Effect.void) })
    return Deferred.await(deferred).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelled.push(index))))
  }
  const release = (index: number) => {
    const wait = waits[index]
    if (wait === undefined) throw new RequestFailure({ status: 500, message: "Missing test timer" })
    wait.release()
  }
  return { waits, cancelled, delay, release }
}

const queuedId = (fixture: ReturnType<typeof setup>, index = 0) => {
  const item = fixture.state().queued[index]
  if (item === undefined) throw new RequestFailure({ status: 500, message: "Missing queued approval" })
  return item.id
}

const until = (
  fixture: ReturnType<typeof setup>,
  predicate: (state: ReturnType<typeof fixture.state>) => boolean
) => {
  if (predicate(fixture.state())) return Promise.resolve()
  const reached = gate<void>()
  const close = fixture.registry.subscribe(fixture.review.state, (state) => {
    if (predicate(state)) reached.resolve(undefined)
  })
  cleanups.push(close)
  return reached.promise
}

it("previews quick approval synchronously and Undo cancels its timer without a provider call", async () => {
  const clock = timer()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })).toBe(true)
  expect(fixture.state()).toMatchObject({ queueActive: true, queueUnavailable: false, unavailable: true, busy: false })
  expect(fixture.state().queued).toMatchObject([{
    ticketKey: "PROJ-123",
    day: fixture.plan.monday,
    status: "queued",
    undoUntil: 5000,
    startMs: new Date(`${fixture.plan.monday}T14:00:00`).getTime(),
    endMs: new Date(`${fixture.plan.monday}T15:00:00`).getTime()
  }])
  expect(fixture.state().optimisticEntries).toHaveLength(2)
  expect(fixture.state().optimisticEntries.every((entry) => entry.pending)).toBe(true)
  expect(clock.waits.map((wait) => wait.milliseconds)).toEqual([5000])
  expect(fixture.review.undoQueued(queuedId(fixture))).toBe(true)
  expect(fixture.state().optimisticEntries).toEqual([])
  expect(clock.cancelled).toEqual([0])
  clock.release(0)
  expect(fixture.transport.confirmRow).not.toHaveBeenCalled()
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  expect(fixture.state().queueActive).toBe(false)
})

it("serializes quick writes, accepts other blocks while saving, and refreshes totals once after drain", async () => {
  const clock = timer()
  const first = gate<WriteResultResponse>()
  const second = gate<WriteResultResponse>()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  fixture.transport.confirmRow.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })).toBe(true)
  const firstId = queuedId(fixture)
  const savingFirst = until(fixture, (state) => state.queued[0]?.status === "saving")
  clock.release(0)
  await savingFirst
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
  expect(fixture.review.undoQueued(firstId)).toBe(false)
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })).toBe(false)
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })).toBe(true)
  expect(fixture.state().optimisticEntries).toHaveLength(4)
  expect(new Set(fixture.state().optimisticEntries.map((entry) => entry.id)).size).toBe(4)
  expect(fixture.state()).toMatchObject({ busy: false, queueActive: true, queueUnavailable: false })
  clock.release(1)
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  const savingSecond = until(fixture, (state) => state.queued.length === 1 && state.queued[0]?.status === "saving")
  first.resolve(written)
  await savingSecond
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(2)
  expect(fixture.state().optimisticEntries.filter((entry) => !entry.pending)).toHaveLength(2)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  const drained = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
  second.resolve(written)
  await drained
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(2)
  expect(fixture.transport.readWeek).not.toHaveBeenCalled()
  expect(fixture.state().optimisticEntries).toEqual([])
})

it("keeps ready approvals undoable behind a saving write and locks replacement/manual actions", async () => {
  const clock = timer()
  const first = gate<WriteResultResponse>()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  fixture.transport.confirmRow.mockImplementationOnce(() => first.promise)
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })
  const secondId = queuedId(fixture, 1)
  const saving = until(fixture, (state) => state.queued[0]?.status === "saving")
  clock.release(0)
  clock.release(1)
  await saving
  await fixture.review.navigate("2026-09-14", "jira")
  await fixture.review.chooseScope("clockify")
  await fixture.review.refreshRecorded()
  await fixture.review.rescan()
  await fixture.review.retry()
  expect(await fixture.review.confirm({ rowId: "row-one", blocks: [1] })).toBe(false)
  expect(await fixture.review.logManual({ ticketKey: "PROJ-123", day: fixture.plan.monday, seconds: 60 })).toBe(false)
  expect(await fixture.review.markMine({ ticketKey: "PROJ-123" })).toBe(false)
  expect(fixture.state().plan).toEqual(fixture.plan)
  expect(fixture.transport.readSavedWeek).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  expect(fixture.transport.readWeek).not.toHaveBeenCalled()
  expect(fixture.transport.logManual).not.toHaveBeenCalled()
  expect(fixture.review.undoQueued(secondId)).toBe(true)
  const drained = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
  first.resolve(written)
  await drained
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
})

it.each(["jira", "clockify"] satisfies Array<"jira" | "clockify">)(
  "intersects captured targets with selected layers when %s becomes hidden during grace",
  async (hidden) => {
    const clock = timer()
    const fixture = setup({}, clock.delay)
    await fixture.review.initialize()
    fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
    fixture.review.toggleLayer(hidden)
    const drained = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
    clock.release(0)
    await drained
    expect(fixture.transport.confirmRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      targets: { jira: hidden !== "jira", clockify: hidden !== "clockify" }
    }))
  }
)

it("does not broaden captured targets and cancels a queue item when no captured provider remains selected", async () => {
  const clock = timer()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  fixture.review.toggleLayer("jira")
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.toggleLayer("jira")
  fixture.review.toggleLayer("clockify")
  const cancelled = until(fixture, (state) => !state.queueActive)
  clock.release(0)
  await cancelled
  expect(fixture.state().optimisticEntries).toEqual([])
  expect(fixture.transport.confirmRow).not.toHaveBeenCalled()
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
})

it("retains successful provider entries on partial failure, drops failed ones, and continues the queue", async () => {
  const clock = timer()
  const first = gate<WriteResultResponse>()
  const second = gate<WriteResultResponse>()
  const totals = gate<WeekPlanResponse>()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  fixture.transport.confirmRow.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  fixture.transport.refreshRecordedTime.mockImplementationOnce(() => totals.promise)
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })
  clock.release(0)
  clock.release(1)
  const savingSecond = until(fixture, (state) => state.queued.length === 1 && state.queued[0]?.status === "saving")
  first.resolve({ ...written, jira: { _tag: "Refused", message: "Jira denied" } })
  await savingSecond
  expect(fixture.state().optimisticEntries.filter((entry) => !entry.pending)).toMatchObject([{ source: "clockify" }])
  expect(fixture.state().actionFailure).toContain("Jira denied")
  const refreshing = until(fixture, (state) => state.loading)
  second.reject("Second create failed")
  await refreshing
  expect(fixture.state().optimisticEntries).toMatchObject([{ source: "clockify", pending: false, blocks: [0] }])
  expect(fixture.state().actionFailure).toContain("Second create failed")
  const failed = until(fixture, (state) => state.failure !== null)
  totals.reject("Totals unavailable")
  await failed
  expect(fixture.state().optimisticEntries).toHaveLength(1)
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(2)
  await fixture.review.retry()
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(2)
})

it("disposes unsent work while letting the dispatched write settle without retry or refresh", async () => {
  const clock = timer()
  const activeWrite = gate<WriteResultResponse>()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  fixture.transport.confirmRow.mockImplementationOnce(() => activeWrite.promise)
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })
  const saving = until(fixture, (state) => state.queued[0]?.status === "saving")
  clock.release(0)
  await saving
  fixture.review.dispose()
  expect(clock.cancelled).toContain(1)
  expect(fixture.state().queued).toHaveLength(1)
  expect(fixture.state().optimisticEntries).toHaveLength(2)
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })).toBe(false)
  const settled = until(fixture, (state) => !state.queueActive)
  activeWrite.resolve(written)
  await settled
  expect(fixture.state().optimisticEntries).toHaveLength(2)
  expect(fixture.state().optimisticEntries.every((entry) => !entry.pending)).toBe(true)
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
})

it("keeps a provider login failure visible after a later queued write succeeds", async () => {
  const clock = timer()
  const second = gate<WriteResultResponse>()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  fixture.transport.confirmRow
    .mockResolvedValueOnce({ ...written, jira: { _tag: "NotLoggedIn" } })
    .mockImplementationOnce(() => second.promise)
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })
  const loginFailed = until(fixture, (state) => state.actionFailure?.includes("Jira is not logged in") === true)
  clock.release(0)
  await loginFailed
  expect(fixture.state().optimisticEntries.filter((entry) => !entry.pending)).toMatchObject([{ source: "clockify" }])
  const saving = until(fixture, (state) => state.queued[0]?.status === "saving")
  clock.release(1)
  await saving
  const drained = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
  second.resolve(written)
  await drained
  expect(fixture.state().written).toEqual(written)
  expect(fixture.state().actionFailure).toContain("Jira is not logged in")
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(2)
})

it("reserves a saving block even when layer changes remove all its previews", async () => {
  const clock = timer()
  const create = gate<WriteResultResponse>()
  const original = fixtureWeek()
  const plan = { ...original, rows: original.rows.map((row) => ({ ...row, clockifySeconds: 7200 })) }
  const fixture = setup({ refreshRecordedTime: async () => plan, confirmRow: () => create.promise }, clock.delay)
  await fixture.review.initialize()
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })).toBe(true)
  expect(fixture.state().optimisticEntries).toMatchObject([{ source: "jira" }])
  fixture.review.toggleLayer("jira")
  const saving = until(fixture, (state) => state.queued[0]?.status === "saving")
  clock.release(0)
  await saving
  expect(fixture.state().optimisticEntries).toEqual([])
  fixture.review.toggleLayer("jira")
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })).toBe(false)
  const drained = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
  create.resolve({ ...written, jira: { _tag: "Skipped" }, clockify: { _tag: "NothingOwed" } })
  await drained
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
})

// React effect replay reuses the memoized controller; disposal is one mount's cleanup, not its end.
it("reinitializes the current week and scope without reviving cancelled approvals", async () => {
  const clock = timer()
  const fixture = setup({}, clock.delay)
  await fixture.review.initialize()
  expect(fixture.transport.readSavedWeek).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  await fixture.review.navigate("2026-09-14", "jira")
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.dispose()
  expect(clock.cancelled).toEqual([0])
  await fixture.review.initialize()
  expect(fixture.state()).toMatchObject({ monday: "2026-09-14", scope: "jira", fresh: true, unavailable: false })
  expect(fixture.transport.readSavedWeek).toHaveBeenCalledTimes(3)
  expect(fixture.transport.readSavedWeek).toHaveBeenLastCalledWith("2026-09-14", "jira", expect.any(AbortSignal))
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(3)
  expect(fixture.state().queued).toEqual([])
  expect(fixture.state().optimisticEntries).toEqual([])
  clock.release(0)
  expect(fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })).toBe(true)
  const drained = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
  clock.release(1)
  await drained
  expect(fixture.transport.confirmRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    planId: "plan-2026-09-14-jira",
    targets: { jira: true, clockify: false }
  }))
  expect(fixture.transport.readWeek).not.toHaveBeenCalled()
})

// Cleanup cannot revoke a sent create. Its one settlement refresh unlocks the replayed mount.
it("remounts during a dispatched approval without replacing it or sending cancelled work", async () => {
  const clock = timer()
  const create = gate<WriteResultResponse>()
  const fixture = setup({ confirmRow: () => create.promise }, clock.delay)
  await fixture.review.initialize()
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [0] })
  fixture.review.queueConfirm({ rowId: "row-one", blocks: [1] })
  const saving = until(fixture, (state) => state.queued[0]?.status === "saving")
  clock.release(0)
  await saving
  fixture.review.dispose()
  await fixture.review.initialize()
  expect(fixture.state()).toMatchObject({ queueActive: true, fresh: false, unavailable: true })
  expect(fixture.transport.readSavedWeek).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(1)
  expect(clock.cancelled).toContain(1)
  clock.release(1)
  const operational = until(fixture, (state) => !state.queueActive && !state.loading && state.fresh)
  create.resolve(written)
  await operational
  expect(fixture.state().unavailable).toBe(false)
  expect(fixture.transport.confirmRow).toHaveBeenCalledTimes(1)
  expect(fixture.transport.refreshRecordedTime).toHaveBeenCalledTimes(2)
  expect(fixture.state().queued).toEqual([])
})
