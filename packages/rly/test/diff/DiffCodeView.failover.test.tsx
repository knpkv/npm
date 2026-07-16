// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type * as PierreReact from "@pierre/diffs/react"
import { DiffCodeView } from "../../src/diff/DiffCodeView.js"
import type { RlyDiffCodeItem, RlyDiffCodeViewHandle } from "../../src/diff/types.js"
import { createDiffWorkerFactory, DiffWorkerProvider } from "../../src/diff/worker-pool.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface RendererItemSnapshot {
  readonly annotations?: ReadonlyArray<unknown>
  readonly fileDiff?: unknown
  readonly id: string
  readonly version?: number
}

const rendererMounts = vi.hoisted((): Array<ReadonlyArray<RendererItemSnapshot>> => [])
const workerStats = vi.hoisted(
  (): {
    emit: ((stats: { readonly workersFailed: boolean }) => void) | undefined
  } => ({ emit: undefined })
)

vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreReact>()
  const React = await import("react")
  return {
    ...actual,
    CodeView: React.forwardRef(function CodeViewProbe(
      { initialItems }: { readonly initialItems: ReadonlyArray<RendererItemSnapshot> },
      ref
    ) {
      const [mountedItems] = React.useState(() => {
        rendererMounts.push(initialItems)
        return initialItems
      })
      React.useImperativeHandle(ref, () => ({
        addItems: () => undefined,
        cleanUp: () => undefined,
        getItem: () => undefined,
        scrollTo: () => undefined,
        setOptions: () => undefined,
        updateItem: () => true
      }))
      return <output data-renderer-items={JSON.stringify(mountedItems)} />
    })
  }
})

vi.mock("@pierre/diffs/worker", () => ({
  WorkerPoolManager: class {
    subscribeToStatChanges(callback: (stats: { readonly workersFailed: boolean }) => void): () => void {
      workerStats.emit = callback
      return () => undefined
    }

    terminate(): void {}
  }
}))

class FakeWorker extends EventTarget {
  onerror = null
  onmessage = null
  onmessageerror = null

  postMessage(): void {}
  terminate(): void {}
}

const initialItem = {
  after: { contents: "export const ready = true\n", name: "src/release.ts" },
  before: { contents: "export const ready = false\n", name: "src/release.ts" },
  id: "release"
} satisfies RlyDiffCodeItem

afterEach(() => {
  document.body.replaceChildren()
  rendererMounts.length = 0
  workerStats.emit = undefined
  vi.unstubAllGlobals()
})

describe("DiffCodeView worker failover", () => {
  it("rehydrates imperative items, versions, and current annotations on the fallback renderer", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const rendererRef = createRef<RlyDiffCodeViewHandle>()
    vi.stubGlobal("Worker", FakeWorker)
    const workerFactory = createDiffWorkerFactory({ workerUrl: "/diff-worker.js" })
    const renderView = (message: string) => (
      <DiffWorkerProvider workerFactory={workerFactory}>
        <DiffCodeView
          ref={rendererRef}
          annotations={[{ id: "finding", itemId: "release", lineNumber: 1, message, side: "additions" }]}
          initialItems={[initialItem]}
        />
      </DiffWorkerProvider>
    )

    await act(async () => root.render(renderView("Initial finding")))
    const appended = {
      after: { contents: "export const audit = true\n", name: "src/audit.ts" },
      before: { contents: "", name: "src/audit.ts" },
      id: "audit"
    } satisfies RlyDiffCodeItem
    await act(async () => {
      rendererRef.current?.addItems([appended])
      rendererRef.current?.updateItem({
        ...initialItem,
        after: { contents: 'export const ready = "verified"\n', name: "src/release.ts" }
      })
      root.render(renderView("Current finding"))
    })

    if (workerStats.emit === undefined) throw new Error("Worker stat subscription was not installed")
    await act(async () => workerStats.emit?.({ workersFailed: true }))

    expect(rendererMounts.length).toBeGreaterThanOrEqual(2)
    const fallbackMount = rendererMounts[rendererMounts.length - 1]
    if (fallbackMount === undefined) throw new Error("Fallback renderer did not mount")
    const fallbackItems = JSON.stringify(fallbackMount)
    expect(fallbackItems).toContain("audit")
    expect(fallbackItems).toContain("verified")
    expect(fallbackItems).toContain("Current finding")
    expect(host.textContent).toContain("Worker acceleration is unavailable")
    await act(async () => root.unmount())
  })
})
