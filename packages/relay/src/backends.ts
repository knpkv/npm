/**
 * The two backends Relay supports, each a model turn through the user's own CLI login: Claude Code
 * (Claude Pro/Max or whatever the CLI is signed in with) and Codex (ChatGPT login). Relay never holds a
 * provider credential; the CLI does.
 *
 * Both run with every CLI tool withheld (`prompt-only` / `promptOnly`): the harness runs Relay's tools
 * behind its gate, so the CLI is only ever asked for one structured answer.
 *
 * Each backend's `probe` runs `<cli> --version` with only `PATH`, so the dock can say "installed, not yet
 * verified" without spending a model call.
 *
 * @module
 */
import * as ClaudeCli from "@knpkv/ai-claude"
import * as CodexCli from "@knpkv/ai-codex"
import { readLocalCliRuntimeMetadata } from "@knpkv/ai-runtime"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { RelayBackendUnavailable } from "./harness.js"
import type { RelayBackend } from "./harness.js"

export interface CliBackendOptions {
  /** Working directory the CLI starts in. It reads no files there: every tool is withheld. */
  readonly cwd: string
  /** Model override; omitted means the CLI's configured default. */
  readonly model?: string | undefined
}

interface CliProbe {
  readonly executable: string
  readonly implementation: string
  readonly install: string
  readonly cwd: string
}

const notInstalled = (cli: CliProbe) => new RelayBackendUnavailable({ cause: "NotInstalled", fix: cli.install })

const misconfigured = (cli: CliProbe) =>
  new RelayBackendUnavailable({
    cause: "Misconfigured",
    fix: `${cli.executable} --version printed no version; reinstall it.`
  })

const probe = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cli: CliProbe
) =>
  readLocalCliRuntimeMetadata({ executable: cli.executable, implementation: cli.implementation, cwd: cli.cwd }).pipe(
    Effect.mapError((failure) => failure.reason === "unavailable" ? notInstalled(cli) : misconfigured(cli)),
    // A local CLI always reports its version; only a remote API may not.
    Effect.flatMap((metadata) =>
      metadata.version === null ? Effect.fail(misconfigured(cli)) : Effect.succeed(metadata.version)
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  )

/** Claude Code on the user's own login. */
export const claudeCodeBackend = Effect.fn("Relay.claudeCodeBackend")(function*(options: CliBackendOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return {
    id: "claude-code",
    name: "Claude Code",
    model: ClaudeCli.model({ cwd: options.cwd, access: "prompt-only", model: options.model }).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
    ),
    probe: probe(spawner, {
      executable: "claude",
      implementation: "claude",
      install: "Install Claude Code: npm install -g @anthropic-ai/claude-code",
      cwd: options.cwd
    }),
    signInFix: "Run claude and sign in with /login."
  } satisfies RelayBackend
})

/** Codex on the user's own ChatGPT login. */
export const codexCliBackend = Effect.fn("Relay.codexCliBackend")(function*(options: CliBackendOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fileSystem = yield* FileSystem.FileSystem
  return {
    id: "codex-cli",
    name: "Codex",
    model: CodexCli.model({ cwd: options.cwd, access: "read-only", promptOnly: true, model: options.model }).pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(FileSystem.FileSystem, fileSystem)
      ))
    ),
    probe: probe(spawner, {
      executable: "codex",
      implementation: "codex-cli",
      install: "Install Codex: npm install -g @openai/codex",
      cwd: options.cwd
    }),
    signInFix: "Run codex login."
  } satisfies RelayBackend
})
