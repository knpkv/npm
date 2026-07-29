"use client"

import { createElement, type KeyboardEvent, type ReactElement, useRef } from "react"
import { renderedDiffLine } from "./rendered-line.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeAnnotationLocation } from "./types.js"

interface DiffCodeAnnotationProps {
  readonly annotation: RlyDiffCodeAnnotation
  readonly className: string
  readonly returnFocus?: () => void
}

const pierreLine = (annotationNode: HTMLDivElement, location: RlyDiffCodeAnnotationLocation): HTMLElement | null => {
  const item = annotationNode.closest("diffs-container")
  return item === null ? null : renderedDiffLine(item, location)
}

const focusLine = (annotationNode: HTMLDivElement, location: RlyDiffCodeAnnotationLocation): void => {
  const line = pierreLine(annotationNode, location)
  if (line === null) return
  line.tabIndex = -1
  line.focus({ preventScroll: true })
}

/** Keyboard boundary shared by virtualized and bounded annotation presentations. */
export const DiffCodeAnnotation = ({
  annotation,
  className,
  returnFocus
}: DiffCodeAnnotationProps): ReactElement => {
  const annotationRef = useRef<HTMLDivElement>(null)
  const restoreLineFocus = (): void => {
    if (returnFocus !== undefined) {
      returnFocus()
      return
    }
    if (annotationRef.current !== null) focusLine(annotationRef.current, annotation.location)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    restoreLineFocus()
  }

  return createElement(
    "div",
    {
      ref: annotationRef,
      "aria-label": annotation.accessibilityLabel,
      className,
      "data-rly-diff-annotation": annotation.id,
      "data-rly-diff-annotation-item": annotation.location.itemId,
      "data-rly-diff-annotation-line": annotation.location.lineNumber,
      "data-rly-diff-annotation-side": annotation.location.side,
      onKeyDown: handleKeyDown,
      role: "group",
      tabIndex: 0
    },
    annotation.render({
      annotationId: annotation.id,
      location: annotation.location,
      returnFocus: restoreLineFocus
    })
  )
}

/** Validate public annotations before either renderer crosses into implementation code. */
export const requireDiffCodeAnnotations = (annotations: ReadonlyArray<RlyDiffCodeAnnotation>): void => {
  const ids = new Set<string>()
  for (const annotation of annotations) {
    if (annotation.id.trim().length === 0 || annotation.accessibilityLabel.trim().length === 0) {
      throw new Error("Diff annotation id and accessibility label must not be blank")
    }
    if (annotation.location.itemId.trim().length === 0) {
      throw new Error(`Diff annotation ${annotation.id} location item id must not be blank`)
    }
    if (!Number.isInteger(annotation.location.lineNumber) || annotation.location.lineNumber < 1) {
      throw new Error(`Diff annotation ${annotation.id} line number must be a positive integer`)
    }
    if (ids.has(annotation.id)) throw new Error(`Diff annotation id ${annotation.id} must be unique`)
    ids.add(annotation.id)
  }
}
