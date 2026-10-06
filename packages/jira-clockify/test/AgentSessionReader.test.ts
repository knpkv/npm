/** Session discovery uses the real filesystem so provider layouts cannot disappear behind a fake. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { Schema } from "effect"
import { Effect, FileSystem, Layer } from "effect"
import {
  activeWindows,
  attributeSession,
  mineTicketKeys,
  splitCredits,
  splitSessionAttribution,
  ticketMentionCounts
} from "../src/agent/sessions.js"
import {
  AgentSessionReader,
  decodeSessionLines,
  decodeTranscript,
  layer as readerLayer
} from "../src/services/AgentSessionReader.js"
import { layer as configLayer } from "../src/services/ConfigService.js"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import type { SessionLine } from "../src/services/SessionLine.js"
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
  event(
    "event_msg",
    {
      type: "item_completed",
      item: { type: "UserMessage", id: `prompt-${String(minutes)}`, content: [{ type: "text", text }] }
    },
    minutes
  )

it("keeps settled split blocks unchanged when later mentions are appended across idle", () => {
  const first = Array.from({ length: 56 }, (_, minute): SessionLine => ({
    sessionId: "orchestrator",
    cwd: "/work",
    gitBranch: null,
    atMs: fromMs + minute * 60_000,
    presence: "prompt",
    text: minute === 0 ? "PROJ-1 PROJ-1 PROJ-1 PROJ-2" : ""
  }))
  const decode = (lines: ReadonlyArray<SessionLine>) => decodeSessionLines(lines, { fromMs, toMs, idleCapMs: 300_000 })
  const allocate = (lines: ReadonlyArray<SessionLine>) => {
    const records = decode(lines)
    const windows = activeWindows(records.flatMap((record) => record.activity), {
      idleCapSeconds: 300,
      observedAtMs: toMs,
      boundsBySession: new Map(
        records.flatMap((record) =>
          record.boundedAtMs === null ? [] : [[record.sessionId, record.boundedAtMs] satisfies [string, number]]
        )
      )
    })
    const attributions = records.map((record) => {
      const session = {
        ...record,
        candidateKeys: mineTicketKeys(record.texts.join("\n")),
        mentionCounts: ticketMentionCounts(record.texts.join("\n"))
      }
      return splitSessionAttribution(
        session,
        attributeSession(session, { standingMap: {}, confidenceFloor: 0.7 }),
        new Set(["PROJ-1", "PROJ-2"]),
        new Set()
      )
    })
    return splitCredits(windows, attributions).attributed.flatMap((row) =>
      row.blocks
        .filter((block) => block.sourceStartMs === fromMs).map((block) => ({ ticketKey: row.ticketKey, ...block }))
    )
  }
  const appended: ReadonlyArray<SessionLine> = [...first, {
    sessionId: "orchestrator",
    cwd: "/work",
    gitBranch: null,
    presence: "prompt",
    atMs: fromMs + 180 * 60_000,
    text: Array.from({ length: 10 }, () => "PROJ-2").join(" ")
  }]
  expect(decode(appended).map((record) => record.sessionId)).toEqual([
    "orchestrator",
    `orchestrator@${fromMs + 180 * 60_000}`
  ])
  expect(allocate(first).map((block) => block.seconds)).toEqual([2700, 900])
  expect(allocate(appended)).toEqual(allocate(first))
})

// A queued prompt is stamped when typed, so it can arrive after later activity; idle is measured from the latest.
it("measures idle from the latest activity when a queued prompt arrives out of order", () => {
  const line = (minute: number): SessionLine => ({
    sessionId: "queued",
    cwd: "/work",
    gitBranch: null,
    atMs: fromMs + minute * 60_000,
    presence: "prompt",
    text: ""
  })
  const records = decodeSessionLines([line(0), line(4), line(1), line(8)], { fromMs, toMs, idleCapMs: 300_000 })
  expect(records.map((record) => record.sessionId)).toEqual(["queued"])
  expect(records[0]?.activity.map((activity) => (activity.atMs - fromMs) / 60_000)).toEqual([0, 1, 4, 8])
})

it("keeps the person's turn open when a subagent ends its own turn", () => {
  const line = (minutes: number, fields: Readonly<Record<string, Schema.Json>>) =>
    JSON.stringify({ sessionId: "main", cwd: "/work", timestamp: at(minutes), ...fields })
  const transcript = [
    line(0, { type: "user", message: { content: "review PROJ-1" } }),
    line(1, { type: "assistant", isSidechain: true, message: { content: "done", stop_reason: "end_turn" } }),
    line(2, { type: "assistant", message: { content: "applying the review", stop_reason: "tool_use" } })
  ].join("\n")
  const [segment] = decodeTranscript(transcript, { fromMs, toMs, idleCapMs: 300_000 })
  expect(segment?.activity.map((activity) => activity.atMs)).toEqual([
    fromMs,
    fromMs + 60_000,
    fromMs + 120_000
  ])
})

/** A resumed rollout can live in an older date directory; activity time decides its week. */
const withTranscripts = (files: Readonly<Record<string, string>>, sessionRoots: ReadonlyArray<string> = ["/work"]) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    yield* fs.makeDirectory(`${home}/.jcf`)
    yield* fs.writeFileString(`${home}/.jcf/config.json`, JSON.stringify({ sessionRoots }))
    for (const [relative, content] of Object.entries(files)) {
      const file = `${home}/${relative}`
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
      yield* fs.writeFileString(file, content)
    }
    return yield* Effect.gen(function*() {
      const reader = yield* AgentSessionReader
      return yield* reader.read({ from: new Date(fromMs), to: new Date(toMs) })
    }).pipe(
      Effect.provide(
        readerLayer.pipe(Layer.provide(configLayer), Layer.provide(Layer.succeed(HomeDirectory, { path: home })))
      )
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("Claude and Codex session discovery", () => {
  // Literal Claude Code Windows project slug; the fixture must not derive it from our prefilter.
  it.effect("discovers Windows Claude roots without admitting sibling, drive, or POSIX case variants", () =>
    withTranscripts(
      {
        ".claude/projects/C--Work-Repo/case.jsonl": JSON.stringify({
          type: "user",
          sessionId: "windows-case",
          cwd: "C:/Work/Repo/src",
          timestamp: at(10),
          message: { content: "Case variant" }
        }),
        ".claude/projects/C--Work-Repo/backslash.jsonl": JSON.stringify({
          type: "user",
          sessionId: "windows-backslash",
          cwd: "C:\\Work\\Repo\\src",
          timestamp: at(11),
          message: { content: "Separator variant" }
        }),
        ".claude/projects/C--Work-Repo/sibling.jsonl": JSON.stringify({
          type: "user",
          sessionId: "windows-sibling",
          cwd: "C:/Work/Repository",
          timestamp: at(12),
          message: { content: "Out of root" }
        }),
        ".claude/projects/C--Work-Repo/drive.jsonl": JSON.stringify({
          type: "user",
          sessionId: "windows-other-drive",
          cwd: "D:/Work/Repo",
          timestamp: at(13),
          message: { content: "Other drive" }
        }),
        ".claude/projects/-Work-Repo/posix.jsonl": JSON.stringify({
          type: "user",
          sessionId: "posix-case",
          cwd: "/Work/Repo",
          timestamp: at(14),
          message: { content: "POSIX case variant" }
        })
      },
      ["c:/work/repo", "/work/repo"]
    ).pipe(
      Effect.map((records) => {
        expect(records.map((record) => record.sessionId).sort()).toEqual(["windows-backslash", "windows-case"])
      })
    ))

  it.effect("discovers a Claude project beneath a backslash-configured Windows root", () =>
    withTranscripts(
      {
        ".claude/projects/C--Work-Repo/nested.jsonl": JSON.stringify({
          type: "user",
          sessionId: "windows-root",
          cwd: "c:/work/repo/src",
          timestamp: at(15),
          message: { content: "Nested work" }
        })
      },
      ["C:\\Work\\Repo"]
    ).pipe(
      Effect.map((records) => {
        expect(records.map((record) => record.sessionId)).toEqual(["windows-root"])
      })
    ))

  it.effect("discovers descendants of either spelling of a Windows drive root", () =>
    Effect.forEach(["C:/", "C:\\"], (root) =>
      withTranscripts(
        {
          ".claude/projects/C--Work-Repo/inside.jsonl": JSON.stringify({
            type: "user",
            sessionId: "same-drive",
            cwd: "c:\\Work\\Repo",
            timestamp: at(16),
            message: { content: "In opted-in drive" }
          }),
          ".claude/projects/D--Work-Repo/outside.jsonl": JSON.stringify({
            type: "user",
            sessionId: "other-drive",
            cwd: "D:/Work/Repo",
            timestamp: at(17),
            message: { content: "Other drive" }
          })
        },
        [root]
      )).pipe(Effect.map((results) => {
        expect(results.map((records) => records.map((record) => record.sessionId))).toEqual([
          ["same-drive"],
          ["same-drive"]
        ])
      })))

  it.effect("discovers a non-root Windows prefix with a trailing separator", () =>
    withTranscripts({
      ".claude/projects/C--Work-Repo/nested.jsonl": JSON.stringify({
        type: "user",
        sessionId: "trailing-root",
        cwd: "C:/Work/Repo/src",
        timestamp: at(18),
        message: { content: "Inside" }
      }),
      ".claude/projects/C--Work-Repo2/sibling.jsonl": JSON.stringify({
        type: "user",
        sessionId: "sibling",
        cwd: "C:/Work/Repo2",
        timestamp: at(19),
        message: { content: "Outside" }
      })
    }, ["c:\\work\\repo\\"]).pipe(Effect.map((records) => {
      expect(records.map((record) => record.sessionId)).toEqual(["trailing-root"])
    })))

  it.effect("discovers an accepted UNC share root without crossing to another share", () =>
    withTranscripts({
      ".claude/projects/--Server-Share-Repo/inside.jsonl": JSON.stringify({
        type: "user",
        sessionId: "same-share",
        cwd: "//server/share/repo",
        timestamp: at(20),
        message: { content: "Inside share" }
      }),
      ".claude/projects/--Server-Other-Repo/outside.jsonl": JSON.stringify({
        type: "user",
        sessionId: "other-share",
        cwd: "//server/other/repo",
        timestamp: at(21),
        message: { content: "Other share" }
      })
    }, ["\\\\Server\\Share\\"]).pipe(Effect.map((records) => {
      expect(records.map((record) => record.sessionId)).toEqual(["same-share"])
    })))

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

  it.effect("counts authoritative user events once, supervises the work after them, and ignores injected context", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/rollout.jsonl": [
        meta("human", "/work/repo"),
        event(
          "response_item",
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Injected PROJ-9999" }]
          },
          0
        ),
        prompt("Actual PROJ-5662 work", 10),
        prompt("Actual PROJ-5662 work", 10),
        event(
          "event_msg",
          {
            type: "item_completed",
            item: { type: "AgentMessage", content: [{ type: "text", text: "PROJ-8888" }] }
          },
          11
        ),
        event("response_item", { type: "function_call_output", output: "PROJ-7777" }, 12),
        event(
          "response_item",
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Verified PROJ-5662 fix" }]
          },
          13
        ),
        event("compacted", { replacement_history: [{ role: "user", content: "PROJ-6666" }] }, 14),
        prompt("Follow-up", 15),
        "{malformed"
      ].join("\n")
    }).pipe(
      Effect.map((records) => {
        expect(records).toHaveLength(1)
        // Prompt at 10 (once), the agent's completed item at 11, tool output at 12 and reply at 13,
        // prompt at 15. The injected message at 0 is a copy, not work, and precedes any prompt.
        expect(records[0]?.activity.map((activity) => (activity.atMs - fromMs) / 60_000)).toEqual([
          10,
          11,
          12,
          13,
          15
        ])
        expect(records[0]?.candidateKeys).toEqual(["PROJ-5662"])
        expect(records[0]?.digest).toContain("Verified PROJ-5662 fix")
        expect(records[0]?.digest).not.toContain("Injected")
      })
    ))

  it.effect("reads older user_message events without counting their response-item copies", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/older.jsonl": [
        meta("older", "/work/repo"),
        event("event_msg", { type: "user_message", message: "Older prompt" }, 10),
        event(
          "response_item",
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Older prompt" }]
          },
          10
        ),
        event("event_msg", { type: "user_message", message: "Outside requested week" }, -1),
        event("event_msg", { type: "user_message", message: "Next week" }, 7 * 1440)
      ].join("\n")
    }).pipe(
      Effect.map((records) => {
        expect(records[0]?.activity).toEqual([{ sessionId: "older", atMs: fromMs + 600_000 }])
        expect(records[0]?.digest).toContain("Older prompt")
        expect(records[0]?.digest).not.toContain("requested week")
        expect(records[0]?.digest).not.toContain("Next week")
      })
    ))

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
    }).pipe(
      Effect.map((records) => {
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          cwd: "/work/repo",
          gitBranch: null,
          boundedAtMs: fromMs + 13 * 60_000,
          candidateKeys: ["PROJ-5662"]
        })
        expect(records[0]?.digest).not.toContain("Outside")
        expect(records[0]?.digest).not.toContain("Machine")
      })
    ))

  it.effect("ends a supervised Codex turn at task_complete", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/turns.jsonl": [
        meta("turns", "/work/repo"),
        prompt("Do PROJ-5662", 10),
        event("event_msg", { type: "item_completed", item: { type: "CommandExecution" } }, 12),
        event("event_msg", { type: "task_complete" }, 14),
        event("event_msg", { type: "item_completed", item: { type: "CommandExecution" } }, 15)
      ].join("\n")
    }).pipe(
      Effect.map((records) => {
        expect(records[0]?.activity.map((activity) => (activity.atMs - fromMs) / 60_000)).toEqual([10, 12, 14])
      })
    ))

  // Older rollouts have no completed-item events: a long tool run is only response items, and must
  // keep the turn alive without letting an injected user-role copy's text into the evidence.
  it.effect("supervises legacy tool-call response items without keeping their text", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/legacy.jsonl": [
        meta("legacy", "/work/repo"),
        event("event_msg", { type: "user_message", message: "Fix PROJ-5662" }, 10),
        event("response_item", { type: "function_call", name: "shell", arguments: "{}" }, 14),
        event("response_item", { type: "function_call_output", output: "PROJ-7777" }, 18),
        event(
          "response_item",
          { type: "message", role: "user", content: [{ type: "input_text", text: "PROJ-9999" }] },
          20
        ),
        event("response_item", { type: "reasoning", summary: [] }, 22)
      ].join("\n")
    }).pipe(
      Effect.map((records) => {
        // The user-role copy at 20 is context, never work; the reasoning at 22 continues the turn.
        expect(records[0]?.activity.map((activity) => (activity.atMs - fromMs) / 60_000)).toEqual([10, 14, 18, 22])
        expect(records[0]?.candidateKeys).toEqual(["PROJ-5662"])
      })
    ))

  it.effect("uses user start time, skips invalid timestamps, and tolerates a missing Claude directory", () =>
    withTranscripts({
      ".codex/sessions/2026/09/07/start.jsonl": [
        meta("started", "/work/repo"),
        event(
          "event_msg",
          {
            type: "item_completed",
            started_at_ms: fromMs + 600_000,
            item: { type: "UserMessage", content: [{ type: "text", text: "Actual start" }] }
          },
          20
        ),
        event(
          "event_msg",
          {
            type: "item_completed",
            started_at_ms: 1e30,
            item: { type: "UserMessage", content: [{ type: "text", text: "Invalid time" }] }
          },
          21
        )
      ].join("\n")
    }).pipe(
      Effect.map((records) => {
        expect(records[0]?.activity).toEqual([{ sessionId: "started", atMs: fromMs + 600_000 }])
      })
    ))

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
    }).pipe(
      Effect.map((records) => {
        expect(records.map((record) => record.sessionId).sort()).toEqual(["claude", "codex-latest"])
        expect(
          records.find((record) => record.sessionId === "codex-latest")?.activity.map((activity) => activity.atMs)
        ).toEqual([fromMs + (3 * 1440 + 600) * 60_000, fromMs + (3 * 1440 + 604) * 60_000])
      })
    ))
})
