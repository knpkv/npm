/**
 * Read local Claude Code Agent Sessions as reconciliation evidence.
 *
 * **Mental model**
 *
 * - **Read-only evidence**: transcripts are never written, moved, or modified. This service only
 *   reports what a session touched, when, and where — see ADR-0006.
 * - **Opt-in scope**: a session is read only when its working directory sits inside a configured
 *   Session Root. Everything else is skipped before its contents are ever parsed, so scratch
 *   directories and side projects can never reach a Coding Agent or a proposal.
 * - **Tolerant decoding**: the transcript layout is an external contract that changes without
 *   notice. Unrecognised and malformed lines are skipped; a session survives on the lines it can
 *   decode rather than failing the whole run.
 * - **Presence, not busy-ness**: only messages the *person* typed count as Session Activity. A
 *   transcript is overwhelmingly the agent's own output — measured on one real day, 1641 events of
 *   which 66 were human — so counting every event measures how long the agent was busy, which is
 *   not the same as how long anyone was working.
 *
 * **Gotchas**
 *
 * - A `user` line is not necessarily a person. Tool results come back as `user` messages whose
 *   content is `tool_result` blocks, and they outnumber real prompts roughly ten to one. Only text
 *   content counts.
 * - Assistant output, sidechain turns, and tool results still feed the candidate Issue Keys and the
 *   digest: they say nothing about presence, but plenty about *what* the session was for.
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
import {
  type AttributableSession,
  buildSessionDigest,
  expandHomePath,
  isWithinSessionRoots,
  mineTicketKeys,
  type SessionActivity
} from "../agent/sessions.js"
import { ConfigService } from "./ConfigService.js"
import { HomeDirectory } from "./HomeDirectory.js"
import type { ReconcilePeriod } from "./ReconcileService.js"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** One Agent Session, reduced to the evidence attribution and partitioning need. */
export interface AgentSessionRecord extends AttributableSession {
  /** Session Activity inside the requested window, ascending. */
  readonly activity: ReadonlyArray<SessionActivity>
  /** Bounded digest of the session's prompts, for a Coding Agent to read. */
  readonly digest: string
}

export class AgentSessionError extends Data.TaggedError("AgentSessionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface AgentSessionReaderContract {
  /**
   * Every in-scope Agent Session with activity inside the period. Sessions outside every
   * Session Root are never read.
   */
  readonly read: (
    period: ReconcilePeriod
  ) => Effect.Effect<ReadonlyArray<AgentSessionRecord>, AgentSessionError>
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
  message: Schema.optional(Schema.Unknown)
})

const ContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String)
})

/** Message content is either a bare string or a list of blocks, only some of which carry text. */
const MessageContent = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentBlock)]))
})

const JsonValue = Schema.fromJsonString(Schema.Json)

const decodeJson = Schema.decodeUnknownOption(JsonValue)
const decodeLine = Schema.decodeUnknownOption(TranscriptLine)
const decodeContent = Schema.decodeUnknownOption(MessageContent)

/** Line types that carry a timestamp and a message. Everything else is session metadata. */
const ACTIVITY_TYPES: ReadonlyArray<string> = ["user", "assistant"]

/** Block types that are the agent's own machinery rather than anything a person wrote. */
const MACHINE_BLOCK_TYPES: ReadonlyArray<string> = ["tool_result", "tool_use", "thinking"]

/** The fields of a transcript line that decide whether it evidences a person being present. */
interface TranscriptLineFields {
  readonly type?: string | undefined
  readonly isSidechain?: boolean | null | undefined
}

/** The readable text of a message, or `""` when it carries none we understand. */
const messageText = <UnparsedInput>(message: UnparsedInput): string => {
  const decoded = decodeContent(message)
  if (Option.isNone(decoded)) return ""
  const content = decoded.value.content
  if (content === undefined) return ""
  if (Predicate.isString(content)) return content
  return content.flatMap((block) => (block.text === undefined ? [] : [block.text])).join("\n")
}

/**
 * True when a line is a message the person typed — the only thing that evidences their presence.
 *
 * A bare string is a person only on the main thread. A block list is a person only if it contains
 * none of the agent's machinery: tool results in particular arrive as `user` messages and are far
 * more numerous than real prompts, so counting them would measure the agent's throughput as if it
 * were attention.
 *
 * A sidechain line is the agent talking to its own subagent. It has the exact shape of a typed
 * prompt — `type: "user"`, plain string content — so nothing else here would exclude it, and a run
 * that fans out to many subagents would manufacture a stream of "prompts" dense enough to bridge
 * every Idle Cap gap. That is the one thing the Idle Cap exists to stop, and under `jcf watch` the
 * result would be written unattended.
 */
const isHumanPrompt = <UnparsedInput>(
  line: TranscriptLineFields,
  message: UnparsedInput
): boolean => {
  if (line.type !== "user" || line.isSidechain === true) return false
  const decoded = decodeContent(message)
  if (Option.isNone(decoded)) return false
  const content = decoded.value.content
  if (content === undefined) return false
  if (Predicate.isString(content)) return content.trim().length > 0
  return content.length > 0 &&
    content.every((block) => block.type === undefined || !MACHINE_BLOCK_TYPES.includes(block.type))
}

/** What one transcript file contributes, before scope and window filtering. */
interface DecodedTranscript {
  readonly sessionId: string
  readonly cwd: string
  readonly gitBranch: string | null
  readonly activity: ReadonlyArray<SessionActivity>
  /** Prompt text in transcript order — mined for candidate keys and folded into the digest. */
  readonly texts: ReadonlyArray<string>
}

/**
 * Decode one transcript into the evidence it holds, keeping only activity inside `[from, to)`.
 * Pure and total: a malformed line, an unparseable timestamp, or a file of pure noise yields a
 * transcript with no activity rather than an error.
 */
export const decodeTranscript = (
  content: string,
  period: { readonly fromMs: number; readonly toMs: number }
): DecodedTranscript | null => {
  const promptTimes: Array<number> = []
  const texts: Array<string> = []
  let sessionId: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null

  for (const rawLine of content.split("\n")) {
    if (rawLine.trim().length === 0) continue
    const json = decodeJson(rawLine)
    if (Option.isNone(json)) continue // malformed JSONL line — skip, never fail the run
    const decoded = decodeLine(json.value)
    if (Option.isNone(decoded)) continue
    const line = decoded.value
    if (line.type === undefined || !ACTIVITY_TYPES.includes(line.type)) continue
    if (line.sessionId === undefined || line.timestamp === undefined || line.cwd === undefined) continue

    const atMs = Date.parse(line.timestamp)
    if (Number.isNaN(atMs)) continue

    if (atMs < period.fromMs || atMs >= period.toMs) continue

    // Inside the window only, and every kind of line: a key mentioned solely in the agent's own
    // output is still a candidate, but a prompt written after the window is not evidence about it.
    // A resumed session that moved on to something else would otherwise attribute — and describe —
    // yesterday's hours from today's work, and could carry text from a directory that was never
    // opted in to a Coding Agent.
    const text = messageText(line.message)
    if (text !== "") texts.push(text)

    sessionId = line.sessionId
    // Last in-window line wins: the directory and branch the credited work ran under.
    cwd = line.cwd
    gitBranch = line.gitBranch ?? null
    if (isHumanPrompt(line, line.message)) promptTimes.push(atMs)
  }

  if (sessionId === null || cwd === null || promptTimes.length === 0) return null
  // Stamped with the *resolved* session id rather than each line's own. Downstream, windows are
  // grouped by the activity's id and attributions are looked up by the record's, so labelling them
  // from two different places is a way for a transcript carrying more than one id to produce windows
  // no attribution matches — hours that vanish into "unattributed" with nothing to explain them.
  // One file is one session; this makes the code say that.
  const resolved = sessionId
  return {
    sessionId: resolved,
    cwd,
    gitBranch,
    activity: promptTimes.map((atMs): SessionActivity => ({ sessionId: resolved, atMs })),
    texts
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Where the Claude CLI keeps its transcripts, one directory per project. */
const CLAUDE_TRANSCRIPT_DIR = [".claude", "projects"]

const TRANSCRIPT_SUFFIX = ".jsonl"

/**
 * A working directory as the Claude CLI names the project directory holding its transcripts:
 * every `/` and `.` replaced by `-`, so `/Users/me/dev/knpkv.dev` becomes `-Users-me-dev-knpkv-dev`.
 */
const encodeProjectDir = (cwd: string): string => cwd.replace(/[/.]/g, "-")

/**
 * True when a project directory could hold a session inside one of the Session Roots.
 *
 * The encoding is many-to-one — `/a/b-c` and `/a/b/c` produce the same name — so this can admit a
 * directory that turns out to be elsewhere, and the authoritative check on the decoded `cwd`
 * still runs afterwards. What it cannot do is *exclude* one wrongly: the substitution is
 * character-by-character, so any path beneath a root encodes to a name beneath the root's.
 *
 * Worth the subtlety because the alternative is reading every transcript on the machine to find out
 * it was out of scope — on this author's laptop, 157 project directories to reach two. Opting a
 * directory in should mean the others are never opened, not that they are read and then discarded.
 */
export const mayHoldSessionRoot = (projectDir: string, roots: ReadonlyArray<string>): boolean =>
  roots.some((root) => {
    const encoded = encodeProjectDir(root)
    return encoded.length > 0 && (projectDir === encoded || projectDir.startsWith(`${encoded}-`))
  })

export const layer = Layer.effect(
  AgentSessionReader,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const config = yield* ConfigService

    const transcriptRoot = path.join(home, ...CLAUDE_TRANSCRIPT_DIR)

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
        const exists = yield* fs.exists(transcriptRoot).pipe(
          Effect.catch(asAgentSessionError("Checking for Claude transcripts failed"))
        )
        if (!exists) return []

        const projectDirs = yield* fs.readDirectory(transcriptRoot).pipe(
          Effect.catch(asAgentSessionError("Listing Claude projects failed"))
        )

        const paths: Array<string> = []
        for (const projectDir of projectDirs) {
          // Before the directory is even listed: a project outside every Session Root is not opened.
          if (!mayHoldSessionRoot(projectDir, roots)) continue
          const dir = path.join(transcriptRoot, projectDir)
          const entries = yield* fs.readDirectory(dir).pipe(
            Effect.catch((error) =>
              Effect.logDebug(`Skipping unreadable project directory ${projectDir}: ${error.message}`).pipe(
                Effect.as<ReadonlyArray<string>>([])
              )
            )
          )
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
        const paths = yield* transcriptPaths(roots)
        const records: Array<AgentSessionRecord> = []

        for (const filePath of paths) {
          if (!(yield* mayHoldActivity(filePath, fromMs))) continue

          const content = yield* fs.readFileString(filePath).pipe(
            Effect.catch((error) =>
              Effect.logDebug(`Skipping unreadable transcript ${filePath}: ${error.message}`).pipe(
                Effect.as<string | null>(null)
              )
            )
          )
          if (content === null) continue

          const transcript = decodeTranscript(content, { fromMs, toMs })
          if (transcript === null) continue
          // Scope check before anything is mined or digested: out-of-scope work leaves no trace.
          if (!isWithinSessionRoots(transcript.cwd, roots)) continue

          const text = transcript.texts.join("\n")
          records.push({
            sessionId: transcript.sessionId,
            cwd: transcript.cwd,
            gitBranch: transcript.gitBranch,
            candidateKeys: mineTicketKeys(text),
            digest: buildSessionDigest(transcript.texts),
            activity: transcript.activity
          })
        }

        return records
      })

    return { read }
  })
)
