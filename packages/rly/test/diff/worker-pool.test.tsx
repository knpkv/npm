// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createDiffWorkerFactory,
  DiffWorkerProvider,
  normalizeDiffWorkerPoolSize,
  useDiffWorkerState
} from "../../src/diff/worker-pool.js"

const terminatePool = vi.fn()
const constructPool = vi.fn()
const unsubscribeFromStats = vi.fn()
const terminateWorker = vi.fn()
let emitStats: ((stats: { readonly workersFailed: boolean }) => void) | undefined

vi.mock("@pierre/diffs/worker", () => ({
  WorkerPoolManager: class {
    constructor() {
      constructPool()
    }

    subscribeToStatChanges(callback: (stats: { readonly workersFailed: boolean }) => void): () => void {
      emitStats = callback
      return unsubscribeFromStats
    }

    terminate(): void {
      terminatePool()
    }
  }
}))

class FakeWorker extends EventTarget {
  static latestUrl: string | URL | undefined

  onerror = null
  onmessage = null
  onmessageerror = null

  constructor(url: string | URL) {
    super()
    FakeWorker.latestUrl = url
  }

  postMessage(): void {}
  terminate(): void {
    terminateWorker()
  }
}

const WorkerStateProbe = (): ReactElement => {
  const state = useDiffWorkerState()
  return <output data-worker-state={state.status}>{state.status}</output>
}

afterEach(() => {
  document.body.replaceChildren()
  terminatePool.mockClear()
  constructPool.mockClear()
  unsubscribeFromStats.mockClear()
  terminateWorker.mockClear()
  emitStats = undefined
  FakeWorker.latestUrl = undefined
  vi.unstubAllGlobals()
})

describe("diff worker boundary", () => {
  it("accepts only a bounded one-to-four worker pool", () => {
    expect(normalizeDiffWorkerPoolSize()).toBe(2)
    expect(normalizeDiffWorkerPoolSize(1)).toBe(1)
    expect(normalizeDiffWorkerPoolSize(4)).toBe(4)
    for (const invalid of [0, 1.5, 5]) {
      expect(() => normalizeDiffWorkerPoolSize(invalid)).toThrow("1 through 4")
    }
  })

  it("owns the built-in module worker URL while allowing an explicit override", () => {
    vi.stubGlobal("Worker", FakeWorker)
    expect(createDiffWorkerFactory()()).toBeInstanceOf(FakeWorker)
    expect(String(FakeWorker.latestUrl)).toContain("worker")

    const factory = createDiffWorkerFactory({ name: "release-diff", workerUrl: "/diff-worker.js" })
    expect(factory()).toBeInstanceOf(FakeWorker)
    expect(FakeWorker.latestUrl).toBe("/diff-worker.js")
  })

  it("falls back after an asynchronous worker failure and cleans up its subscription and manager", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const factory = createDiffWorkerFactory({ workerUrl: "/diff-worker.js" })
    await act(async () =>
      root.render(
        <DiffWorkerProvider workerFactory={factory}>
          <WorkerStateProbe />
        </DiffWorkerProvider>
      )
    )
    expect(host.querySelector("[data-worker-state='worker']")).not.toBeNull()
    if (emitStats === undefined) throw new Error("Worker stat subscription was not installed")
    await act(async () => emitStats?.({ workersFailed: true }))
    expect(host.querySelector("[data-worker-state='fallback']")).not.toBeNull()
    expect(unsubscribeFromStats).toHaveBeenCalledOnce()
    expect(terminatePool).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    expect(unsubscribeFromStats).toHaveBeenCalledOnce()
    expect(terminatePool).toHaveBeenCalledOnce()
  })

  it("balances every StrictMode probe and manager with deterministic cleanup", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const factory = createDiffWorkerFactory({ workerUrl: "/diff-worker.js" })
    await act(async () =>
      root.render(
        <StrictMode>
          <DiffWorkerProvider workerFactory={factory}>
            <WorkerStateProbe />
          </DiffWorkerProvider>
        </StrictMode>
      )
    )
    await act(async () => root.unmount())
    expect(constructPool.mock.calls.length).toBeGreaterThan(0)
    expect(terminatePool).toHaveBeenCalledTimes(constructPool.mock.calls.length)
    expect(terminateWorker).toHaveBeenCalledTimes(constructPool.mock.calls.length)
    expect(unsubscribeFromStats).toHaveBeenCalledTimes(constructPool.mock.calls.length)
  })
})
