import type { ComponentPropsWithRef, CSSProperties, ReactElement } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Skeleton.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_SKELETON_VARIANTS = defineVariants({
  variant: {
    text: { className: style("text"), purpose: "A line of unavailable copy", tokens: ["type-body", "radius-tag"] },
    block: {
      className: style("block"),
      purpose: "A rectangular unavailable region",
      tokens: ["space-64", "radius-control"]
    },
    circle: { className: style("circle"), purpose: "A circular unavailable image", tokens: ["radius-round"] }
  }
})

export const RLY_SKELETON_DEFAULT_VARIANTS = defineVariants({ variant: "text" })
export type RlySkeletonVariant = keyof typeof RLY_SKELETON_VARIANTS.variant

type SkeletonBaseProps = Omit<ComponentPropsWithRef<"div">, "aria-label" | "children" | "style"> & {
  readonly height?: CSSProperties["blockSize"]
  readonly style?: CSSProperties
  readonly variant?: RlySkeletonVariant
  readonly width?: CSSProperties["inlineSize"]
}
export type SkeletonProps = SkeletonBaseProps &
  ({ readonly decorative?: true; readonly label?: never } | { readonly decorative: false; readonly label: string })

/** Reserve content geometry without suggesting progress or motion. */
export const Skeleton = ({
  className,
  decorative = true,
  height,
  label,
  style: inlineStyle,
  variant = "text",
  width,
  ...props
}: SkeletonProps): ReactElement => {
  if (!decorative && label === undefined) throw new Error("Skeleton label must contain visible text")
  const accessibleLabel = decorative || label === undefined ? undefined : requireText(label, "Skeleton label")
  const dimensions: CSSProperties = {
    ...(height === undefined ? {} : { blockSize: height }),
    ...(width === undefined ? {} : { inlineSize: width })
  }

  return (
    <div
      {...props}
      aria-busy={decorative ? undefined : "true"}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={accessibleLabel}
      className={classNames(style("root"), RLY_SKELETON_VARIANTS.variant[variant].className, className)}
      role={decorative ? "presentation" : "status"}
      style={{ ...inlineStyle, ...dimensions }}
    />
  )
}
