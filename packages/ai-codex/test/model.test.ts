import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema, Sink, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { model } from "../src/index.js"
import { PROMPT_ONLY_DISABLED_FEATURES, PROMPT_ONLY_SAFE_FEATURES } from "../src/internal/configuration.js"

interface FakeProcessOptions {
  readonly exitCode?: number
  readonly featureExitCode?: number
  readonly featureInventory?: string
  readonly stderr?: string
  readonly stdout: string
}

const completeFeatureInventory = [...PROMPT_ONLY_DISABLED_FEATURES, ...PROMPT_ONLY_SAFE_FEATURES]
  .map((feature) => `${feature} stable false`)
  .join("\n")

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>,
  options: FakeProcessOptions
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const isFeatureInventory = ChildProcess.isStandardCommand(command) && command.args.join(" ") === "features list"
      const stdout = Stream.make(
        isFeatureInventory ? (options.featureInventory ?? completeFeatureInventory) : options.stdout
      ).pipe(Stream.encodeText)
      const stderr = Stream.make(options.stderr ?? "").pipe(Stream.encodeText)
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          all: Stream.concat(stdout, stderr),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(isFeatureInventory ? (options.featureExitCode ?? 0) : (options.exitCode ?? 0))
          ),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(42),
          reref: Effect.void,
          stderr,
          stdin: Sink.drain,
          stdout,
          unref: Effect.succeed(Effect.void)
        })
      )
    })
  )

const successTranscript = (text: string): string =>
  [
    JSON.stringify({ thread_id: "thread-1", type: "thread.started" }),
    JSON.stringify({ item: { text, type: "agent_message" }, type: "item.completed" }),
    JSON.stringify({
      type: "turn.completed",
      usage: { cached_input_tokens: 2, input_tokens: 7, output_tokens: 3 }
    })
  ].join("\n")

const provideTestRuntime = <Result, Error, Requirements>(
  effect: Effect.Effect<Result, Error, Requirements>,
  calls: Array<ChildProcess.Command>,
  process: FakeProcessOptions
) =>
  effect.pipe(
    Effect.provide(model({ cwd: "/workspace" })),
    Effect.provide(fakeProcessLayer(calls, process)),
    Effect.provide(NodeFileSystem.layer)
  )

describe("model", () => {
  it.effect("generates text with safe bounded defaults", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const response = yield* provideTestRuntime(LanguageModel.generateText({ prompt: "Say hello" }), calls, {
        stdout: successTranscript("hello")
      })

      expect(response.text).toBe("hello")
      expect(response.usage.inputTokens.total).toBe(7)
      expect(calls).toHaveLength(1)
      const command = calls[0]
      expect(command === undefined ? undefined : ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.command).toBe("codex")
        expect(command.args).toContain("--ephemeral")
        expect(command.args).not.toContain("--ignore-user-config")
        expect(command.args).not.toContain("--disable")
        expect(command.args).toContain("read-only")
        expect(command.args).not.toContain("--cd")
        expect(command.options.cwd).toBe("/workspace")
        expect(command.options.detached).toBeUndefined()
        expect(command.options.shell).toBe(false)
      }
    }))

  it.effect("passes disables only for unsafe features supported by the installed Codex", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const olderInventory = completeFeatureInventory
        .split("\n")
        .filter((line) => !line.startsWith("skill_search "))
        .join("\n")
      yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(
          fakeProcessLayer(calls, {
            featureInventory: olderInventory,
            stdout: successTranscript("clean")
          })
        ),
        Effect.provide(NodeFileSystem.layer)
      )

      expect(calls).toHaveLength(2)
      const command = calls[1]
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).not.toContain("skill_search")
        expect(command.args).toContain("plugins")
      }
    }))

  it.effect("rejects an unclassified installed Codex feature before starting the turn", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(
          fakeProcessLayer(calls, {
            featureInventory: `${completeFeatureInventory}\nfuture_host_tool stable true`,
            stdout: successTranscript("must not run")
          })
        ),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(1)
    }))

  it.effect("rejects an incomplete feature inventory from an unsuccessful process", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(
          fakeProcessLayer(calls, {
            featureExitCode: 1,
            featureInventory: completeFeatureInventory.split("\n").slice(0, 4).join("\n"),
            stdout: successTranscript("must not run")
          })
        ),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(1)
    }))

  it.effect("bounds feature inventory output before starting the turn", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxOutputBytes: 32, promptOnly: true })),
        Effect.provide(
          fakeProcessLayer(calls, {
            featureInventory: completeFeatureInventory,
            stdout: successTranscript("must not run")
          })
        ),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(1)
    }))

  it.effect("removes every host-capable input for prompt-only turns", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("clean") })),
        Effect.provide(NodeFileSystem.layer)
      )

      expect(calls).toHaveLength(2)
      const command = calls[1]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).toContain("--ignore-user-config")
        expect(command.args).toContain("--ignore-rules")
        expect(command.args).toContain("project_doc_max_bytes=0")
        expect(command.args).toContain("shell_environment_policy.inherit=none")
        expect(command.args).toContain("web_search=\"disabled\"")
        expect(command.args).toContain("tools.view_image=false")
        for (const feature of PROMPT_ONLY_DISABLED_FEATURES) {
          const index = command.args.indexOf(feature)
          expect(index).toBeGreaterThan(0)
          expect(command.args[index - 1]).toBe("--disable")
        }
        expect(PROMPT_ONLY_DISABLED_FEATURES).toEqual(
          expect.arrayContaining(["hooks", "plugins", "skill_mcp_dependency_install", "skill_search"])
        )
      }
    }))

  it.effect("isolates feature discovery from user config without dropping turn authentication", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("clean") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                CODEX_ACCESS_TOKEN: "codex-access-token",
                CODEX_API_KEY: "codex-api-key",
                CODEX_HOME: "/home/reviewer/.codex",
                CODEX_SQLITE_HOME: "/home/reviewer/.codex/sqlite",
                HOME: "/home/reviewer",
                PATH: "/reviewed/bin",
                USERPROFILE: "C:\\Users\\reviewer",
                XDG_CONFIG_HOME: "/home/reviewer/.config"
              }
            })
          )
        )
      )

      expect(calls).toHaveLength(2)
      const inventory = calls[0]
      const turn = calls[1]
      expect(inventory !== undefined && ChildProcess.isStandardCommand(inventory)).toBe(true)
      expect(turn !== undefined && ChildProcess.isStandardCommand(turn)).toBe(true)
      if (
        inventory !== undefined &&
        ChildProcess.isStandardCommand(inventory) &&
        turn !== undefined &&
        ChildProcess.isStandardCommand(turn)
      ) {
        expect(inventory.options.env).toEqual({
          CODEX_ACCESS_TOKEN: "codex-access-token",
          CODEX_API_KEY: "codex-api-key",
          PATH: "/reviewed/bin"
        })
        expect(turn.options.env).toEqual({
          CODEX_ACCESS_TOKEN: "codex-access-token",
          CODEX_API_KEY: "codex-api-key",
          CODEX_HOME: "/home/reviewer/.codex",
          CODEX_SQLITE_HOME: "/home/reviewer/.codex/sqlite",
          HOME: "/home/reviewer",
          PATH: "/reviewed/bin",
          USERPROFILE: "C:\\Users\\reviewer",
          XDG_CONFIG_HOME: "/home/reviewer/.config"
        })
      }
    }))

  it.effect("keeps normal turns eligible for configured Codex tools", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Review the workspace" }).pipe(
        Effect.provide(model({ cwd: "/workspace" })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("clean") })),
        Effect.provide(NodeFileSystem.layer)
      )

      expect(calls).toHaveLength(1)
      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).not.toContain("web_search=\"disabled\"")
        expect(command.args).not.toContain("tools.view_image=false")
      }
    }))

  it.effect("uses a scoped output schema for structured output", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const response = yield* provideTestRuntime(
        LanguageModel.generateObject({
          prompt: "Return status",
          schema: Schema.Struct({ status: Schema.String })
        }),
        calls,
        { stdout: successTranscript("{\"status\":\"ready\"}") }
      )

      expect(response.value).toEqual({ status: "ready" })
      const command = calls[0]
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).toContain("--output-schema")
      }
    }))

  it.effect("forwards only the reviewed Codex child environment", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Say hello" }).pipe(
        Effect.provide(
          model({
            cwd: "/workspace",
            environment: { CUSTOM_PROVIDER_KEY: "custom-provider-key" }
          })
        ),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("hello") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
                CODEX_ACCESS_TOKEN: "codex-access-token",
                CODEX_API_KEY: "codex-api-key",
                CODEX_HOME: "/home/reviewer/.codex",
                CODEX_THREAD_ID: "session-canary",
                HOME: "/home/reviewer",
                PATH: "/reviewed/bin",
                SENTRY_AUTH_TOKEN: "vendor-canary",
                XDG_CONFIG_HOME: "/home/reviewer/.config"
              }
            })
          )
        )
      )

      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(Object.isFrozen(command)).toBe(true)
        expect(Object.isFrozen(command.args)).toBe(true)
        expect(Object.isFrozen(command.options)).toBe(true)
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({
          CODEX_ACCESS_TOKEN: "codex-access-token",
          CODEX_API_KEY: "codex-api-key",
          CODEX_HOME: "/home/reviewer/.codex",
          CUSTOM_PROVIDER_KEY: "custom-provider-key",
          HOME: "/home/reviewer",
          PATH: "/reviewed/bin",
          XDG_CONFIG_HOME: "/home/reviewer/.config"
        })
        expect(command.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
        expect(command.options.env).not.toHaveProperty("CODEX_THREAD_ID")
        expect(command.options.env).not.toHaveProperty("SENTRY_AUTH_TOKEN")
        const environment = command.options.env
        const originalArguments = [...command.args]
        const stdin = command.options.stdin
        expect(environment === undefined ? false : Object.isFrozen(environment)).toBe(true)
        expect(() => Object.assign(command, { options: { extendEnv: true } })).toThrow()
        expect(() => Object.assign(command.args, { 0: "--dangerously-bypass-safety" })).toThrow()
        expect(() => Object.assign(command.options, { extendEnv: true })).toThrow()
        expect(() => Object.assign(environment ?? {}, { AWS_SECRET_ACCESS_KEY: "injected" })).toThrow()
        expect(typeof stdin === "object" && stdin !== null && Object.isFrozen(stdin)).toBe(true)
        if (typeof stdin === "object" && stdin !== null && "endOnDone" in stdin) {
          expect(stdin.endOnDone).toBe(true)
          expect(() => Object.assign(stdin, { endOnDone: false })).toThrow()
          expect(stdin.endOnDone).toBe(true)
        }
        expect(command.args).toEqual(originalArguments)
        expect(command.options.extendEnv).toBe(false)
        expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
      }
    }))

  it.effect("uses the isolated environment for streamed model turns", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.streamText({ prompt: "Say hello" }).pipe(
        Stream.provide(
          model({
            cwd: "/workspace",
            environment: { CUSTOM_PROVIDER_KEY: "custom-provider-key" }
          })
        ),
        Stream.provide(fakeProcessLayer(calls, { stdout: successTranscript("hello") })),
        Stream.provide(NodeFileSystem.layer),
        Stream.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
                CODEX_API_KEY: "codex-api-key",
                HOME: "/home/reviewer",
                PATH: "/reviewed/bin"
              }
            })
          )
        ),
        Stream.runDrain
      )

      const command = calls[0]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.options.extendEnv).toBe(false)
        expect(command.options.env).toEqual({
          CODEX_API_KEY: "codex-api-key",
          CUSTOM_PROVIDER_KEY: "custom-provider-key",
          HOME: "/home/reviewer",
          PATH: "/reviewed/bin"
        })
        expect(command.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
      }
    }))

  it.effect("maps environment provider failures before spawning", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const failingProvider = ConfigProvider.make(() =>
        Effect.fail(new ConfigProvider.SourceError({ message: "environment unavailable" }))
      )
      const error = yield* LanguageModel.generateText({ prompt: "Say hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace" })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("unused") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(ConfigProvider.layer(failingProvider)),
        Effect.flip
      )

      expect(error.reason).toMatchObject({
        _tag: "InternalProviderError",
        metadata: { "codex-cli": { phase: "configuration" } }
      })
      expect(calls).toHaveLength(0)
    }))

  it.effect("rejects file prompt parts before spawning Codex", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* provideTestRuntime(
        LanguageModel.generateText({
          prompt: [
            {
              content: [{ data: "aGVsbG8=", mediaType: "text/plain", type: "file" }],
              role: "user"
            }
          ]
        }),
        calls,
        { stdout: successTranscript("unused") }
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))

  it.effect("fails with AiError when stdout exceeds its configured bound", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "Say hello" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxOutputBytes: 8 })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("hello") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects an oversized rendered prompt before spawning", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "éé" }).pipe(
        Effect.provide(model({ cwd: "/workspace", maxPromptBytes: 8 })),
        Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("unused") })),
        Effect.provide(NodeFileSystem.layer),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(0)
    }))
})
