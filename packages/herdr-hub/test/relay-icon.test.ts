import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { relayChefArt } from "../src/internal/relay-chef-art.js"
import { relayIconAssets, relayIconSvg } from "../src/relay-icon.js"

const IconRecords = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({ pngSha256: Schema.String, size: Schema.Number, sourceSha256: Schema.String })
  )
)

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** The committed icons and their recorded hashes, read through the platform services. */
const icons = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const hashing = yield* Crypto.Crypto
  const directory = path.join(import.meta.dirname, "..", "icons")
  return {
    read: (file: string) => fileSystem.readFile(path.join(directory, file)),
    recorded: yield* Schema.decodeUnknownEffect(IconRecords)(
      yield* fileSystem.readFileString(path.join(directory, "icons.json"))
    ),
    sha256: (bytes: Uint8Array) => hashing.digest("SHA-256", bytes).pipe(Effect.map(hex))
  }
})

/** Width and height from a PNG's IHDR chunk, or null when the bytes aren't a PNG. */
const pngSize = (bytes: Uint8Array): { readonly height: number; readonly width: number } | null => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((byte, index) => bytes[index] === byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { height: view.getUint32(20), width: view.getUint32(16) }
}

// The PNGs are committed because CI can't rasterise. These fail when the SVG they come from changes
// (the approved Chef or icon layout) or when a PNG is replaced by hand: re-run `pnpm render:icons`.
it.layer(NodeServices.layer)("Relay app icons", (it) => {
  it.effect("records exactly the icons the hub serves", () =>
    Effect.gen(function*() {
      const { recorded } = yield* icons
      expect(Object.keys(recorded).sort()).toEqual(relayIconAssets.map(({ file }) => file).sort())
    }))

  for (const asset of relayIconAssets) {
    it.effect(`${asset.file} is rendered from the current SVG and untouched since`, () =>
      Effect.gen(function*() {
        const { read, recorded, sha256 } = yield* icons
        const entry = recorded[asset.file]
        expect(entry).toBeDefined()
        expect(entry?.sourceSha256).toBe(
          yield* sha256(new TextEncoder().encode(relayIconSvg(asset.variant, asset.size)))
        )
        const png = yield* read(asset.file)
        expect(entry?.pngSha256).toBe(yield* sha256(png))
        expect(pngSize(png)).toEqual({ height: asset.size, width: asset.size })
      }))
  }
})

describe("Relay icon geometry", () => {
  it("uses the approved tile and a separate simplified favicon", () => {
    expect(relayIconSvg("tile", 512)).toContain("translate(64 64) scale(12)")
    expect(relayIconSvg("tile", 512)).toContain("rx=\"115\"")
    expect(relayIconSvg("favicon", 16)).toContain("width=\"16\" height=\"16\"")
    expect(relayIconSvg("favicon", 16)).not.toContain("translate(64 64)")
    expect(relayChefArt.tile).toContain("viewBox=\"0 0 512 512\"")
  })

  it("keeps the full-bleed glyph inside the maskable safe circle with opaque corners", () => {
    const svg = relayIconSvg("full-bleed", 512)
    expect(svg).toContain("<rect width=\"512\" height=\"512\" fill=\"url(#relay-chef-tile-tile)\"")
    expect(svg).not.toContain("rx=\"115\"")
    // The approved body's outer control points lie within [4.244,27.756] x [7.5,31].
    // The toque reaches y=1.5 and x=6; after its 12x scale every extreme stays inside radius 204.8.
    const reach = Math.max(Math.hypot(12 * (27.756 - 16), 12 * (18.253 - 16)), 12 * (31 - 16), 12 * (16 - 1.5) + 0.5)
    expect(reach).toBeLessThanOrEqual(512 * 0.4)
    expect(svg).toContain("translate(64 64) scale(12)")
  })

  it("draws the badge with no background, so Android reads its alpha", () => {
    expect(relayIconSvg("badge", 96)).not.toMatch(/<rect[^>]*width="(?:32|96)"/)
    expect(relayIconSvg("badge", 96)).not.toMatch(/Canvas|currentColor/)
    expect(relayIconSvg("badge", 96)).toContain("stroke=\"#FFFFFF\"")
  })
})
