/**
 * Relay's app icons, drawn from rly's mark geometry so the home-screen icon, the favicon and the
 * notification badge can't drift from the mark in the app.
 *
 * - `tile`: the mark on its agent-coloured rounded square, as `@knpkv/rly/relay-mark.svg` draws it. The
 *   favicon and the manifest's `any` icons.
 * - `full-bleed`: the same colours edge to edge, for a platform that cuts its own shape (Android's
 *   maskable icon, iOS's home screen). The glyph sits well inside the maskable safe circle.
 * - `badge`: the glyph alone, white on transparent; Android draws a notification badge from its alpha.
 *
 * @module
 */
import { RLY_RELAY_MARK_GLYPH } from "@knpkv/rly/patterns"

export type RelayIconVariant = "badge" | "full-bleed" | "tile"

/** rly's light agent colour, `oklch(47.08% 0.1548 297.66)`, as `@knpkv/rly/relay-mark.svg` fills its tile. */
export const relayIconTileColor = "#6741A5"
const glyphColor = "#FFFFFF"

/** How much of the icon the glyph's 24 grid spans: half on a tile, three quarters on a bare badge. */
const glyphShare = { badge: 0.75, "full-bleed": 0.5, tile: 0.5 } satisfies Record<RelayIconVariant, number>

/** One icon as standalone SVG, `size` pixels square. */
export const relayIconSvg = (variant: RelayIconVariant, size: number): string => {
  const grid = 24
  const scale = (size * glyphShare[variant]) / grid
  const offset = (size - grid * scale) / 2
  const { paths, strokeWidth } = RLY_RELAY_MARK_GLYPH
  const background = variant === "tile"
    ? `<rect width="${size}" height="${size}" rx="${size * 0.3}" fill="${relayIconTileColor}"/>`
    : variant === "full-bleed"
    ? `<rect width="${size}" height="${size}" fill="${relayIconTileColor}"/>`
    : ""
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
    `<title>Relay</title>`,
    background,
    `<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${glyphColor}"`,
    ` stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    `<path d="${paths.hookStart}"/><path d="${paths.hookEnd}"/><path d="${paths.baton}"/>`,
    `</g></svg>`
  ].join("")
}

/** A PNG the hub serves, and the SVG it is rendered from. */
export interface RelayIconAsset {
  readonly file: string
  readonly size: number
  readonly variant: RelayIconVariant
}

/**
 * Every PNG the hub serves: iOS takes only a PNG apple-touch icon; Android's install and maskable
 * icons, and its monochrome notification badge, are PNGs too. `scripts/render-icons.ts` renders them
 * into `icons/` and records both hashes in `icons/icons.json`.
 */
export const relayIconAssets: ReadonlyArray<RelayIconAsset> = [
  { file: "relay-apple-touch-180.png", size: 180, variant: "full-bleed" },
  { file: "relay-192.png", size: 192, variant: "tile" },
  { file: "relay-512.png", size: 512, variant: "tile" },
  { file: "relay-maskable-512.png", size: 512, variant: "full-bleed" },
  { file: "relay-badge-96.png", size: 96, variant: "badge" }
]
