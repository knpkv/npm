import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./ReleaseRelay.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Closed indices for the versioned rly release-symbol catalog. */
export type RlyReleaseRelaySymbolIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15

/** Semver-governed persisted index-to-name contract; reordering changes release identity. */
export const RLY_RELEASE_RELAY_SYMBOLS = defineVariants({
  0: { name: "orbit" },
  1: { name: "split" },
  2: { name: "brace" },
  3: { name: "wave" },
  4: { name: "gate" },
  5: { name: "fork" },
  6: { name: "bridge" },
  7: { name: "beacon" },
  8: { name: "loop" },
  9: { name: "pulse" },
  10: { name: "anchor" },
  11: { name: "ladder" },
  12: { name: "knot" },
  13: { name: "spark" },
  14: { name: "stack" },
  15: { name: "compass" }
}) satisfies Readonly<Record<RlyReleaseRelaySymbolIndex, { readonly name: string }>>

/** Stable name for one code-owned release symbol. */
export type RlyReleaseRelaySymbolName = (typeof RLY_RELEASE_RELAY_SYMBOLS)[RlyReleaseRelaySymbolIndex]["name"]

/** Machine-readable ReleaseRelay geometry choices. */
export const RLY_RELEASE_RELAY_VARIANTS = defineVariants({
  size: {
    compact: {
      className: style("compact"),
      purpose: "Release rows and compact previews",
      tokens: ["space-32", "space-8", "type-label"]
    },
    hero: {
      className: style("hero"),
      purpose: "Page-level release identity",
      tokens: ["space-48", "space-4", "space-8", "type-card-title"]
    }
  }
})

/** Default ReleaseRelay geometry. */
export const RLY_RELEASE_RELAY_DEFAULT_VARIANTS = defineVariants({ size: "compact" })

/** Visual geometry supported by ReleaseRelay. */
export type RlyReleaseRelaySize = keyof typeof RLY_RELEASE_RELAY_VARIANTS.size

/** Exactly three persisted symbol indices supplied by a release identity projection. */
export type RlyReleaseRelaySymbolIndices = readonly [
  RlyReleaseRelaySymbolIndex,
  RlyReleaseRelaySymbolIndex,
  RlyReleaseRelaySymbolIndex
]

const symbolPaths: Readonly<Record<RlyReleaseRelaySymbolIndex, string>> = {
  0: "M12 4a8 8 0 1 1-6.9 4M5.1 8H9V4.1",
  1: "M5 5v4c0 2 1 3 3 3h8c2 0 3 1 3 3v4M12 12V5",
  2: "M9 4H7v5l-3 3 3 3v5h2M15 4h2v5l3 3-3 3v5h-2",
  3: "M3 9c3-4 6-4 9 0s6 4 9 0M3 15c3-4 6-4 9 0s6 4 9 0",
  4: "M5 19V8l7-4 7 4v11M9 19v-7h6v7",
  5: "M12 20V9M12 12 6 6M12 12l6-6M6 6v4M18 6v4",
  6: "M3 17h18M5 17v-5c4-5 10-5 14 0v5M8 17v-3M16 17v-3",
  7: "M12 3v3M5.6 5.6l2.1 2.1M18.4 5.6l-2.1 2.1M6 20h12l-2-9H8Z",
  8: "M8 8a4 4 0 0 1 8 0v8a4 4 0 0 1-8 0V8Zm0 4h8",
  9: "M3 13h4l2-6 4 12 2-6h6",
  10: "M12 3v15M8 7h8M5 14c0 4 3 7 7 7s7-3 7-7M5 14l-2 2M19 14l2 2",
  11: "M7 3v18M17 3v18M7 7h10M7 12h10M7 17h10",
  12: "M8 5a4 4 0 0 1 4 4v6a4 4 0 1 0 4-4H8a4 4 0 1 0 4 4V9a4 4 0 0 1 4-4",
  13: "M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M18.4 5.6l-3.5 3.5M9.1 14.9l-3.5 3.5",
  14: "m4 8 8-4 8 4-8 4Zm0 4 8 4 8-4M4 16l8 4 8-4",
  15: "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Zm0 6v6M9 12h6"
}

const validateSymbols = (symbolIndices: RlyReleaseRelaySymbolIndices): RlyReleaseRelaySymbolIndices => {
  if (symbolIndices.length !== 3) throw new Error("ReleaseRelay symbolIndices must contain exactly three indices")
  const seen = new Set<number>()
  for (const symbol of symbolIndices) {
    if (!Number.isInteger(symbol) || symbol < 0 || symbol > 15) {
      throw new Error("ReleaseRelay symbol indices must be integers from 0 through 15")
    }
    if (seen.has(symbol)) throw new Error("ReleaseRelay symbol indices must be distinct")
    seen.add(symbol)
  }
  return symbolIndices
}

/** Props for an already-derived, versioned release identity projection. */
export type ReleaseRelayProps = Omit<ComponentPropsWithRef<"figure">, "aria-label" | "children"> & {
  readonly algorithm: string
  readonly codename: string
  readonly size?: RlyReleaseRelaySize
  readonly symbolIndices: RlyReleaseRelaySymbolIndices
}

/** Render a supplied codename and three-symbol projection without hashing or domain derivation. */
export const ReleaseRelay = ({
  algorithm,
  className,
  codename,
  size = "compact",
  symbolIndices: suppliedSymbolIndices,
  ...props
}: ReleaseRelayProps): ReactElement => {
  const visibleAlgorithm = requireText(algorithm, "ReleaseRelay algorithm")
  const visibleCodename = requireText(codename, "ReleaseRelay codename")
  const symbolIndices = validateSymbols(suppliedSymbolIndices)
  const names = symbolIndices.map((symbol) => RLY_RELEASE_RELAY_SYMBOLS[symbol].name)
  const accessibleName = `Release relay, ${visibleCodename}, symbols ${names.join(", ")}.`

  return (
    <figure
      {...props}
      className={classNames(style("root"), RLY_RELEASE_RELAY_VARIANTS.size[size].className, className)}
      data-rly-release-relay-size={size}
    >
      <span aria-label={accessibleName} className={style("tiles")} role="img">
        <span aria-hidden="true" className={style("handoff")} data-rly-release-relay-handoff="" />
        {symbolIndices.map((symbol, position) => (
          <span
            aria-hidden="true"
            className={style("tile")}
            data-rly-release-relay-position={position}
            data-rly-release-symbol-index={symbol}
            data-rly-release-symbol-name={RLY_RELEASE_RELAY_SYMBOLS[symbol].name}
            key={symbol}
          >
            <svg className={style("glyph")} focusable="false" viewBox="0 0 24 24">
              <path
                d={symbolPaths[symbol]}
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </span>
        ))}
      </span>
      <figcaption className={style("identity")}>
        <span className={style("codename")}>{visibleCodename}</span>
        <span className={style("algorithm")}>Identity algorithm: {visibleAlgorithm}</span>
      </figcaption>
    </figure>
  )
}
