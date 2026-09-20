import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { makeLanguageModel } from "./internal/languageModel.js"

/** Supplied request, visible agent text, final answer or a fixed milestone; excludes reasoning and tool events. */
export interface CodexActivity {
  readonly kind: "request" | "status" | "text" | "response"
  readonly text: string
}

/** Configuration for a local Codex-backed Effect AI model. */
export interface CodexModelOptions {
  /** Working directory made visible to Codex. */
  readonly cwd: string
  /** Codex executable name or absolute path. Defaults to `codex`. */
  readonly executable?: string
  /** Optional Codex model override. */
  readonly model?: string | undefined
  /** Optional reasoning effort override. Omission preserves the configured default. */
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
  /** Observes live visible activity. Backpressure and cancellation follow the generation call. */
  readonly onActivity?: ((activity: CodexActivity) => Effect.Effect<void>) | undefined
  /** Explicit extra variables for custom Codex providers. Parent variables are not inherited. */
  readonly environment?: Readonly<Record<string, string>>
  /** Filesystem access granted to Codex. Defaults to `read-only`. */
  readonly access?: "read-only" | "workspace-write"
  /**
   * Runs without host-capable tools, user configuration, repository instructions,
   * or inherited shell variables. Use when all review material is in the prompt.
   */
  readonly promptOnly?: boolean
  /** Maximum duration of one Codex turn. Defaults to two minutes. */
  readonly timeout?: Duration.Input
  /** Maximum bytes accepted from Codex stdout. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number
  /** Maximum UTF-8 bytes accepted for one rendered prompt. Defaults to 1 MiB. */
  readonly maxPromptBytes?: number
  /** Maximum bytes accepted from Codex stderr. Defaults to 64 KiB. */
  readonly maxStderrBytes?: number
}

/**
 * Creates an Effect AI model backed by an authenticated local Codex CLI.
 *
 * Each Effect AI generation is isolated in an ephemeral Codex invocation.
 * Toolkits and file prompt parts are rejected because the local CLI transport
 * cannot preserve Effect AI's typed tool and file semantics.
 */
export const model = (
  options: CodexModelOptions
): AiModel.Model<
  "codex-cli",
  LanguageModel.LanguageModel,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  AiModel.make(
    "codex-cli",
    options.model ?? "configured-default",
    Layer.effect(LanguageModel.LanguageModel, makeLanguageModel(options))
  )
