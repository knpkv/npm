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

const terminateWorker = vi.fn()
const unsubscribeFromStats = vi.fn()
const observeWorkerFailure = vi.fn()
let emitFailure: (() => void) | undefined
let emitFailureSynchronously = false

class FakeWorker extends EventTarget {
  static latestUrl: string | URL | undefined
  static instances: Array<FakeWorker> = []

  onerror = null
  onmessage = null
  onmessageerror = null
  terminated = false

  constructor(url: string | URL) {
    super()
    FakeWorker.latestUrl = url
    FakeWorker.instances.push(this)
  }

  postMessage(): void {}
  terminate(): void {
    this.terminated = true
    terminateWorker()
  }
}

const WorkerStateProbe = (): ReactElement => {
  const state = useDiffWorkerState()
  return <output data-worker-state={state.status}>{state.status}</output>
}

afterEach(() => {
  document.body.replaceChildren()
  terminateWorker.mockClear()
  unsubscribeFromStats.mockClear()
  observeWorkerFailure.mockReset()
  observeWorkerFailure.mockImplementation((onFailure) => {
    emitFailure = onFailure
    if (emitFailureSynchronously) onFailure()
    return unsubscribeFromStats
  })
  emitFailure = undefined
  emitFailureSynchronously = false
  FakeWorker.latestUrl = undefined
  FakeWorker.instances = []
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
        <DiffWorkerProvider observeWorkerFailure={observeWorkerFailure} workerFactory={factory}>
          <WorkerStateProbe />
        </DiffWorkerProvider>
      )
    )
    expect(host.querySelector("[data-worker-state='worker']")).not.toBeNull()
    if (emitFailure === undefined) throw new Error("Worker failure observer was not installed")
    await act(async () => emitFailure?.())
    expect(host.querySelector("[data-worker-state='fallback']")).not.toBeNull()
    expect(FakeWorker.instances.every(({ terminated }) => terminated)).toBe(true)
    await act(async () => root.unmount())
    expect(FakeWorker.instances.every(({ terminated }) => terminated)).toBe(true)
  })

  it("does not expose a manager after synchronous worker construction fails", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    vi.stubGlobal("Worker", FakeWorker)
    emitFailureSynchronously = true
    const factory = createDiffWorkerFactory({ workerUrl: "/diff-worker.js" })
    await act(async () =>
      root.render(
        <DiffWorkerProvider observeWorkerFailure={observeWorkerFailure} workerFactory={factory}>
          <WorkerStateProbe />
        </DiffWorkerProvider>
      )
    )

    expect(host.querySelector("[data-worker-state='fallback']")).not.toBeNull()
    expect(unsubscribeFromStats).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
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
          <DiffWorkerProvider observeWorkerFailure={observeWorkerFailure} workerFactory={factory}>
            <WorkerStateProbe />
          </DiffWorkerProvider>
        </StrictMode>
      )
    )
    await act(async () => root.unmount())
    expect(FakeWorker.instances.length).toBeGreaterThan(0)
    expect(FakeWorker.instances.every(({ terminated }) => terminated)).toBe(true)
    expect(unsubscribeFromStats).toHaveBeenCalledTimes(observeWorkerFailure.mock.calls.length)
  })
})
