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
      tokens: ["color-text-2", "color-border-2"]
    },
    positive: {
      className: style("positive"),
      purpose: "Positive outcome",
      tokens: ["color-success-ink"]
    },
    critical: {
      className: style("critical"),
      purpose: "Critical outcome requiring attention",
      tokens: ["color-blocked-ink"]
    },
    caution: {
      className: style("caution"),
      purpose: "Held outcome requiring review",
      tokens: ["color-held-ink"]
    },
    progress: {
      className: style("progress"),
      purpose: "Work currently in progress",
      tokens: ["color-deploying-ink"]
    }
  }
})

export const RLY_STATE_PANEL_DEFAULT_VARIANTS = defineVariants({ tone: "neutral" })
export type RlyStatePanelTone = keyof typeof RLY_STATE_PANEL_VARIANTS.tone
export type RlyStatePanelAnnouncement = "off" | "polite" | "assertive"

// Neutral has no glyph by default: a dash read as a stray mark, and the word already carries it.
const toneIcons = {
  neutral: undefined,
  positive: "check",
  critical: "alert",
  caution: "clock",
  progress: "loader"
} satisfies Readonly<Record<RlyStatePanelTone, RlyIconName | undefined>>

export type StatePanelProps = Omit<ComponentPropsWithRef<"section">, "aria-live" | "children" | "title"> & {
  readonly action?: ReactNode
  readonly announce?: RlyStatePanelAnnouncement
  readonly description?: ReactNode
  readonly icon?: RlyIconName
  readonly title: string
  readonly tone?: RlyStatePanelTone
}

/**
 * Explain an outcome with redundant word, icon, ink, and tint cues. A neutral panel shows no
 * icon unless `icon` names one.
 *
 * `announce` makes the panel a live region. A polite status region reliably announces
 * changes only once it is already mounted: mount it persistently and swap its content.
 * An assertive alert may announce as soon as it is inserted. Keep `announce="off"`
 * for static states.
 */
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
  // An announcing region owns its role; otherwise the caller's role (for example "note") stands.
  const role = announce === "assertive" ? "alert" : announce === "polite" ? "status" : props.role
  const glyph = icon ?? toneIcons[tone]

  return (
    <section
      {...props}
      aria-live={announce === "off" ? undefined : announce}
      className={classNames(style("root"), RLY_STATE_PANEL_VARIANTS.tone[tone].className, className)}
      data-icon={glyph === undefined ? "none" : undefined}
      role={role}
    >
      {glyph === undefined ? null : (
        <span aria-hidden="true" className={style("icon")}>
          <Icon decorative name={glyph} />
        </span>
      )}
      <div className={style("content")}>
        <strong className={style("title")}>{requireText(title, "StatePanel title")}</strong>
        {description === undefined ? null : <div className={style("description")}>{description}</div>}
        {action === undefined ? null : <div className={style("action")}>{action}</div>}
      </div>
    </section>
  )
}
