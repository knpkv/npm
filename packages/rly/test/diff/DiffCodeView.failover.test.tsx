// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type * as PierreReact from "@pierre/diffs/react"
import { DiffCodeView } from "../../src/diff/DiffCodeView.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem, RlyDiffCodeViewHandle } from "../../src/diff/types.js"
import { createDiffWorkerFactory, DiffWorkerProvider } from "../../src/diff/worker-pool.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

interface RendererItemSnapshot {
  readonly annotations?: ReadonlyArray<unknown>
  readonly fileDiff?: unknown
  readonly id: string
  readonly version?: number
}

const rendererMounts = vi.hoisted((): Array<ReadonlyArray<RendererItemSnapshot>> => [])
const rendererUpdates = vi.hoisted((): Array<RendererItemSnapshot> => [])
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
        updateItem: (item: RendererItemSnapshot) => {
          rendererUpdates.push(item)
          return true
        }
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
  rendererUpdates.length = 0
  workerStats.emit = undefined
  vi.unstubAllGlobals()
})

describe("DiffCodeView worker failover", () => {
  it("updates only the item whose immutable annotation set changed without remounting", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    vi.stubGlobal("Worker", FakeWorker)
    const workerFactory = createDiffWorkerFactory({ workerUrl: "/diff-worker.js" })
    const auditItem = {
      after: { contents: "export const audit = true\n", name: "src/audit.ts" },
      before: { contents: "export const audit = false\n", name: "src/audit.ts" },
      id: "audit"
    } satisfies RlyDiffCodeItem
    const annotation = (id: string, itemId: string, label: string): RlyDiffCodeAnnotation => ({
      accessibilityLabel: label,
      id,
      location: { itemId, lineNumber: 1, side: "additions" },
      render: () => label
    })
    const auditAnnotation = annotation("audit-finding", "audit", "Audit finding")
    const renderView = (releaseAnnotation: RlyDiffCodeAnnotation) => (
      <DiffWorkerProvider workerFactory={workerFactory}>
        <DiffCodeView annotations={[releaseAnnotation, auditAnnotation]} initialItems={[initialItem, auditItem]} />
      </DiffWorkerProvider>
    )

    await act(async () => root.render(renderView(annotation("release-finding", "release", "Draft finding"))))
    const initialMountCount = rendererMounts.length
    expect(initialMountCount).toBeGreaterThan(0)
    expect(rendererUpdates).toHaveLength(0)

    await act(async () => root.render(renderView(annotation("release-finding", "release", "Resolved finding"))))
    expect(rendererMounts).toHaveLength(initialMountCount)
    expect(rendererUpdates.map(({ id }) => id)).toEqual(["release"])
    expect(JSON.stringify(rendererUpdates)).toContain("Resolved finding")
    await act(async () => root.unmount())
  })

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
          annotations={[
            {
              accessibilityLabel: message,
              id: "finding",
              location: { itemId: "release", lineNumber: 1, side: "additions" },
              render: () => message
            }
          ]}
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
