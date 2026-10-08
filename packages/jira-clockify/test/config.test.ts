/**
 * `jcf config` and the config file it reads, at the two seams a bad value can enter through: a
 * hand-edited file, and `reset`.
 */
import { describe, expect, it } from "@effect/vitest"
import { FileSystem, Layer, Path, Schema } from "effect"
import { Command } from "effect/cli"
import * as Effect from "effect/Effect"
import { agentEfforts, defaultSessionAgentSettings, SessionAgentSettings } from "../src/agent/agentSettings.js"
import { root } from "../src/cli/root.js"
import { ConfigService, layer as ConfigLayer, parseConfigPatch } from "../src/services/ConfigService.js"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

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

// QA-J12: the header named ~/.jcf/config.json when no such file existed, and no value said where it came from.
describe("jcf config show", () => {
  it.effect("says when there is no config file and every value is jcf's default", () =>
    Effect.gen(function*() {
      const { world } = yield* run(["config", "show"], undefined)
      const printed = world.stdout.join("\n")
      expect(printed).toContain(`No config file yet (${FAKE_HOME}/.jcf/config.json)`)
      expect(printed).not.toContain("(default)")
    }))

  it.effect("marks the values in the file that are still jcf's default", () =>
    Effect.gen(function*() {
      const { world } = yield* run(["config", "show"], { sessionIdleCapSeconds: 600 })
      const lines = world.stdout
      expect(lines[0]).toBe(`Settings in ${FAKE_HOME}/.jcf/config.json. "(default)" marks a value that is jcf's own.`)
      expect(lines.find((line) => line.includes("Idle cap"))).toBe("  Idle cap (sec):   600")
      expect(lines.find((line) => line.includes("Refresh"))).toBe("  Refresh (sec):    30  (default)")
    }))
})

describe("jcf config reset", () => {
  it.effect("accepts a Windows absolute session root without interpreting it as a relative path", () =>
    Effect.gen(function*() {
      const { stored } = yield* run(["config", "set", "session-root", "C:\\Work\\Repo"], {})
      expect(stored.sessionRoots).toEqual(["C:\\Work\\Repo"])
      const drive = yield* run(["config", "set", "session-root", "C:\\"], {})
      expect(drive.stored.sessionRoots).toEqual(["C:\\"])
    }))

  // Only `~` and `~/…` expand to the home directory. `~work` or `~other/x` would be stored as
  // configured and then never match an absolute transcript cwd, silently opting nothing in.
  it.effect("rejects tilde prefixes that do not expand to the home directory", () =>
    Effect.gen(function*() {
      for (const prefix of ["~work", "~work/repo", "~other/repo"]) {
        const { stored, world } = yield* run(["config", "set", "session-root", prefix], {})
        expect(stored.sessionRoots).toEqual([])
        expect(world.stdout.join("\n")).toContain("Use an absolute path")
      }
      const home = yield* run(["config", "set", "session-root", "~"], {})
      expect(home.stored.sessionRoots).toEqual(["~"])
      const nested = yield* run(["config", "set", "session-root", "~/dev/work"], {})
      expect(nested.stored.sessionRoots).toEqual(["~/dev/work"])
    }))

  // `jcf config show` lists the session settings, so leaving them behind was invisible: a user
  // chasing a bad idle cap or a stale Standing Attribution would reset, see them still there, and
  // have nothing to go on. Reset means reset.
  it.effect("clears the session settings it also displays", () =>
    Effect.gen(function*() {
      const { stored, world } = yield* run(["config", "reset"], {
        sessionRoots: [`${FAKE_HOME}/dev/work`],
        sessionTicketMap: { [`${FAKE_HOME}/dev/work/docs`]: "PROJ-42" },
        sessionIdleCapSeconds: 900,
        sessionConfidenceFloor: 0.9,
        sessionIgnoredTickets: ["PROJ-42"],
        sessionAgent: { provider: "codex", model: "custom-model", effort: "high" }
      })

      expect(stored.sessionRoots).toEqual([])
      expect(stored.sessionTicketMap).toEqual({})
      expect(stored.sessionIdleCapSeconds).toBe(300)
      expect(stored.sessionConfidenceFloor).toBe(0.7)
      expect(stored.sessionAgent).toEqual(defaultSessionAgentSettings)
      expect(stored.sessionIgnoredTickets).toEqual([])
      expect(world.stdout.join("\n")).toContain("session roots")
    }))
})

describe("~/.jcf/config.json", () => {
  it("validates complete provider settings and their provider-specific efforts", () => {
    for (const provider of ["claude", "codex"] satisfies ReadonlyArray<SessionAgentSettings["provider"]>) {
      for (const effort of [null, ...agentEfforts(provider)]) {
        const settings = { provider, model: "chosen-model", effort }
        expect(Schema.decodeUnknownSync(SessionAgentSettings)(settings)).toEqual(settings)
        expect(parseConfigPatch(JSON.stringify({ sessionAgent: settings })).sessionAgent).toEqual(settings)
      }
    }
  })

  it("rejects unsupported providers, efforts and malformed models without accepting partial settings", () => {
    const invalid = [
      { provider: "other", model: null, effort: null },
      { provider: "claude", model: null, effort: "minimal" },
      { provider: "codex", model: null, effort: "max" },
      { provider: "codex", model: null, effort: "ultra" },
      { provider: "claude", model: "", effort: null },
      { provider: "claude", model: "   ", effort: null },
      { provider: "claude", model: " model ", effort: null },
      { provider: "claude", model: "m".repeat(201), effort: null },
      { provider: "claude", model: 123, effort: null },
      { provider: "codex" },
      null
    ]
    for (const sessionAgent of invalid) {
      expect(() => Schema.decodeUnknownSync(SessionAgentSettings)(sessionAgent)).toThrow()
      expect(parseConfigPatch(JSON.stringify({ sessionAgent, refreshInterval: 60 })))
        .toEqual({ refreshInterval: 60 })
    }
  })

  it.effect("loads omitted settings as Claude with the default model and effort", () =>
    Effect.gen(function*() {
      const config = yield* ConfigService
      expect((yield* config.get).sessionAgent).toEqual(defaultSessionAgentSettings)
    }).pipe(Effect.provide(ConfigLayer.pipe(
      Layer.provide(Layer.succeed(HomeDirectory, { path: FAKE_HOME })),
      Layer.provide(Path.layer),
      Layer.provide(FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed("{}")
      }))
    ))))

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

describe("session ignored tickets", () => {
  it("retains only valid issue keys from stored ignored tickets", () => {
    expect(parseConfigPatch(JSON.stringify({ sessionIgnoredTickets: ["PROJ-42", "bad", "", "ABC-7"] })))
      .toMatchObject({ sessionIgnoredTickets: ["PROJ-42", "ABC-7"] })
    expect(parseConfigPatch(JSON.stringify({ sessionIgnoredTickets: ["PROJ-42", 2] })).sessionIgnoredTickets)
      .toBeUndefined()
  })

  it.effect("round-trips ignored tickets through the real file-backed config service", () => {
    let saved = "{}"
    const configLayer = ConfigLayer.pipe(
      Layer.provide(Layer.succeed(HomeDirectory, { path: FAKE_HOME })),
      Layer.provide(Path.layer),
      Layer.provide(FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(saved),
        writeFileString: (_, contents) =>
          Effect.sync(() => {
            saved = contents
          })
      }))
    )
    return Effect.gen(function*() {
      const config = yield* ConfigService
      expect((yield* config.get).sessionIgnoredTickets).toEqual([])
      yield* config.set({ sessionIgnoredTickets: ["PROJ-42"] })
      expect((yield* config.get).sessionIgnoredTickets).toEqual(["PROJ-42"])
      expect(parseConfigPatch(saved).sessionIgnoredTickets).toEqual(["PROJ-42"])
    }).pipe(Effect.provide(configLayer))
  })

  it.effect("sets, lists, deduplicates and restores an ignored ticket through the CLI", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless()
      yield* Effect.gen(function*() {
        const command = Command.runWith(root, { version: "0.0.0-test" })
        yield* command(["config", "set", "session-ignore", "proj-42"])
        yield* command(["config", "set", "session-ignore", "PROJ-42"])
        const config = yield* ConfigService
        expect((yield* config.get).sessionIgnoredTickets).toEqual(["PROJ-42"])
        yield* command(["config"])
        expect(fake.world.stdout.join("\n")).toMatch(/Ignored tickets:\s+PROJ-42/)
        yield* command(["config", "unset", "session-ignore", "PROJ-42"])
        expect((yield* config.get).sessionIgnoredTickets).toEqual([])
      }).pipe(Effect.provide(fake.layer))
    }))

  it.effect("rejects malformed keys without changing the ignored list", () =>
    Effect.gen(function*() {
      const { stored, world } = yield* run(["config", "set", "session-ignore", "not-a-key"], {})
      expect(stored.sessionIgnoredTickets).toEqual([])
      expect(world.stdout.join("\n")).toContain("not an Issue Key")
    }))
})
