import { createElement, type ComponentPropsWithoutRef, type ReactElement, type ReactNode, type Ref } from "react"
import { classNames, cssClass, defineVariants } from "../internal/component.js"
import styles from "./Surface.module.css"

const style = (name: string): string => cssClass(styles, name)
export const RLY_SURFACE_VARIANTS = defineVariants({
  tone: {
    primary: {
      className: style("tonePrimary"),
      purpose: "Primary bordered surface",
      tokens: ["color-surface-1", "color-border-1"]
    },
    secondary: { className: style("toneSecondary"), purpose: "Quiet secondary surface", tokens: ["color-surface-2"] },
    tertiary: { className: style("toneTertiary"), purpose: "Inset tertiary surface", tokens: ["color-surface-3"] }
  },
  shape: {
    card: { className: style("shapeCard"), purpose: "Standard card geometry", tokens: ["radius-control"] },
    grouped: { className: style("shapeGrouped"), purpose: "Grouped content geometry", tokens: ["radius-group"] }
  },
  padding: {
    none: { className: style("paddingNone"), purpose: "Caller-owned internal layout", tokens: ["space-0"] },
    compact: { className: style("paddingCompact"), purpose: "Dense supporting content", tokens: ["space-16"] },
    default: { className: style("paddingDefault"), purpose: "Standard content", tokens: ["space-24"] },
    spacious: { className: style("paddingSpacious"), purpose: "Prominent grouped content", tokens: ["space-32"] }
  }
})
export const RLY_SURFACE_DEFAULT_VARIANTS = defineVariants({ tone: "primary", shape: "card", padding: "default" })
export type RlySurfaceTone = keyof typeof RLY_SURFACE_VARIANTS.tone
export type RlySurfaceShape = keyof typeof RLY_SURFACE_VARIANTS.shape
export type RlySurfacePadding = keyof typeof RLY_SURFACE_VARIANTS.padding
export type RlySurfaceElement = "div" | "section" | "article" | "aside"

type RefTarget<Value> = Value extends Ref<infer Target> ? Target : never
type ExactRef<Expected, Value> =
  Value extends Ref<Expected> ? (Expected extends RefTarget<Value> ? Value : never) : never

export type SurfaceProps<
  Element extends RlySurfaceElement = "div",
  ElementRef extends Ref<HTMLElementTagNameMap[Element]> = Ref<HTMLElementTagNameMap[Element]>
> = Omit<ComponentPropsWithoutRef<Element>, "children" | "color"> & {
  readonly as?: Element
  readonly children: ReactNode
  readonly padding?: RlySurfacePadding
  readonly ref?: ExactRef<HTMLElementTagNameMap[Element], ElementRef>
  readonly shape?: RlySurfaceShape
  readonly tone?: RlySurfaceTone
}

/** Render a quiet, non-interactive structural surface without elevation semantics. */
export const Surface = <
  const Element extends RlySurfaceElement = "div",
  ElementRef extends Ref<HTMLElementTagNameMap[Element]> = Ref<HTMLElementTagNameMap[Element]>
>({
  as,
  children,
  className,
  padding = "default",
  ref,
  shape = "card",
  tone = "primary",
  ...props
}: SurfaceProps<Element, ElementRef>): ReactElement =>
  createElement(
    as ?? "div",
    {
      ...props,
      className: classNames(
        style("root"),
        RLY_SURFACE_VARIANTS.tone[tone].className,
        RLY_SURFACE_VARIANTS.shape[shape].className,
        RLY_SURFACE_VARIANTS.padding[padding].className,
        className
      ),
      ref
    },
    children
  )
