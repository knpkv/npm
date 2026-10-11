/**
 * Approved Chef app icons. Tile and simplified favicon have separate URLs; full-bleed icons
 * keep opaque edges for iOS and platform masks. The white outline badge carries only alpha.
 * @module
 */
import { relayChefArt } from "./internal/relay-chef-art.js"

export type RelayIconVariant = "badge" | "full-bleed" | "tile" | "favicon"

/** Standalone Chef SVG. System colours are resolved before the monochrome badge is rasterised. */
export const relayIconSvg = (variant: RelayIconVariant, size: number): string => {
  const source = {
    badge: () => relayChefArt.contrast.replaceAll("currentColor", "#FFFFFF").replaceAll("Canvas", "none"),
    "full-bleed": () => relayChefArt.tile.replace(" rx=\"115\"", ""),
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
