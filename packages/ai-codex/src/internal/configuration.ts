import { Effect } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import type { CodexModelOptions } from "../model.js"
import { invalidRequest } from "./errors.js"

const DEFAULT_EXECUTABLE = "codex"
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_MAX_STDERR_BYTES = 65_536
const DEFAULT_TIMEOUT = "2 minutes"

export interface NormalizedOptions {
  readonly access: "read-only" | "workspace-write"
  readonly cwd: string
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly model: string | undefined
  readonly timeout: NonNullable<CodexModelOptions["timeout"]>
}

export const normalizeOptions = (
  options: CodexModelOptions,
  method: string
): Effect.Effect<NormalizedOptions, AiError.AiError> =>
  Effect.gen(function*() {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      return yield* invalidRequest(method, "maxOutputBytes", "must be a positive safe integer")
    }
    if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes <= 0) {
      return yield* invalidRequest(method, "maxStderrBytes", "must be a positive safe integer")
    }
    if (options.cwd.trim().length === 0) {
      return yield* invalidRequest(method, "cwd", "must not be empty")
    }
    return {
      access: options.access ?? "read-only",
      cwd: options.cwd,
      executable: options.executable ?? DEFAULT_EXECUTABLE,
      maxOutputBytes,
      maxStderrBytes,
      model: options.model,
      timeout: options.timeout ?? DEFAULT_TIMEOUT
    }
  })

export const makeArguments = (
  options: NormalizedOptions,
  schemaFile: string | undefined
): ReadonlyArray<string> => {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    options.access,
    "--skip-git-repo-check"
  ]
  if (options.model !== undefined) args.push("--model", options.model)
  if (schemaFile !== undefined) args.push("--output-schema", schemaFile)
  args.push("-")
  return args
}
