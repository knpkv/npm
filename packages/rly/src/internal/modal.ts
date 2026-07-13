import { type RefObject, useLayoutEffect } from "react"

interface InertRecord {
  count: number
  readonly previous: boolean
}

const inertRecords = new WeakMap<HTMLElement, InertRecord>()
let focusTransitionGeneration = 0

/** Narrows DOM elements through the HTML-only inert contract without relying on a realm-specific constructor. */
export const isHTMLElement = (element: Element | null): element is HTMLElement =>
  element !== null && "inert" in element && typeof element.inert === "boolean"

const retainInert = (element: HTMLElement): void => {
  const record = inertRecords.get(element)
  if (record === undefined) {
    inertRecords.set(element, { count: 1, previous: element.inert })
    element.inert = true
    return
  }
  record.count += 1
}

const releaseInert = (element: HTMLElement): void => {
  const record = inertRecords.get(element)
  if (record === undefined) return
  if (record.count > 1) {
    record.count -= 1
    return
  }
  element.inert = record.previous
  inertRecords.delete(element)
}

/** Shares reference-counted background isolation across every rly modal primitive. */
export const useModalIsolation = (layerRef: RefObject<HTMLDivElement | null>, isOpen: boolean): void => {
  useLayoutEffect(() => {
    if (!isOpen) return
    const layer = layerRef.current
    if (layer === null) return
    let current: HTMLElement = layer
    const retained: Array<HTMLElement> = []

    while (true) {
      if (current === current.ownerDocument.body) break
      const parent = current.parentElement
      if (parent === null) break
      for (const sibling of parent.children) {
        if (sibling !== current && isHTMLElement(sibling)) {
          retainInert(sibling)
          retained.push(sibling)
        }
      }
      current = parent
    }

    return () => {
      for (const element of retained) releaseInert(element)
    }
  }, [isOpen, layerRef])
}

/** Invalidates an older deferred restoration whenever a newer modal transition starts. */
export const invalidateModalFocusRestore = (): void => {
  focusTransitionGeneration += 1
}

/** Restores focus only after modal cleanup and only while this remains the newest transition. */
export const restoreModalFocusAfterCleanup = (target: HTMLElement | null): void => {
  const generation = ++focusTransitionGeneration
  setTimeout(() => {
    if (focusTransitionGeneration === generation && target?.isConnected) target.focus()
  }, 0)
}
