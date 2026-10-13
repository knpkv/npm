import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { relayChefArt } from "../src/internal/relay-chef-art.js"
import { fullBleedChefTile, relayIconAssets, relayIconSvg } from "../src/relay-icon.js"

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

/** Decode only the committed 8-bit RGB/RGBA PNGs, including their row filters, to check real corner alpha. */
const pngCornerAlpha = async (bytes: Uint8Array): Promise<ReadonlyArray<number>> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  expect(view.getUint8(24)).toBe(8)
  const type = view.getUint8(25)
  expect([2, 6]).toContain(type)
  expect(view.getUint8(28)).toBe(0)
  if (type === 2) return [255, 255, 255, 255]
  const compressed: Array<number> = []
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset)
    const kind = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))
    if (kind === "IDAT") {
      for (const byte of bytes.slice(offset + 8, offset + 8 + length)) compressed.push(byte)
    }
    offset += 12 + length
  }
  const stream = new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(new DecompressionStream("deflate"))
  const filtered = new Uint8Array(await new Response(stream).arrayBuffer())
  const stride = width * 4
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)]
    expect(filter).toBeLessThanOrEqual(4)
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x
      const left = x < 4 ? 0 : pixels[index - 4] ?? 0
      const above = y === 0 ? 0 : pixels[index - stride] ?? 0
      const corner = y === 0 || x < 4 ? 0 : pixels[index - stride - 4] ?? 0
      const predicted = left + above - corner
      const pa = Math.abs(predicted - left), pb = Math.abs(predicted - above), pc = Math.abs(predicted - corner)
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner
      const adjustment = filter === 1
        ? left
        : filter === 2
        ? above
        : filter === 3
        ? Math.floor((left + above) / 2)
        : filter === 4
        ? paeth
        : 0
      pixels[index] = ((filtered[y * (stride + 1) + x + 1] ?? 0) + adjustment) & 255
    }
  }
  return [
    pixels[3] ?? 0,
    pixels[stride - 1] ?? 0,
    pixels[(height - 1) * stride + 3] ?? 0,
    pixels[height * stride - 1] ?? 0
  ]
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
        if (asset.variant === "full-bleed") {
          expect(yield* Effect.promise(() => pngCornerAlpha(png))).toEqual([255, 255, 255, 255])
        }
      }))
  }
})

describe("Relay icon geometry", () => {
  it("uses the approved tile and a separate simplified favicon", () => {
    expect(relayIconSvg("tile", 512)).toContain("translate(64 64) scale(12)")
    expect(relayIconSvg("tile", 512)).toContain("rx=\"115.2\"")
    expect(relayIconSvg("favicon", 16)).toContain("width=\"16\" height=\"16\"")
    expect(relayIconSvg("favicon", 16)).not.toContain("translate(64 64)")
    expect(relayChefArt.tile).toContain("viewBox=\"0 0 512 512\"")
  })

  it("keeps the full-bleed glyph inside the maskable safe circle with opaque corners", () => {
    const svg = relayIconSvg("full-bleed", 512)
    expect(svg).toContain("<rect width=\"512\" height=\"512\" fill=\"#4e1f50\"")
    expect(/<rect\b(?=[^>]*width="512")(?=[^>]*height="512")[^>]*>/.exec(svg)?.[0]).not.toMatch(/\brx=/)
    // The tile body is radius12 around(16,18.75); the toque and its outline reach y=0.25.
    const reach = Math.max(12 * (12 + 2.75), 12 * (16 - 0.25))
    expect(reach).toBeLessThanOrEqual(512 * 0.4)
    expect(svg).toContain("translate(64 64) scale(12)")
  })

  it("removes any background radius and uses the approved pixel-specific icon sources", () => {
    expect(fullBleedChefTile("<svg><rect width=\"512\" height=\"512\" rx=\"115.2\" fill=\"#4e1f50\" /></svg>")).not
      .toMatch(/\brx=/)
    expect(relayIconSvg("full-bleed", 180)).toContain("id=\"rcmt180-t-body\"")
    expect(relayIconSvg("badge", 96)).toContain("id=\"rcmfc64-e0\"")
    expect(relayIconSvg("favicon", 16)).toContain("id=\"rcm16-body\"")
  })

  it("draws the badge with no background, so Android reads its alpha", () => {
    expect(relayIconSvg("badge", 96)).not.toMatch(/<rect[^>]*width="(?:32|96)"/)
    expect(relayIconSvg("badge", 96)).not.toMatch(/Canvas|currentColor/)
    expect(relayIconSvg("badge", 96)).toContain("stroke=\"#FFFFFF\"")
  })
})
