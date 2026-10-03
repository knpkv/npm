/**
 * One ingest pass: every transcript and rollout read from its Ingest Cursor to the last complete
 * line, committed chunk by chunk.
 *
 * **Mental model**
 *
 * - **Append-only files, byte cursors.** A cursor holds a file's identity (device + inode), the byte
 *   offset after its last complete line, and the reader's carried state. A file whose identity
 *   changed or that shrank is read again from the start; event keys absorb the overlap.
 * - **A line is read once its newline lands.** A half-written final line stays unread until the
 *   next pass, so a live session is never booked from a fragment.
 * - **Nothing is passed over quietly.** An unreadable file or a missing source root is reported in
 *   the Ingest Status; only a store failure fails the pass.
 *
 * @module
 */
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ClaudeReaderState, initialClaudeState, readClaude } from "./ClaudeReader.js"
import { CodexReaderState, initialCodexState, readCodex } from "./CodexReader.js"
import type { Agent } from "./Model.js"
import { mergeSkips, noSkips, type ReadResult, type SkipCounts, type SourceFile, type SourceLine } from "./Readers.js"
import { type StoreError, UsageStore } from "./Store.js"

/** Where this Machine's agents keep their sessions, and the Machine's name. */
export interface SourceRoots {
  /** `<claude config>/projects` */
  readonly claudeProjects: string
  /** `<CODEX_HOME>/sessions` */
  readonly codexSessions: string
  readonly machine: string
}

export interface UnreadableFile {
  /** Path relative to the source root; `.` is the root itself. */
  readonly fileKey: string
  readonly reason: string
}

/** What one pass found in one Agent's source root. */
export interface SourceStatus {
  readonly rootMissing: boolean
  readonly filesScanned: number
  readonly filesRead: number
  readonly eventsAdded: number
  readonly skipped: SkipCounts
  readonly unreadable: ReadonlyArray<UnreadableFile>
}

export interface IngestStatus {
  readonly startedAt: number
  readonly finishedAt: number
  readonly claude: SourceStatus
  readonly codex: SourceStatus
}

export interface IngestOptions {
  /** How many bytes to read and commit at a time; bounds memory during a backfill. */
  readonly chunkBytes?: number
}

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
const NEWLINE = 10

interface ListedFile {
  readonly fileKey: string
  readonly sessionId: string
}

interface Source<State> {
  readonly agent: Agent
  readonly initial: State
  readonly decodeState: (json: string) => Option.Option<State>
  readonly encodeState: (state: State) => string
  readonly read: (file: SourceFile, lines: ReadonlyArray<SourceLine>, state: State) => ReadResult<State>
  /** Whether to list a directory, given its path segments below the root. */
  readonly descend: (segments: ReadonlyArray<string>) => boolean
  /** The files worth reading among the `.jsonl` paths found, relative to the root. */
  readonly select: (relativePaths: ReadonlyArray<string>, path: Path.Path) => ReadonlyArray<ListedFile>
}

const ClaudeStateJson = Schema.fromJsonString(ClaudeReaderState)
const CodexStateJson = Schema.fromJsonString(CodexReaderState)

/** `<project>/<session>.jsonl`, and `<project>/<session>/subagents/<agent>.jsonl` booked to the session. */
const claudeSource: Source<ClaudeReaderState> = {
  agent: "claude",
  initial: initialClaudeState,
  decodeState: Schema.decodeUnknownOption(ClaudeStateJson),
  encodeState: Schema.encodeSync(ClaudeStateJson),
  read: readClaude,
  descend: (segments) => segments.length <= 2 || (segments.length === 3 && segments[2] === "subagents"),
  select: (paths, path) =>
    paths.flatMap((fileKey) => {
      if (!fileKey.endsWith(".jsonl")) return []
      const segments = fileKey.split(path.sep)
      if (segments.length === 2) return [{ fileKey, sessionId: path.basename(fileKey, ".jsonl") }]
      if (segments.length === 4 && segments[2] === "subagents" && segments[1] !== undefined) {
        return [{ fileKey, sessionId: segments[1] }]
      }
      return []
    })
}

const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu

/** `YYYY/MM/DD/rollout-<time>-<session uuid>.jsonl` */
const codexSource: Source<CodexReaderState> = {
  agent: "codex",
  initial: initialCodexState,
  decodeState: Schema.decodeUnknownOption(CodexStateJson),
  encodeState: Schema.encodeSync(CodexStateJson),
  read: readCodex,
  descend: (segments) => segments.length <= 3,
  select: (paths, path) =>
    paths.flatMap((fileKey) => {
      const name = path.basename(fileKey)
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return []
      return [{ fileKey, sessionId: ROLLOUT_ID.exec(name)?.[1] ?? path.basename(name, ".jsonl") }]
    })
}

const decoder = new TextDecoder()

/** Splits complete, newline-terminated bytes into lines with their absolute byte offsets. */
const splitLines = (bytes: Uint8Array, startOffset: number): ReadonlyArray<SourceLine> => {
  const lines: Array<SourceLine> = []
  let lineStart = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index === bytes.length || bytes[index] === NEWLINE) {
      if (index > lineStart) {
        lines.push({ offset: startOffset + lineStart, text: decoder.decode(bytes.subarray(lineStart, index)) })
      }
      lineStart = index + 1
    }
  }
  return lines
}

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.length === 0) return right
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left, 0)
  joined.set(right, left.length)
  return joined
}

interface FileOutcome {
  readonly read: boolean
  readonly eventsAdded: number
  readonly skipped: SkipCounts
}

const unchanged: FileOutcome = { read: false, eventsAdded: 0, skipped: noSkips }

const ingestFile = <State>(
  source: Source<State>,
  root: string,
  machine: string,
  listed: ListedFile,
  chunkBytes: number
): Effect.Effect<FileOutcome, StoreError | PlatformError, UsageStore | FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const store = yield* UsageStore
    const absolute = path.join(root, listed.fileKey)
    const info = yield* fs.stat(absolute)
    if (info.type !== "File") return unchanged
    const size = Number(info.size)
    const identity = `${info.dev}:${Option.getOrElse(info.ino, () => 0)}`
    const saved = yield* store.cursor(source.agent, listed.fileKey)
    const resumed = Option.flatMap(
      Option.filter(saved, (cursor) => cursor.identity === identity && cursor.offset <= size),
      (cursor) => Option.map(source.decodeState(cursor.state), (state) => ({ offset: cursor.offset, state }))
    )
    let offset = Option.match(resumed, { onNone: () => 0, onSome: (value) => value.offset })
    let state = Option.match(resumed, { onNone: () => source.initial, onSome: (value) => value.state })
    if (offset === size) return unchanged

    const file: SourceFile = { fileKey: listed.fileKey, machine, sessionId: listed.sessionId }
    const handle = yield* fs.open(absolute)
    yield* handle.seek(BigInt(offset), "start")
    let pending: Uint8Array = new Uint8Array(0)
    let eventsAdded = 0
    let skipped = noSkips
    while (offset + pending.length < size) {
      const chunk = yield* handle.readAlloc(Math.min(chunkBytes, size - offset - pending.length))
      if (Option.isNone(chunk)) break
      const buffer = concat(pending, chunk.value)
      const lastNewline = buffer.lastIndexOf(NEWLINE)
      if (lastNewline < 0) {
        pending = buffer
        continue
      }
      const result = source.read(file, splitLines(buffer.subarray(0, lastNewline), offset), state)
      const next = offset + lastNewline + 1
      const committed = yield* store.commitChunk({
        agent: source.agent,
        fileKey: listed.fileKey,
        cursor: { identity, offset: next, state: source.encodeState(result.state) },
        events: result.events,
        snapshots: result.snapshots,
        balances: result.balances
      })
      eventsAdded += committed.eventsAdded
      skipped = mergeSkips(skipped, result.skipped)
      state = result.state
      offset = next
      pending = buffer.subarray(lastNewline + 1)
    }
    return { read: true, eventsAdded, skipped }
  }))

const emptyStatus = (rootMissing: boolean): SourceStatus => ({
  rootMissing,
  filesScanned: 0,
  filesRead: 0,
  eventsAdded: 0,
  skipped: noSkips,
  unreadable: []
})

interface Walk {
  readonly rootMissing: boolean
  readonly files: ReadonlyArray<string>
  readonly unreadable: ReadonlyArray<UnreadableFile>
}

/**
 * Every `.jsonl` path under the root, listing one directory at a time so that one directory this
 * user cannot read (a container's, owned by another uid) is reported on its own instead of
 * hiding the rest of the root.
 */
const walk = (root: string, descend: (segments: ReadonlyArray<string>) => boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files: Array<string> = []
    const unreadable: Array<UnreadableFile> = []
    const pending: Array<ReadonlyArray<string>> = [[]]
    for (let segments = pending.shift(); segments !== undefined; segments = pending.shift()) {
      const relative = segments.join(path.sep)
      const listing = yield* Effect.result(fs.readDirectory(path.join(root, relative)))
      if (listing._tag === "Failure") {
        const reason = listing.failure.reason._tag
        if (segments.length === 0 && reason === "NotFound") {
          const missing: Walk = { rootMissing: true, files: [], unreadable: [] }
          return missing
        }
        if (reason !== "NotFound") unreadable.push({ fileKey: relative === "" ? "." : relative, reason })
        continue
      }
      for (const name of [...listing.success].sort()) {
        const child = [...segments, name]
        if (name.endsWith(".jsonl")) {
          files.push(child.join(path.sep))
          continue
        }
        if (!descend(child)) continue
        const info = yield* Effect.result(fs.stat(path.join(root, ...child)))
        if (info._tag === "Failure") {
          unreadable.push({ fileKey: child.join(path.sep), reason: info.failure.reason._tag })
        } else if (info.success.type === "Directory") pending.push(child)
      }
    }
    const found: Walk = { rootMissing: false, files: files.sort(), unreadable }
    return found
  })

const ingestSource = <State>(source: Source<State>, root: string, machine: string, chunkBytes: number) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const walked = yield* walk(root, source.descend)
    if (walked.rootMissing) return emptyStatus(true)
    const files = source.select(walked.files, path)
    let status: SourceStatus = { ...emptyStatus(false), filesScanned: files.length, unreadable: walked.unreadable }
    for (const listed of files) {
      const outcome = yield* ingestFile(source, root, machine, listed, chunkBytes).pipe(
        Effect.catchTag(
          "PlatformError",
          (error) => Effect.succeed({ unreadable: { fileKey: listed.fileKey, reason: error.reason._tag } })
        )
      )
      status = "unreadable" in outcome
        ? { ...status, unreadable: [...status.unreadable, outcome.unreadable] }
        : {
          ...status,
          filesRead: status.filesRead + (outcome.read ? 1 : 0),
          eventsAdded: status.eventsAdded + outcome.eventsAdded,
          skipped: mergeSkips(status.skipped, outcome.skipped)
        }
    }
    return status
  })

/** Reads everything appended since the last pass in both sources. Fails only when the store does. */
export const ingestOnce = (
  roots: SourceRoots,
  options: IngestOptions = {}
): Effect.Effect<IngestStatus, StoreError, UsageStore | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
    const startedAt = yield* Clock.currentTimeMillis
    const claude = yield* ingestSource(claudeSource, roots.claudeProjects, roots.machine, chunkBytes)
    const codex = yield* ingestSource(codexSource, roots.codexSessions, roots.machine, chunkBytes)
    const finishedAt = yield* Clock.currentTimeMillis
    return { startedAt, finishedAt, claude, codex }
  })
