import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./RelayMark.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Sizes the bare mark is drawn and checked at, in CSS pixels; 16 stays legible in one colour. */
export const RLY_RELAY_MARK_SIZES: readonly [16, 20, 24, 32] = [16, 20, 24, 32]
/** One supported bare mark size. */
export type RlyRelayMarkSize = (typeof RLY_RELAY_MARK_SIZES)[number]

/** Sizes the tile is drawn at; its glyph is half the tile. */
export const RLY_RELAY_MARK_TILE_SIZES: readonly [20, 24, 32] = [20, 24, 32]
/** One supported tile size. */
export type RlyRelayMarkTileSize = (typeof RLY_RELAY_MARK_TILE_SIZES)[number]

/**
 * What Relay is doing, as the mark shows it. `idle` holds still; `working` passes the baton between the
 * hooks while Relay reads or answers; `attention` nudges the hooks together twice, then rests, when Relay
 * waits on the reader. Motion only: the host still says in words what Relay is doing.
 */
export const RLY_RELAY_MARK_ACTIVITIES: readonly ["idle", "working", "attention"] = ["idle", "working", "attention"]
/** One activity the mark can show. */
export type RlyRelayMarkActivity = (typeof RLY_RELAY_MARK_ACTIVITIES)[number]

type MarkBaseProps = Omit<ComponentPropsWithRef<"svg">, "children" | "height" | "viewBox" | "width">

/** Motion shared by the bare mark and the tile; every movement waits for the reader's motion preference. */
interface MarkMotionProps {
  /** `idle` (still) unless given. */
  readonly activity?: RlyRelayMarkActivity | undefined
  /** Plays one short entrance when the mark mounts, for a header that opens with Relay. */
  readonly entrance?: boolean | undefined
}

/** The ARIA naming a caller may pass natively instead of `label`. */
interface NativeNaming {
  readonly "aria-hidden"?: boolean | "true" | "false" | undefined
  readonly "aria-label"?: string | undefined
  readonly "aria-labelledby"?: string | undefined
  readonly role?: string | undefined
}

/**
 * Named by `label`, or natively by `aria-label`/`aria-labelledby`: a named mark is an image, an
 * unnamed one is decorative and hidden. Native naming is kept rather than overwritten.
 */
const requireOptionalText = (value: string | undefined, what: string): string | undefined =>
  value === undefined ? undefined : requireText(value, what)

const naming = (label: string | undefined, native: NativeNaming, what: string): NativeNaming => {
  const named = label !== undefined || native["aria-label"] !== undefined || native["aria-labelledby"] !== undefined
  if (!named) return { "aria-hidden": "true", role: native.role }
  return {
    "aria-hidden": native["aria-hidden"],
    // Every name must be visible text, however it is given, so a named mark is never an unnamed image.
    "aria-label": requireOptionalText(label ?? native["aria-label"], what),
    "aria-labelledby": requireOptionalText(native["aria-labelledby"], `${what} (aria-labelledby)`),
    role: native.role ?? "img"
  }
}

/** Inputs for the bare mark. */
export type RelayMarkProps = MarkBaseProps &
  MarkMotionProps & {
    /** 20px unless given. */
    readonly size?: RlyRelayMarkSize
    /** Names the mark for assistive technology; without it the mark is decorative and hidden. */
    readonly label?: string
  }

/** Inputs for the mark on an agent-coloured tile. */
export type RelayMarkTileProps = Omit<ComponentPropsWithRef<"span">, "children"> &
  MarkMotionProps & {
    /** 24px unless given. */
    readonly size?: RlyRelayMarkTileSize
    /** Names the tile for assistive technology; without it the tile is decorative and hidden. */
    readonly label?: string
  }

/**
 * The baton: two open hooks with a diagonal stroke passed between them, on a 24 grid with a 2.75
 * stroke (Relay UX decision, variant D). Round caps and joins keep the 16px bare mark legible.
 */
const Glyph = ({
  activity,
  entrance,
  size,
  ...props
}: MarkBaseProps & MarkMotionProps & { readonly size: number }): ReactElement => (
  <svg
    {...props}
    data-rly-relay-activity={activity ?? "idle"}
    data-rly-relay-entrance={entrance === true ? "" : undefined}
    fill="none"
    focusable="false"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2.75}
    viewBox="0 0 24 24"
    width={size}
  >
    <path className={style("hookStart")} d="M4 20V9.5A5.5 5.5 0 0 1 9.5 4H13" />
    <path className={style("hookEnd")} d="M20 4v10.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    <path className={style("baton")} d="M10 14 14 10" />
  </svg>
)

/** The mark on an agent-coloured tile; in forced colours the tile becomes an outline in its context's colour. */
const RelayMarkTile = ({ activity, className, entrance, label, size, ...props }: RelayMarkTileProps): ReactElement => {
  const pixels = size ?? 24
  return (
    <span
      {...props}
      {...naming(label, props, "RelayMark.Tile label")}
      className={classNames(style("tile"), className)}
      data-size={pixels}
    >
      <Glyph
        activity={activity}
        aria-hidden="true"
        className={style("tileGlyph")}
        entrance={entrance}
        size={pixels / 2}
      />
    </span>
  )
}

/**
 * Relay's mark, drawn in the current colour, so it follows its host's text in every theme and in
 * forced colours. `RelayMark.Tile` sets it on the agent colour for headers and avatars. Both move only
 * when given an `activity` or `entrance`, and only for a reader who has not asked for reduced motion.
 */
export const RelayMark = Object.assign(
  ({ className, label, size, ...props }: RelayMarkProps): ReactElement => (
    <Glyph
      {...props}
      {...naming(label, props, "RelayMark label")}
      className={classNames(style("root"), className)}
      size={size ?? 20}
    />
  ),
  { Tile: RelayMarkTile }
)
