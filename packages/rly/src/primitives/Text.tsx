import {
  createElement,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref
} from "react"
import { classNames, cssClass, defineVariants } from "../internal/component.js"
import styles from "./Text.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_TEXT_VARIANTS = defineVariants({
  variant: {
    verdict: { className: style("verdict"), purpose: "One restrained verdict thesis", tokens: ["type-verdict"] },
    "page-title": { className: style("pageTitle"), purpose: "Primary page title", tokens: ["type-page-title"] },
    "section-title": { className: style("sectionTitle"), purpose: "Section heading", tokens: ["type-section-title"] },
    "card-title": { className: style("cardTitle"), purpose: "Card or panel heading", tokens: ["type-card-title"] },
    "body-large": { className: style("bodyLarge"), purpose: "Leading explanatory copy", tokens: ["type-body-large"] },
    body: { className: style("body"), purpose: "Default interface copy", tokens: ["type-body"] },
    label: { className: style("label"), purpose: "Control and metadata labels", tokens: ["type-label"] },
    meta: { className: style("meta"), purpose: "Supporting metadata", tokens: ["type-meta"] },
    code: { className: style("code"), purpose: "Code and tabular data", tokens: ["type-code"] }
  },
  tone: {
    primary: { className: style("tonePrimary"), purpose: "Primary readable text", tokens: ["color-text-1"] },
    secondary: { className: style("toneSecondary"), purpose: "Supporting text", tokens: ["color-text-2"] },
    tertiary: { className: style("toneTertiary"), purpose: "Restricted tertiary text", tokens: ["color-text-3"] },
    inherit: { className: style("toneInherit"), purpose: "Inherit semantic context", tokens: [] }
  }
})

export const RLY_TEXT_DEFAULT_VARIANTS = defineVariants({ variant: "body", tone: "primary" })
export type RlyTextVariant = keyof typeof RLY_TEXT_VARIANTS.variant
export type RlyTextTone = keyof typeof RLY_TEXT_VARIANTS.tone
export type RlyTextElement =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "span"
  | "strong"
  | "small"
  | "code"
  | "pre"
  | "time"
  | "li"
  | "dt"
  | "dd"

type HeadingVariant = "page-title" | "section-title" | "card-title"
type HeadingElement = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "span"
type OtherVariant = Exclude<RlyTextVariant, HeadingVariant>
type RefTarget<Value> = Value extends Ref<infer Target> ? Target : never
type ExactRef<Expected, Value> =
  Value extends Ref<Expected> ? (Expected extends RefTarget<Value> ? Value : never) : never
type TextOwnProps = {
  readonly children: ReactNode
  readonly tone?: RlyTextTone
}
type ExplicitVariantProps<Element extends RlyTextElement> =
  { readonly variant?: OtherVariant } | (Element extends HeadingElement ? { readonly variant: HeadingVariant } : never)
type ExplicitTextProps<Element extends RlyTextElement, ElementRef extends Ref<HTMLElementTagNameMap[Element]>> = Omit<
  ComponentPropsWithoutRef<Element>,
  "as" | "children" | "color"
> &
  TextOwnProps &
  ExplicitVariantProps<Element> & {
    readonly as: Element
    readonly ref?: ExactRef<HTMLElementTagNameMap[Element], ElementRef>
  }
type ImplicitTextProps = Omit<HTMLAttributes<HTMLElement>, "children" | "color"> &
  TextOwnProps & {
    readonly as?: never
    readonly ref?: never
    readonly variant?: OtherVariant
  }
export type TextProps<
  Element extends RlyTextElement = RlyTextElement,
  ElementRef extends Ref<HTMLElementTagNameMap[Element]> = Ref<HTMLElementTagNameMap[Element]>
> = ExplicitTextProps<Element, ElementRef> | ImplicitTextProps

type TextComponent = <
  const Element extends RlyTextElement = RlyTextElement,
  ElementRef extends Ref<HTMLElementTagNameMap[Element]> = Ref<HTMLElementTagNameMap[Element]>
>(
  props: TextProps<Element, ElementRef>
) => ReactElement
type TextRuntimeProps = Omit<HTMLAttributes<HTMLElement>, "color"> &
  TextOwnProps & {
    readonly as?: RlyTextElement
    readonly ref?: Ref<HTMLElement>
    readonly variant?: RlyTextVariant
  }

const defaultElement = (variant: RlyTextVariant): RlyTextElement =>
  variant === "code" ? "code" : variant === "verdict" ? "p" : variant === "label" || variant === "meta" ? "span" : "p"

/** Render semantic typography while keeping visual role separate from document structure. */
const renderText = ({
  as,
  children,
  className,
  ref,
  tone = RLY_TEXT_DEFAULT_VARIANTS.tone,
  variant = RLY_TEXT_DEFAULT_VARIANTS.variant,
  ...props
}: TextRuntimeProps): ReactElement =>
  createElement(
    as ?? defaultElement(variant),
    {
      ...props,
      className: classNames(
        style("root"),
        RLY_TEXT_VARIANTS.variant[variant].className,
        RLY_TEXT_VARIANTS.tone[tone].className,
        className
      ),
      ref
    },
    children
  )

export const Text: TextComponent = renderText
