import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import * as Predicate from "./predicates.js"

interface InertRecord {
  count: number
  readonly previous: boolean
}

interface ScrollLockRecord {
  count: number
  readonly overflow: string
  readonly overscrollBehavior: string
}

interface ModalNestingState {
  readonly isContentMounted: boolean
  readonly setContentMounted: (isMounted: boolean) => void
}

interface ModalNestingBoundaryProps {
  readonly children: ReactNode
}

const inertRecords = new WeakMap<HTMLElement, InertRecord>()
const scrollLockRecords = new WeakMap<Document, ScrollLockRecord>()
const ModalNestingContext = createContext<ModalNestingState | null>(null)
let focusTransitionGeneration = 0

/** Entry-motion ownership sampled once for each closed-to-open modal cycle. */
export type ModalEntryMotion = "external" | "intrinsic"

/** Keep entry ownership stable while a modal is open, then resample it for the next open cycle. */
export const useModalEntryMotion = (open: boolean, requested: ModalEntryMotion): ModalEntryMotion => {
  const committedCycleRef = useRef({ open, value: requested })
  const resolved = open && !committedCycleRef.current.open ? requested : committedCycleRef.current.value
  useLayoutEffect(() => {
    if (!open) committedCycleRef.current = { open: false, value: requested }
    else if (!committedCycleRef.current.open) committedCycleRef.current = { open: true, value: requested }
  }, [open, requested])
  return resolved
}

const hasHTMLElementInertContract = <Value extends object>(element: Value): element is Value & HTMLElement =>
  "inert" in element && Predicate.isBoolean(element.inert)

/** Narrows DOM elements through the HTML-only inert contract without relying on a realm-specific constructor. */
export const isHTMLElement = (element: Element | null): element is HTMLElement =>
  element !== null && hasHTMLElementInertContract(element)

/** Stages nested default-open or controlled overlays until their parent content is mounted. */
export const ModalNestingBoundary = ({ children }: ModalNestingBoundaryProps): ReactElement => {
  const [isContentMounted, setContentMounted] = useState(false)
  return createElement(ModalNestingContext.Provider, { value: { isContentMounted, setContentMounted } }, children)
}

/** Reports whether a logical parent modal is ready to host a nested overlay. */
export const useParentModalReady = (): boolean => useContext(ModalNestingContext)?.isContentMounted ?? true

/** Reports whether this component belongs to a logical parent modal. */
export const useParentModalPresent = (): boolean => useContext(ModalNestingContext) !== null

/** Registers the current portal content so deeper overlays mount in logical stack order. */
export const useModalContentRegistration = (): void => {
  const setContentMounted = useContext(ModalNestingContext)?.setContentMounted
  useLayoutEffect(() => {
    setContentMounted?.(true)
    return () => setContentMounted?.(false)
  }, [setContentMounted])
}

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
    const retained = new Set<HTMLElement>()
    const observedParents = new Set<Node>()
    const MutationObserverConstructor = layer.ownerDocument.defaultView?.MutationObserver
    let observer: MutationObserver | null = null

    const synchronizeIsolation = (): void => {
      let current: Element = layer
      while (true) {
        if (current === current.ownerDocument.body) break
        const parent = current.parentNode
        if (parent === null) break
        if (!observedParents.has(parent)) {
          observer?.observe(parent, { childList: true })
          observedParents.add(parent)
        }
        let hasReachedCurrent = false
        for (const sibling of parent.children) {
          if (sibling === current) {
            hasReachedCurrent = true
            continue
          }
          const isLaterModalLayer = hasReachedCurrent && sibling.hasAttribute("data-rly-modal-layer")
          if (!isLaterModalLayer && isHTMLElement(sibling) && !retained.has(sibling)) {
            retainInert(sibling)
            retained.add(sibling)
          }
        }
        const parentElement = current.parentElement
        if (parentElement !== null) {
          current = parentElement
          continue
        }
        if (!("host" in parent)) break
        const host = parent.host
        if (!Predicate.isObjectOrArray(host) || !hasHTMLElementInertContract(host)) break
        current = host
      }
    }

    if (MutationObserverConstructor !== undefined) observer = new MutationObserverConstructor(synchronizeIsolation)
    synchronizeIsolation()

    return () => {
      observer?.disconnect()
      for (const element of retained) releaseInert(element)
    }
  }, [isOpen, layerRef])
}

const retainScrollLock = (ownerDocument: Document): void => {
  const record = scrollLockRecords.get(ownerDocument)
  if (record !== undefined) {
    record.count += 1
    return
  }
  const root = ownerDocument.documentElement
  scrollLockRecords.set(ownerDocument, {
    count: 1,
    overflow: root.style.overflow,
    overscrollBehavior: root.style.overscrollBehavior
  })
  root.style.overflow = "hidden"
  root.style.overscrollBehavior = "none"
}

const releaseScrollLock = (ownerDocument: Document): void => {
  const record = scrollLockRecords.get(ownerDocument)
  if (record === undefined) return
  if (record.count > 1) {
    record.count -= 1
    return
  }
  const root = ownerDocument.documentElement
  root.style.overflow = record.overflow
  root.style.overscrollBehavior = record.overscrollBehavior
  scrollLockRecords.delete(ownerDocument)
}

/** Shares a reference-counted document scroll lock across custom rly modal surfaces. */
export const useModalScrollLock = (layerRef: RefObject<HTMLDivElement | null>, isOpen: boolean): void => {
  useLayoutEffect(() => {
    if (!isOpen) return
    const ownerDocument = layerRef.current?.ownerDocument
    if (ownerDocument === undefined) return
    retainScrollLock(ownerDocument)
    return () => releaseScrollLock(ownerDocument)
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
    if (focusTransitionGeneration === generation && target !== null && target.isConnected === true) target.focus()
  }, 0)
}
