import type { ComponentPropsWithRef, ReactElement } from "react"
import { Avatar as RadixAvatar } from "radix-ui"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Avatar.module.css"

const style = (name: string): string => cssClass(styles, name)
export const RLY_AVATAR_VARIANTS = defineVariants({
  size: {
    small: { className: style("small"), purpose: "Compact supporting identity", tokens: ["space-24"] },
    default: { className: style("defaultSize"), purpose: "Standard identity", tokens: ["space-32"] },
    large: { className: style("large"), purpose: "Prominent identity", tokens: ["space-40"] },
    hero: { className: style("hero"), purpose: "Page-level identity", tokens: ["space-48", "space-8"] }
  },
  shape: {
    circle: { className: style("circle"), purpose: "Human or general identity", tokens: ["radius-round"] },
    "rounded-square": {
      className: style("roundedSquare"),
      purpose: "Non-human or system identity",
      tokens: ["radius-field"]
    }
  }
})
export const RLY_AVATAR_DEFAULT_VARIANTS = defineVariants({ size: "default", shape: "circle" })
export type RlyAvatarSize = keyof typeof RLY_AVATAR_VARIANTS.size
export type RlyAvatarShape = keyof typeof RLY_AVATAR_VARIANTS.shape
type AvatarBaseProps = Omit<ComponentPropsWithRef<"span">, "aria-label" | "children"> & {
  readonly fallback: string
  readonly shape?: RlyAvatarShape
  readonly size?: RlyAvatarSize
  readonly src?: string
}
export type AvatarProps = AvatarBaseProps &
  ({ readonly decorative: true; readonly label?: never } | { readonly decorative?: false; readonly label: string })

/** Render a fixed-geometry image with deterministic fallback and owned accessible name. */
export const Avatar = ({
  className,
  decorative,
  fallback,
  label,
  shape = "circle",
  size = "default",
  src,
  ...props
}: AvatarProps): ReactElement => {
  const accessibleLabel = decorative ? undefined : requireText(label, "Avatar label")
  const visibleFallback = requireText(fallback, "Avatar fallback")
  return (
    <RadixAvatar.Root
      {...props}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={accessibleLabel}
      className={classNames(
        style("root"),
        RLY_AVATAR_VARIANTS.size[size].className,
        RLY_AVATAR_VARIANTS.shape[shape].className,
        className
      )}
      role={decorative ? undefined : "img"}
    >
      {src === undefined ? null : (
        <RadixAvatar.Image alt="" className={style("image")} decoding="async" loading="lazy" src={src} />
      )}
      <RadixAvatar.Fallback aria-hidden="true" className={style("fallback")}>
        {visibleFallback}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  )
}
