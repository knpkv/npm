import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import { cropRegions, FrameSize } from "../src/browser.js"
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
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    const cropped = PNG.sync.read(Buffer.from(bytes))
    expect([cropped.width, cropped.height]).toEqual([4, 4])
    const expected = new PNG({ width: 4, height: 4 })
    PNG.bitblt(frame, expected, 2, 2, 4, 4, 0, 0)
    expect(cropped.data).toEqual(expected.data)
    const clipped = cropRegions(PNG.sync.write(frame), {
      ...metadata,
      regions: metadata.regions.map((region) => ({ ...region, box: { x: -1, y: -1, width: 3, height: 3 } }))
    }).get("content")
    expect(clipped).toBeDefined()
    if (clipped !== undefined) {
      expect([PNG.sync.read(Buffer.from(clipped)).width, PNG.sync.read(Buffer.from(clipped)).height]).toEqual([2, 2])
    }
  }))
