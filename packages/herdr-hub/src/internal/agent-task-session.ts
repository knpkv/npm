import { DateTime, Effect, FileSystem, Path, Result, Schema } from "effect"
import { readSessionTaskActivity, type TaskActivity } from "./agent-task-evidence.js"

export type SessionTaskRoots = {
  readonly claudeProjects: string | undefined
  readonly codexSessions: string | undefined
}
export type SessionTaskInput = { readonly provider: string; readonly cwd: string; readonly session: unknown }

const Session = Schema.Struct({
  agent: Schema.Literals(["claude", "codex"]),
  kind: Schema.Literals(["id", "path"]),
  value: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))
})
const safeId = Schema.is(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)))
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const unknownActivity: TaskActivity = { kind: "unknown", outcome: "unknown" }

/** Resolves only the session reported by Herdr; unreadable/unsupported evidence is unknown, never newest-file discovery. */
export const makeSessionTaskReader = Effect.fn("TaskEvidence.makeSessionReader")(function*(roots: SessionTaskRoots) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const codexPath = Effect.fn("TaskEvidence.codexPath")(function*(id: string, root: string) {
    if (!uuidV7.test(id)) return undefined
    // UUIDv7 embeds creation time. Probe adjacent UTC dates because rollout directories use local dates.
    const timestamp = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)
    const matches: Array<string> = []
    for (const day of [-1, 0, 1]) {
      const date = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(timestamp + day * 24 * 60 * 60 * 1000))
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined
      const directory = paths.join(root, ...date.split("-"))
      const names = yield* fs.readDirectory(directory).pipe(
        Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error))
      )
      if (names.length > 4096) return undefined
      for (const name of names) {
        if (name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`)) matches.push(paths.join(directory, name))
      }
    }
    return matches.length === 1 ? matches[0] : undefined
  })

  return Effect.fn("TaskEvidence.readReportedSession")(function*(input: SessionTaskInput) {
    const decoded = Schema.decodeUnknownResult(Session)(input.session)
    if (Result.isFailure(decoded) || decoded.success.agent !== input.provider) return unknownActivity
    const session = decoded.success
    const root = session.agent === "claude" ? roots.claudeProjects : roots.codexSessions
    if (root === undefined || !paths.isAbsolute(root)) return unknownActivity
    let candidate: string | undefined
    if (session.kind === "path") {
      if (!paths.isAbsolute(session.value)) return unknownActivity
      candidate = session.value
    } else {
      if (!safeId(session.value)) return unknownActivity
      candidate = session.agent === "claude"
        ? paths.join(root, input.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session.value}.jsonl`)
        : yield* codexPath(session.value, root)
    }
    if (candidate === undefined) return unknownActivity
    const actualRoot = yield* fs.realPath(root)
    const actualFile = yield* fs.realPath(candidate)
    const relative = paths.relative(actualRoot, actualFile)
    if (
      relative === "" || paths.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..") ||
      !actualFile.endsWith(".jsonl")
    ) return unknownActivity
    return yield* readSessionTaskActivity(session.agent, actualFile).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    )
  }, Effect.catchTag("PlatformError", () => Effect.succeed(unknownActivity)))
})
