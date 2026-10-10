/**
 * Read local Claude Code and Codex Agent Sessions as reconciliation evidence.
 *
 * **Mental model**
 *
 * - **Read-only evidence**: transcripts are never written, moved, or modified. This service only
 *   reports what a session touched, when, and where.
 * - **Opt-in scope**: a session becomes evidence only when its working directory sits inside a
 *   configured Session Root. Claude project names allow a pre-read filter; Codex date directories
 *   do not, so Codex working directories are checked after local decoding. Out-of-scope text never
 *   reaches ticket mining, a Coding Agent or a proposal.
 * - **Tolerant decoding**: the transcript layout is an external contract that changes without
 *   notice. Unrecognised and malformed lines are skipped; a session survives on the lines it can
 *   decode rather than failing the whole run.
 * - **Supervised turns, not busy-ness**: a message the *person* typed opens a supervised turn, and
 *   the agent's work counts as Session Activity only inside one — until the agent ends the turn, a
 *   turn nobody typed takes over, or the agent falls silent for longer than the Idle Cap. Agent
 *   output outside a turn the person started measures how long the agent was busy, not how long
 *   anyone was working, so it never counts.
 *
 * **Gotchas**
 *
 * - A `user` line is not necessarily a person. Tool results come back as `user` messages whose
 *   content is `tool_result` blocks; task notifications and auto-continuations carry a machine
 *   `origin`; `isMeta` lines are expanded skills and command caveats. None of them opens a turn.
 * - A message typed while the agent is busy is not a `user` line at all: it is a `queued_command`
 *   attachment, timestamped when it was typed. It opens a turn like any other prompt.
 * - Assistant output, sidechain turns, and tool results still feed the candidate Issue Keys and the
 *   digest whether or not they count as presence: they say plenty about *what* the session was for.
 * - The working directory and branch are taken from the session's last in-window line of any kind —
 *   the state the credited work actually ran under.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  type AttributableSession,
  buildSessionDigest,
  expandHomePath,
  isWithinSessionRoots,
  mineTicketKeys,
  type SessionActivity,
  ticketMentionCounts
} from "../agent/sessions.js"
import { codexTranscriptLines, decodeCodexLine } from "./CodexTranscript.js"
import { ConfigService } from "./ConfigService.js"
import { HomeDirectory } from "./HomeDirectory.js"
import type { ReconcilePeriod } from "./ReconcileService.js"
import type { Presence, SessionLine } from "./SessionLine.js"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** One Agent Session, reduced to the evidence attribution and partitioning need. */
export interface AgentSessionRecord extends AttributableSession {
  /** Session Activity inside the requested window, ascending. */
  readonly activity: ReadonlyArray<SessionActivity>
  /** Bounded digest of the session's prompts, for a Coding Agent to read. */
  readonly digest: string
  /**
   * Where this stretch of the transcript ended, when something followed it under a different branch
   * or directory. Presence after its final prompt stops here rather than running the full Idle Cap.
   */
  readonly boundedAtMs: number | null
}

export class AgentSessionError extends Data.TaggedError("AgentSessionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface AgentSessionReaderContract {
  /**
   * Every in-scope Agent Session with activity inside the period. Codex files are decoded locally
   * to check their working directories; only in-scope segments become evidence.
   */
  readonly read: (period: ReconcilePeriod) => Effect.Effect<ReadonlyArray<AgentSessionRecord>, AgentSessionError>
}

export class AgentSessionReader extends Context.Service<AgentSessionReader, AgentSessionReaderContract>()(
  "jcf/AgentSessionReader"
) {}

// ---------------------------------------------------------------------------
// Transcript decoding
// ---------------------------------------------------------------------------

/**
 * The subset of a transcript line jcf depends on. Everything is optional because every field is
 * outside our control; a line missing `timestamp`, `sessionId`, or `cwd` simply is not activity.
 */
const TranscriptLine = Schema.Struct({
  type: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.NullOr(Schema.String)),
  isSidechain: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isMeta: Schema.optional(Schema.NullOr(Schema.Boolean)),
  origin: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
  attachment: Schema.optional(Schema.Unknown)
})

const TextBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String)
})

/**
 * A `tool_result` carries its output in `content`. It is decoded on its own, so an output shape we
 * do not understand loses only that output, never the rest of the message.
 */
const ContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown)
})

const decodeToolOutput = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Array(TextBlock)]))

/** Message content is either a bare string or a list of blocks, only some of which carry text. */
const MessageContent = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentBlock)]))
})

/** Why a turn started. Absent on older transcripts, where the content prefix is the only hint. */
const Origin = Schema.Struct({ kind: Schema.optional(Schema.String) })

/** A message typed while the agent was busy, recorded when it was typed rather than delivered. */
const QueuedCommand = Schema.Struct({
  type: Schema.Literal("queued_command"),
  commandMode: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.Unknown),
  prompt: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentBlock)]))
})

const AssistantStop = Schema.Struct({ stop_reason: Schema.optional(Schema.NullOr(Schema.String)) })

const JsonValue = Schema.fromJsonString(Schema.Json)

const decodeJson = Schema.decodeUnknownOption(JsonValue)
const decodeLine = Schema.decodeUnknownOption(TranscriptLine)
const decodeContent = Schema.decodeUnknownOption(MessageContent)
const decodeOrigin = Schema.decodeUnknownOption(Origin)
const decodeQueuedCommand = Schema.decodeUnknownOption(QueuedCommand)
const decodeAssistantStop = Schema.decodeUnknownOption(AssistantStop)

/** Block types that are the agent's own machinery rather than anything a person wrote. */
const MACHINE_BLOCK_TYPES: ReadonlyArray<string> = ["tool_result", "tool_use", "thinking"]

/** Turn origins nobody typed. */
const MACHINE_ORIGINS: ReadonlyArray<string> = ["task-notification", "auto-continuation"]

/** Stop reasons that end the agent's turn rather than pausing it for a tool. */
const TURN_END_STOPS: ReadonlyArray<string> = ["end_turn", "stop_sequence"]

/**
 * Prefixes of `user` lines that echo a local command's output or announce a notification. Older
 * transcripts carry no `origin`, so the content is the only evidence that nobody typed them.
 */
const MACHINE_TEXT = /^\s*<(task-notification|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)\b/

/**
 * How much of one tool result is kept as evidence. Command output can be megabytes; an Issue Key a
 * command printed sits near the top, and the digest only needs a hint of what the output was.
 */
const TOOL_RESULT_TEXT_LIMIT = 2_000

/** The textual output of a tool result, bounded; non-text parts such as images are ignored. */
const toolResultText = <UnparsedInput>(output: UnparsedInput): ReadonlyArray<string> => {
  const decoded = decodeToolOutput(output)
  if (Option.isNone(decoded)) return []
  const content = decoded.value
  const text = Predicate.isString(content)
    ? content
    : content.flatMap((block) => (block.text === undefined ? [] : [block.text])).join("\n")
  return text.length === 0 ? [] : [text.slice(0, TOOL_RESULT_TEXT_LIMIT)]
}

type Content = typeof MessageContent.Type["content"]

/**
 * The readable text of message content, or `""` when it carries none we understand.
 *
 * Includes tool-result output: it is attribution and description evidence, never presence, which
 * {@link claudePresence} decides separately.
 */
const contentText = (content: Content): string => {
  if (content === undefined) return ""
  if (Predicate.isString(content)) return content
  return content.flatMap((block) =>
    block.type === "tool_result"
      ? toolResultText(block.content)
      : block.text === undefined
      ? []
      : [block.text]
  ).join("\n")
}

/** True when content is something a person could have typed: text with none of the agent's machinery. */
const isTypedContent = (content: Content): boolean => {
  if (content === undefined) return false
  if (Predicate.isString(content)) return content.trim().length > 0
  return content.length > 0 &&
    content.every((block) => block.type === undefined || !MACHINE_BLOCK_TYPES.includes(block.type))
}

const isMachineOrigin = <UnparsedInput>(origin: UnparsedInput): boolean => {
  const decoded = decodeOrigin(origin)
  return Option.isSome(decoded) && decoded.value.kind !== undefined && MACHINE_ORIGINS.includes(decoded.value.kind)
}

/**
 * What one Claude line says about presence, with its readable text; `undefined` for lines that are
 * neither messages nor queued prompts.
 *
 * A sidechain line is the agent talking to its own subagent. It has the exact shape of a typed
 * prompt — `type: "user"`, plain string content — so it is classified as the agent's work before the
 * content is looked at: it may continue a turn the person started, never open one.
 */
const claudePresence = (
  line: typeof TranscriptLine.Type
): { readonly presence: Presence; readonly text: string } | undefined => {
  if (line.type === "assistant") {
    const content = decodeContent(line.message)
    const text = Option.isSome(content) ? contentText(content.value.content) : ""
    const stop = decodeAssistantStop(line.message)
    const stopReason = Option.isSome(stop) ? stop.value.stop_reason : undefined
    // A subagent finishing its own turn does not end the person's turn on the main thread.
    const ends = line.isSidechain !== true && stopReason !== undefined && stopReason !== null &&
      TURN_END_STOPS.includes(stopReason)
    return { presence: ends ? "turn-end" : "work", text }
  }
  if (line.type === "attachment") {
    const queued = decodeQueuedCommand(line.attachment)
    if (Option.isNone(queued)) return undefined
    const text = contentText(queued.value.prompt)
    const typed = queued.value.commandMode === "prompt" && !isMachineOrigin(queued.value.origin)
    return { presence: typed ? "prompt" : "machine", text }
  }
  if (line.type !== "user") return undefined
  const decoded = decodeContent(line.message)
  const content = Option.isSome(decoded) ? decoded.value.content : undefined
  const text = contentText(content)
  if (isMachineOrigin(line.origin)) return { presence: "machine", text }
  if (line.isSidechain === true || line.isMeta === true) return { presence: "work", text }
  if (/^\s*<task-notification\b/.test(text)) return { presence: "machine", text }
  if (MACHINE_TEXT.test(text) || !isTypedContent(content)) return { presence: "work", text }
  return { presence: "prompt", text }
}

/** What one transcript file contributes, before scope and window filtering. */
interface DecodedTranscript {
  readonly sessionId: string
  readonly cwd: string
  readonly gitBranch: string | null
  readonly activity: ReadonlyArray<SessionActivity>
  /** Where this segment gave way to the next, or null when nothing followed it. */
  readonly boundedAtMs: number | null
  /** Text in transcript order — mined for candidate keys and folded into the digest. */
  readonly texts: ReadonlyArray<string>
}

/** The window being read and the Idle Cap that ends a silent supervised turn. */
export interface DecodeOptions {
  readonly fromMs: number
  readonly toMs: number
  readonly idleCapMs: number
}

/**
 * Decode one transcript into the evidence it holds, keeping only activity inside `[from, to)`.
 *
 * Returns one entry per *segment* — a stretch of the transcript that ran under one working
 * directory and one branch. A session that switches branch mid-run is two pieces of work, and
 * taking the last line's branch for all of it would credit the morning's prompts to the afternoon's
 * ticket. Under `jcf watch` that is worse than a misattribution: the morning can already have been
 * written under the first ticket before the switch, and would then be derived again under the
 * second, putting the same wall clock on two tickets.
 *
 * Segments that resolve to the same Issue Key are unioned again downstream, so splitting costs
 * nothing when a branch change does not change the work. What it does cost is the gap *across* a
 * switch, which is no longer bridged — an under-count of at most one Idle Cap, which is the
 * direction this design prefers to be wrong in.
 *
 * Pure and total: a malformed line, an unparseable timestamp, or a file of pure noise yields no
 * segments rather than an error.
 */
export const decodeTranscript = (content: string, options: DecodeOptions): ReadonlyArray<DecodedTranscript> =>
  decodeSessionLines(claudeTranscriptLines(content), options)

/** Skip malformed external lines before the common segmenter sees them. */
function* claudeTranscriptLines(content: string): Generator<SessionLine> {
  for (const rawLine of content.split("\n")) {
    const json = decodeJson(rawLine)
    if (Option.isNone(json)) continue
    const decoded = decodeLine(json.value)
    if (Option.isNone(decoded)) continue
    const line = decoded.value
    if (line.sessionId === undefined || line.timestamp === undefined || line.cwd === undefined) continue
    const classified = claudePresence(line)
    if (classified === undefined) continue
    yield {
      sessionId: line.sessionId,
      cwd: line.cwd,
      gitBranch: line.gitBranch ?? null,
      atMs: Date.parse(line.timestamp),
      ...classified
    }
  }
}

/**
 * Both providers share supervised-turn accounting and per-directory evidence boundaries.
 *
 * Turn state is tracked across the whole file, including lines outside the window, so a prompt
 * typed just before the window opens still supervises the work that runs into it.
 */
export const decodeSessionLines = (
  lines: Iterable<SessionLine>,
  options: DecodeOptions
): ReadonlyArray<DecodedTranscript> => {
  const segments: Array<DecodedTranscript> = []
  let activityTimes: Array<number> = []
  // Latest counted instant of the open segment. A queued prompt is stamped when typed, so input order
  // is not time order and `activityTimes.at(-1)` can be stale.
  let latestActivityMs: number | null = null
  let texts: Array<string> = []
  let sessionId: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  let afterIdle = false
  // Last counted instant of the open supervised turn, or null when no turn is open.
  let turnAtMs: number | null = null

  // One segment per `(cwd, branch)`. The id carries the segment index so windows, attributions and
  // digests all key on the same thing — they are looked up from three different places.
  const closeSegment = (endedAtMs: number | null) => {
    if (sessionId !== null && cwd !== null && activityTimes.length > 0) {
      const id = afterIdle
        ? `${sessionId}@${String(activityTimes[0])}`
        : segments.length === 0
        ? sessionId
        : `${sessionId}#${String(segments.length)}`
      segments.push({
        sessionId: id,
        cwd,
        gitBranch,
        // Where the segment gives way to the next. Presence after its final activity ends there, not
        // one whole Idle Cap later: the same person carried straight on under a different branch, so
        // crediting the tail to both would put the switch's minutes on two tickets at once.
        boundedAtMs: endedAtMs,
        activity: [...activityTimes].sort((a, b) => a - b).map((atMs): SessionActivity => ({ sessionId: id, atMs })),
        texts
      })
    }
    // Reset unconditionally. A stretch with no activity still has text, and leaving it behind
    // leaks it into the next segment — including text from a directory that was never opted in.
    activityTimes = []
    latestActivityMs = null
    texts = []
  }

  for (const line of lines) {
    const atMs = line.atMs
    if (Number.isNaN(atMs)) continue

    // The turn advances on every line, inside the window or not.
    const supervised: boolean = turnAtMs !== null && atMs - turnAtMs <= options.idleCapMs
    const counts: boolean = line.presence === "prompt" ||
      ((line.presence === "work" || line.presence === "turn-end") && supervised)
    if (line.presence === "prompt") turnAtMs = Math.max(turnAtMs ?? atMs, atMs)
    else if (line.presence === "work") turnAtMs = supervised ? Math.max(turnAtMs ?? atMs, atMs) : null
    else if (line.presence === "turn-end" || line.presence === "machine") turnAtMs = null

    if (atMs < options.fromMs || atMs >= options.toMs) continue

    // Later mentions must not rebalance an already settled group. An idle barrier closes its text
    // and activity together; the next group has a timestamp identity stable under later appends.
    if (latestActivityMs !== null && atMs - latestActivityMs > options.idleCapMs) {
      closeSegment(latestActivityMs + options.idleCapMs)
      afterIdle = true
    }

    // Closed *before* this line contributes anything: the first line under the new branch is
    // evidence about the new segment, and appending it first put it in the old segment's digest and
    // left it out of the new one's.
    if (cwd !== null && (cwd !== line.cwd || gitBranch !== line.gitBranch)) {
      closeSegment(atMs)
      afterIdle = false
    }
    sessionId = line.sessionId
    cwd = line.cwd
    gitBranch = line.gitBranch

    // Inside the window only, and every kind of line: a key mentioned solely in the agent's own
    // output is still a candidate, but a prompt written after the window is not evidence about it.
    // A resumed session that moved on to something else would otherwise attribute — and describe —
    // yesterday's hours from today's work, and could carry text from a directory that was never
    // opted in to a Coding Agent.
    if (line.text !== "") texts.push(line.text)
    if (counts) {
      activityTimes.push(atMs)
      latestActivityMs = Math.max(latestActivityMs ?? atMs, atMs)
    }
  }

  closeSegment(null)
  return segments
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Where the Claude CLI keeps its transcripts, one directory per project. */
const CLAUDE_TRANSCRIPT_DIR = [".claude", "projects"]

const TRANSCRIPT_SUFFIX = ".jsonl"

/**
 * A working directory as the Claude CLI names the project directory holding its transcripts:
 * `/`, `.`, and the Windows drive colon become `-`, so `C:/Work/Repo` becomes `C--Work-Repo`.
 */
const encodeProjectDir = (cwd: string): string => cwd.replace(/[/:.]/g, "-")

/**
 * True when a project directory could hold a session inside one of the Session Roots.
 *
 * A *filter*, not a decision. The encoding is many-to-one — a root `/a/b-c` and an out-of-root
 * `/a/b/c` both become `-a-b-c` — so a directory it admits may still turn out to be elsewhere, and
 * the authoritative check on the decoded `cwd` runs afterwards regardless. What it cannot do is
 * exclude one wrongly: separators encode character-by-character after a trailing root separator
 * is removed, and Windows root spelling is folded. The decoded `cwd` still decides scope.
 *
 * So the guarantee is bounded, and worth stating exactly: a transcript whose project directory
 * cannot encode from any Session Root is never opened, which in a working set of any size is nearly
 * all of them. A transcript that collides with a root's encoding is opened and then discarded
 * unread — the honest limit of deciding scope from a lossy directory name.
 */
export const mayHoldSessionRoot = (projectDir: string, roots: ReadonlyArray<string>): boolean =>
  roots.some((root) => {
    const windows = /^[A-Za-z]:[\\/]/.test(root) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(root)
    const canonicalRoot = (windows ? root.replaceAll("\\", "/") : root).replace(/\/+$/, "")
    const encoded = encodeProjectDir(canonicalRoot)
    const candidate = windows ? projectDir.toLowerCase() : projectDir
    const prefix = windows ? encoded.toLowerCase() : encoded
    return prefix.length > 0 && (candidate === prefix || candidate.startsWith(`${prefix}-`))
  })

export const layer = Layer.effect(
  AgentSessionReader,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const config = yield* ConfigService

    const transcriptRoot = path.join(home, ...CLAUDE_TRANSCRIPT_DIR)
    const codexRoot = path.join(home, ".codex", "sessions")

    const asAgentSessionError = (message: string) => (cause: { readonly message: string }) =>
      Effect.fail(new AgentSessionError({ message: `${message}: ${cause.message}`, cause }))

    /**
     * Every `*.jsonl` transcript under the Claude project directories.
     *
     * A *missing* transcript root is an empty result — the user may simply never have run Claude.
     * A root that exists but cannot be read is an error, because reporting "no sessions" for a
     * permission problem would look exactly like having nothing to log.
     */
    const transcriptPaths = (roots: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const exists = yield* fs
          .exists(transcriptRoot)
          .pipe(Effect.catch(asAgentSessionError("Checking for Claude transcripts failed")))
        if (!exists) return []

        const projectDirs = yield* fs
          .readDirectory(transcriptRoot)
          .pipe(Effect.catch(asAgentSessionError("Listing Claude projects failed")))

        const paths: Array<string> = []
        for (const projectDir of projectDirs) {
          // Before the directory is even listed: a project outside every Session Root is not opened.
          if (!mayHoldSessionRoot(projectDir, roots)) continue
          const dir = path.join(transcriptRoot, projectDir)
          const entries = yield* fs
            .readDirectory(dir)
            .pipe(Effect.catch(asAgentSessionError(`Listing Claude project ${projectDir} failed`)))
          for (const entry of entries) {
            if (entry.endsWith(TRANSCRIPT_SUFFIX)) paths.push(path.join(dir, entry))
          }
        }
        return paths
      })

    /**
     * True when a file could hold activity in the window. A transcript's last write is at or
     * after its last activity, so an older mtime is a sound reason to skip reading it at all —
     * which matters because a working directory accumulates hundreds of transcripts.
     */
    const mayHoldActivity = (filePath: string, fromMs: number) =>
      fs.stat(filePath).pipe(
        Effect.map((info) => Option.isNone(info.mtime) || info.mtime.value.getTime() >= fromMs),
        Effect.catch((error) =>
          Effect.logDebug(`Transcript stat failed, reading anyway: ${error.message}`).pipe(Effect.as(true))
        )
      )

    const read = (period: ReconcilePeriod) =>
      Effect.gen(function*() {
        const cfg = yield* config.get
        const roots = cfg.sessionRoots.map((root) => expandHomePath(root, home))
        // No Session Root means nothing is opted in, so there is nothing to read.
        if (roots.length === 0) return []

        const fromMs = period.from.getTime()
        const toMs = period.to.getTime()
        const idleCapMs = Math.max(0, cfg.sessionIdleCapSeconds) * 1000
        const paths = yield* transcriptPaths(roots)
        const records: Array<AgentSessionRecord> = []

        const addSegments = (segments: ReadonlyArray<DecodedTranscript>) => {
          for (const segment of segments) {
            // Scope precedes key mining and digest construction, including moved Codex sessions.
            if (!isWithinSessionRoots(segment.cwd, roots)) continue
            records.push({
              sessionId: segment.sessionId,
              cwd: segment.cwd,
              gitBranch: segment.gitBranch,
              candidateKeys: mineTicketKeys(segment.texts.join("\n")),
              mentionCounts: ticketMentionCounts(segment.texts.join("\n")),
              digest: buildSessionDigest(segment.texts),
              activity: segment.activity,
              boundedAtMs: segment.boundedAtMs
            })
          }
        }

        for (const filePath of paths) {
          if (!(yield* mayHoldActivity(filePath, fromMs))) continue

          // Fails the run rather than skipping the file. An in-scope transcript that cannot be read
          // is not an absent one: it may overlap a readable session on another ticket, and dropping
          // it takes that ticket out of the overlap sharing — so the interval it should have halved
          // is credited whole to whichever session happened to be readable, and `watch` writes it.
          // An out-of-scope path never reaches here; `transcriptPaths` has already excluded it.
          const content = yield* fs.readFileString(filePath).pipe(
            Effect.mapError(
              (error) =>
                new AgentSessionError({
                  message: `Could not read the session transcript ${filePath}: ${error.message}`,
                  cause: error
                })
            )
          )

          addSegments(decodeTranscript(content, { fromMs, toMs, idleCapMs }))
        }

        const hasCodex = yield* fs
          .exists(codexRoot)
          .pipe(Effect.catch(asAgentSessionError("Checking Codex sessions failed")))
        if (hasCodex) {
          // Date directories name creation time, not last activity: resumed old rollouts still count.
          const entries = yield* fs
            .readDirectory(codexRoot, { recursive: true })
            .pipe(Effect.catch(asAgentSessionError("Listing Codex sessions failed")))
          for (const entry of entries) {
            if (!entry.endsWith(TRANSCRIPT_SUFFIX)) continue
            const filePath = path.join(codexRoot, entry)
            if (!(yield* mayHoldActivity(filePath, fromMs))) continue
            // Rollouts can be hundreds of MB; discard tool data before retaining decoded messages.
            const lines = yield* fs.stream(filePath).pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.map((line) => decodeCodexLine(line)),
              Stream.filter(Option.isSome),
              Stream.map((decoded) => decoded.value),
              Stream.runCollect,
              Effect.catch(asAgentSessionError("Reading Codex session failed"))
            )
            addSegments(decodeSessionLines(codexTranscriptLines(lines), { fromMs, toMs, idleCapMs }))
          }
        }

        return records
      })

    return { read }
  })
)
