import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { RLY_RELAY_MARK_GLYPH } from "@knpkv/rly/patterns"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { createRequire } from "node:module"
import { relayIconAssets, relayIconSvg, relayIconTileColor } from "../src/relay-icon.js"

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
// (rly's mark or the icon layout) or when a PNG is replaced by hand: re-run `pnpm render:icons`.
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

  it.effect("draws rly's mark on the tile colour rly's own favicon uses", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const favicon = yield* fileSystem.readFileString(
        createRequire(import.meta.url).resolve("@knpkv/rly/relay-mark.svg")
      )
      expect(favicon).toContain(`fill="${relayIconTileColor}"`)
      const svg = relayIconSvg("tile", 32)
      for (const d of Object.values(RLY_RELAY_MARK_GLYPH.paths)) expect(svg).toContain(`d="${d}"`)
    }))
})

describe("Relay icon geometry", () => {
  it("keeps the glyph inside the maskable safe circle, stroke included", () => {
    // The farthest stroked point from the centre is a hook's end, (4, 20), plus half the stroke.
    const size = 512
    const transform = /translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/.exec(relayIconSvg("full-bleed", size))
    const [x, y, scale] = (transform?.slice(1) ?? []).map(Number)
    expect([x, y, scale].every((value) => value !== undefined && Number.isFinite(value))).toBe(true)
    const centre = size / 2
    const reach = Math.hypot((x ?? 0) + 4 * (scale ?? 0) - centre, (y ?? 0) + 20 * (scale ?? 0) - centre) +
      (RLY_RELAY_MARK_GLYPH.strokeWidth / 2) * (scale ?? 0)
    expect(reach).toBeLessThanOrEqual(size * 0.4)
  })

  it("draws the badge with no background, so Android reads its alpha", () => {
    expect(relayIconSvg("badge", 96)).not.toContain("<rect")
  })
})
