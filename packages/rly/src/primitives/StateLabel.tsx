import type { ComponentPropsWithRef, ReactElement } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./StateLabel.module.css"

const style = (name: string): string => cssClass(styles, name)
export type RlyStateTone = "neutral" | "positive" | "critical" | "caution" | "progress"
export const RLY_STATE_LABEL_VARIANTS = defineVariants({
  tone: {
    neutral: {
      className: style("neutral"),
      purpose: "Neutral or unavailable state",
      tokens: ["color-text-2", "color-surface-2"]
    },
    positive: {
      className: style("positive"),
      purpose: "Positive state",
      tokens: ["color-success-ink", "color-success-tint"]
    },
    critical: {
      className: style("critical"),
      purpose: "Critical state",
      tokens: ["color-blocked-ink", "color-blocked-tint"]
    },
    caution: { className: style("caution"), purpose: "Caution state", tokens: ["color-held-ink", "color-held-tint"] },
    progress: {
      className: style("progress"),
      purpose: "Work in progress",
      tokens: ["color-deploying-ink", "color-deploying-tint"]
    }
  },
  size: {
    compact: { className: style("compact"), purpose: "Dense metadata state", tokens: ["type-meta"] },
    default: { className: style("defaultSize"), purpose: "Standard explicit state", tokens: ["type-label"] }
  }
})
export const RLY_STATE_LABEL_DEFAULT_VARIANTS = defineVariants({ tone: "neutral", size: "default" })
export type RlyStateLabelSize = keyof typeof RLY_STATE_LABEL_VARIANTS.size
const toneIcons: Readonly<Record<RlyStateTone, RlyIconName>> = {
  neutral: "minus",
  positive: "check",
  critical: "alert",
  caution: "clock",
  progress: "loader"
}
export type StateLabelProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  readonly icon?: RlyIconName
  readonly label: string
  readonly size?: RlyStateLabelSize
  readonly tone?: RlyStateTone
}

/** Render state through a visible word, icon, ink, and restrained tint. */
export const StateLabel = ({
  className,
  icon,
  label,
  size = "default",
  tone = "neutral",
  ...props
}: StateLabelProps): ReactElement => (
  <span
    {...props}
    className={classNames(
      style("root"),
      RLY_STATE_LABEL_VARIANTS.tone[tone].className,
      RLY_STATE_LABEL_VARIANTS.size[size].className,
      className
    )}
  >
    <Icon decorative name={icon ?? toneIcons[tone]} size="small" />
    <span>{requireText(label, "StateLabel label")}</span>
  </span>
)
