import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants } from "../internal/component.js"
import styles from "./Notice.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_NOTICE_VARIANTS = defineVariants({
  tone: {
    neutral: {
      className: style("neutral"),
      purpose: "Neutral context",
      tokens: ["color-text-2", "color-surface-2", "color-border-1"]
    },
    positive: {
      className: style("positive"),
      purpose: "Completed outcome",
      tokens: ["color-success-ink", "color-success-tint"]
    },
    critical: {
      className: style("critical"),
      purpose: "Failure that needs attention",
      tokens: ["color-blocked-ink", "color-blocked-tint"]
    },
    caution: {
      className: style("caution"),
      purpose: "Limitation or warning",
      tokens: ["color-held-ink", "color-held-tint"]
    },
    progress: {
      className: style("progress"),
      purpose: "Work in progress",
      tokens: ["color-deploying-ink", "color-deploying-tint"]
    }
  }
})

export const RLY_NOTICE_DEFAULT_VARIANTS = defineVariants({ tone: "neutral" })
export type RlyNoticeTone = keyof typeof RLY_NOTICE_VARIANTS.tone
export type RlyNoticeAnnouncement = "off" | "polite" | "assertive"

// Neutral encodes nothing, so it carries no glyph unless the caller asks for one.
const toneIcons = {
  neutral: undefined,
  positive: "check",
  critical: "alert",
  caution: "clock",
  progress: "loader"
} satisfies Readonly<Record<RlyNoticeTone, RlyIconName | undefined>>

export type NoticeProps = Omit<ComponentPropsWithRef<"div">, "aria-live" | "children"> & {
  readonly action?: ReactNode
  readonly announce?: RlyNoticeAnnouncement
  readonly children: ReactNode
  readonly icon?: RlyIconName
  readonly tone?: RlyNoticeTone
}

/**
 * Say one sentence of context or outcome inline, between controls and content.
 * Use `StatePanel` instead when the state needs a title and replaces a region.
 * The caller owns lifecycle: there is no dismiss control.
 *
 * The tone icon is decorative, so `children` must state the tone in words
 * ("Sync failed: …"), not rely on color and glyph.
 *
 * `announce` makes the notice a live region. Screen readers announce changes
 * inside a region that is already mounted, not the region appearing: mount it
 * persistently and swap its children, or keep `announce="off"` for static text.
 *
 * @example
 * <Notice tone="caution">Jira is read-only for this week.</Notice>
 * <Notice announce="assertive" tone="critical" action={<Button size="compact">Retry</Button>}>
 *   Clockify rejected the entry.
 * </Notice>
 */
export const Notice = ({
  action,
  announce = "off",
  children,
  className,
  icon,
  tone = "neutral",
  ...props
}: NoticeProps): ReactElement => {
  const glyph = icon ?? toneIcons[tone]
  // An announcing region owns its role; otherwise the caller's role (for example "note") stands.
  const role = announce === "assertive" ? "alert" : announce === "polite" ? "status" : props.role

  return (
    <div
      {...props}
      aria-live={announce === "off" ? undefined : announce}
      className={classNames(style("root"), RLY_NOTICE_VARIANTS.tone[tone].className, className)}
      role={role}
    >
      {glyph === undefined ? null : (
        <span aria-hidden="true" className={style("icon")}>
          <Icon decorative name={glyph} size="small" />
        </span>
      )}
      <div className={style("message")}>{children}</div>
      {action === undefined ? null : <div className={style("action")}>{action}</div>}
    </div>
  )
}
