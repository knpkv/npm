import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { Portal as RadixPortal } from "radix-ui"
import { Icon } from "../foundations/Icon.js"
import { PortalBoundary, usePortalTarget } from "../foundations/PortalProvider.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import * as Predicate from "../internal/predicates.js"
import {
  invalidateModalFocusRestore,
  isHTMLElement,
  ModalNestingBoundary,
  restoreModalFocusAfterCleanup,
  useModalContentRegistration,
  useModalIsolation,
  useParentModalPresent,
  useParentModalReady,
  useModalScrollLock
} from "../internal/modal.js"
import { Field } from "../primitives/Field.js"
import { Select, type RlySelectOption } from "../primitives/Select.js"
import { StatePanel } from "../primitives/StatePanel.js"
import styles from "./RelayDock.module.css"

const style = (name: string): string => cssClass(styles, name)
const compactViewportQuery = "(max-width: 40rem), (max-height: 40rem) and (pointer: coarse)"
const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "details > summary:first-of-type",
  "textarea:not([disabled])",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])'
].join(",")

const hasActiveElement = (node: Node): node is Node & DocumentOrShadowRoot => "activeElement" in node

interface ShadowRootHost extends Node {
  readonly host: Element
}

const hasShadowRootHost = (value: Node): value is ShadowRootHost =>
  "host" in value && Predicate.isObjectOrArray(value.host)

const deepActiveElement = (root: DocumentOrShadowRoot): Element | null => {
  const active = root.activeElement
  if (active === null) return null
  if (active.shadowRoot !== null) return deepActiveElement(active.shadowRoot) ?? active
  return active
}

const activeElementFor = (panel: HTMLElement): Element | null => {
  const root = panel.getRootNode()
  return hasActiveElement(root) ? deepActiveElement(root) : panel.ownerDocument.activeElement
}

const shadowHostFor = (node: Node): HTMLElement | null => {
  const root = node.getRootNode()
  if (!hasShadowRootHost(root)) return null
  return isHTMLElement(root.host) ? root.host : null
}

interface AssignedSlotNode extends Node {
  readonly assignedSlot: HTMLSlotElement | null
}

const hasAssignedSlot = (node: Node): node is AssignedSlotNode => "assignedSlot" in node

const isElementNode = (node: Node): node is Element => node.nodeType === 1

const composedParentFor = (node: Node, composedParents?: ReadonlyMap<Node, Node | null>): Element | null => {
  if (composedParents !== undefined && composedParents.has(node)) {
    const parent = composedParents.get(node)
    return parent !== null && parent !== undefined && isElementNode(parent) ? parent : null
  }
  const assignedSlot = hasAssignedSlot(node) ? node.assignedSlot : null
  return assignedSlot ?? node.parentElement ?? shadowHostFor(node)
}

const isWithinComposedElement = (
  ancestor: Element,
  descendant: Node | null,
  composedParents?: ReadonlyMap<Node, Node | null>
): boolean => {
  if (descendant === null) return false
  if (ancestor.contains(descendant)) return true
  const seen = new Set<Node>()
  let current: Node = descendant
  while (!seen.has(current)) {
    seen.add(current)
    const parent = composedParentFor(current, composedParents)
    if (parent === null) return false
    if (parent === ancestor || ancestor.contains(parent)) return true
    current = parent
  }
  return false
}

const isWithinPanel = (panel: HTMLElement, active: Element | null): boolean => isWithinComposedElement(panel, active)

const deepActiveHTMLElement = (root: DocumentOrShadowRoot): HTMLElement | null => {
  const active = root.activeElement
  if (!isHTMLElement(active)) return null
  return active.shadowRoot === null ? active : (deepActiveHTMLElement(active.shadowRoot) ?? active)
}

const focusRestoreTarget = (ownerDocument: Document): HTMLElement | null => {
  const active = deepActiveHTMLElement(ownerDocument)
  return active === ownerDocument.body || active === ownerDocument.documentElement ? null : active
}

const isRenderedFocusable = (element: HTMLElement, composedParents?: ReadonlyMap<Node, Node | null>): boolean => {
  if (element.matches(":disabled")) return false
  const view = element.ownerDocument.defaultView
  if (view === null) return element.hidden === false
  const visibility = view.getComputedStyle(element).visibility
  if (visibility === "hidden" || visibility === "collapse") return false
  const nativeRoot = element.getRootNode()
  let current: Element | null = element
  while (current !== null) {
    if (isHTMLElement(current) && current.inert) return false
    if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
      const firstSummary: HTMLElement | null = current.querySelector(":scope > summary:first-of-type")
      if (firstSummary === null || !isWithinComposedElement(firstSummary, element, composedParents)) return false
    }
    if (
      current !== element &&
      current.tagName === "FIELDSET" &&
      current.hasAttribute("disabled") &&
      current.getRootNode() === nativeRoot
    ) {
      const firstLegend: HTMLElement | null = current.querySelector(":scope > legend:first-of-type")
      if (firstLegend === null || !isWithinComposedElement(firstLegend, element, composedParents)) return false
    }
    const computed = view.getComputedStyle(current)
    if (
      (isHTMLElement(current) && current.hidden !== false) ||
      computed.display === "none" ||
      (current !== element && computed.contentVisibility === "hidden")
    ) {
      return false
    }
    current = composedParentFor(current, composedParents)
  }
  return true
}

interface RadioInput extends HTMLElement {
  readonly checked: boolean
  readonly form: HTMLFormElement | null
  readonly name: string
}

const isRadioInput = (element: Element): element is RadioInput =>
  isHTMLElement(element) && element.tagName === "INPUT" && element.getAttribute("type")?.toLowerCase() === "radio"

interface ComposedElement {
  readonly composedParent: Node | null
  readonly element: Element
  readonly focusScope: ParentNode
  readonly nativeRoot: Node
}

interface ComposedHTMLElement extends ComposedElement {
  readonly element: HTMLElement
}

interface SlotElement extends Element {
  readonly assignedNodes: (options?: { readonly flatten?: boolean }) => Array<Node>
}

const isSlotElement = (element: Element): element is SlotElement =>
  element.tagName === "SLOT" && "assignedNodes" in element && hasShadowRootHost(element.getRootNode())

const compareSequentialTabOrder = (left: Element, right: Element): number => {
  const leftTabIndex = isSlotElement(left) || !isHTMLElement(left) ? -1 : left.tabIndex
  const rightTabIndex = isSlotElement(right) || !isHTMLElement(right) ? -1 : right.tabIndex
  const leftPositive = leftTabIndex > 0
  const rightPositive = rightTabIndex > 0
  if (leftPositive !== rightPositive) return leftPositive ? -1 : 1
  if (leftPositive && rightPositive && leftTabIndex !== rightTabIndex) return leftTabIndex - rightTabIndex
  return 0
}

const hasExplicitNegativeTabIndex = (element: Element): boolean =>
  isHTMLElement(element) && element.hasAttribute("tabindex") && element.tabIndex < 0

const isSequentiallyFocusableRadio = (
  element: RadioInput,
  nativeRoot: Node,
  elements: ReadonlyArray<ComposedElement>,
  composedParents: ReadonlyMap<Node, Node | null>
): boolean => {
  if (element.name.length === 0) return true
  const group = elements
    .filter(
      ({ element: candidate, nativeRoot: candidateRoot }) =>
        candidateRoot === nativeRoot &&
        isRadioInput(candidate) &&
        candidate.name === element.name &&
        candidate.form === element.form &&
        isRenderedFocusable(candidate, composedParents)
    )
    .map(({ element: candidate }) => candidate)
    .filter(isRadioInput)
  const checked = group.find((candidate) => candidate.checked)
  return checked === undefined ? group[0] === element : checked === element
}

interface ScopeTraversal {
  readonly entries: ReadonlyArray<ComposedElement>
  readonly nested: ReadonlyMap<Element, ScopeTraversal>
}

const composedElementsInScope = (root: ParentNode): Array<ComposedElement> => {
  const visitScopeElements = (
    elements: ReadonlyArray<Element>,
    focusScope: ParentNode,
    composedParent: Node | null
  ): ScopeTraversal => {
    const entries: Array<ComposedElement> = []
    const nested = new Map<Element, ScopeTraversal>()
    const visitElement = (element: Element, parent: Node | null): void => {
      entries.push({ composedParent: parent, element, focusScope, nativeRoot: element.getRootNode() })
      if (isSlotElement(element)) {
        if (hasExplicitNegativeTabIndex(element)) return
        const slotNodes = element.assignedNodes({ flatten: false })
        const assignedElements = (slotNodes.length > 0 ? slotNodes : [...element.childNodes]).filter(isElementNode)
        nested.set(element, visitScopeElements(assignedElements, element, element))
        return
      }
      if (element.shadowRoot !== null && !hasExplicitNegativeTabIndex(element)) {
        nested.set(element, visitScope(element.shadowRoot, element.shadowRoot, element))
      } else if (element.shadowRoot === null) {
        for (const child of element.children) visitElement(child, element)
      }
    }
    for (const element of elements) visitElement(element, composedParent)
    return { entries, nested }
  }
  const visitScope = (scope: ParentNode, focusScope: ParentNode, composedParent: Node | null): ScopeTraversal =>
    visitScopeElements([...scope.children], focusScope, composedParent)
  const flattenScope = (scope: ScopeTraversal): Array<ComposedElement> => {
    const ordered = [...scope.entries].sort((left, right) => compareSequentialTabOrder(left.element, right.element))
    const flattened: Array<ComposedElement> = []
    for (const entry of ordered) {
      flattened.push(entry)
      const nested = scope.nested.get(entry.element)
      if (nested !== undefined) {
        for (const nestedEntry of flattenScope(nested)) flattened.push(nestedEntry)
      }
    }
    return flattened
  }
  return flattenScope(visitScope(root, root, root))
}

/** One explicit piece of application-owned context attached to the current Relay thread. */
export interface RlyRelayDockContextChip {
  readonly id: string
  readonly label: string
  readonly value: string
}

/** One controlled profile or model selector supplied by a product adapter. */
export interface RlyRelayDockSelectionControl {
  readonly disabled?: boolean
  readonly onValueChange: (value: string) => void
  readonly options: ReadonlyArray<RlySelectOption>
  readonly value: string
}

/** Controlled run selection shown before a person asks Relay to do anything. */
export interface RlyRelayDockSelection {
  readonly model: RlyRelayDockSelectionControl
  readonly profile: RlyRelayDockSelectionControl
}

/** Caller-owned thread state. RelayDock does not load, retry, or persist it. */
export type RlyRelayDockState =
  | {
      readonly description?: ReactNode
      readonly status: "loading"
      readonly title: string
    }
  | {
      readonly action?: ReactNode
      readonly description: ReactNode
      readonly status: "empty"
      readonly title: string
    }
  | {
      readonly content: ReactNode
      readonly status: "ready"
    }
  | {
      readonly action?: ReactNode
      readonly description: ReactNode
      readonly status: "error"
      readonly title: string
    }
  | {
      readonly action?: ReactNode
      readonly description: ReactNode
      readonly status: "unavailable"
      readonly title: string
    }

/** Desktop placement policy. Compact viewports always use a full-height modal sheet. */
export type RlyRelayDockDesktopPresentation = "overlay" | "rail"

interface RelayDockBaseProps extends Omit<ComponentPropsWithRef<"div">, "children" | "title"> {
  readonly context: ReadonlyArray<RlyRelayDockContextChip>
  readonly description?: string
  readonly desktopPresentation?: RlyRelayDockDesktopPresentation
  readonly footer?: ReactNode
  readonly selection: RlyRelayDockSelection
  readonly state: RlyRelayDockState
  readonly title?: string
  readonly triggerLabel?: string
}

type ControlledRelayDockProps = RelayDockBaseProps & {
  readonly defaultOpen?: never
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}

type DefaultRelayDockProps = RelayDockBaseProps & {
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly open?: never
}

/** Controlled-first dock state with a collapsed uncontrolled default. */
export type RelayDockProps = ControlledRelayDockProps | DefaultRelayDockProps

const subscribeToCompactViewport = (view: Window | null, onStoreChange: () => void): (() => void) => {
  if (view === null || !("matchMedia" in view)) return () => undefined
  const query = view.matchMedia(compactViewportQuery)
  query.addEventListener("change", onStoreChange)
  return () => query.removeEventListener("change", onStoreChange)
}

const compactViewportSnapshot = (view: Window | null): boolean =>
  view !== null && "matchMedia" in view && view.matchMedia(compactViewportQuery).matches

const serverCompactViewportSnapshot = (): boolean => false

const useCompactViewport = (view: Window | null): boolean => {
  const subscribe = useCallback((onStoreChange: () => void) => subscribeToCompactViewport(view, onStoreChange), [view])
  const snapshot = useCallback(() => compactViewportSnapshot(view), [view])
  return useSyncExternalStore(subscribe, snapshot, serverCompactViewportSnapshot)
}

const RelayMark = (): ReactElement => (
  <span aria-hidden="true" className={style("mark")}>
    <span className={style("markLine")} />
    <svg className={style("markGlyph")} focusable="false" viewBox="0 0 24 24">
      <path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5L10 14l-6.5-2 6.5-2Z" fill="currentColor" />
    </svg>
  </span>
)

const ContextChips = ({
  context,
  labelId
}: {
  readonly context: ReadonlyArray<RlyRelayDockContextChip>
  readonly labelId: string
}): ReactElement => {
  if (context.length === 0) throw new Error("RelayDock context must contain at least one chip")
  const ids = new Set<string>()
  return (
    <section aria-labelledby={labelId} className={style("context")}>
      <h2 className={style("sectionLabel")} id={labelId}>
        Context
      </h2>
      <ul className={style("chipList")}>
        {context.map((chip) => {
          const id = requireText(chip.id, "RelayDock context chip id")
          if (ids.has(id)) throw new Error(`Duplicate RelayDock context chip id: ${id}`)
          ids.add(id)
          return (
            <li className={style("chip")} data-rly-relay-dock-context={id} key={id}>
              <span className={style("chipLabel")}>{requireText(chip.label, "RelayDock context chip label")}</span>
              <span className={style("chipValue")}>{requireText(chip.value, "RelayDock context chip value")}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const SelectionControls = ({
  labelId,
  selection
}: {
  readonly labelId: string
  readonly selection: RlyRelayDockSelection
}): ReactElement => {
  const profileId = useId()
  const modelId = useId()
  return (
    <section aria-labelledby={labelId} className={style("selection")}>
      <h2 className={style("sectionLabel")} id={labelId}>
        Run with
      </h2>
      <div className={style("selectionGrid")}>
        <Field controlId={`rly-relay-dock-profile-${profileId}`} label="Profile" size="compact">
          {(controlProps) => (
            <Select
              {...controlProps}
              {...(selection.profile.disabled === undefined ? {} : { disabled: selection.profile.disabled })}
              onValueChange={selection.profile.onValueChange}
              options={selection.profile.options}
              size="compact"
              value={selection.profile.value}
            />
          )}
        </Field>
        <Field controlId={`rly-relay-dock-model-${modelId}`} label="Model" size="compact">
          {(controlProps) => (
            <Select
              {...controlProps}
              {...(selection.model.disabled === undefined ? {} : { disabled: selection.model.disabled })}
              onValueChange={selection.model.onValueChange}
              options={selection.model.options}
              size="compact"
              value={selection.model.value}
            />
          )}
        </Field>
      </div>
    </section>
  )
}

const DockState = ({ state }: { readonly state: RlyRelayDockState }): ReactElement => {
  if (state.status === "ready") {
    return (
      <section aria-live="polite" className={style("ready")} data-rly-relay-dock-state="ready">
        {state.content}
      </section>
    )
  }
  const announcement = state.status === "error" ? "assertive" : "polite"
  const tone = state.status === "loading" ? "progress" : state.status === "error" ? "critical" : "neutral"
  return (
    <StatePanel
      action={"action" in state ? state.action : undefined}
      announce={announcement}
      className={style("state")}
      data-rly-relay-dock-state={state.status}
      description={state.description}
      title={requireText(state.title, `RelayDock ${state.status} title`)}
      tone={tone}
    />
  )
}

const DockContents = ({
  context,
  footer,
  selection,
  state
}: Pick<RelayDockBaseProps, "context" | "footer" | "selection" | "state">): ReactElement => {
  const contextLabelId = useId()
  const selectionLabelId = useId()
  return (
    <div className={style("contents")} data-rly-relay-dock-scroll="">
      <div className={style("fixedContext")}>
        <ContextChips context={context} labelId={contextLabelId} />
        <SelectionControls labelId={selectionLabelId} selection={selection} />
      </div>
      <section aria-label="Relay thread" className={style("body")} tabIndex={0}>
        <DockState state={state} />
      </section>
      {footer === undefined || footer === null ? null : <footer className={style("footer")}>{footer}</footer>}
    </div>
  )
}

interface DockLayerProps extends Pick<RelayDockBaseProps, "context" | "footer" | "selection" | "state"> {
  readonly compactViewport: boolean
  readonly description: string
  readonly headingId: string
  readonly modal: boolean
  readonly parentModalPresent: boolean
  readonly onClose: () => void
  readonly restoreDocument: Document | null
  readonly restoreTargetRef: RefObject<HTMLElement | null>
  readonly title: string
  readonly closeRef: RefObject<HTMLButtonElement | null>
}

const DockInitialFocus = ({
  restoreDocument,
  restoreTarget,
  target
}: {
  readonly restoreDocument: Document | null
  readonly restoreTarget: RefObject<HTMLElement | null>
  readonly target: RefObject<HTMLButtonElement | null>
}): null => {
  const hasCapturedRestoreTarget = useRef(false)
  useLayoutEffect(() => {
    const focusTarget = target.current
    if (focusTarget === null) return
    if (!hasCapturedRestoreTarget.current) {
      restoreTarget.current = focusRestoreTarget(restoreDocument ?? focusTarget.ownerDocument)
      hasCapturedRestoreTarget.current = true
    }
    focusTarget.focus()
  }, [restoreDocument, restoreTarget, target])
  return null
}

const DockLayerSurface = ({
  children,
  modal,
  modalLayer
}: {
  readonly children: ReactNode
  readonly modal: boolean
  readonly modalLayer: boolean
}): ReactElement => {
  const layerRef = useRef<HTMLDivElement>(null)
  useModalContentRegistration()
  useModalIsolation(layerRef, modal)
  useModalScrollLock(layerRef, modal)
  return (
    <div
      className={style("layer")}
      data-rly-modal-layer={modalLayer ? "" : undefined}
      data-rly-relay-dock-modal={modal ? "true" : "false"}
      ref={layerRef}
    >
      {children}
    </div>
  )
}

const DockLayer = ({
  closeRef,
  compactViewport,
  context,
  description,
  footer,
  headingId,
  modal,
  onClose,
  parentModalPresent,
  restoreDocument,
  restoreTargetRef,
  selection,
  state,
  title
}: DockLayerProps): ReactElement => {
  const descriptionId = `${headingId}-description`

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const panel = event.currentTarget
    if (!event.nativeEvent.composedPath().includes(panel)) return
    if (event.defaultPrevented) return
    if (event.key === "Escape") {
      if (event.nativeEvent.isComposing) return
      event.stopPropagation()
      onClose()
      return
    }
    if (!modal || event.key !== "Tab") return

    const composed = composedElementsInScope(panel)
    const composedParents = new Map<Node, Node | null>(
      composed.map(({ composedParent, element }) => [element, composedParent])
    )
    const delegatingShadowHostFor = (element: Element): HTMLElement | null => {
      const seen = new Set<Node>()
      let current: Node = element
      while (!seen.has(current)) {
        seen.add(current)
        const parent = composedParentFor(current, composedParents)
        if (parent === null) return null
        if (isHTMLElement(parent) && parent.shadowRoot?.delegatesFocus === true) return parent
        current = parent
      }
      return null
    }
    const delegatedTargets = new Set<Element>()
    for (const { element: host } of composed) {
      if (!isHTMLElement(host) || host.shadowRoot?.delegatesFocus !== true || host.tabIndex < 0) continue
      const delegated = composed.find(({ element, nativeRoot }) => {
        if (element === host || !isHTMLElement(element) || element.tagName === "SLOT") return false
        if (!isWithinComposedElement(host, element, composedParents)) return false
        if (!element.matches(focusableSelector) && !hasExplicitNegativeTabIndex(element)) return false
        if (!isRenderedFocusable(element, composedParents)) return false
        return !isRadioInput(element) || isSequentiallyFocusableRadio(element, nativeRoot, composed, composedParents)
      })
      if (delegated !== undefined && isHTMLElement(delegated.element) && delegated.element.tabIndex < 0) {
        delegatedTargets.add(delegated.element)
      }
    }
    const focusable = composed
      .filter((entry): entry is ComposedHTMLElement => {
        const { element, nativeRoot } = entry
        if (element.tagName === "SLOT") return false
        if (!isHTMLElement(element)) return false
        const isDelegatedTarget = delegatedTargets.has(element)
        if (!element.matches(focusableSelector) && !isDelegatedTarget) return false
        if (element.shadowRoot?.delegatesFocus === true) return false
        if (!isRenderedFocusable(element, composedParents)) return false
        if (isRadioInput(element) && !isSequentiallyFocusableRadio(element, nativeRoot, composed, composedParents)) {
          return false
        }
        return (
          element.tabIndex >= 0 ||
          (element.isContentEditable && !element.hasAttribute("tabindex")) ||
          element.matches("details > summary:first-of-type") ||
          isDelegatedTarget
        )
      })
      .map(({ element }) => element)
    const first = focusable[0] ?? panel
    const last = focusable[focusable.length - 1] ?? panel
    const active = activeElementFor(panel)
    const activeIsUnlistedDelegatedDescendant =
      active !== null &&
      isWithinPanel(panel, active) &&
      !focusable.some((element) => element === active) &&
      delegatingShadowHostFor(active) !== null
    const leavingStart =
      event.shiftKey && (active === first || !isWithinPanel(panel, active) || activeIsUnlistedDelegatedDescendant)
    const leavingEnd =
      !event.shiftKey && (active === last || !isWithinPanel(panel, active) || activeIsUnlistedDelegatedDescendant)
    if (!leavingStart && !leavingEnd) return
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target.focus()
  }

  return (
    <PortalBoundary>
      {(container) => (
        <RadixPortal.Root container={container}>
          <DockLayerSurface modal={modal} modalLayer={modal || parentModalPresent}>
            {modal ? (
              <div
                aria-hidden="true"
                className={style("overlay")}
                data-rly-relay-dock-overlay=""
                onPointerDown={onClose}
              />
            ) : null}
            <section
              aria-describedby={descriptionId}
              aria-labelledby={headingId}
              aria-modal={modal ? true : undefined}
              className={classNames(style("panel"), modal ? style("sheet") : style("rail"))}
              data-rly-relay-dock-presentation={compactViewport ? "mobile-sheet" : modal ? "overlay" : "rail"}
              onKeyDown={handleKeyDown}
              role={modal ? "dialog" : "complementary"}
              tabIndex={-1}
            >
              <header className={style("railHeader")}>
                <div className={style("railHeading")}>
                  <h1 className={style("title")} id={headingId}>
                    {title}
                  </h1>
                  <p className={style("description")} id={descriptionId}>
                    {description}
                  </p>
                </div>
                <button
                  aria-label={`Close ${title}`}
                  className={style("close")}
                  onClick={onClose}
                  ref={closeRef}
                  type="button"
                >
                  <Icon decorative name="close" />
                </button>
              </header>
              <DockInitialFocus restoreDocument={restoreDocument} restoreTarget={restoreTargetRef} target={closeRef} />
              <DockContents context={context} footer={footer} selection={selection} state={state} />
            </section>
          </DockLayerSurface>
        </RadixPortal.Root>
      )}
    </PortalBoundary>
  )
}

/**
 * Present one adapter-owned Relay thread. The uncontrolled form starts collapsed.
 * Desktop rail stays non-modal; desktop overlay and compact viewports trap focus in a sheet.
 */
export const RelayDock = (componentProps: RelayDockProps): ReactElement => {
  const {
    className,
    context,
    defaultOpen = false,
    description = "Ask in this context or prepare approval-bound work.",
    desktopPresentation = "overlay",
    footer,
    onOpenChange,
    open,
    ref,
    selection,
    state,
    title = "Relay",
    triggerLabel = "Open Relay",
    ...props
  } = componentProps
  const [defaultState, setDefaultState] = useState(defaultOpen)
  const parentModalPresent = useParentModalPresent()
  const parentModalReady = useParentModalReady()
  const portalTarget = usePortalTarget()
  const resolvedOpen = (open ?? defaultState) && parentModalReady && portalTarget.available
  const portalView = portalTarget.available ? portalTarget.container.ownerDocument.defaultView : null
  const compactViewport = useCompactViewport(portalView)
  const modal = compactViewport || desktopPresentation === "overlay"
  const triggerRef = useRef<HTMLButtonElement>(null)
  const railCloseRef = useRef<HTMLButtonElement>(null)
  const restoreTargetRef = useRef<HTMLElement>(null)
  const previousStateRef = useRef({ modal, open: false })
  const headingId = useId()
  const visibleDescription = requireText(description, "RelayDock description")
  const visibleTitle = requireText(title, "RelayDock title")
  const visibleTriggerLabel = requireText(triggerLabel, "RelayDock triggerLabel")

  const requestOpenChange = (nextOpen: boolean): void => {
    if (open === undefined) setDefaultState(nextOpen)
    onOpenChange?.(nextOpen)
  }

  useLayoutEffect(() => {
    const previousState = previousStateRef.current
    previousStateRef.current = { modal, open: resolvedOpen }
    if (!previousState.open && resolvedOpen) {
      invalidateModalFocusRestore()
      railCloseRef.current?.focus()
    } else if (previousState.open && resolvedOpen && previousState.modal !== modal) {
      railCloseRef.current?.focus()
    } else if (previousState.open && !resolvedOpen) {
      restoreModalFocusAfterCleanup(restoreTargetRef.current ?? triggerRef.current)
      restoreTargetRef.current = null
    }
  }, [modal, resolvedOpen])

  return (
    <div
      {...props}
      className={classNames(style("root"), className)}
      data-rly-relay-dock=""
      data-rly-relay-dock-open={resolvedOpen ? "true" : "false"}
      ref={ref}
    >
      <button
        aria-expanded={resolvedOpen}
        aria-haspopup={modal ? "dialog" : undefined}
        className={style("trigger")}
        data-rly-relay-dock-trigger=""
        hidden={resolvedOpen}
        onClick={(event) => {
          event.currentTarget.focus()
          requestOpenChange(true)
        }}
        ref={triggerRef}
        type="button"
      >
        <RelayMark />
        <span>{visibleTriggerLabel}</span>
      </button>
      {!resolvedOpen ? null : (
        <ModalNestingBoundary>
          <DockLayer
            closeRef={railCloseRef}
            compactViewport={compactViewport}
            context={context}
            description={visibleDescription}
            footer={footer}
            headingId={headingId}
            modal={modal}
            onClose={() => requestOpenChange(false)}
            parentModalPresent={parentModalPresent}
            restoreDocument={triggerRef.current?.ownerDocument ?? null}
            restoreTargetRef={restoreTargetRef}
            selection={selection}
            state={state}
            title={visibleTitle}
          />
        </ModalNestingBoundary>
      )}
    </div>
  )
}
