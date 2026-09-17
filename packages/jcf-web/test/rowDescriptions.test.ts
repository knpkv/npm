import { Deferred, Effect } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { afterEach, expect, it, vi } from "vitest"
import { type describeRow, RequestFailure } from "../src/client/api.js"
import { makeRowDescriptions } from "../src/client/rowDescriptions.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

const setup = () => {
  const registry = AtomRegistry.make()
  cleanups.push(() => registry.dispose())
  const reply = Deferred.makeUnsafe<Awaited<ReturnType<typeof describeRow>>, RequestFailure>()
  const describe = vi.fn<typeof describeRow>(() => Effect.runPromise(Deferred.await(reply)))
  const drafts = makeRowDescriptions(registry, describe)
  cleanups.push(drafts.dispose)
  return {
    registry,
    describe,
    drafts,
    reply: (note: string | null, rowId = "row") =>
      Deferred.doneUnsafe(reply, Effect.succeed({ planId: "plan", rowId, note })),
    fail: () => Deferred.doneUnsafe(reply, Effect.fail(new RequestFailure({ status: 503, message: "Unavailable" })))
  }
}

// Reopening another block of the same row must reuse the pending request and its resulting note.
it("coalesces a row draft across blocks and keeps it through totals refresh", async () => {
  const { describe, drafts, registry, reply } = setup()
  const draft = drafts.get("plan", "row")
  const loading = draft.load()
  expect(registry.get(draft.state).status).toBe("loading")
  drafts.retain("plan")
  expect(drafts.get("plan", "row")).toBe(draft)
  await draft.load()
  expect(describe).toHaveBeenCalledTimes(1)
  reply("Reviewed approval behavior")
  await loading
  await draft.load()
  expect(describe).toHaveBeenCalledTimes(1)
  expect(registry.get(draft.state)).toMatchObject({ text: "Reviewed approval behavior", status: "ready" })
})

// An empty field can be a deliberate edit; a late agent response must respect that too.
for (const text of ["My own description", ""]) {
  it(`preserves the edited draft ${JSON.stringify(text)} over a pending suggestion`, async () => {
    const { drafts, registry, reply } = setup()
    const draft = drafts.get("plan", "row")
    const loading = draft.load()
    draft.edit(text)
    reply("Agent text")
    await loading
    drafts.invalidate()
    expect(registry.get(draft.state)).toMatchObject({ text, edited: true, status: "ready" })
  })
}

// Identity checks guard transports and settings invalidation guards already-started work.
it("rejects a reply for another row", async () => {
  const { drafts, registry, reply } = setup()
  const draft = drafts.get("plan", "row")
  const loading = draft.load()
  reply("Another row's text", "other")
  await loading
  expect(registry.get(draft.state)).toMatchObject({ text: "", status: "failed" })
})

it("discards old settings responses and allows a new request after disposal and replay", async () => {
  const { describe, drafts, registry, reply } = setup()
  const draft = drafts.get("plan", "row")
  const loading = draft.load()
  drafts.invalidate()
  expect(describe.mock.calls[0]?.[1].aborted).toBe(true)
  reply("Old settings")
  await loading
  expect(registry.get(draft.state)).toMatchObject({ text: "", status: "idle" })
  describe.mockImplementation(async (request) => ({ ...request, note: "Current settings" }))
  drafts.dispose()
  await draft.load()
  expect(registry.get(draft.state)).toMatchObject({ text: "Current settings", status: "ready" })
  drafts.retain("new-plan")
  expect(drafts.get("plan", "row")).not.toBe(draft)
})

// Null is an explicit unavailable suggestion. Transport failures remain retryable.
it("exposes null and retries a failed request without losing the editable field", async () => {
  const { describe, drafts, fail, registry } = setup()
  const draft = drafts.get("plan", "row")
  const loading = draft.load()
  fail()
  await loading
  expect(registry.get(draft.state).status).toBe("failed")
  describe.mockImplementation(async (request) => ({ ...request, note: null }))
  await draft.load()
  expect(registry.get(draft.state)).toMatchObject({ text: "", status: "empty", failure: null })
})
