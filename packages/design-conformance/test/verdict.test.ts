import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PNG } from "pngjs"

import { type Capture, RegionPixels } from "../src/browser.js"
import { compareLiveRegions, comparePixels } from "../src/compare.js"
import { renderReport, reportSummary } from "../src/report.js"
import { Manifest } from "../src/schema.js"
import { verdict, waiverMatches } from "../src/verdict.js"
import { failure, identity, manifest, manifestInput, waiver } from "./models.js"

const shot = { ...identity, touched: false, touchedRegions: [], outsidePixelsChanged: false, artifacts: {} }
const before = DateTime.makeUnsafe("2026-10-17T23:59:59.999Z")
const after = DateTime.makeUnsafe("2026-10-18T00:00:00.000Z")

const pixels = (shade: number, count: number, height = 20): Uint8Array => {
  const image = new PNG({ width: 20, height })
  image.data.fill(255)
  for (let pixel = 0; pixel < count; pixel++) {
    image.data[pixel * 4] = shade
    image.data[pixel * 4 + 1] = shade
    image.data[pixel * 4 + 2] = shade
  }
  return PNG.sync.write(image)
}

const capture = (nav: Uint8Array, content: Uint8Array): Capture => {
  const navImage = PNG.sync.read(Buffer.from(nav))
  const contentImage = PNG.sync.read(Buffer.from(content))
  const frame = new PNG({ width: 20, height: navImage.height + contentImage.height })
  frame.data.set(navImage.data)
  frame.data.set(contentImage.data, navImage.data.length)
  return {
    frame: PNG.sync.write(frame),
    regions: new Map([
      ["nav", RegionPixels.Image({ bytes: nav })],
      ["content", RegionPixels.Image({ bytes: content })]
    ]),
    snapshot: {
      overflow: false,
      regions: ["nav", "content"].map((name, index) => ({
        name,
        copy: name,
        parent: null,
        box: { x: 0, y: index * 20, width: 20, height: index === 0 ? navImage.height : contentImage.height },
        overflow: false,
        styles: { color: "rgb(0, 0, 0)" }
      }))
    }
  }
}

it.effect("changed content does not require inherited nav drift with zero significant base-to-PR pixels", () =>
  Effect.sync(() => {
    const reference = pixels(255, 400)
    const baseNav = pixels(0, 4)
    const currentNav = pixels(1, 4)
    const currentContent = pixels(0, 400)
    expect(comparePixels(reference, baseNav).ratio).toBe(0.01)
    expect(comparePixels(reference, currentNav).ratio).toBe(0.01)
    expect(comparePixels(baseNav, currentNav).ratio).toBe(0)
    const changes = compareLiveRegions(
      identity,
      capture(baseNav, reference),
      capture(currentNav, currentContent),
      ["nav", "content"]
    )
    expect(changes).toEqual({ touchedRegions: ["content"], outsidePixelsChanged: false })
    const findings = [
      { ...failure, region: "nav", rule: "pixels", detail: "Inherited 1% nav drift" },
      { ...failure, rule: "pixels", detail: "PR changes content pixels" }
    ] satisfies ReadonlyArray<typeof failure>
    const regionalShot = { ...shot, touched: true, ...changes }
    const result = verdict(manifest, findings, [], [regionalShot], before)
    expect(result.findings.map((finding) => [finding.region, finding.disposition])).toEqual([
      ["nav", "report-only"],
      ["content", "required"]
    ])
    expect(result.passed).toBe(false)
  }))

it.effect("real PR nav drift exceeds the same comparator and fails without waivers", () =>
  Effect.sync(() => {
    const reference = pixels(255, 400)
    const base = capture(pixels(0, 4), reference)
    const live = capture(pixels(0, 400), reference)
    const changes = compareLiveRegions(identity, base, live, ["nav", "content"])
    expect(changes).toEqual({ touchedRegions: ["nav"], outsidePixelsChanged: false })
    const result = verdict(
      manifest,
      [
        { ...failure, region: "nav", rule: "pixels" },
        { ...failure, region: "*", rule: "pixels" }
      ],
      [],
      [{
        ...shot,
        touched: true,
        ...changes
      }],
      before
    )
    expect(result.passed).toBe(false)
    expect(result.findings.every((finding) => finding.disposition === "required")).toBe(true)
  }))

it.effect("a matching changed region passes with inherited region and frame drift still listed", () =>
  Effect.sync(() => {
    const white = pixels(255, 400)
    const black = pixels(0, 400)
    const base = capture(pixels(0, 4), white)
    const live = capture(pixels(1, 4), black)
    const reference = capture(white, black)
    const frameDrift = comparePixels(reference.frame, live.frame).ratio
    const navDrift = comparePixels(white, pixels(1, 4)).ratio
    expect(frameDrift).toBe(0.005)
    expect(navDrift).toBe(0.01)
    const regionalShot = {
      ...shot,
      touched: true,
      ...compareLiveRegions(identity, base, live, ["nav", "content"])
    }
    const result = verdict(
      manifest,
      [
        { ...failure, region: "*", rule: "pixels", detail: "Different pixels 0.005; maximum 0.001" },
        { ...failure, region: "nav", rule: "pixels", detail: "Different pixels 0.01; maximum 0.001" }
      ],
      [],
      [regionalShot],
      before
    )
    expect(result.passed).toBe(true)
    expect(result.findings.map((finding) => [finding.region, finding.disposition])).toEqual([
      ["*", "report-only"],
      ["nav", "report-only"]
    ])
    for (const report of [renderReport(result), reportSummary(result)]) {
      expect(report).toContain("nav")
      expect(report).toContain("Different pixels 0.01; maximum 0.001")
    }
  }))

it.effect("a matching region may grow the frame without promoting inherited nav drift", () =>
  Effect.sync(() => {
    const white = pixels(255, 400)
    const base = capture(pixels(0, 4), white)
    const live = capture(pixels(1, 4), pixels(0, 800, 40))
    const changes = compareLiveRegions(identity, base, live, ["nav", "content"])
    expect(changes).toEqual({ touchedRegions: ["content"], outsidePixelsChanged: false })
    const result = verdict(
      manifest,
      [
        { ...failure, region: "*", rule: "pixels", detail: "Inherited nav pixels in the grown frame" },
        { ...failure, region: "nav", rule: "pixels", detail: "Different pixels 0.01; maximum 0.001" }
      ],
      [],
      [{ ...shot, touched: true, ...changes }],
      before
    )
    expect(result.passed).toBe(true)
    expect(result.findings).toHaveLength(2)
    expect(result.findings.every((finding) => finding.disposition === "report-only")).toBe(true)
  }))

it.effect("changed pixels outside named regions require frame drift while inherited nav remains listed", () =>
  Effect.sync(() => {
    const white = pixels(255, 400)
    const named = capture(pixels(0, 4), white)
    const image = new PNG({ width: 40, height: 40 })
    image.data.fill(255)
    PNG.bitblt(PNG.sync.read(Buffer.from(named.frame)), image, 0, 0, 20, 40, 0, 0)
    const base = { ...named, frame: PNG.sync.write(image) }
    for (const y of [30, 31]) {
      for (const x of [30, 31]) {
        for (let channel = 0; channel < 3; channel++) image.data[(y * 40 + x) * 4 + channel] = 0
      }
    }
    const live = { ...base, frame: PNG.sync.write(image) }
    const changes = compareLiveRegions(identity, base, live, ["nav", "content"])
    expect(changes).toEqual({ touchedRegions: ["*"], outsidePixelsChanged: true })
    const result = verdict(
      manifest,
      [
        { ...failure, region: "*", rule: "pixels", detail: "New pixels outside every named region" },
        { ...failure, region: "nav", rule: "pixels", detail: "Different pixels 0.01; maximum 0.001" }
      ],
      [],
      [{ ...shot, touched: true, ...changes }],
      before
    )
    expect(result.passed).toBe(false)
    expect(result.findings.map((finding) => [finding.region, finding.disposition])).toEqual([
      ["*", "required"],
      ["nav", "report-only"]
    ])
  }))

it.effect("a changed theme does not promote inherited drift in another theme", () =>
  Effect.sync(() => {
    const result = verdict(manifest, [failure], [], [shot, {
      ...shot,
      theme: "dark",
      touched: true,
      touchedRegions: ["content"]
    }], before)
    expect(result.passed).toBe(true)
    expect(result.findings[0]?.disposition).toBe("report-only")
  }))

it.effect("unchanged legacy drift is reported before expiry and required at expiry", () =>
  Effect.sync(() => {
    const report = verdict(manifest, [failure], [], [shot], before)
    expect(report.passed).toBe(true)
    expect(report.findings[0]?.disposition).toBe("report-only")
    expect(verdict(manifest, [failure], [], [shot], after).passed).toBe(false)
  }))

it.effect("a change in one viewport does not promote the same region in another shot", () =>
  Effect.sync(() => {
    const result = verdict(manifest, [failure], [], [shot, {
      ...shot,
      viewport: 1280,
      touched: true,
      touchedRegions: ["content"]
    }], before)
    expect(result.passed).toBe(true)
    expect(result.shots.map((shot) => shot.touched)).toEqual([false, true])
  }))

it.effect("waivers match exact failures and retain optional viewport/theme scope", () =>
  Effect.sync(() => {
    expect(waiverMatches(waiver, failure)).toBe(true)
    expect(waiverMatches({ ...waiver, viewport: 1280 }, failure)).toBe(false)
    expect(waiverMatches({ ...waiver, theme: "dark" }, failure)).toBe(false)
    expect(waiverMatches({ ...waiver, region: "*" }, failure)).toBe(false)
    const result = verdict(
      manifest,
      [failure],
      [waiver],
      [{ ...shot, touched: true, touchedRegions: ["content"] }],
      after
    )
    expect(result.passed).toBe(true)
    expect(result.findings[0]).toMatchObject({ disposition: "waived", waiver: 0 })
  }))

it.effect("stale waivers and coverage fail during grace", () =>
  Effect.sync(() => {
    expect(verdict(manifest, [], [waiver], [shot], before).findings[0]).toMatchObject({
      rule: "stale-waiver",
      disposition: "required"
    })
    expect(verdict(manifest, [{ ...failure, rule: "coverage" }], [], [shot], before).passed).toBe(false)
    expect(
      verdict({ ...manifest, enforcement: { touched: "required", legacy: "required" } }, [failure], [], [shot], before)
        .passed
    ).toBe(false)
  }))

// The offset sorts after UTC strings but represents an earlier instant.
it.effect("offset grace expires at its UTC instant, not its lexical position", () =>
  Effect.gen(function*() {
    const offset = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifestInput,
      enforcement: { touched: "required", legacy: { mode: "report-only", until: "2026-10-18T02:00:00.000+02:00" } }
    })
    expect(verdict(offset, [failure], [], [shot], before).findings[0]?.disposition).toBe("report-only")
    expect(verdict(offset, [failure], [], [shot], after).findings[0]?.disposition).toBe("required")
    const encoded = yield* Schema.encodeEffect(Manifest)(offset)
    expect(encoded.enforcement.legacy).toEqual({ mode: "report-only", until: "2026-10-18T00:00:00.000Z" })
  }))

it.effect("date-only grace decodes to UTC midnight and expires there", () =>
  Effect.gen(function*() {
    const date = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifestInput,
      enforcement: { touched: "required", legacy: { mode: "report-only", until: "2026-10-18" } }
    })
    expect(verdict(date, [failure], [], [shot], before).passed).toBe(true)
    expect(verdict(date, [failure], [], [shot], after).passed).toBe(false)
  }))
