import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Schema } from "effect"
import { fileURLToPath } from "node:url"
import {
  comparisonEligibility,
  type OrbitSample,
  phaseKnown,
  phaseLabels,
  referencePhase
} from "./browser/reference-phase.js"
import references from "./browser/reference-phase/references.json" with { type: "json" }

// Actual native capture's 390-light sample, before and after its screenshot.
const pinned: OrbitSample = {
  animationCount: 1,
  sameAnimation: true,
  name: "relay-orbit",
  currentTime: 0,
  playState: "paused",
  pending: false,
  duration: 3500,
  localTime: 0,
  progress: 0,
  targetTag: "circle",
  targetInFigure: true,
  targetRect: { x: 152.5, y: 162.7924041748047, width: 198, height: 198.00001525878906 }
}

type RecordedSample = Omit<(typeof references.frames)[number]["before"], "targetRect"> & {
  readonly targetRect: OrbitSample["targetRect"]
}

const OrbitMetadata = Schema.Struct({
  animationCount: Schema.Number,
  sameAnimation: Schema.Boolean,
  name: Schema.NullOr(Schema.Literal("relay-orbit")),
  currentTime: Schema.NullOr(Schema.Number),
  playState: Schema.NullOr(Schema.Literals(["idle", "running", "paused", "finished"])),
  pending: Schema.NullOr(Schema.Boolean),
  duration: Schema.NullOr(Schema.Number),
  localTime: Schema.NullOr(Schema.Number),
  progress: Schema.NullOr(Schema.Number),
  targetTag: Schema.NullOr(Schema.String),
  targetInFigure: Schema.Boolean,
  targetRect: Schema.NullOr(Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number
  }))
})

const readSample = Schema.decodeUnknownSync(OrbitMetadata)

// Validate the adopted metadata before it reaches the phase/eligibility guard.
const adoptedPhase = (before: RecordedSample, after: RecordedSample) =>
  referencePhase(readSample(before), readSample(after))

it("accepts the adopted first-frame orbit without certifying unknown historical phases", () => {
  expect(phaseKnown(pinned)).toBe(true)
  expect(referencePhase(pinned, pinned)).toEqual({
    _tag: "Pinned",
    sameAnimationAcrossCapture: true,
    targetRectStable: true
  })
  expect(comparisonEligibility("connect--2i--390-light", null)).toEqual({
    _tag: "Uncertain",
    reason: "ReferenceAnimationPhaseUnknown"
  })
})

it("refuses time drift, same-name replacement, extra animations and a pending pause", () => {
  const changes: ReadonlyArray<Partial<OrbitSample>> = [
    { currentTime: 1 },
    { sameAnimation: false },
    { animationCount: 2 },
    { playState: "running" },
    { pending: true },
    { duration: 900 },
    { localTime: 1 },
    { progress: 0.1 },
    { name: "unreviewed-motion" },
    { targetTag: "path" },
    { targetInFigure: false },
    { targetRect: null }
  ]
  for (const change of changes) {
    expect(referencePhase(pinned, { ...pinned, ...change })._tag).toBe("Uncertain")
    expect(referencePhase({ ...pinned, ...change }, pinned)._tag).toBe("Uncertain")
  }
})

it("refuses a target rectangle that moves or changes size during the shot", () => {
  for (
    const rect of [
      { x: 153.5, y: 162.7924041748047, width: 198, height: 198.00001525878906 },
      { x: 152.5, y: 163.7924041748047, width: 198, height: 198.00001525878906 },
      { x: 152.5, y: 162.7924041748047, width: 199, height: 198.00001525878906 },
      { x: 152.5, y: 162.7924041748047, width: 198, height: 199.00001525878906 }
    ]
  ) expect(referencePhase(pinned, { ...pinned, targetRect: rect })._tag).toBe("Uncertain")
})

it("keeps all four future goals boards unmapped and refuses a v5 substitution", () => {
  const evidence = referencePhase(pinned, pinned)
  expect(references.unmapped.map(({ label }) => comparisonEligibility(label, evidence))).toEqual([
    { _tag: "Unmapped", reason: "FutureGoalsBoard" },
    { _tag: "Unmapped", reason: "FutureGoalsBoard" },
    { _tag: "Unmapped", reason: "FutureGoalsBoard" },
    { _tag: "Unmapped", reason: "FutureGoalsBoard" }
  ])
  expect(comparisonEligibility("connect--2i-v5--390-light", evidence)).toEqual({ _tag: "OutsideScope" })
})

it("refuses adopted metadata when either or both target rectangles are missing", () => {
  for (const frame of references.frames) {
    const missing = { ...frame.before, targetRect: null }
    for (
      const evidence of [
        adoptedPhase(missing, frame.after),
        adoptedPhase(frame.before, missing),
        adoptedPhase(missing, missing)
      ]
    ) {
      expect(comparisonEligibility(frame.label, evidence)).toEqual({
        _tag: "Uncertain",
        reason: "ReferenceAnimationPhaseUnknown"
      })
    }
  }
})

it.layer(NodeServices.layer)((it) => {
  it.effect("pins all four adopted native PNG bytes and dimensions, without resizing", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const cryptoService = yield* Crypto.Crypto
      expect(references.frames.map(({ label }) => label)).toEqual(phaseLabels)
      for (const frame of references.frames) {
        const png = yield* fs.readFile(
          fileURLToPath(new URL(`./browser/reference-phase/${frame.file}`, import.meta.url))
        )
        const digest = yield* cryptoService.digest("SHA-256", png)
        expect(Buffer.from(digest).toString("hex")).toBe(frame.sha256)
        const buffer = Buffer.from(png)
        expect([buffer.readUInt32BE(16), buffer.readUInt32BE(20)]).toEqual(frame.pixels)
        expect(frame.before).toEqual(frame.after)
        expect(frame.before).toMatchObject({
          animationCount: 1,
          sameAnimation: true,
          name: "relay-orbit",
          currentTime: 0,
          playState: "paused",
          pending: false,
          duration: 3500,
          localTime: 0,
          progress: 0,
          targetTag: "circle",
          targetInFigure: true
        })
        expect(comparisonEligibility(frame.label, adoptedPhase(frame.before, frame.after))).toEqual({
          _tag: "PhaseRecorded"
        })
      }
    }))
})
