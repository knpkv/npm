import type { ComponentPropsWithRef, ReactElement } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Verdict.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable semantic context choices for a caller-supplied Verdict. */
export const RLY_VERDICT_VARIANTS = defineVariants({
  tone: {
    caution: {
      className: style("caution"),
      purpose: "Intentional hold or caution requiring attention",
      tokens: ["color-held-ink", "color-held-tint"]
    },
    critical: {
      className: style("critical"),
      purpose: "Explicit blocker or failed prerequisite",
      tokens: ["color-blocked-ink", "color-blocked-tint"]
    },
    neutral: {
      className: style("neutral"),
      purpose: "Neutral, missing, or unavailable outcome",
      tokens: ["color-text-2", "color-surface-2"]
    },
    positive: {
      className: style("positive"),
      purpose: "Satisfied readiness or successful outcome",
      tokens: ["color-success-ink", "color-success-tint"]
    },
    progress: {
      className: style("progress"),
      purpose: "Active work or delivery progress",
      tokens: ["color-deploying-ink", "color-deploying-tint"]
    }
  }
})

/** Owned semantic presentation tone; it does not derive application readiness. */
export type RlyVerdictTone = keyof typeof RLY_VERDICT_VARIANTS.tone

/** Minimal presentation-only Verdict props supplied by an authoritative application presenter. */
export type VerdictProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  /** Required concise evidence or explanation supplied by the application. */
  readonly reason: string
  /** Explicit semantic style only; no readiness or authorization is derived. */
  readonly tone: RlyVerdictTone
  /** Required neutral verdict word or thesis supplied by the application. */
  readonly verdict: string
}

const toneIcons: Readonly<Record<RlyVerdictTone, RlyIconName>> = {
  caution: "clock",
  critical: "alert",
  neutral: "minus",
  positive: "check",
  progress: "loader"
}

/** Render a neutral giant verdict with explicit icon, semantic rail, and supplied reason. */
export const Verdict = ({ className, reason, tone, verdict, ...props }: VerdictProps): ReactElement => {
  const visibleReason = requireText(reason, "Verdict reason")
  const visibleVerdict = requireText(verdict, "Verdict verdict")

  return (
    <section
      {...props}
      className={classNames(style("root"), RLY_VERDICT_VARIANTS.tone[tone].className, className)}
      data-rly-verdict-tone={tone}
    >
      <h2 className={style("verdict")}>{visibleVerdict}</h2>
      <div className={style("reasonPanel")}>
        <span aria-hidden="true" className={style("icon")}>
          <Icon decorative name={toneIcons[tone]} size="large" />
        </span>
        <p className={style("reason")}>{visibleReason}</p>
      </div>
    </section>
  )
}
