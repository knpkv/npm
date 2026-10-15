import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { classifyAgentTask } from "@knpkv/herdr-fleet"
import { Effect, FileSystem, Path } from "effect"
import {
  parseSessionTaskActivity,
  readSessionTaskActivity,
  type TaskProvider
} from "../src/internal/agent-task-evidence.js"

const jsonl = (...values: ReadonlyArray<object>): string =>
  values.map((value) => JSON.stringify(value)).join("\n") + "\n"
const claudeCall = (name: string, command?: string) => ({
  type: "assistant",
  message: {
    content: [{
      type: "tool_use",
      id: "call-1",
      name,
      input: { command, file_path: "/private/source", content: "private tool content" }
    }]
  }
})
const codexCall = (name: string, cmd?: string) => ({
  type: "response_item",
  payload: {
    type: "function_call",
    call_id: "call-1",
    name,
    arguments: JSON.stringify({ cmd, path: "/private/source", content: "private tool content" })
  }
})

describe("host-private provider task evidence", () => {
  const cases: ReadonlyArray<readonly [TaskProvider, string, string, "reading" | "writing" | "testing"]> = [
    ["claude", "Read", "", "reading"],
    ["claude", "Grep", "", "reading"],
    ["claude", "Glob", "", "reading"],
    ["claude", "Write", "", "writing"],
    ["claude", "Edit", "", "writing"],
    ["claude", "Bash", "pnpm test", "testing"],
    ["claude", "Bash", "npm run build", "testing"],
    ["codex", "read_file", "", "reading"],
    ["codex", "apply_patch", "", "writing"],
    ["codex", "exec_command", "pnpm exec vitest run", "testing"],
    ["codex", "exec_command", "cargo build", "testing"],
    ["codex", "exec_command", "npx vitest run", "testing"]
  ]
  it.each(cases)("%s %s %s maps to %s", (provider, tool, command, expected) => {
    const activity = parseSessionTaskActivity(
      provider,
      jsonl(provider === "claude" ? claudeCall(tool, command) : codexCall(tool, command))
    )
    expect(classifyAgentTask({ status: "working", activity })).toBe(expected)
    expect(Object.keys(activity).sort()).toEqual(["kind", "outcome"])
    expect(JSON.stringify(activity)).not.toContain("private")
  })

  it("ignores non-tool Codex metadata envelopes while decoding actual tool events", () => {
    expect(parseSessionTaskActivity(
      "codex",
      jsonl(
        { type: "session_meta", payload: { id: "fixture-session", cwd: "/private/source" } },
        { type: "event_msg", payload: { type: "user_message", message: "private prompt" } },
        codexCall("apply_patch")
      )
    )).toEqual({ kind: "edit", outcome: "running" })
  })

  it("uses only structured native Codex command outcomes and matching call identities", () => {
    const result = (callId: string, output: string) => ({
      type: "response_item",
      payload: { type: "function_call_output", call_id: callId, output }
    })
    const activity = parseSessionTaskActivity(
      "codex",
      jsonl(
        codexCall("exec_command", "pnpm test"),
        result("call-1", JSON.stringify({ exit_code: 1, output: "private failure" }))
      )
    )
    expect(classifyAgentTask({ status: "working", activity })).toBe("failing")
    const other = parseSessionTaskActivity(
      "codex",
      jsonl(codexCall("exec_command", "false"), result("call-1", JSON.stringify({ exit_code: 1 })))
    )
    expect(classifyAgentTask({ status: "working", activity: other })).toBe("unknown")
    expect(
      parseSessionTaskActivity(
        "codex",
        jsonl(codexCall("read_file"), result("unrelated", JSON.stringify({ exit_code: 1 })))
      )
    ).toEqual({ kind: "read", outcome: "running" })
  })

  it("bounds package-launcher chains and keeps complex command wrappers unknown", () => {
    const activity = parseSessionTaskActivity("codex", jsonl(codexCall("exec_command", "npx ".repeat(32) + "vitest")))
    expect(classifyAgentTask({ status: "working", activity })).toBe("unknown")
  })

  it("uses the latest call, including an unsupported tool, without retaining old reading evidence", () => {
    expect(parseSessionTaskActivity("claude", jsonl(claudeCall("Read"), claudeCall("unsupported")))).toEqual({
      kind: "unknown",
      outcome: "unknown"
    })
  })

  it("leaves Codex JS orchestration wrappers unknown even when their source mentions test commands", () => {
    expect(
      parseSessionTaskActivity(
        "codex",
        jsonl({
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "wrapper",
            name: "exec",
            input: "await tools.exec_command({cmd: \"pnpm test\"})"
          }
        })
      )
    ).toEqual({ kind: "unknown", outcome: "unknown" })
  })

  it("maps direct Codex custom apply_patch calls without reading the patch body", () => {
    expect(
      parseSessionTaskActivity(
        "codex",
        jsonl({
          type: "response_item",
          payload: { type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "private patch content" }
        })
      )
    ).toEqual({ kind: "edit", outcome: "running" })
  })

  it.each(["claude", "codex"])(
    "%s malformed and partial final records return unknown instead of an earlier call",
    (provider) => {
      const supported: TaskProvider = provider === "claude" ? "claude" : "codex"
      const valid = jsonl(supported === "claude" ? claudeCall("Read") : codexCall("apply_patch"))
      expect(parseSessionTaskActivity(supported, valid + "{broken}\n")).toEqual({ kind: "unknown", outcome: "unknown" })
      expect(parseSessionTaskActivity(supported, valid.slice(0, -1))).toEqual({ kind: "unknown", outcome: "unknown" })
    }
  )

  it("only marks a failed test/build tool as failing, never an ordinary non-zero command", () => {
    const failed = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "private failure output" }]
      }
    }
    for (const command of ["pnpm test", "pnpm run build"]) {
      expect(
        classifyAgentTask({
          status: "working",
          activity: parseSessionTaskActivity("claude", jsonl(claudeCall("Bash", command), failed))
        })
      ).toBe("failing")
    }
    for (
      const command of ["grep absent file", "false", "echo pnpm test", "echo build; false", "bash -lc 'pnpm test'"]
    ) {
      expect(
        classifyAgentTask({
          status: "working",
          activity: parseSessionTaskActivity("claude", jsonl(claudeCall("Bash", command), failed))
        })
      ).toBe("unknown")
    }
  })
})

describe("bounded local session reads", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("reads at most 128KiB of a huge log, never an unbounded file read", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "task-session-tail-" })
        const file = path.join(root, "fixture.jsonl")
        yield* fs.writeFileString(
          file,
          jsonl({ type: "metadata", padding: "x".repeat(3 * 1024 * 1024) }, claudeCall("Read"))
        )
        const readSizes: Array<number> = []
        const readTotals: Array<number> = []
        const observedFs: FileSystem.FileSystem = {
          ...fs,
          readFile: () => Effect.die("unbounded readFile is forbidden for session evidence"),
          readFileString: () => Effect.die("unbounded readFileString is forbidden for session evidence"),
          open: (filePath, options) =>
            fs.open(filePath, options).pipe(Effect.map((opened) => ({
              [FileSystem.FileTypeId]: opened[FileSystem.FileTypeId],
              stat: opened.stat,
              sync: opened.sync,
              seek: (offset, from) => opened.seek(offset, from),
              readAlloc: (size) => opened.readAlloc(size),
              truncate: (length) => opened.truncate(length),
              write: (buffer) => opened.write(buffer),
              writeAll: (buffer) => opened.writeAll(buffer),
              read: (buffer) =>
                Effect.gen(function*() {
                  readSizes.push(buffer.byteLength)
                  const read = yield* opened.read(buffer)
                  readTotals.push(read)
                  return read
                })
            })))
        }
        const activity = yield* readSessionTaskActivity("claude", file).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFs)
        )
        expect(activity).toEqual({ kind: "read", outcome: "running" })
        expect(readSizes.length).toBeGreaterThan(0)
        expect(Math.max(...readSizes)).toBeLessThanOrEqual(128 * 1024)
        expect(readTotals.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(128 * 1024)
      }).pipe(Effect.scoped))
  })
})
