/**
 * Approved Chef app icons. Tile and simplified favicon have separate URLs; full-bleed icons
 * keep opaque edges for iOS and platform masks. The white outline badge carries only alpha.
 * @module
 */
import { Data } from "effect"
import { relayChefArt } from "./internal/relay-chef-art.js"

export type RelayIconVariant = "badge" | "full-bleed" | "tile" | "favicon"

class RelayIconGeometryError extends Data.TaggedError("RelayIconGeometryError") {}

/** Remove corner rounding only from the tile background, refusing a changed drawing structure. */
export const fullBleedChefTile = (source: string): string => {
  const background = /<rect\b(?=[^>]*\bwidth="512")(?=[^>]*\bheight="512")[^>]*>/
  if (!background.test(source)) throw new RelayIconGeometryError()
  const fullBleed = source.replace(background, (rect) => rect.replace(/\s+rx="[^"]*"/, ""))
  if (/\brx=/.test(background.exec(fullBleed)?.[0] ?? "")) throw new RelayIconGeometryError()
  return fullBleed
}

/** Standalone Chef SVG. System colours are resolved before the monochrome badge is rasterised. */
export const relayIconSvg = (variant: RelayIconVariant, size: number): string => {
  const source = {
    badge: () => relayChefArt.contrastBadge.replaceAll("currentColor", "#FFFFFF").replaceAll("Canvas", "none"),
    "full-bleed": () => fullBleedChefTile(size === 180 ? relayChefArt.tileApple : relayChefArt.tile),
    tile: () => relayChefArt.tile,
    favicon: () => relayChefArt.favicon
  } satisfies Record<RelayIconVariant, () => string>
  return source[variant]()
    .replace(/width="[0-9]+" height="[0-9]+"/, `width="${String(size)}" height="${String(size)}"`)
    .replace(" aria-hidden=\"true\"", "")
    .replace(/(<svg[^>]*>)/, "$1<title>Relay</title>")
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
