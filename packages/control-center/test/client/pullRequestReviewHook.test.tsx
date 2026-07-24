// @vitest-environment happy-dom

import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PullRequestReviewNotStarted } from "../../src/api/agent.js"
import type { PullRequestReviewState } from "../../src/api/agent.js"
import {
  type PullRequestReviewTransport,
  usePullRequestReview
} from "../../src/client/entities/usePullRequestReview.js"
import { EntityId } from "../../src/domain/identifiers.js"
import { PrReviewSubject } from "../../src/domain/prReview.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const ENTITY_ID = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000601")
const HEAD_A = "a".repeat(40)
const HEAD_B = "b".repeat(40)

const reviewFor = (headRevision: string): PullRequestReviewState =>
  new PullRequestReviewNotStarted({
    subject: PrReviewSubject.make({
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision: "0".repeat(40),
      headRevision
    })
  })

const deferred = <Value,>() => {
  let resolveValue: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve
  })
  return {
    promise,
    resolve: (value: Value): void => {
      if (resolveValue === undefined) throw new Error("Deferred resolution unavailable")
      resolveValue(value)
    }
  }
}

let mountedRoot: Root | undefined
const ignoreSessionExpired = (): void => undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const Harness = ({
  headRevision,
  transport
}: {
  readonly headRevision: string
  readonly transport: PullRequestReviewTransport
}): ReactElement => {
  const controller = usePullRequestReview(ENTITY_ID, headRevision, "session-a", false, ignoreSessionExpired, transport)
  return (
    <span>
      {controller.state._tag === "ready"
        ? `${controller.state.review._tag}:${controller.state.subjectRevision}`
        : controller.state._tag}
    </span>
  )
}

describe("usePullRequestReview", () => {
  it("never presents a prior immutable head while the refreshed head loads", async () => {
    const requestA = deferred<PullRequestReviewState>()
    const requestB = deferred<PullRequestReviewState>()
    const requests = [requestA.promise, requestB.promise]
    const transport = {
      enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
      load: vi.fn(() => requests.shift() ?? Promise.reject(new Error("Unexpected review read"))),
      providers: () => Promise.reject(new Error("Unexpected provider read"))
    } satisfies PullRequestReviewTransport
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_A} transport={transport} />))
    await act(async () => requestA.resolve(reviewFor(HEAD_A)))
    expect(host.textContent).toBe(`not-started:${HEAD_A}`)

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_A} transport={transport} />))
    expect(host.textContent).toBe(`not-started:${HEAD_A}`)
    expect(transport.load).toHaveBeenCalledOnce()

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_B} transport={transport} />))
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(reviewFor(HEAD_B)))
    expect(host.textContent).toBe(`not-started:${HEAD_B}`)
    expect(transport.load).toHaveBeenCalledTimes(2)
  })
})
