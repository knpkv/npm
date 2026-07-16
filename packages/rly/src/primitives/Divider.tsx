import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Divider.module.css"

const style = (name: string): string => cssClass(styles, name)
export const RLY_DIVIDER_VARIANTS = defineVariants({
  orientation: {
    horizontal: { className: style("horizontal"), purpose: "Separate stacked content", tokens: ["space-0"] },
    vertical: { className: style("vertical"), purpose: "Separate adjacent content", tokens: ["space-0"] }
  },
  strength: {
    subtle: { className: style("subtle"), purpose: "Quiet structural boundary", tokens: ["color-border-1"] },
    strong: { className: style("strong"), purpose: "Explicit structural boundary", tokens: ["color-border-2"] }
  }
})
export const RLY_DIVIDER_DEFAULT_VARIANTS = defineVariants({ orientation: "horizontal", strength: "subtle" })
export type RlyDividerOrientation = keyof typeof RLY_DIVIDER_VARIANTS.orientation
export type RlyDividerStrength = keyof typeof RLY_DIVIDER_VARIANTS.strength
type DividerBaseProps = Omit<ComponentPropsWithRef<"div">, "aria-label" | "children" | "role">
export type DividerProps = DividerBaseProps & {
  readonly orientation?: RlyDividerOrientation
  readonly strength?: RlyDividerStrength
} & ({ readonly decorative?: true; readonly label?: never } | { readonly decorative: false; readonly label: string })

/** Separate content visually or, when explicitly labelled, semantically. */
export const Divider = ({
  className,
  decorative = true,
  label,
  orientation = "horizontal",
  strength = "subtle",
  ...props
}: DividerProps): ReactElement => {
  if (!decorative && label === undefined) throw new Error("Semantic Divider label must contain visible text")
  const accessibleLabel = decorative || label === undefined ? undefined : requireText(label, "Semantic Divider label")
  return (
    <div
      {...props}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={accessibleLabel}
      aria-orientation={decorative ? undefined : orientation}
      className={classNames(
        style("root"),
        RLY_DIVIDER_VARIANTS.orientation[orientation].className,
        RLY_DIVIDER_VARIANTS.strength[strength].className,
        className
      )}
      role={decorative ? "presentation" : "separator"}
    />
  )
}
