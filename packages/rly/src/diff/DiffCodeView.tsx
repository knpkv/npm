"use client"

import { CodeView, type CodeViewHandle, type CodeViewItem, type DiffLineAnnotation } from "@pierre/diffs/react"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { cssClass } from "../internal/component.js"
import { DiffCodeAnnotation, requireDiffCodeAnnotations } from "./annotation.js"
import styles from "./DiffCodeView.module.css"
import { parseDiffFilePair, validateDiffCodeItem } from "./parse-diff.js"
import { renderedDiffLine } from "./rendered-line.js"
import { ensureRlyDiffThemes, RLY_DIFF_THEMES } from "./themes.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem, RlyDiffCodeViewHandle, RlyDiffCodeViewProps } from "./types.js"
import { useDiffWorkerState } from "./worker-pool.js"

interface AnnotationMetadata {
  readonly annotation: RlyDiffCodeAnnotation
}

const annotationsForItem = (
  itemId: string,
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>
): Array<DiffLineAnnotation<AnnotationMetadata>> =>
  annotations
    .filter((annotation) => annotation.location.itemId === itemId)
    .map((annotation) => ({
      lineNumber: annotation.location.lineNumber,
      metadata: { annotation },
      side: annotation.location.side
    }))

const annotationItemsChanged = (
  previous: ReadonlyArray<RlyDiffCodeAnnotation>,
  current: ReadonlyArray<RlyDiffCodeAnnotation>
): ReadonlySet<string> => {
  const previousById = new Map(previous.map((annotation) => [annotation.id, annotation]))
  const currentById = new Map(current.map((annotation) => [annotation.id, annotation]))
  const itemIds = new Set<string>()
  for (const [id, annotation] of previousById) {
    if (currentById.get(id) !== annotation) itemIds.add(annotation.location.itemId)
  }
  for (const [id, annotation] of currentById) {
    if (previousById.get(id) !== annotation) itemIds.add(annotation.location.itemId)
  }
  return itemIds
}

const toRendererItem = (
  item: RlyDiffCodeItem,
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>,
  version: number
): CodeViewItem<AnnotationMetadata> => {
  return {
    annotations: annotationsForItem(item.id, annotations),
    ...(item.collapsed === undefined ? {} : { collapsed: item.collapsed }),
    fileDiff: parseDiffFilePair(item),
    id: item.id,
    type: "diff",
    version
  }
}

const requireInitialItems = (items: ReadonlyArray<RlyDiffCodeItem>): void => {
  const ids = new Set<string>()
  for (const item of items) {
    validateDiffCodeItem(item)
    if (ids.has(item.id)) throw new Error(`Diff item id ${item.id} must be unique`)
    ids.add(item.id)
  }
}

const joinClassNames = (className: string | undefined): string =>
  className === undefined ? cssClass(styles, "root") : `${cssClass(styles, "root")} ${className}`

const keepRenderedDiffKeyboardAccessible = (
  node: HTMLElement,
  itemId: string,
  phase: "mount" | "unmount" | "update",
  scrollable: boolean
): void => {
  if (phase === "unmount") return
  const root = node.shadowRoot
  node.dataset.rlyDiffItem = itemId
  node.style.setProperty("--diffs-selection-number-fg", "var(--rly-color-text-1)")
  if (scrollable) {
    for (const region of root?.querySelectorAll<HTMLElement>("code[data-code]") ?? []) {
      region.tabIndex = 0
    }
  }
  for (const expander of root?.querySelectorAll<HTMLElement>("[data-expand-button]") ?? []) {
    const direction = expander.hasAttribute("data-expand-down") ? "below" : "above"
    expander.setAttribute("aria-label", `Expand unchanged lines ${direction}`)
    expander.tabIndex = 0
    if (expander.hasAttribute("data-rly-diff-keyboard-expander")) continue
    expander.setAttribute("data-rly-diff-keyboard-expander", "")
    expander.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      expander.click()
    })
  }
}

/** Render and incrementally update complete text changes through rly's isolated renderer adapter. */
export const DiffCodeView = forwardRef<RlyDiffCodeViewHandle, RlyDiffCodeViewProps>(function DiffCodeView(
  {
    annotations = [],
    className,
    contextLines = 3,
    empty = "No renderable source changes.",
    expandContext = false,
    initialItems,
    mode = "split",
    onItemRender,
    onSelectedLinesChange,
    selectedLines,
    virtualization = "buffered",
    wrap = false
  },
  ref
) {
  requireInitialItems(initialItems)
  requireDiffCodeAnnotations(annotations)
  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new Error("Diff context lines must be a non-negative integer")
  }
  ensureRlyDiffThemes()

  const workerState = useDiffWorkerState()
  const rendererContainerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<CodeViewHandle<AnnotationMetadata>>(null)
  const annotationsRef = useRef(annotations)
  const previousAnnotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const [sourceItems] = useState(() => new Map(initialItems.map((item) => [item.id, item])))
  const [versions] = useState(() => new Map(initialItems.map((item) => [item.id, item.version ?? 0])))
  const rendererItems = [...sourceItems.values()].map((item) =>
    toRendererItem(item, annotations, versions.get(item.id) ?? item.version ?? 0)
  )

  useEffect(() => {
    const changedItemIds = annotationItemsChanged(previousAnnotationsRef.current, annotations)
    previousAnnotationsRef.current = annotations
    for (const itemId of changedItemIds) {
      const item = sourceItems.get(itemId)
      if (item === undefined) continue
      const nextVersion = (versions.get(item.id) ?? item.version ?? 0) + 1
      versions.set(item.id, nextVersion)
      rendererRef.current?.updateItem(toRendererItem(item, annotations, nextVersion))
    }
  }, [annotations, sourceItems, versions])

  useImperativeHandle(
    ref,
    () => ({
      addItems(items) {
        requireInitialItems(items)
        for (const item of items) {
          if (sourceItems.has(item.id)) throw new Error(`Diff item id ${item.id} already exists`)
        }
        const rendererItems = items.map((item) => {
          sourceItems.set(item.id, item)
          const version = item.version ?? 0
          versions.set(item.id, version)
          return toRendererItem(item, annotationsRef.current, version)
        })
        rendererRef.current?.addItems(rendererItems)
      },
      focusLine(target) {
        const container = rendererContainerRef.current?.querySelector<HTMLElement>(
          `diffs-container[data-rly-diff-item="${CSS.escape(target.id)}"]`
        )
        if (container === null || container === undefined) return false
        const line = renderedDiffLine(container, target)
        if (line === null) return false
        line.tabIndex = -1
        line.focus({ preventScroll: true })
        return container.shadowRoot?.activeElement === line
      },
      scrollTo(target) {
        rendererRef.current?.scrollTo(target)
      },
      updateItem(item) {
        validateDiffCodeItem(item)
        if (!sourceItems.has(item.id)) return false
        const version = Math.max(item.version ?? 0, (versions.get(item.id) ?? 0) + 1)
        versions.set(item.id, version)
        sourceItems.set(item.id, item)
        return rendererRef.current?.updateItem(toRendererItem(item, annotationsRef.current, version)) ?? false
      }
    }),
    [sourceItems, versions]
  )

  if (initialItems.length === 0) {
    return <p className={joinClassNames(className)}>{empty}</p>
  }

  return (
    <div className={joinClassNames(className)} data-rly-diff-code-view="" data-rly-diff-mode={mode}>
      {workerState.status === "fallback" ? (
        <p aria-live="polite" className={styles.fallbackNotice} role="status">
          Worker acceleration is unavailable. The complete diff is rendered on this device.
        </p>
      ) : null}
      <CodeView<AnnotationMetadata>
        key={workerState.status}
        ref={rendererRef}
        className={cssClass(styles, "viewer")}
        containerRef={rendererContainerRef}
        disableWorkerPool={workerState.status !== "worker"}
        initialItems={rendererItems}
        {...(onSelectedLinesChange === undefined ? {} : { onSelectedLinesChange })}
        options={{
          collapsedContextThreshold: contextLines,
          diffIndicators: "bars",
          diffStyle: mode === "split" ? "split" : "unified",
          disableVirtualizationBuffers: virtualization === "strict",
          enableLineSelection: true,
          expandUnchanged: expandContext,
          expansionLineCount: contextLines,
          hunkSeparators: "line-info-basic",
          layout: { gap: 8, paddingBottom: 8, paddingTop: 8 },
          onPostRender: (node, _instance, phase, context) => {
            keepRenderedDiffKeyboardAccessible(node, context.item.id, phase, !wrap)
            if (phase !== "unmount") onItemRender?.(context.item.id, workerState.status)
          },
          overflow: wrap ? "wrap" : "scroll",
          stickyHeaders: true,
          theme: RLY_DIFF_THEMES
        }}
        renderAnnotation={(annotation) => (
          <DiffCodeAnnotation annotation={annotation.metadata.annotation} className={cssClass(styles, "annotation")} />
        )}
        {...(selectedLines === undefined ? {} : { selectedLines })}
      />
    </div>
  )
})
