import { describe, expect, it, vi } from "vitest"

import { makeOverviewRefresh } from "../../src/client/services/overviewRefresh.js"

const pendingRead = () => {
  let resolve: (value: number) => void = () => undefined
  const promise = new Promise<number>((complete) => {
    resolve = complete
  })
  return { promise, resolve: (value: number) => resolve(value) }
}

describe("overview refresh pump", () => {
  it("retains one in-flight read and one follow-up for an invalidation burst", async () => {
    const first = pendingRead()
    const second = pendingRead()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const success = vi.fn()
    const pump = makeOverviewRefresh({ load, onStarted: vi.fn(), onSuccess: success, onFailure: vi.fn() })
    pump.refresh()
    for (let index = 0; index < 10; index++) pump.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    first.resolve(1)
    await first.promise
    expect(load).toHaveBeenCalledTimes(2)
    second.resolve(2)
    await second.promise
    expect(load).toHaveBeenCalledTimes(2)
    expect(success.mock.calls).toEqual([[1], [2]])
    pump.dispose()
  })

  it("disposal aborts the active request and discards its queued refresh and late result", async () => {
    const first = pendingRead()
    const signals: Array<AbortSignal> = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return first.promise
    })
    const success = vi.fn()
    const pump = makeOverviewRefresh({ load, onStarted: vi.fn(), onSuccess: success, onFailure: vi.fn() })
    pump.refresh()
    pump.refresh()
    pump.dispose()
    expect(signals[0]?.aborted).toBe(true)
    first.resolve(1)
    await first.promise
    pump.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    expect(success).not.toHaveBeenCalled()
  })
})

it("preserves a rejected cause so its owner can cancel a queued refresh", async () => {
  let reject: (cause: { readonly _tag: "UnauthorizedApiError" }) => void = () => undefined
  const rejection = new Promise<number>((_resolve, fail) => {
    reject = fail
  })
  const unauthorized = { _tag: "UnauthorizedApiError" } satisfies { readonly _tag: "UnauthorizedApiError" }
  const load = vi.fn().mockReturnValue(rejection)
  const onFailure = vi.fn(() => pump.dispose())
  const pump = makeOverviewRefresh({ load, onStarted: vi.fn(), onSuccess: vi.fn(), onFailure })
  pump.refresh()
  pump.refresh()
  reject(unauthorized)
  await rejection.catch(() => undefined)
  expect(onFailure).toHaveBeenCalledWith(unauthorized)
  expect(load).toHaveBeenCalledTimes(1)
})
