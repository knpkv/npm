// Focus helpers that see through shadow roots and slots, shared by Relay's dock and its keyboard summon.
import { isHTMLElement } from "./modal.js"
import * as Predicate from "./predicates.js"

const hasActiveElement = (node: Node): node is Node & DocumentOrShadowRoot => "activeElement" in node

interface ShadowRootHost extends Node {
  readonly host: Element
}

export const hasShadowRootHost = (value: Node): value is ShadowRootHost =>
  "host" in value && Predicate.isObjectOrArray(value.host)

const deepActiveElement = (root: DocumentOrShadowRoot): Element | null => {
  const active = root.activeElement
  if (active === null) return null
  if (active.shadowRoot !== null) return deepActiveElement(active.shadowRoot) ?? active
  return active
}

export const activeElementFor = (panel: HTMLElement): Element | null => {
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

export const composedParentFor = (node: Node, composedParents?: ReadonlyMap<Node, Node | null>): Element | null => {
  if (composedParents !== undefined && composedParents.has(node)) {
    const parent = composedParents.get(node)
    return parent !== null && parent !== undefined && isElementNode(parent) ? parent : null
  }
  const assignedSlot = hasAssignedSlot(node) ? node.assignedSlot : null
  return assignedSlot ?? node.parentElement ?? shadowHostFor(node)
}

export const isWithinComposedElement = (
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

export const isWithinPanel = (panel: HTMLElement, active: Element | null): boolean =>
  isWithinComposedElement(panel, active)

const deepActiveHTMLElement = (root: DocumentOrShadowRoot): HTMLElement | null => {
  const active = root.activeElement
  if (!isHTMLElement(active)) return null
  return active.shadowRoot === null ? active : (deepActiveHTMLElement(active.shadowRoot) ?? active)
}

export const focusRestoreTarget = (ownerDocument: Document): HTMLElement | null => {
  const active = deepActiveHTMLElement(ownerDocument)
  return active === ownerDocument.body || active === ownerDocument.documentElement ? null : active
}
