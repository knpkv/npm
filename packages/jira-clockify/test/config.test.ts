/**
 * `jcf config` and the config file it reads, at the two seams a bad value can enter through: a
 * hand-edited file, and `reset`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Command } from "effect/unstable/cli"
import { root } from "../src/cli/root.js"
import { ConfigService, parseConfigPatch } from "../src/services/ConfigService.js"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "./fakeHeadless.js"

// A test case is its own entry point: it composes exactly the layers that case needs and
// provides them there. Both provide diagnostics are about production wiring, where a Layer
// provided mid-graph can cut a scope short.
// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

const run = (args: ReadonlyArray<string>, config: FakeHeadlessOptions["config"]) => {
  const fake = makeFakeHeadless({ config })
  return Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
    Effect.andThen(Effect.flatMap(ConfigService, (service) => service.get)),
    Effect.provide(fake.layer),
    Effect.map((stored) => ({ stored, world: fake.world }))
  )
}

describe("jcf config reset", () => {
  // `jcf config show` lists the session settings, so leaving them behind was invisible: a user
  // chasing a bad idle cap or a stale Standing Attribution would reset, see them still there, and
  // have nothing to go on. Reset means reset.
  it.effect("clears the session settings it also displays", () =>
    Effect.gen(function*() {
      const { stored, world } = yield* run(["config", "reset"], {
        sessionRoots: [`${FAKE_HOME}/dev/work`],
        sessionTicketMap: { [`${FAKE_HOME}/dev/work/docs`]: "PROJ-42" },
        sessionIdleCapSeconds: 900,
        sessionConfidenceFloor: 0.9
      })

      expect(stored.sessionRoots).toEqual([])
      expect(stored.sessionTicketMap).toEqual({})
      expect(stored.sessionIdleCapSeconds).toBe(300)
      expect(stored.sessionConfidenceFloor).toBe(0.7)
      expect(world.stdout.join("\n")).toContain("session roots")
    }))
})

describe("~/.jcf/config.json", () => {
  // The only way to set this field is by hand — there is no `jcf config set` subcommand for it —
  // which is exactly where `70` gets written for "70%". Accepting it would mark every Coding Agent
  // attribution below the floor from then on, permanently, with nothing pointing at the cause.
  it("ignores a confidence floor outside [0, 1] rather than withholding everything", () => {
    expect(parseConfigPatch(JSON.stringify({ sessionConfidenceFloor: 70 })).sessionConfidenceFloor)
      .toBeUndefined()
    expect(parseConfigPatch(JSON.stringify({ sessionConfidenceFloor: -1 })).sessionConfidenceFloor)
      .toBeUndefined()
    expect(parseConfigPatch(JSON.stringify({ sessionConfidenceFloor: 0.55 })).sessionConfidenceFloor)
      .toBe(0.55)
    // The Idle Cap shares no such ceiling: a fifteen-minute cap is a real, if generous, setting.
    expect(parseConfigPatch(JSON.stringify({ sessionIdleCapSeconds: 900 })).sessionIdleCapSeconds).toBe(900)
  })

  // Zero is not merely odd: every presence window becomes zero-length, so both `reconcile --agent`
  // and `watch` report nothing to propose, forever, with nothing on screen to explain it.
  // `jcf config set idle-cap` already refuses it; the file is the other way in.
  it("ignores an Idle Cap of zero rather than silencing the whole feature", () => {
    expect(parseConfigPatch(JSON.stringify({ sessionIdleCapSeconds: 0 })).sessionIdleCapSeconds).toBeUndefined()
    expect(parseConfigPatch(JSON.stringify({ sessionIdleCapSeconds: -5 })).sessionIdleCapSeconds).toBeUndefined()
  })
})

describe("jcf config set session-ticket", () => {
  it.effect("refuses a value that is not an issue key", () =>
    Effect.gen(function*() {
      const { stored, world } = yield* run(
        ["config", "set", "session-ticket", "/work/docs", "not-a-key"],
        {}
      )
      expect(stored.sessionTicketMap).toEqual({})
      expect(world.stdout.join("\n")).toContain("not an issue key")
    }))
})

describe("standing attributions", () => {
  // An empty key writes a Clockify description of `[] …`, which the tally then refuses to read
  // back — so a watch never sees the entry it just made and writes the same time again on every
  // settled tick, without end.
  it("drops a stored standing attribution that is not an issue key", () => {
    const parsed = parseConfigPatch(JSON.stringify({
      sessionTicketMap: { "/work/docs": "", "/work/notes": "not a key", "/work/rel": "PROJ-42" }
    }))
    expect(parsed.sessionTicketMap).toEqual({ "/work/rel": "PROJ-42" })
  })
})
