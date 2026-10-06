import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./TrackKey.module.css"

const style = (name: string): string => cssClass(styles, name)
/** The marks a LimitTrack can draw. */
export const RLY_TRACK_KEY_MARKS: readonly ["near", "projected", "stale"] = ["near", "projected", "stale"]
export type RlyTrackKeyMark = (typeof RLY_TRACK_KEY_MARKS)[number]

/** One mark and the caller's words for it. */
export interface RlyTrackKeyItem {
  readonly mark: RlyTrackKeyMark
  readonly label: string
}

type TrackKeyBaseProps = Omit<ComponentPropsWithRef<"ul">, "aria-label" | "children">
export type TrackKeyProps = TrackKeyBaseProps & {
  /** Names the list for assistive technology, for example "What the track marks mean". */
  readonly label: string
  /** Only the marks the tracks above actually draw, in reading order. */
  readonly items: ReadonlyArray<RlyTrackKeyItem>
}

/** One line under a set of LimitTracks explaining their marks; each mark sits before its own words. */
export const TrackKey = ({ className, items, label, ...props }: TrackKeyProps): ReactElement => {
  if (items.length === 0) throw new Error("TrackKey needs at least one mark to explain")
  const marks = new Set<RlyTrackKeyMark>()
  for (const item of items) {
    if (marks.has(item.mark)) throw new Error(`TrackKey marks must be unique: ${item.mark}`)
    marks.add(item.mark)
  }
  return (
    // Flex styling with no list markers drops list semantics in WebKit, so the role is explicit.
    <ul
      {...props}
      aria-label={requireText(label, "TrackKey label")}
      className={classNames(style("root"), className)}
      role="list"
    >
      {items.map((item) => (
        <li className={style("item")} key={item.mark}>
          <span aria-hidden="true" className={style(item.mark)} data-mark={item.mark} />
          {requireText(item.label, "TrackKey item label")}
        </li>
      ))}
    </ul>
  )
}
