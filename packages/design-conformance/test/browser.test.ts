import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import { cropRegions, FrameSize } from "../src/browser.js"
import { Box, Snapshot } from "../src/schema.js"
import { snapshot } from "./models.js"

it.effect("capture frames require nonzero bounded physical dimensions", () =>
  Effect.gen(function*() {
    for (const size of [{ width: 390, height: 844 }, { width: 16_384, height: 800 }]) {
      expect(yield* Schema.decodeUnknownEffect(FrameSize)(size)).toEqual(size)
    }
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 16_385]) {
      for (const size of [{ width: invalid, height: 800 }, { width: 1280, height: invalid }]) {
        expect((yield* Schema.decodeUnknownEffect(FrameSize)(size).pipe(Effect.exit))._tag).toBe("Failure")
      }
    }
  }))

it.effect("region crops preserve frame pixels at physical scale and clip document-edge bounds", () =>
  Effect.sync(() => {
    const frame = new PNG({ width: 8, height: 8 })
    for (let index = 0; index < frame.data.length; index += 1) frame.data[index] = index % 251
    const [region] = snapshot.regions
    expect(region).toBeDefined()
    if (region === undefined) return
    const metadata = {
      ...snapshot,
      regions: [{ ...region, name: "content", box: { x: 1, y: 1, width: 2, height: 2 } }]
    }
    const bytes = cropRegions(PNG.sync.write(frame), metadata, 2).get("content")
    expect(bytes?._tag).toBe("Image")
    if (bytes?._tag !== "Image") return
    const cropped = PNG.sync.read(Buffer.from(bytes.bytes))
    expect([cropped.width, cropped.height]).toEqual([4, 4])
    const expected = new PNG({ width: 4, height: 4 })
    PNG.bitblt(frame, expected, 2, 2, 4, 4, 0, 0)
    expect(cropped.data).toEqual(expected.data)
    const clipped = cropRegions(PNG.sync.write(frame), {
      ...metadata,
      regions: metadata.regions.map((region) => ({ ...region, box: { x: -1, y: -1, width: 3, height: 3 } }))
    }).get("content")
    expect(clipped?._tag).toBe("Image")
    if (clipped?._tag === "Image") {
      expect([PNG.sync.read(Buffer.from(clipped.bytes)).width, PNG.sync.read(Buffer.from(clipped.bytes)).height])
        .toEqual([2, 2])
    }
  }))

for (const axis of ["left", "top"]) {
  it.effect(`fully off-frame ${axis} crops retain metadata and return typed no-image evidence`, () =>
    Effect.sync(() => {
      const frame = new PNG({ width: 8, height: 8 })
      const [template] = snapshot.regions
      expect(template).toBeDefined()
      if (template === undefined) return
      for (const coordinate of [-4, -8]) {
        const box = axis === "left"
          ? { x: coordinate, y: 0, width: 4, height: 4 }
          : { x: 0, y: coordinate, width: 4, height: 4 }
        const metadata = { ...snapshot, regions: [{ ...template, box }] }
        const before = JSON.stringify(metadata)
        expect(cropRegions(PNG.sync.write(frame), metadata).get(template.name)).toMatchObject({ _tag: "OffFrame" })
        expect(JSON.stringify(metadata)).toBe(before)
      }
    }))
}

/** Empty layout boxes remain comparison metadata even though they have no crop. */
for (const axis of ["width", "height"]) {
  it.effect(`zero-${axis} snapshot boxes decode unchanged and return typed no-image evidence`, () =>
    Effect.gen(function*() {
      const [template] = snapshot.regions
      expect(template).toBeDefined()
      if (template === undefined) return
      const box = { x: 1, y: 1, width: 4, height: 4, [axis]: 0 }
      const metadata = { ...snapshot, regions: [{ ...template, box }] }
      const decoded = yield* Schema.decodeUnknownEffect(Snapshot)(metadata)
      expect(decoded).toEqual(metadata)
      const frame = PNG.sync.write(new PNG({ width: 8, height: 8 }))
      expect(cropRegions(frame, decoded).get(template.name)).toMatchObject({ _tag: "OffFrame" })
      expect(decoded).toEqual(metadata)
    }))
}

/** Pixel rounding must not turn a fractional zero-area box into a fabricated one-pixel crop. */
it.effect("zero-area crops remain empty at fractional coordinates and device scales", () =>
  Effect.sync(() => {
    const [template] = snapshot.regions
    expect(template).toBeDefined()
    if (template === undefined) return
    const frame = PNG.sync.write(new PNG({ width: 8, height: 8 }))
    for (
      const box of [
        { x: 0.25, y: 0.75, width: 0, height: 2 },
        { x: 0.25, y: 0.75, width: 2, height: 0 },
        { x: 0.25, y: 0.75, width: 0, height: 0 }
      ]
    ) {
      const metadata = { ...snapshot, regions: [{ ...template, box }] }
      for (const scale of [1, 2]) {
        expect(cropRegions(frame, metadata, scale).get(template.name)).toMatchObject({ _tag: "OffFrame" })
      }
      expect(metadata.regions[0]?.box).toEqual(box)
    }
  }))

/** Allow zero area without weakening finite coordinates or non-negative dimensions. */
it.effect("region boxes reject negative sizes and non-finite coordinates or dimensions", () =>
  Effect.gen(function*() {
    const box = { x: -1, y: -1, width: 4, height: 4 }
    expect(yield* Schema.decodeUnknownEffect(Box)(box)).toEqual(box)
    for (const axis of ["x", "y", "width", "height"]) {
      const invalid = axis === "width" || axis === "height"
        ? [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
        : [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
      for (const value of invalid) {
        expect((yield* Schema.decodeUnknownEffect(Box)({ ...box, [axis]: value }).pipe(Effect.exit))._tag).toBe(
          "Failure"
        )
      }
    }
  }))
