import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema, Sink, Stream } from "effect"
import * as Predicate from "effect/Predicate"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { type CodexActivity, type CodexModelOptions, model } from "../src/index.js"
import { PROMPT_ONLY_DISABLED_FEATURES, PROMPT_ONLY_SAFE_FEATURES } from "../src/internal/configuration.js"
import { inventory as previousFeatureInventory } from "./fixtures/codex-0.153.4.js"
import { inventory as completeFeatureInventory } from "./fixtures/codex-0.154.0.js"

// Each test is an entry point composing its model and fake process lifetime.
// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

interface FakeProcessOptions {
  readonly exitCode?: number
  readonly featureExitCode?: number
  readonly featureInventory?: string
  readonly stderr?: string
  readonly stdout: string | Stream.Stream<string>
  readonly onRelease?: Effect.Effect<void>
}

const fakeProcessLayer = (
  calls: Array<ChildProcess.Command>,
  options: FakeProcessOptions
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(Effect.fn(function*(command) {
      calls.push(command)
      const isFeatureInventory = ChildProcess.isStandardCommand(command) && command.args.join(" ") === "features list"
      if (!isFeatureInventory && options.onRelease !== undefined) {
        yield* Effect.addFinalizer(() => options.onRelease ?? Effect.void)
      }
      const output = isFeatureInventory ? (options.featureInventory ?? completeFeatureInventory) : options.stdout
      const stdout = (Predicate.isString(output) ? Stream.make(output) : output).pipe(Stream.encodeText)
      const stderr = Stream.make(options.stderr ?? "").pipe(Stream.encodeText)
      return (
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
          stderr,
          stdin: Sink.drain,
          stdout,
          unref: Effect.succeed(Effect.void)
        })
      )
    }))
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
  it.effect("passes every supported effort as one config override while retaining prompt-only restrictions", () =>
    Effect.gen(function*() {
      const efforts: ReadonlyArray<NonNullable<CodexModelOptions["effort"]>> = [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
      for (const effort of efforts) {
        const calls: Array<ChildProcess.Command> = []
        yield* LanguageModel.generateText({ prompt: "Supplied evidence" }).pipe(
          Effect.provide(model({ cwd: "/workspace", effort, promptOnly: true })),
          Effect.provide(fakeProcessLayer(calls, { stdout: successTranscript("ready") })),
          Effect.provide(NodeFileSystem.layer)
        )
        expect(calls).toHaveLength(2)
        const command = calls[1]
        if (command === undefined || !ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die("missing command")
        }
        const setting = `model_reasoning_effort=${JSON.stringify(effort)}`
        expect(command.args[command.args.indexOf(setting) - 1]).toBe("-c")
        expect(command.args).toContain("--ignore-user-config")
        expect(command.args).toContain("--ignore-rules")
        expect(command.args).toContain("shell_tool")
        expect(command.options.extendEnv).toBe(false)
      }
    }))

  it.effect("reports visible activity before completion and only the accepted final answer as response", () =>
    Effect.gen(function*() {
      const seen = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const activity: Array<CodexActivity> = []
      const first = [
        { type: "thread.started", thread_id: "private-thread" },
        { type: "turn.started" },
        { type: "system", message: "private-system" },
        { type: "auth", message: "private-auth" },
        { type: "item.completed", item: { type: "reasoning", text: "private-reasoning" } },
        { type: "item.completed", item: { type: "command_execution", text: "private-tool" } },
        { type: "item.completed", item: { type: "agent_message", text: "Checking supplied evidence" } }
      ].map((event) => JSON.stringify(event) + "\n").join("")
      const stdout = Stream.make(first.slice(0, 17), first.slice(17)).pipe(
        Stream.concat(Stream.fromEffect(
          Deferred.await(finish).pipe(
            Effect.as(successTranscript("{\"status\":\"ready\"}"))
          )
        ))
      )
      const fiber = yield* LanguageModel.generateObject({
        prompt: "Status",
        schema: Schema.Struct({ status: Schema.String })
      }).pipe(
        Effect.provide(model({
          cwd: "/workspace",
          promptOnly: true,
          onActivity: (event) =>
            Effect.gen(function*() {
              activity.push(event)
              if (event.kind === "text") yield* Deferred.succeed(seen, undefined)
            })
        })),
        Effect.provide(fakeProcessLayer([], { stdout })),
        Effect.provide(NodeFileSystem.layer),
        Effect.forkChild
      )
      yield* Deferred.await(seen)
      expect(activity[0]?.kind).toBe("request")
      expect(activity[0]?.text).toContain("Status")
      expect(activity).toContainEqual({ kind: "text", text: "Checking supplied evidence" })
      expect(activity.some((event) => event.kind === "response")).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      expect((yield* Fiber.join(fiber)).value).toEqual({ status: "ready" })
      expect(activity.filter((event) => event.kind === "response")).toEqual([{
        kind: "response",
        text: "{\"status\":\"ready\"}"
      }])
      expect(JSON.stringify(activity)).not.toContain("private-")
      expect(activity.at(-1)).toEqual({ kind: "status", text: "Answer received" })
    }))

  it.effect("interrupts an active observed turn and releases its process without emitting a response", () =>
    Effect.gen(function*() {
      const seen = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const activity: Array<CodexActivity> = []
      const fiber = yield* LanguageModel.generateText({ prompt: "Status" }).pipe(
        Effect.provide(model({
          cwd: "/workspace",
          onActivity: (event) =>
            Effect.gen(function*() {
              activity.push(event)
              if (event.kind === "text") yield* Deferred.succeed(seen, undefined)
            })
        })),
        Effect.provide(fakeProcessLayer([], {
          stdout: Stream.make(
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Visible" } }) + "\n"
          ).pipe(Stream.concat(Stream.never)),
          onRelease: Deferred.succeed(released, undefined).pipe(Effect.asVoid)
        })),
        Effect.provide(NodeFileSystem.layer),
        Effect.forkChild
      )
      yield* Deferred.await(seen)
      yield* Fiber.interrupt(fiber)
      expect(yield* Deferred.isDone(released)).toBe(true)
      expect(activity.some((event) => event.kind === "response")).toBe(false)
    }))

  it.effect("withholds the response when process or transcript completion fails", () =>
    Effect.gen(function*() {
      const scenarios: ReadonlyArray<FakeProcessOptions> = [
        { stdout: successTranscript("visible but unsuccessful"), exitCode: 1 },
        { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "incomplete" } }) }
      ]
      for (const scenario of scenarios) {
        const activity: Array<CodexActivity> = []
        const exit = yield* LanguageModel.generateText({ prompt: "Status" }).pipe(
          Effect.provide(model({
            cwd: "/workspace",
            onActivity: (event) =>
              Effect.sync(() => {
                activity.push(event)
              })
          })),
          Effect.provide(fakeProcessLayer([], scenario)),
          Effect.provide(NodeFileSystem.layer),
          Effect.exit
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(activity.some((event) => event.kind === "text")).toBe(true)
        expect(activity.some((event) => event.kind === "response")).toBe(false)
      }
    }))

  it.effect("bounds observed stdout before publishing oversized agent text", () =>
    Effect.gen(function*() {
      const activity: Array<CodexActivity> = []
      const error = yield* LanguageModel.generateText({ prompt: "Status" }).pipe(
        Effect.provide(model({
          cwd: "/workspace",
          maxOutputBytes: 64,
          onActivity: (event) =>
            Effect.sync(() => {
              activity.push(event)
            })
        })),
        Effect.provide(fakeProcessLayer([], { stdout: successTranscript("x".repeat(65)) })),
        Effect.provide(NodeFileSystem.layer),
        Effect.flip
      )
      expect(error.reason._tag).toBe("InternalProviderError")
      expect(activity.some((event) => event.kind === "text" || event.kind === "response")).toBe(false)
    }))

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
        expect(command.args.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false)
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

  it.effect("rejects malformed feature names instead of filtering them out", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      const exit = yield* LanguageModel.generateText({ prompt: "Review this supplied patch" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(
          fakeProcessLayer(calls, {
            featureInventory: `${completeFeatureInventory}\nfeature-alpha stable true`,
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

  it.effect("classifies the independent Codex 0.154.0 inventory and removes host capabilities before the turn", () =>
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
          expect.arrayContaining([
            "hooks",
            "plugins",
            "recommended_plugins",
            "skill_mcp_dependency_install",
            "skill_search",
            "view_image",
            "shell_tool",
            "code_mode",
            "background_paginated_rollout_migration",
            "bedrock_setup_wizard",
            "chronicle",
            "code_mode_prewarm",
            "context_management",
            "guardian_enhanced_node_repl_transcripts",
            "guardian_ext",
            "guardian_node_repl_transcript_images",
            "guardian_reuse_parent_compaction",
            "in_app_chat",
            "in_app_dictation",
            "in_app_local_automation",
            "mcp_oauth_refresh_coordination",
            "powershell_shell_version",
            "psp",
            "shell_snapshot_v2",
            "sleep_tool",
            "step_model_switching",
            "unified_exec_tty",
            "worktrees"
          ])
        )
        expect(PROMPT_ONLY_SAFE_FEATURES).toEqual(
          expect.arrayContaining([
            "executed_tool_call_metadata",
            "image_resize_notice",
            "apply_patch_preserve_line_endings",
            "code_mode_interrupt",
            "compaction_image_budget",
            "content_item_kinds",
            "cwd_relative_turn_diffs",
            "local_thread_store_shared_compression",
            "omit_app_server_notification_media",
            "retain_client_developer_messages",
            "send_async_message",
            "skip_host_skill_discovery",
            "transcript_v2",
            "unbounded_connection_retries",
            "unified_image_budget",
            "write_stdin_approval",
            "guardianv2.thread_context",
            "reasoning_effort_override",
            "windows_sandbox_service"
          ])
        )
        expect(PROMPT_ONLY_DISABLED_FEATURES.filter((feature) => PROMPT_ONLY_SAFE_FEATURES.includes(feature))).toEqual(
          []
        )
        for (const feature of PROMPT_ONLY_SAFE_FEATURES) expect(command.args).not.toContain(feature)
      }
    }))

  it.effect("keeps Codex 0.153.4 compatible without passing newer disables", () =>
    Effect.gen(function*() {
      const calls: Array<ChildProcess.Command> = []
      yield* LanguageModel.generateText({ prompt: "Supplied evidence" }).pipe(
        Effect.provide(model({ cwd: "/workspace", promptOnly: true })),
        Effect.provide(fakeProcessLayer(calls, {
          featureInventory: previousFeatureInventory,
          stdout: successTranscript("ready")
        })),
        Effect.provide(NodeFileSystem.layer)
      )
      expect(calls).toHaveLength(2)
      const command = calls[1]
      expect(command !== undefined && ChildProcess.isStandardCommand(command)).toBe(true)
      if (command !== undefined && ChildProcess.isStandardCommand(command)) {
        expect(command.args).not.toContain("unified_exec_tty")
        expect(command.args).not.toContain("worktrees")
        expect(command.args).toContain("shell_tool")
      }
    }))

  it.effect("isolates feature discovery from user config without dropping turn authentication", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
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
          CODEX_HOME: expect.stringContaining("ai-codex-feature-inventory-"),
          PATH: "/reviewed/bin"
        })
        const inventoryHome = inventory.options.env?.CODEX_HOME
        expect(inventoryHome).not.toBe("/home/reviewer/.codex")
        expect(inventoryHome).toBeDefined()
        if (inventoryHome !== undefined) expect(yield* fileSystem.exists(inventoryHome)).toBe(false)
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
    }).pipe(Effect.provide(NodeFileSystem.layer)))

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
        expect(Predicate.isObjectOrArray(stdin) && stdin !== null && Object.isFrozen(stdin)).toBe(true)
        if (Predicate.isObjectOrArray(stdin) && stdin !== null && "endOnDone" in stdin) {
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
