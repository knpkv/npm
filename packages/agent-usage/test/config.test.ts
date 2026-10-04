import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { loadConfig, machineName } from "../src/server/Config.js"

const load = (env: Record<string, string>) =>
  loadConfig("Example-MacBook.local").pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ HOME: "/home/a", USER: "a", ...env })
    )
  )

describe("configuration", () => {
  it("names the Machine by its short, lower-cased hostname", () => {
    expect(machineName("Example-MacBook.local")).toBe("example-macbook")
    expect(machineName("")).toBe("localhost")
  })

  it.layer(NodeServices.layer)((it) => {
    it.effect("defaults every root under the home directory", () =>
      Effect.gen(function*() {
        const config = yield* load({})
        expect(config).toEqual({
          storeDirectory: "/home/a/.local/share/agent-usage",
          projects: [],
          claudeConfigDir: "/home/a/.claude",
          claudeCredentials: {
            file: "/home/a/.claude/.credentials.json",
            keychainService: "Claude Code-credentials",
            keychainAccount: "a"
          },
          roots: {
            claudeProjects: "/home/a/.claude/projects",
            codexHome: "/home/a/.codex",
            claudeLimitSamples: "/home/a/.local/state/agent-usage/claude-limits.jsonl",
            machine: "example-macbook"
          }
        })
      }))

    it.effect("finds the limit samples under XDG_STATE_HOME, or where AGENT_USAGE_CLAUDE_LIMITS says", () =>
      Effect.gen(function*() {
        expect((yield* load({ XDG_STATE_HOME: "/state" })).roots.claudeLimitSamples).toBe(
          "/state/agent-usage/claude-limits.jsonl"
        )
        expect((yield* load({ AGENT_USAGE_CLAUDE_LIMITS: "/x/samples.jsonl" })).roots.claudeLimitSamples).toBe(
          "/x/samples.jsonl"
        )
      }))

    it.effect("names the Keychain item the way Claude Code does for a custom config directory", () =>
      Effect.gen(function*() {
        const custom = yield* load({ CLAUDE_CONFIG_DIR: "/home/a/claude-work" })
        expect(custom.claudeCredentials).toEqual({
          file: "/home/a/claude-work/.credentials.json",
          keychainService: "Claude Code-credentials-864021f6",
          keychainAccount: "a"
        })
        const moved = yield* load({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/vault" })
        expect(moved.claudeCredentials.file).toBe("/vault/.credentials.json")
        expect(moved.claudeCredentials.keychainService).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/u)
      }))

    it.effect("reads extra Known Projects and refuses an entry that is not a project key", () =>
      Effect.gen(function*() {
        expect((yield* load({ AGENT_USAGE_PROJECTS: "RPS, ABC" })).projects).toEqual(["RPS", "ABC"])
        expect((yield* Effect.result(load({ AGENT_USAGE_PROJECTS: "rps" })))._tag).toBe("Failure")
      }))
  })
})
