import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./StatePanel.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_STATE_PANEL_VARIANTS = defineVariants({
  tone: {
    neutral: {
      className: style("neutral"),
      purpose: "Neutral explanatory state",
      tokens: ["color-text-2", "color-surface-2"]
    },
    positive: {
      className: style("positive"),
      purpose: "Positive outcome",
      tokens: ["color-success-ink", "color-success-tint"]
    },
    critical: {
      className: style("critical"),
      purpose: "Critical outcome requiring attention",
      tokens: ["color-blocked-ink", "color-blocked-tint"]
    },
    caution: {
      className: style("caution"),
      purpose: "Held outcome requiring review",
      tokens: ["color-held-ink", "color-held-tint"]
    },
    progress: {
      className: style("progress"),
      purpose: "Work currently in progress",
      tokens: ["color-deploying-ink", "color-deploying-tint"]
    }
  }
})

export const RLY_STATE_PANEL_DEFAULT_VARIANTS = defineVariants({ tone: "neutral" })
export type RlyStatePanelTone = keyof typeof RLY_STATE_PANEL_VARIANTS.tone
export type RlyStatePanelAnnouncement = "off" | "polite" | "assertive"

const toneIcons: Readonly<Record<RlyStatePanelTone, RlyIconName>> = {
  neutral: "minus",
  positive: "check",
  critical: "alert",
  caution: "clock",
  progress: "loader"
}

export type StatePanelProps = Omit<ComponentPropsWithRef<"section">, "aria-live" | "children" | "title"> & {
  readonly action?: ReactNode
  readonly announce?: RlyStatePanelAnnouncement
  readonly description?: ReactNode
  readonly icon?: RlyIconName
  readonly title: string
  readonly tone?: RlyStatePanelTone
}

/** Explain an outcome with redundant word, icon, rail, ink, and tint cues. */
export const StatePanel = ({
  action,
  announce = "off",
  className,
  description,
  icon,
  title,
  tone = "neutral",
  ...props
}: StatePanelProps): ReactElement => {
  const role = announce === "assertive" ? "alert" : announce === "polite" ? "status" : undefined

  return (
    <section
      {...props}
      aria-live={announce === "off" ? undefined : announce}
      className={classNames(style("root"), RLY_STATE_PANEL_VARIANTS.tone[tone].className, className)}
      role={role}
    >
      <span aria-hidden="true" className={style("rail")} />
      <span aria-hidden="true" className={style("icon")}>
        <Icon decorative name={icon ?? toneIcons[tone]} />
      </span>
      <div className={style("content")}>
        <strong className={style("title")}>{requireText(title, "StatePanel title")}</strong>
        {description === undefined ? null : <div className={style("description")}>{description}</div>}
        {action === undefined ? null : <div className={style("action")}>{action}</div>}
      </div>
    </section>
  )
}
