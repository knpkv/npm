/** The canvas's decorative stroke glyphs, drawn like the Relay screens' interface glyphs. @module */
import type { ReactElement } from "react"

const paths = {
  alert: "M12 3 2 21h20L12 3zM12 10v5M12 18h.01",
  arrow: "m9 5 7 7-7 7",
  check: "m5 12 5 5 9-10",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  minus: "M6 12h12"
} satisfies Record<string, string>

export type CanvasGlyphName = keyof typeof paths

/** Decorative only: the surrounding text carries the meaning. */
export const CanvasGlyph = ({
  name,
  size = 12
}: {
  readonly name: CanvasGlyphName
  readonly size?: number
}): ReactElement => (
  <span aria-hidden="true" className="rc-glyph" style={{ inlineSize: size, blockSize: size }}>
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  </span>
)
