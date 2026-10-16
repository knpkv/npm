import type { AgentTaskFacts } from "@knpkv/herdr-fleet"
import { ByteSize, Effect, FileSystem, Result, Schema } from "effect"

export type TaskActivity = NonNullable<AgentTaskFacts["activity"]>
export type TaskProvider = "claude" | "codex"

const unknownActivity: TaskActivity = { kind: "unknown", outcome: "unknown" }
const Envelope = Schema.Struct({ type: Schema.String })
const CommandInput = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  cmd: Schema.optionalKey(Schema.String)
})
const ClaudeEntry = Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(Schema.Struct({
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({
        type: Schema.String,
        id: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        tool_use_id: Schema.optionalKey(Schema.String),
        is_error: Schema.optionalKey(Schema.Boolean),
        input: Schema.optionalKey(CommandInput)
      }))
    ])
  }))
})
const ToolOutcome = Schema.Struct({
  exit_code: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  exitCode: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  is_error: Schema.optionalKey(Schema.Boolean)
})
const CodexEntry = Schema.Struct({
  type: Schema.String,
  payload: Schema.optionalKey(Schema.Struct({
    type: Schema.String,
    name: Schema.optionalKey(Schema.String),
    call_id: Schema.optionalKey(Schema.String),
    arguments: Schema.optionalKey(Schema.String),
    output: Schema.optionalKey(Schema.Unknown)
  }))
})

/** Codex's own typed parse of a wrapper's command; the command text and output are never read. */
const CodexCommandDone = Schema.Struct({
  type: Schema.Literal("event_msg"),
  payload: Schema.Struct({
    type: Schema.Literal("item_completed"),
    item: Schema.Struct({
      type: Schema.Literal("CommandExecution"),
      parsed_cmd: Schema.Array(Schema.Struct({ type: Schema.String }))
    })
  })
})
const typedReads: ReadonlySet<string> = new Set(["read", "search", "list_files"])

/** Only direct commands are classified. Shell control flow and wrappers require their own producer. */
const commandKind = (command: string, depth = 0): TaskActivity["kind"] => {
  if (depth >= 4) return "other"
  if (/[;&|`$<>\n\r]/u.test(command)) return "other"
  const words = command.trim().split(/\s+/u)
  const executable = words[0]?.split("/").at(-1)
  const args = words.slice(1)
  if (
    executable === "rg" || executable === "grep" || executable === "cat" || executable === "head" ||
    executable === "tail" || executable === "ls"
  ) return "read"
  if (executable === "vitest" || executable === "jest" || executable === "pytest") return "test"
  if (executable === "playwright" && args[0] === "test") return "test"
  if (
    (executable === "cargo" || executable === "go" || executable === "make" || executable === "nix") &&
    args[0] === "test"
  ) return "test"
  if (
    (executable === "cargo" || executable === "go" || executable === "make" || executable === "nix") &&
    args[0] === "build"
  ) return "build"
  if (executable === "npx") return commandKind(args.join(" "), depth + 1)
  if (executable !== "npm" && executable !== "pnpm" && executable !== "yarn" && executable !== "bun") return "other"
  let index = 0
  while (args[index] === "--filter" || args[index] === "-C" || args[index] === "--dir") index += 2
  if (args[index] === "-w" || args[index] === "--workspace-root") index += 1
  if (args[index] === "exec") return commandKind(args.slice(index + 1).join(" "), depth + 1)
  if (args[index] === "run") index += 1
  const script = args[index]
  if (script === "test" || script?.startsWith("test:") === true) return "test"
  if (script === "build" || script?.startsWith("build:") === true) return "build"
  return "other"
}

const toolKind = (name: string, command: string | undefined): TaskActivity["kind"] => {
  switch (name.replace(/^functions\./u, "").toLowerCase()) {
    case "read":
    case "read_file":
    case "grep":
    case "glob":
    case "search":
    case "websearch":
      return "read"
    case "edit":
    case "multiedit":
    case "apply_patch":
      return "edit"
    case "write":
    case "write_file":
      return "write"
    case "sleep":
      return "wait"
    case "bash":
    case "exec_command":
    case "shell_command":
      return command === undefined ? "unknown" : commandKind(command)
    default:
      return "unknown"
  }
}

const activityFor = (name: string, command: string | undefined): TaskActivity => {
  const kind = toolKind(name, command)
  return kind === "unknown" ? unknownActivity : { kind, outcome: "running" }
}

/** Provider transcript input stays host-private; only normalized activity leaves this parser. */
export const parseSessionTaskActivity = (provider: TaskProvider, tail: string): TaskActivity => {
  if (tail === "" || !tail.endsWith("\n")) return unknownActivity
  let activity = unknownActivity
  let callId: string | undefined
  // A Codex orchestration wrapper whose output has not arrived yet; its commands report typed parses meanwhile.
  let wrapperOpen = false
  for (const line of tail.split("\n").slice(0, -1)) {
    if (line === "") continue
    const envelope = Schema.decodeUnknownResult(Schema.fromJsonString(Envelope))(line)
    if (Result.isFailure(envelope)) return unknownActivity
    if (provider === "claude") {
      if (envelope.success.type !== "assistant" && envelope.success.type !== "user") continue
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(ClaudeEntry))(line)
      if (Result.isFailure(decoded)) return unknownActivity
      const entry = decoded.success
      const content = entry.message?.content
      if (content === undefined || Schema.is(Schema.String)(content)) continue
      for (const block of content) {
        if (entry.type === "assistant" && block.type === "tool_use") {
          callId = block.id
          if (callId === undefined || callId.trim() === "") {
            callId = undefined
            activity = unknownActivity
            continue
          }
          activity = block.name === undefined ? unknownActivity : activityFor(block.name, block.input?.command)
        } else if (block.type === "tool_result" && callId !== undefined && block.tool_use_id === callId) {
          activity = { kind: activity.kind, outcome: block.is_error === true ? "failed" : "succeeded" }
        }
      }
    } else {
      if (envelope.success.type === "event_msg") {
        if (!wrapperOpen) continue
        const done = Schema.decodeUnknownResult(Schema.fromJsonString(CodexCommandDone))(line)
        if (Result.isFailure(done)) continue
        const parsed = done.success.payload.item.parsed_cmd
        activity = parsed.length > 0 && parsed.every((command) => typedReads.has(command.type))
          ? { kind: "read", outcome: "running" }
          : unknownActivity
        continue
      }
      if (envelope.success.type !== "response_item") continue
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(CodexEntry))(line)
      if (Result.isFailure(decoded)) return unknownActivity
      const entry = decoded.success
      const payload = entry.payload
      if (entry.type !== "response_item" || payload === undefined) continue
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        callId = payload.call_id
        wrapperOpen = false
        if (callId === undefined || callId.trim() === "") {
          callId = undefined
          activity = unknownActivity
          continue
        }
        const args = payload.arguments === undefined
          ? undefined
          : Schema.decodeUnknownResult(Schema.fromJsonString(CommandInput))(payload.arguments)
        const command = args !== undefined && Result.isSuccess(args)
          ? args.success.cmd ?? args.success.command
          : undefined
        activity = payload.name === undefined ? unknownActivity : activityFor(payload.name, command)
        wrapperOpen = payload.type === "custom_tool_call" && payload.name === "exec"
      } else if (
        (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
        callId !== undefined && payload.call_id === callId
      ) {
        wrapperOpen = false
        const output = payload.output
        const decodedOutput = Schema.is(Schema.String)(output)
          ? Schema.decodeUnknownResult(Schema.fromJsonString(ToolOutcome))(output)
          : Schema.decodeUnknownResult(ToolOutcome)(output)
        if (Result.isFailure(decodedOutput)) {
          activity = { kind: activity.kind, outcome: "unknown" }
        } else {
          const outcome = decodedOutput.success
          const code = outcome.exit_code ?? outcome.exitCode
          activity = {
            kind: activity.kind,
            outcome: outcome.is_error === true || (code !== undefined && code !== 0)
              ? "failed"
              : code === 0
              ? "succeeded"
              : "unknown"
          }
        }
      }
    }
  }
  return activity
}

/** Reads at most one bounded tail; the caller retains the provider log path on the host. */
export const readSessionTaskActivity = Effect.fn("TaskEvidence.readSession")(
  function*(provider: TaskProvider, path: string) {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.scoped(Effect.gen(function*() {
      const file = yield* fs.open(path, { flag: "r" })
      const stat = yield* file.stat
      if (stat.type !== "File") return unknownActivity
      const size = ByteSize.toBigInt(stat.size)
      const limit = 128 * 1024
      const offset = size > BigInt(limit) ? size - BigInt(limit) : 0n
      const length = Number(size - offset)
      if (length === 0) return unknownActivity
      yield* file.seek(offset, "start")
      const buffer = new Uint8Array(length)
      let consumed = 0
      while (consumed < length) {
        const read = yield* file.read(buffer.subarray(consumed))
        if (read === 0) break
        consumed += read
      }
      const bytes = buffer.subarray(0, consumed)
      // A tail may start inside UTF-8 or a JSON record. Drop that record before decoding.
      const firstNewline = offset === 0n ? -1 : bytes.indexOf(10)
      if (offset !== 0n && firstNewline === -1) return unknownActivity
      const tail = new TextDecoder().decode(offset === 0n ? bytes : bytes.subarray(firstNewline + 1))
      return parseSessionTaskActivity(provider, tail)
    }))
  }
)
