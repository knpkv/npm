/** Session discovery uses the real filesystem so provider layouts cannot disappear behind a fake. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { Schema } from "effect"
import { Effect, FileSystem, Layer } from "effect"
import { AgentSessionReader, layer as readerLayer } from "../src/services/AgentSessionReader.js"
import { layer as configLayer } from "../src/services/ConfigService.js"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import { makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

const fromMs = Date.parse("2026-09-07T00:00:00Z")
const toMs = Date.parse("2026-09-14T00:00:00Z")
const at = (minutes: number) => new Date(fromMs + minutes * 60_000).toISOString()
const event = (type: string, payload: Schema.Json, minutes = 0) =>
  JSON.stringify({ type, timestamp: at(minutes), payload })
const meta = (id: string, cwd: string, source: Schema.Json = "cli") =>
  event("session_meta", { id, cwd, source, git: { branch: "feat/PROJ-5662" } }, -1440)
const prompt = (text: string, minutes: number) =>
  event("event_msg", {
    type: "item_completed",
    item: { type: "UserMessage", id: `prompt-${String(minutes)}`, content: [{ type: "text", text }] }
  }, minutes)

/** A resumed rollout can live in an older date directory; activity time decides its week. */
const withTranscripts = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${home}/.jcf`)
    yield* fs.writeFileString(`${home}/.jcf/config.json`, JSON.stringify({ sessionRoots: ["/work"] }))
    for (const [relative, content] of Object.entries(files)) {
      const file = `${home}/${relative}`
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
      yield* fs.writeFileString(file, content)
    }
    return yield* Effect.gen(function*() {
      const reader = yield* AgentSessionReader
      return yield* reader.read({ from: new Date(fromMs), to: new Date(toMs) })
    }).pipe(Effect.provide(readerLayer.pipe(
      Layer.provide(configLayer),
      Layer.provide(Layer.succeed(HomeDirectory, { path: home }))
    )))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("Claude and Codex session discovery", () => {
  it.effect("fails when an admitted Claude project directory cannot be listed", () => {
    const fake = makeFakeHeadless({
      config: { sessionRoots: ["/work"] },
      transcripts: {
        "repo/session.jsonl": JSON.stringify({
          type: "user",
          sessionId: "session",
          cwd: "/work/repo",
          timestamp: at(10),
          message: { content: "PROJ-1" }
        })
      },
      unreadableTranscripts: ["-work-repo"]
    })
    return Effect.gen(function*() {
      const reader = yield* AgentSessionReader
      const exit = yield* Effect.exit(reader.read({ from: new Date(fromMs), to: new Date(toMs) }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("Listing Claude project")
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("counts authoritative user events once and ignores injected context, replay and tool output", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/rollout.jsonl": [
        meta("human", "/work/repo"),
        event("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Injected PROJ-9999" }]
        }, 0),
        prompt("Actual PROJ-5662 work", 10),
        prompt("Actual PROJ-5662 work", 10),
        event("event_msg", {
          type: "item_completed",
          item: { type: "AgentMessage", content: [{ type: "text", text: "PROJ-8888" }] }
        }, 11),
        event("response_item", { type: "function_call_output", output: "PROJ-7777" }, 12),
        event("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Verified PROJ-5662 fix" }]
        }, 13),
        event("compacted", { replacement_history: [{ role: "user", content: "PROJ-6666" }] }, 14),
        prompt("Follow-up", 15),
        "{malformed"
      ].join("\n")
    }).pipe(Effect.map((records) => {
      expect(records).toHaveLength(1)
      expect(records[0]?.activity).toHaveLength(2)
      expect(records[0]?.candidateKeys).toEqual(["PROJ-5662"])
      expect(records[0]?.digest).toContain("Verified PROJ-5662 fix")
      expect(records[0]?.digest).not.toContain("Injected")
    })))

  it.effect("reads older user_message events without counting their response-item copies", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/older.jsonl": [
        meta("older", "/work/repo"),
        event("event_msg", { type: "user_message", message: "Older prompt" }, 10),
        event("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Older prompt" }]
        }, 10),
        event("event_msg", { type: "user_message", message: "Outside requested week" }, -1),
        event("event_msg", { type: "user_message", message: "Next week" }, 7 * 1440)
      ].join("\n")
    }).pipe(Effect.map((records) => {
      expect(records[0]?.activity).toEqual([{ sessionId: "older", atMs: fromMs + 600_000 }])
      expect(records[0]?.digest).toContain("Older prompt")
      expect(records[0]?.digest).not.toContain("requested week")
      expect(records[0]?.digest).not.toContain("Next week")
    })))

  it.effect("bounds moved sessions and never includes out-of-scope text in their evidence", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/moved.jsonl": [
        meta("moved", "/outside/repo"),
        prompt("Outside PROJ-9999", 10),
        event("turn_context", { cwd: "/work/repo" }, 11),
        prompt("Inside PROJ-5662", 12),
        event("turn_context", { cwd: "/outside/repo" }, 13),
        prompt("Outside again PROJ-8888", 14)
      ].join("\n"),
      ".codex/sessions/2026/09/07/child.jsonl": [
        meta("child", "/work/repo", { subagent: { thread_spawn: { parent_thread_id: "parent" } } }),
        prompt("Machine delegated PROJ-7777", 15)
      ].join("\n")
    }).pipe(Effect.map((records) => {
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        cwd: "/work/repo",
        gitBranch: null,
        boundedAtMs: fromMs + 13 * 60_000,
        candidateKeys: ["PROJ-5662"]
      })
      expect(records[0]?.digest).not.toContain("Outside")
      expect(records[0]?.digest).not.toContain("Machine")
    })))

  it.effect("uses user start time, skips invalid timestamps, and tolerates a missing Claude directory", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/start.jsonl": [
        meta("started", "/work/repo"),
        event("event_msg", {
          type: "item_completed",
          started_at_ms: fromMs + 600_000,
          item: { type: "UserMessage", content: [{ type: "text", text: "Actual start" }] }
        }, 20),
        event("event_msg", {
          type: "item_completed",
          started_at_ms: 1e30,
          item: { type: "UserMessage", content: [{ type: "text", text: "Invalid time" }] }
        }, 21)
      ].join("\n")
    }).pipe(Effect.map((records) => {
      expect(records[0]?.activity).toEqual([{ sessionId: "started", atMs: fromMs + 600_000 }])
    })))

  it.effect("finds the latest Codex work in a resumed old rollout alongside Claude", () =>
    withTranscripts({
      ".codex/sessions/2026/08/31/rollout.jsonl": [
        meta("codex-latest", "/work/repo"),
        prompt("Work on PROJ-5662", 3 * 1440 + 600),
        prompt("Verify the change", 3 * 1440 + 604)
      ].join("\n"),
      ".claude/projects/-work-repo/claude.jsonl": JSON.stringify({
        type: "user",
        sessionId: "claude",
        cwd: "/work/repo",
        timestamp: at(60),
        message: { content: "Earlier work" }
      })
    }).pipe(Effect.map((records) => {
      expect(records.map((record) => record.sessionId).sort()).toEqual(["claude", "codex-latest"])
      expect(records.find((record) => record.sessionId === "codex-latest")?.activity.map((activity) => activity.atMs))
        .toEqual([fromMs + (3 * 1440 + 600) * 60_000, fromMs + (3 * 1440 + 604) * 60_000])
    })))
})
