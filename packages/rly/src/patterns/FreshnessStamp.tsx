import type { ComponentPropsWithRef, ReactElement } from "react"
import { Icon, type RlyIconName } from "../foundations/Icon.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./FreshnessStamp.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable freshness states and density choices. */
export const RLY_FRESHNESS_STAMP_VARIANTS = defineVariants({
  state: {
    current: {
      className: style("current"),
      purpose: "Current source observation",
      tokens: ["color-success-ink", "color-success-tint"]
    },
    cached: {
      className: style("cached"),
      purpose: "Valid cached source observation",
      tokens: ["color-text-2", "color-surface-2"]
    },
    stale: {
      className: style("stale"),
      purpose: "Source observation beyond its supplied freshness threshold",
      tokens: ["color-held-ink", "color-held-tint"]
    },
    missing: {
      className: style("missing"),
      purpose: "Provider authoritatively reported no object",
      tokens: ["color-text-2", "color-surface-2"]
    },
    unavailable: {
      className: style("unavailable"),
      purpose: "No valid source observation is available",
      tokens: ["color-blocked-ink", "color-blocked-tint"]
    }
  },
  size: {
    compact: { className: style("compact"), purpose: "Dense freshness metadata", tokens: ["type-meta"] },
    default: {
      className: style("defaultSize"),
      purpose: "Standard freshness metadata",
      tokens: ["type-label", "type-meta"]
    }
  }
})

/** Default FreshnessStamp density. Freshness state is always supplied explicitly. */
export const RLY_FRESHNESS_STAMP_DEFAULT_VARIANTS = defineVariants({ size: "default" })

/** Explicit freshness states supplied by an application presenter. */
export type RlyFreshnessState = keyof typeof RLY_FRESHNESS_STAMP_VARIANTS.state

/** Visual density supported by FreshnessStamp. */
export type RlyFreshnessStampSize = keyof typeof RLY_FRESHNESS_STAMP_VARIANTS.size

const freshnessWords: Readonly<Record<RlyFreshnessState, string>> = {
  current: "Current",
  cached: "Cached",
  stale: "Stale",
  missing: "Missing",
  unavailable: "Unavailable"
}

const freshnessIcons: Readonly<Record<RlyFreshnessState, RlyIconName>> = {
  current: "check",
  cached: "clock",
  stale: "clock",
  missing: "minus",
  unavailable: "alert"
}

type FreshnessTimeProps =
  { readonly dateTime: string; readonly time: string } | { readonly dateTime?: never; readonly time?: never }

/** Props for an explicit freshness word with an optional application-formatted time. */
export type FreshnessStampProps = Omit<ComponentPropsWithRef<"span">, "children"> &
  FreshnessTimeProps & {
    readonly size?: RlyFreshnessStampSize
    readonly state: RlyFreshnessState
  }

/** Render supplied freshness without deriving thresholds, state, or relative time. */
export const FreshnessStamp = ({
  className,
  dateTime,
  size = "default",
  state,
  time,
  ...props
}: FreshnessStampProps): ReactElement => {
  const visibleTime = time === undefined ? undefined : requireText(time, "FreshnessStamp time")
  const machineTime = dateTime === undefined ? undefined : requireText(dateTime, "FreshnessStamp dateTime")
  return (
    <span
      {...props}
      className={classNames(
        style("root"),
        RLY_FRESHNESS_STAMP_VARIANTS.state[state].className,
        RLY_FRESHNESS_STAMP_VARIANTS.size[size].className,
        className
      )}
      data-rly-freshness-state={state}
    >
      <span className={style("stateWord")}>
        <Icon decorative name={freshnessIcons[state]} size="small" />
        <span>{freshnessWords[state]}</span>
      </span>
      {visibleTime === undefined || machineTime === undefined ? null : (
        <>
          <span aria-hidden="true" className={style("separator")}>
            ·
          </span>
          <time className={style("time")} dateTime={machineTime}>
            {visibleTime}
          </time>
        </>
      )}
    </span>
  )
}
