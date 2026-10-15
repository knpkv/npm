// @vitest-environment happy-dom
import { expect, it, vi } from "@effect/vitest"

import { Effect, Schema } from "effect"
import { act, createElement } from "react"
import { type CodeReviewReadOptions, useCodeReviewReading } from "../src/client/hooks/use-code-review-reading.js"
import type { CodeReference, CodeReviewResult } from "../src/host-contract.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const a: CodeReference = "00000000-0000-4000-8000-000000000001"
const b: CodeReference = "00000000-0000-4000-8000-000000000002"
const value: CodeReviewResult = { _tag: "Unavailable", reason: "permission_required", host: null }
const other: CodeReviewResult = { _tag: "Unavailable", reason: "other_host", host: "fixture-host" }
class ReadTestFailure extends Schema.TaggedError<ReadTestFailure>()("ReadTestFailure", {
  reason: Schema.Literals(["not_found", "unauthorized", "network", "status", "invalid_response", "timeout"])
}) {}
const Harness = (props: CodeReviewReadOptions) => {
  const { readAgain, state } = useCodeReviewReading(props)
  return createElement(
    "div",
    null,
    createElement("output", { "data-state": state._tag }, JSON.stringify(state)),
    createElement("button", { onClick: readAgain }, "Read again")
  )
}
const reading = (host: HTMLElement) => host.querySelector("output")?.textContent
const tag = (host: HTMLElement) => host.querySelector("output")?.getAttribute("data-state")

it("reads only when enabled/selected, retains a failed same-ref reading and has no extra read on unrelated renders", async () => {
  let reads = 0
  const read: CodeReviewReadOptions["read"] = () =>
    Effect.suspend(() => {
      reads += 1
      return reads === 1 ? Effect.succeed(value) : Effect.fail(new ReadTestFailure({ reason: "network" }))
    })
  const fixture = await mountFixture(createElement(Harness, { ref: null, enabled: true, read }))
  expect(reads).toBe(0)
  await fixture.render(createElement(Harness, { ref: a, enabled: false, read }))
  expect(reads).toBe(0)
  await fixture.render(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(tag(fixture.host)).toBe("Ready"))
  await fixture.render(createElement(Harness, { ref: a, enabled: true, read }))
  expect(reads).toBe(1)
  await click(fixture.host, "Read again")
  await vi.waitFor(() =>
    expect(reading(fixture.host)).toBe(JSON.stringify({
      _tag: "Retained",
      ref: a,
      value,
      failure: { _tag: "Expected", reason: "network" }
    }))
  )
  expect(reads).toBe(2)
})

it("interrupts an inactive held read, ignores repeated retry, and re-reads once on activation", async () => {
  let reads = 0
  let interrupted = 0
  const read: CodeReviewReadOptions["read"] = () =>
    Effect.sync(() => {
      reads += 1
    }).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted += 1
        })
      )
    )
  const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(reads).toBe(1))
  await click(fixture.host, "Read again")
  await click(fixture.host, "Read again")
  expect(reads).toBe(1)
  await fixture.render(createElement(Harness, { ref: a, enabled: false, read }))
  await vi.waitFor(() => expect(interrupted).toBe(1))
  expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Paused", ref: a, previous: null }))
  await click(fixture.host, "Read again")
  expect(reads).toBe(1)
  await fixture.render(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(reads).toBe(2))
  await fixture.unmount()
  await vi.waitFor(() => expect(interrupted).toBe(2))
})

it("drops another ref's value immediately and rejects a late old-ref response", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  const returned = Promise.withResolvers<void>()
  const read: CodeReviewReadOptions["read"] = (ref) =>
    ref === a ?
      Effect.promise(() => held.promise).pipe(
        Effect.tap(() => Effect.sync(() => returned.resolve())),
        Effect.uninterruptible
      ) :
      Effect.succeed(other)
  const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
  await fixture.render(createElement(Harness, { ref: b, enabled: true, read }))
  await vi.waitFor(() => expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Ready", ref: b, value: other })))
  await act(async () => {
    held.resolve(value)
    await returned.promise
  })
  await vi.waitFor(() => expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Ready", ref: b, value: other })))
})

it("does not retain protected output after authorization loss or a missing target", async () => {
  for (const reason of ["unauthorized", "not_found"] satisfies ReadonlyArray<"unauthorized" | "not_found">) {
    let reads = 0
    const read: CodeReviewReadOptions["read"] = () =>
      Effect.suspend(() => {
        reads += 1
        return reads === 1 ? Effect.succeed(value) : Effect.fail(new ReadTestFailure({ reason }))
      })
    const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
    await vi.waitFor(() => expect(tag(fixture.host)).toBe("Ready"))
    await click(fixture.host, "Read again")
    await vi.waitFor(() =>
      expect(reading(fixture.host)).toBe(
        JSON.stringify({ _tag: "Failed", ref: a, failure: { _tag: "Expected", reason } })
      )
    )
    await fixture.unmount()
  }
})

it("never shows a ready ref A reading while the new ref B response is held", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  const read: CodeReviewReadOptions["read"] = (ref) =>
    ref === a
      ? Effect.succeed(value)
      : Effect.promise(() => held.promise)
  const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(tag(fixture.host)).toBe("Ready"))
  await fixture.render(createElement(Harness, { ref: b, enabled: true, read }))
  expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Loading", ref: b, previous: null }))
  await act(async () => {
    held.resolve(other)
    await held.promise
  })
  await vi.waitFor(() => expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Ready", ref: b, value: other })))
})

it("rejects a late request from a previous activation of the same ref", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  const returned = Promise.withResolvers<void>()
  let reads = 0
  const read: CodeReviewReadOptions["read"] = () =>
    Effect.suspend(() => {
      reads += 1
      return reads === 1
        ? Effect.promise(() => held.promise).pipe(
          Effect.tap(() => Effect.sync(() => returned.resolve())),
          Effect.uninterruptible
        )
        : Effect.succeed(other)
    })
  const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(reads).toBe(1))
  await fixture.render(createElement(Harness, { ref: a, enabled: false, read }))
  await fixture.render(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Ready", ref: a, value: other })))
  await act(async () => {
    held.resolve(value)
    await returned.promise
  })
  expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Ready", ref: a, value: other }))
  expect(reads).toBe(2)
})

it("reactivates with an explicitly previous reading and one fresh request", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  let reads = 0
  const read: CodeReviewReadOptions["read"] = () =>
    Effect.suspend(() => {
      reads += 1
      return reads === 1 ? Effect.succeed(value) : Effect.promise(() => held.promise)
    })
  const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() => expect(tag(fixture.host)).toBe("Ready"))
  await fixture.render(createElement(Harness, { ref: a, enabled: false, read }))
  expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Paused", ref: a, previous: value }))
  await fixture.render(createElement(Harness, { ref: a, enabled: true, read }))
  expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Loading", ref: a, previous: value }))
  expect(reads).toBe(2)
  await act(async () => {
    held.resolve(other)
    await held.promise
  })
  await vi.waitFor(() => expect(tag(fixture.host)).toBe("Ready"))
})

it("keeps unexpected failures closed and never emits the defect text", async () => {
  const read: CodeReviewReadOptions["read"] = () => Effect.die("private transport detail")
  const fixture = await mountFixture(createElement(Harness, { ref: a, enabled: true, read }))
  await vi.waitFor(() =>
    expect(reading(fixture.host)).toBe(JSON.stringify({
      _tag: "Failed",
      ref: a,
      failure: { _tag: "Unexpected" }
    }))
  )
  expect(fixture.host.textContent).not.toContain("private transport detail")
})

it("uses fresh inline read callbacks without restarting a held request or a ready reading", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  let reads = 0
  const request = () =>
    Effect.sync(() => {
      reads += 1
    }).pipe(Effect.andThen(Effect.promise(() => held.promise)))
  const fixture = await mountFixture(createElement(Harness, {
    ref: a,
    enabled: true,
    read: () => request()
  }))
  await vi.waitFor(() => expect(reads).toBe(1))
  for (let render = 0; render < 3; render += 1) {
    await fixture.render(createElement(Harness, { ref: a, enabled: true, read: () => request() }))
    expect(reads).toBe(1)
    expect(tag(fixture.host)).toBe("Loading")
  }
  await act(async () => {
    held.resolve(value)
    await held.promise
  })
  await vi.waitFor(() => expect(tag(fixture.host)).toBe("Ready"))
  await fixture.render(createElement(Harness, { ref: a, enabled: true, read: () => request() }))
  expect(tag(fixture.host)).toBe("Ready")
  expect(reads).toBe(1)
  await fixture.render(createElement(Harness, {
    ref: a,
    enabled: true,
    read: () =>
      Effect.sync(() => {
        reads += 1
        return other
      })
  }))
  expect(reads).toBe(1)
  await click(fixture.host, "Read again")
  await vi.waitFor(() => expect(reading(fixture.host)).toBe(JSON.stringify({ _tag: "Ready", ref: a, value: other })))
  expect(reads).toBe(2)
})

it("exposes only accepted current-ref completions, keeping parent rerenders and stale/aborted requests out of the signal", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  const returned = Promise.withResolvers<void>()
  const read: CodeReviewReadOptions["read"] = (ref) =>
    ref === a ?
      Effect.promise(() => held.promise).pipe(
        Effect.tap(() => Effect.sync(() => returned.resolve())),
        Effect.uninterruptible
      ) :
      Effect.succeed(other)
  const CompletionHarness = (props: CodeReviewReadOptions) => {
    const { completion, state } = useCodeReviewReading(props)
    return createElement("output", { "data-state": state._tag }, JSON.stringify(completion))
  }
  const fixture = await mountFixture(createElement(CompletionHarness, { ref: a, enabled: true, read }))
  expect(fixture.host.textContent).toBe("null")
  await fixture.render(createElement(CompletionHarness, { ref: b, enabled: true, read }))
  await vi.waitFor(() => expect(fixture.host.textContent).toBe(JSON.stringify({ ref: b, id: 2 })))
  await act(async () => {
    held.resolve(value)
    await returned.promise
  })
  expect(fixture.host.textContent).toBe(JSON.stringify({ ref: b, id: 2 }))
  await fixture.render(createElement(CompletionHarness, { ref: b, enabled: true, read }))
  expect(fixture.host.textContent).toBe(JSON.stringify({ ref: b, id: 2 }))
  await fixture.render(createElement(CompletionHarness, { ref: b, enabled: false, read }))
  expect(fixture.host.textContent).toBe("null")
})
