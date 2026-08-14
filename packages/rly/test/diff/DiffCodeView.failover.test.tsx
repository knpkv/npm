// @vitest-environment happy-dom

import { act, createRef, useImperativeHandle, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CodeViewHandle, CodeViewItem } from "@pierre/diffs/react"
import {
  type AnnotationMetadata,
  createDiffCodeView,
  type DiffCodeRendererAdapterProps
} from "../../src/diff/DiffCodeView.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem, RlyDiffCodeViewHandle } from "../../src/diff/types.js"
import { createDiffWorkerFactory, DiffWorkerProvider } from "../../src/diff/worker-pool.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const rendererMounts: Array<ReadonlyArray<CodeViewItem<AnnotationMetadata>>> = []
const rendererUpdates: Array<CodeViewItem<AnnotationMetadata>> = []
let emitWorkerFailure: (() => void) | undefined

const CodeViewProbe = ({ rendererProps }: DiffCodeRendererAdapterProps) => {
  const initialItems = rendererProps.initialItems ?? []
  const [mountedItems] = useState(() => {
    rendererMounts.push(initialItems)
    return initialItems
  })
  useImperativeHandle(rendererProps.ref, (): CodeViewHandle<AnnotationMetadata> => ({
    addItems: () => undefined,
    clearSelectedLines: () => undefined,
    getEditor: () => undefined,
    getInstance: () => undefined,
    getItem: () => undefined,
    getSelectedLines: () => null,
    removeItem: () => false,
    scrollTo: () => undefined,
    setSelectedLines: () => undefined,
    updateItem: (item) => {
      rendererUpdates.push(item)
      return true
    },
    updateItemId: () => false
  }))
  return <output data-renderer-items={JSON.stringify(mountedItems)} />
}

const ProbeDiffCodeView = createDiffCodeView(CodeViewProbe)
const observeWorkerFailure = (onFailure: () => void) => {
  emitWorkerFailure = onFailure
  return () => undefined
}

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
  emitWorkerFailure = undefined
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
      <DiffWorkerProvider observeWorkerFailure={observeWorkerFailure} workerFactory={workerFactory}>
        <ProbeDiffCodeView annotations={[releaseAnnotation, auditAnnotation]} initialItems={[initialItem, auditItem]} />
      </DiffWorkerProvider>
    )

    await act(async () => root.render(renderView(annotation("release-finding", "release", "Draft finding"))))
    const initialMountCount = rendererMounts.length
    expect(initialMountCount).toBeGreaterThan(0)
    expect(rendererUpdates).toHaveLength(0)

    await act(async () => root.render(renderView(annotation("release-finding", "release", "Resolved finding"))))
    expect(rendererMounts).toHaveLength(initialMountCount)
    expect(rendererUpdates.map(({ id }) => id)).toEqual(["release"])
    expect(rendererUpdates[0]?.annotations?.map(({ metadata }) => metadata.annotation.accessibilityLabel)).toEqual([
      "Resolved finding"
    ])
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
      <DiffWorkerProvider observeWorkerFailure={observeWorkerFailure} workerFactory={workerFactory}>
        <ProbeDiffCodeView
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

    if (emitWorkerFailure === undefined) throw new Error("Worker failure observer was not installed")
    await act(async () => emitWorkerFailure?.())

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
