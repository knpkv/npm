import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { makeSessionTaskReader } from "../src/internal/agent-task-session.js"

describe("reported session task source", () => {
  it.layer(NodeServices.layer)((it) => {
    const setup = Effect.fn("test.sessionTaskSetup")(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "task-session-source-" })
      const roots = {
        claudeProjects: paths.join(root, "claude-projects"),
        codexSessions: paths.join(root, "codex-sessions")
      }
      yield* fs.makeDirectory(roots.claudeProjects)
      yield* fs.makeDirectory(roots.codexSessions)
      return { fs, paths, root, roots }
    })

    it.effect("binds Claude id to its project and ignores a newer unrelated session", () =>
      Effect.gen(function*() {
        const { fs, paths, roots } = yield* setup()
        const cwd = "/fixture/repo"
        const project = paths.join(roots.claudeProjects, "-fixture-repo")
        yield* fs.makeDirectory(project)
        const call = (name: string) =>
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "call", name, input: {} }] }
          }) + "\n"
        yield* fs.writeFileString(paths.join(project, "session-target.jsonl"), call("Read"))
        yield* fs.writeFileString(paths.join(project, "session-newer.jsonl"), call("Write"))
        const read = yield* makeSessionTaskReader(roots)
        expect(
          yield* read({ provider: "claude", cwd, session: { agent: "claude", kind: "id", value: "session-target" } })
        ).toEqual({ kind: "read", outcome: "running" })
        expect(yield* read({ provider: "claude", cwd, session: { agent: "claude", kind: "id", value: "missing" } }))
          .toEqual({ kind: "unknown", outcome: "unknown" })
      }).pipe(Effect.scoped))

    it.effect("uses Claude project encoding for underscores, dots, colons and ordinary paths", () =>
      Effect.gen(function*() {
        const { fs, paths, roots } = yield* setup()
        const cases: ReadonlyArray<readonly [string, string]> = [
          ["/fixture/my_repo", "-fixture-my_repo"],
          ["/fixture/repo", "-fixture-repo"],
          ["/fixture/has.dot", "-fixture-has-dot"],
          ["/fixture/a:b", "-fixture-a-b"]
        ]
        const read = yield* makeSessionTaskReader(roots)
        for (const [cwd, encoded] of cases) {
          const project = paths.join(roots.claudeProjects, encoded)
          yield* fs.makeDirectory(project, { recursive: true })
          yield* fs.writeFileString(
            paths.join(project, "target.jsonl"),
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "tool_use", id: "call", name: "Read", input: {} }] }
            }) + "\n"
          )
          expect(
            yield* read({ provider: "claude", cwd, session: { agent: "claude", kind: "id", value: "target" } }),
            cwd
          )
            .toEqual({ kind: "read", outcome: "running" })
        }
      }).pipe(Effect.scoped))

    it.effect("resolves a Codex v7 identity across a local-date boundary and accepts an explicit in-root path", () =>
      Effect.gen(function*() {
        const { fs, paths, roots } = yield* setup()
        // The UUID encodes 2026-10-11T06:59:21.846Z. A timezone can place a rollout on the previous local date.
        const id = "01a129c2-4c76-7000-8000-000000000001"
        const directory = paths.join(roots.codexSessions, "2026", "10", "10")
        yield* fs.makeDirectory(directory, { recursive: true })
        const file = paths.join(directory, `rollout-2026-10-10T23-59-21-${id}.jsonl`)
        yield* fs.writeFileString(
          file,
          JSON.stringify({
            type: "response_item",
            payload: { type: "function_call", name: "apply_patch", call_id: "patch", arguments: "{}" }
          }) + "\n"
        )
        const read = yield* makeSessionTaskReader(roots)
        expect(yield* read({ provider: "codex", cwd: "/repo", session: { agent: "codex", kind: "id", value: id } }))
          .toEqual({ kind: "edit", outcome: "running" })
        expect(yield* read({ provider: "codex", cwd: "/repo", session: { agent: "codex", kind: "path", value: file } }))
          .toEqual({ kind: "edit", outcome: "running" })
      }).pipe(Effect.scoped))

    it.effect("returns unknown for malformed sessions, cross-provider identity, traversal and out-of-root symlinks", () =>
      Effect.gen(function*() {
        const { fs, paths, root, roots } = yield* setup()
        const privateFile = paths.join(root, "private.jsonl")
        yield* fs.writeFileString(
          privateFile,
          JSON.stringify({
            type: "response_item",
            payload: { type: "function_call", name: "apply_patch", call_id: "patch", arguments: "{}" }
          }) + "\n"
        )
        const linked = paths.join(roots.codexSessions, "linked.jsonl")
        yield* fs.symlink(privateFile, linked)
        const read = yield* makeSessionTaskReader(roots)
        for (
          const session of [
            null,
            { kind: "id", value: "target" },
            { agent: "claude", kind: "path", value: privateFile },
            { agent: "codex", kind: "id", value: "../../private" },
            { agent: "codex", kind: "path", value: privateFile },
            { agent: "codex", kind: "path", value: linked }
          ]
        ) {
          expect(yield* read({ provider: "codex", cwd: "/repo", session })).toEqual({
            kind: "unknown",
            outcome: "unknown"
          })
        }
      }).pipe(Effect.scoped))
  })
})
