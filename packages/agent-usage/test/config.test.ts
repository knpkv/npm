import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { loadConfig, machineName } from "../src/server/Config.js"

const load = (env: Record<string, string>) =>
  loadConfig("Example-MacBook.local").pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ HOME: "/home/a", ...env }))
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
          roots: {
            claudeProjects: "/home/a/.claude/projects",
            codexHome: "/home/a/.codex",
            machine: "example-macbook"
          }
        })
      }))

    it.effect("reads extra Known Projects and refuses an entry that is not a project key", () =>
      Effect.gen(function*() {
        expect((yield* load({ AGENT_USAGE_PROJECTS: "RPS, ABC" })).projects).toEqual(["RPS", "ABC"])
        expect((yield* Effect.result(load({ AGENT_USAGE_PROJECTS: "rps" })))._tag).toBe("Failure")
      }))
  })
})
