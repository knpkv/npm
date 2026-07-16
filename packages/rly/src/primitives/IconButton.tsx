import type { ComponentPropsWithRef, ReactElement } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./IconButton.module.css"

const style = (name: string): string => cssClass(styles, name)
export const RLY_ICON_BUTTON_VARIANTS = defineVariants({
  variant: {
    primary: {
      className: style("primary"),
      purpose: "Principal icon action",
      tokens: ["color-action-background", "color-action-foreground"]
    },
    secondary: {
      className: style("secondary"),
      purpose: "Default icon action",
      tokens: ["color-surface-1", "color-border-2"]
    },
    quiet: {
      className: style("quiet"),
      purpose: "Low-emphasis icon action",
      tokens: ["color-text-1", "color-surface-2"]
    }
  },
  size: {
    compact: {
      className: style("compact"),
      purpose: "Minimum accessible icon target",
      tokens: ["space-40", "space-4"]
    },
    default: { className: style("defaultSize"), purpose: "Standard icon target", tokens: ["space-48"] },
    principal: { className: style("principal"), purpose: "Prominent icon target", tokens: ["space-48", "space-8"] }
  }
})
export const RLY_ICON_BUTTON_DEFAULT_VARIANTS = defineVariants({ variant: "secondary", size: "default" })
export type RlyIconButtonVariant = keyof typeof RLY_ICON_BUTTON_VARIANTS.variant
export type RlyIconButtonSize = keyof typeof RLY_ICON_BUTTON_VARIANTS.size
export type IconButtonProps = Omit<ComponentPropsWithRef<"button">, "aria-label" | "children"> & {
  readonly icon: RlyIconName
  readonly label: string
  readonly loading?: boolean
  readonly size?: RlyIconButtonSize
  readonly variant?: RlyIconButtonVariant
}

/** Render an icon-only action whose accessible name is mandatory and owned. */
export const IconButton = ({
  className,
  disabled,
  icon,
  label,
  loading = false,
  size = "default",
  type,
  variant = "secondary",
  ...props
}: IconButtonProps): ReactElement => (
  <button
    {...props}
    aria-busy={loading ? "true" : undefined}
    aria-label={requireText(label, "IconButton label")}
    className={classNames(
      style("root"),
      RLY_ICON_BUTTON_VARIANTS.variant[variant].className,
      RLY_ICON_BUTTON_VARIANTS.size[size].className,
      className
    )}
    data-loading={loading ? "true" : undefined}
    disabled={disabled || loading}
    type={type ?? "button"}
  >
    <Icon decorative name={loading ? "loader" : icon} size={size === "compact" ? "small" : "default"} />
  </button>
)
