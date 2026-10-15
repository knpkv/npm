/** Idle loops share document observers. Invisible creatures keep their phase without running animations. */
import { type RefObject, useEffect } from "react"

interface VisibilityOwner {
  readonly intersection: IntersectionObserver
  readonly resize: ResizeObserver
  readonly nodes: Map<Element, SVGSVGElement>
}

const owners = new WeakMap<Document, VisibilityOwner>()

const ownerFor = (document: Document): VisibilityOwner => {
  const existing = owners.get(document)
  if (existing !== undefined) return existing
  const nodes = new Map<Element, SVGSVGElement>()
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute("data-motion-visible", entry.isIntersecting)
  })
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      // The registration map proves which observer targets belong to this SVG owner.
      const node = nodes.get(entry.target)
      if (node === undefined || entry.contentRect.width <= 0) continue
      // Habit travel is in painted CSS pixels at every app slot, not SVG user units.
      node.style.setProperty("--connect-creature-pixel", String(node.viewBox.baseVal.width / entry.contentRect.width))
    }
  })
  const owner = { intersection, resize, nodes }
  owners.set(document, owner)
  return owner
}

/** Starts paused until the first visibility sample; cleanup releases only this SVG's subscriptions. */
export const useCreatureVisibility = (root: RefObject<SVGSVGElement | null>, active: boolean): void => {
  useEffect(() => {
    const node = root.current
    if (!active || node === null) return
    const document = node.ownerDocument
    const owner = ownerFor(document)
    owner.nodes.set(node, node)
    owner.intersection.observe(node)
    owner.resize.observe(node)
    return () => {
      owner.intersection.unobserve(node)
      owner.resize.unobserve(node)
      owner.nodes.delete(node)
      node.removeAttribute("data-motion-visible")
      if (owner.nodes.size === 0) {
        owner.intersection.disconnect()
        owner.resize.disconnect()
        owners.delete(document)
      }
    }
  }, [active, root])
}
