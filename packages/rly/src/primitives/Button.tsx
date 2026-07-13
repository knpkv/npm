import type { ComponentPropsWithRef, ReactElement } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants } from "../internal/component.js"
import styles from "./Button.module.css"

const style = (name: string): string => cssClass(styles, name)
export const RLY_BUTTON_VARIANTS = defineVariants({
  variant: {
    primary: {
      className: style("primary"),
      purpose: "Single principal action",
      tokens: ["color-action-background", "color-action-foreground"]
    },
    secondary: {
      className: style("secondary"),
      purpose: "Default supporting action",
      tokens: ["color-surface-1", "color-border-2"]
    },
    quiet: {
      className: style("quiet"),
      purpose: "Low-emphasis contextual action",
      tokens: ["color-text-1", "color-surface-2"]
    }
  },
  size: {
    compact: { className: style("compact"), purpose: "Dense text action", tokens: ["space-40"] },
    default: { className: style("defaultSize"), purpose: "Standard action", tokens: ["space-48"] },
    principal: {
      className: style("principal"),
      purpose: "Prominent consequential action",
      tokens: ["space-48", "space-8"]
    }
  }
})
export const RLY_BUTTON_DEFAULT_VARIANTS = defineVariants({ variant: "secondary", size: "default" })
export type RlyButtonVariant = keyof typeof RLY_BUTTON_VARIANTS.variant
export type RlyButtonSize = keyof typeof RLY_BUTTON_VARIANTS.size
export type ButtonProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  /** Plain visible text. Use IconButton for an icon-only action. */
  readonly children: number | string
  readonly leadingIcon?: RlyIconName
  readonly loading?: boolean
  readonly size?: RlyButtonSize
  readonly stretch?: boolean
  readonly trailingIcon?: RlyIconName
  readonly variant?: RlyButtonVariant
}

/** Render a visible-text action with stable disabled and loading geometry. */
export const Button = ({
  children,
  className,
  disabled,
  leadingIcon,
  loading = false,
  size = "default",
  stretch = false,
  trailingIcon,
  type,
  variant = "secondary",
  ...props
}: ButtonProps): ReactElement => {
  if (
    (typeof children !== "number" && typeof children !== "string") ||
    (typeof children === "string" && children.trim().length === 0)
  ) {
    throw new Error("Button children must contain visible content")
  }
  return (
    <button
      {...props}
      aria-busy={loading ? "true" : undefined}
      className={classNames(
        style("root"),
        RLY_BUTTON_VARIANTS.variant[variant].className,
        RLY_BUTTON_VARIANTS.size[size].className,
        stretch && style("stretch"),
        className
      )}
      data-loading={loading ? "true" : undefined}
      disabled={disabled || loading}
      type={type ?? "button"}
    >
      <span className={classNames(style("content"), loading && style("loadingContent"))}>
        {leadingIcon === undefined ? null : (
          <Icon decorative name={leadingIcon} size={size === "compact" ? "small" : "default"} />
        )}
        <span className={style("label")}>{children}</span>
        {trailingIcon === undefined ? null : (
          <Icon decorative name={trailingIcon} size={size === "compact" ? "small" : "default"} />
        )}
      </span>
      {loading ? (
        <span aria-hidden="true" className={style("loader")}>
          <Icon decorative name="loader" size={size === "compact" ? "small" : "default"} />
        </span>
      ) : null}
    </button>
  )
}
