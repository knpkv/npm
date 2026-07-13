"use client"

import { CodeView, type CodeViewHandle, type CodeViewItem, type DiffLineAnnotation } from "@pierre/diffs/react"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { cssClass } from "../internal/component.js"
import styles from "./DiffCodeView.module.css"
import { parseDiffFilePair, validateDiffCodeItem } from "./parse-diff.js"
import { ensureRlyDiffThemes, RLY_DIFF_THEMES } from "./themes.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem, RlyDiffCodeViewHandle, RlyDiffCodeViewProps } from "./types.js"
import { useDiffWorkerState } from "./worker-pool.js"

interface AnnotationMetadata {
  readonly id: string
  readonly message: string
}

const requireAnnotations = (annotations: ReadonlyArray<RlyDiffCodeAnnotation>): void => {
  const ids = new Set<string>()
  for (const annotation of annotations) {
    if (annotation.id.trim().length === 0 || annotation.message.trim().length === 0) {
      throw new Error("Diff annotation id and message must not be blank")
    }
    if (!Number.isInteger(annotation.lineNumber) || annotation.lineNumber < 0) {
      throw new Error(`Diff annotation ${annotation.id} line number must be a non-negative integer`)
    }
    if (ids.has(annotation.id)) throw new Error(`Diff annotation id ${annotation.id} must be unique`)
    ids.add(annotation.id)
  }
}

const annotationsForItem = (
  itemId: string,
  annotations: ReadonlyArray<RlyDiffCodeAnnotation>
): Array<DiffLineAnnotation<AnnotationMetadata>> =>
  annotations
    .filter((annotation) => annotation.itemId === itemId)
    .map((annotation) => ({
      lineNumber: annotation.lineNumber,
      metadata: { id: annotation.id, message: annotation.message },
      side: annotation.side
    }))

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

const keepScrollableCodeKeyboardAccessible = (node: HTMLElement, phase: "mount" | "unmount" | "update"): void => {
  if (phase === "unmount") return
  for (const region of node.shadowRoot?.querySelectorAll<HTMLElement>("code[data-code]") ?? []) {
    region.tabIndex = 0
  }
}

export const DiffCodeView = forwardRef<RlyDiffCodeViewHandle, RlyDiffCodeViewProps>(function DiffCodeView(
  {
    annotations = [],
    className,
    contextLines = 3,
    empty = "No renderable source changes.",
    expandContext = false,
    initialItems,
    mode = "split",
    onSelectedLinesChange,
    selectedLines,
    virtualization = "buffered",
    wrap = false
  },
  ref
) {
  requireInitialItems(initialItems)
  requireAnnotations(annotations)
  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new Error("Diff context lines must be a non-negative integer")
  }
  ensureRlyDiffThemes()

  const workerState = useDiffWorkerState()
  const rendererRef = useRef<CodeViewHandle<AnnotationMetadata>>(null)
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const [sourceItems] = useState(() => new Map(initialItems.map((item) => [item.id, item])))
  const [versions] = useState(() => new Map(initialItems.map((item) => [item.id, item.version ?? 0])))
  const [seedItems] = useState(() => initialItems.map((item) => toRendererItem(item, annotations, item.version ?? 0)))

  useEffect(() => {
    for (const item of sourceItems.values()) {
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
        disableWorkerPool={workerState.status !== "worker"}
        initialItems={seedItems}
        {...(onSelectedLinesChange === undefined ? {} : { onSelectedLinesChange })}
        options={{
          collapsedContextThreshold: contextLines,
          controlledSelection: selectedLines !== undefined,
          diffIndicators: "bars",
          diffStyle: mode === "split" ? "split" : "unified",
          disableVirtualizationBuffers: virtualization === "strict",
          enableLineSelection: true,
          expandUnchanged: expandContext,
          expansionLineCount: contextLines,
          hunkSeparators: "line-info-basic",
          layout: { gap: 8, paddingBottom: 8, paddingTop: 8 },
          ...(wrap
            ? {}
            : { onPostRender: (node, _instance, phase) => keepScrollableCodeKeyboardAccessible(node, phase) }),
          overflow: wrap ? "wrap" : "scroll",
          stickyHeaders: true,
          theme: RLY_DIFF_THEMES
        }}
        renderAnnotation={(annotation) => (
          <div className={styles.annotation} data-rly-diff-annotation={annotation.metadata.id}>
            {annotation.metadata.message}
          </div>
        )}
        {...(selectedLines === undefined ? {} : { selectedLines })}
      />
    </div>
  )
})
