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
const BASE_A = "0".repeat(40)
const BASE_B = "1".repeat(40)
const HEAD_A = "a".repeat(40)
const HEAD_B = "b".repeat(40)

const reviewFor = (baseRevision: string, headRevision: string): PullRequestReviewState =>
  new PullRequestReviewNotStarted({
    subject: PrReviewSubject.make({
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision,
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
  baseRevision = BASE_A,
  headRevision,
  transport
}: {
  readonly baseRevision?: string | null
  readonly headRevision: string
  readonly transport: PullRequestReviewTransport
}): ReactElement => {
  const controller = usePullRequestReview(
    ENTITY_ID,
    baseRevision,
    headRevision,
    "session-a",
    false,
    ignoreSessionExpired,
    transport
  )
  return (
    <span>
      {controller.state._tag === "ready"
        ? `${controller.state.review._tag}:${controller.state.baseRevision}:${controller.state.headRevision}`
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
    await act(async () => requestA.resolve(reviewFor(BASE_A, HEAD_A)))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_A}`)

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_A} transport={transport} />))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_A}`)
    expect(transport.load).toHaveBeenCalledOnce()

    await act(async () => mountedRoot?.render(<Harness headRevision={HEAD_B} transport={transport} />))
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(reviewFor(BASE_A, HEAD_B)))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_B}`)
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it("drops prior review state when the base changes under the same head", async () => {
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

    await act(async () =>
      mountedRoot?.render(<Harness baseRevision={BASE_A} headRevision={HEAD_A} transport={transport} />)
    )
    await act(async () => requestA.resolve(reviewFor(BASE_A, HEAD_A)))
    expect(host.textContent).toBe(`not-started:${BASE_A}:${HEAD_A}`)

    await act(async () =>
      mountedRoot?.render(<Harness baseRevision={BASE_B} headRevision={HEAD_A} transport={transport} />)
    )
    expect(host.textContent).toBe("loading")

    await act(async () => requestB.resolve(reviewFor(BASE_B, HEAD_A)))
    expect(host.textContent).toBe(`not-started:${BASE_B}:${HEAD_A}`)
    expect(transport.load).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      label: "base",
      requestedBase: BASE_B,
      requestedHead: HEAD_A,
      responseBase: BASE_A,
      responseHead: HEAD_A
    },
    {
      label: "head",
      requestedBase: BASE_A,
      requestedHead: HEAD_B,
      responseBase: BASE_A,
      responseHead: HEAD_A
    }
  ])(
    "rejects a response for a mismatched immutable $label revision",
    async ({ requestedBase, requestedHead, responseBase, responseHead }) => {
      const transport = {
        enqueue: () => Promise.reject(new Error("Unexpected review enqueue")),
        load: vi.fn(() => Promise.resolve(reviewFor(responseBase, responseHead))),
        providers: () => Promise.reject(new Error("Unexpected provider read"))
      } satisfies PullRequestReviewTransport
      const host = document.createElement("div")
      document.body.append(host)
      mountedRoot = createRoot(host)

      await act(async () =>
        mountedRoot?.render(<Harness baseRevision={requestedBase} headRevision={requestedHead} transport={transport} />)
      )
      expect(host.textContent).toBe("failed")
    }
  )
})
