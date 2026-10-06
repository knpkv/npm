import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./LimitTrack.module.css"

const style = (name: string): string => cssClass(styles, name)
export const RLY_LIMIT_TRACK_VARIANTS = defineVariants({
  size: {
    default: {
      className: style("defaultSize"),
      purpose: "A limit beside its numbers",
      tokens: ["space-12", "radius-tag"]
    },
    slim: { className: style("slim"), purpose: "A limit inside a dense row", tokens: ["space-6", "radius-tag"] }
  }
})
export const RLY_LIMIT_TRACK_DEFAULT_VARIANTS = defineVariants({ size: "default" })
export type RlyLimitTrackSize = keyof typeof RLY_LIMIT_TRACK_VARIANTS.size
/** How full a limit is: no reading, comfortable, past the near mark, or at the limit. */
export type RlyLimitTrackTone = "unknown" | "ok" | "near" | "full"

/** A reading that is not a finite number (for example a failed division) is no reading at all. */
const readingOf = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? value : null)

const requireFinite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

/**
 * Tone of a reading in percent against the near mark; 100% and above is full, a non-finite reading
 * is unknown, and a non-finite near mark throws, as it does on the component.
 */
export const limitTrackTone = (value: number | null, near: number): RlyLimitTrackTone => {
  const mark = requireFinite(near, "limitTrackTone near")
  const reading = readingOf(value)
  return reading === null ? "unknown" : reading >= 100 ? "full" : reading >= mark ? "near" : "ok"
}

const percent = (value: number): number => Math.min(100, Math.max(0, value))

type LimitTrackBaseProps = Omit<ComponentPropsWithRef<"span">, "aria-label" | "children" | "role">
export type LimitTrackProps = LimitTrackBaseProps & {
  /**
   * Latest reading in percent of the limit; `null` when there is none. Values past 100 fill the track.
   * A non-finite value is drawn and announced as no reading.
   */
  readonly value: number | null
  /** Where the caller expects the limit to stand later (for example at its reset), in percent. Non-finite draws none. */
  readonly projected?: number
  /** The near-limit mark in percent. Defaults to 80; a non-finite mark throws. */
  readonly near?: number
  /** The reading is old: it says how full the limit was, not how full it is. */
  readonly stale?: boolean
  readonly size?: RlyLimitTrackSize
} & (
    | { readonly decorative?: true; readonly label?: never; readonly valueText?: never }
    | { readonly decorative: false; readonly label: string; readonly valueText: string }
  )

/**
 * A 0–100% limit track. The solid fill is the latest reading, a dotted extension shows a projected
 * level the caller computed, and a hairline marks the near threshold. A stale reading is hatched.
 * Decorative by default, because the caller prints the number beside it. A decorative track hides
 * everything it draws, so that adjacent text must also say when the reading is old and what the
 * projection is (for example "61%, old reading" or "84%, about 103% at reset"). Pass
 * `decorative={false}` with a label and the caller's own words for the value to expose it as a meter.
 * An unknown reading draws a faint full-width hatch in a dashed edge, never an empty (0%) track, and
 * when announced is a named image with the label and value description, without a numeric range.
 */
export const LimitTrack = ({
  className,
  decorative = true,
  label,
  near = 80,
  projected,
  size = RLY_LIMIT_TRACK_DEFAULT_VARIANTS.size,
  stale = false,
  value: rawValue,
  valueText,
  ...props
}: LimitTrackProps): ReactElement => {
  const value = readingOf(rawValue)
  const nearMark = requireFinite(near, "LimitTrack near")
  // An explicit `decorative={false}` is a promise to announce the track; a missing label or value
  // text (possible from untyped callers) throws instead of quietly hiding it.
  const accessible = !decorative
  const accessibleLabel = accessible ? requireText(label ?? "", "LimitTrack label") : undefined
  const accessibleValueText = accessible ? requireText(valueText ?? "", "LimitTrack valueText") : undefined
  const meter = accessible && value !== null
  const projection =
    value !== null && projected !== undefined && Number.isFinite(projected) && projected > value
      ? { start: percent(value), length: percent(projected) - percent(value) }
      : null
  return (
    <span
      {...props}
      aria-hidden={accessible ? undefined : "true"}
      aria-label={accessible && !meter ? `${accessibleLabel}: ${accessibleValueText}` : accessibleLabel}
      aria-valuemax={meter ? 100 : undefined}
      aria-valuemin={meter ? 0 : undefined}
      aria-valuenow={meter && value !== null ? percent(value) : undefined}
      aria-valuetext={meter ? accessibleValueText : undefined}
      className={classNames(style("root"), RLY_LIMIT_TRACK_VARIANTS.size[size].className, className)}
      data-stale={stale ? "true" : undefined}
      data-tone={limitTrackTone(value, nearMark)}
      role={accessible ? (meter ? "meter" : "img") : undefined}
    >
      {value === null ? null : (
        <span className={style("fill")} data-part="fill" style={{ inlineSize: `${percent(value)}%` }} />
      )}
      {projection === null ? null : (
        <span
          className={style("projection")}
          data-part="projection"
          style={{ inlineSize: `${projection.length}%`, insetInlineStart: `${projection.start}%` }}
        />
      )}
      <span
        className={style("near")}
        data-part="near"
        style={{ insetInlineStart: `min(${percent(nearMark)}%, 100% - 1px)` }}
      />
    </span>
  )
}
