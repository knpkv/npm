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

type MarkBaseProps = Omit<ComponentPropsWithRef<"svg">, "children" | "height" | "viewBox" | "width">

/** Inputs for the bare mark. */
export type RelayMarkProps = MarkBaseProps & {
  /** 20px unless given. */
  readonly size?: RlyRelayMarkSize
  /** Names the mark for assistive technology; without it the mark is decorative and hidden. */
  readonly label?: string
}

/** Inputs for the mark on an agent-coloured tile. */
export type RelayMarkTileProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** 24px unless given. */
  readonly size?: RlyRelayMarkTileSize
  /** Names the tile for assistive technology; without it the tile is decorative and hidden. */
  readonly label?: string
}

/**
 * The baton: two open hooks with a diagonal stroke passed between them, on a 24 grid with a 2.75
 * stroke (Relay UX decision, variant D). Round caps and joins keep the 16px bare mark legible.
 */
const Glyph = ({ size, ...props }: MarkBaseProps & { readonly size: number }): ReactElement => (
  <svg
    {...props}
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
    <path d="M4 20V9.5A5.5 5.5 0 0 1 9.5 4H13" />
    <path d="M20 4v10.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    <path d="M10 14 14 10" />
  </svg>
)

/** The mark on an agent-coloured tile; in forced colours the tile becomes an outline in its context's colour. */
const RelayMarkTile = ({ className, label, size, ...props }: RelayMarkTileProps): ReactElement => {
  const pixels = size ?? 24
  return (
    <span
      {...props}
      aria-hidden={label === undefined ? "true" : undefined}
      aria-label={label === undefined ? undefined : requireText(label, "RelayMark.Tile label")}
      className={classNames(style("tile"), className)}
      data-size={pixels}
      role={label === undefined ? undefined : "img"}
    >
      <Glyph aria-hidden="true" className={style("tileGlyph")} size={pixels / 2} />
    </span>
  )
}

/**
 * Relay's mark, drawn in the current colour, so it follows its host's text in every theme and in
 * forced colours. `RelayMark.Tile` sets it on the agent colour for headers and avatars.
 */
export const RelayMark = Object.assign(
  ({ className, label, size, ...props }: RelayMarkProps): ReactElement => (
    <Glyph
      {...props}
      aria-hidden={label === undefined ? "true" : undefined}
      aria-label={label === undefined ? undefined : requireText(label, "RelayMark label")}
      className={classNames(style("root"), className)}
      role={label === undefined ? undefined : "img"}
      size={size ?? 20}
    />
  ),
  { Tile: RelayMarkTile }
)
