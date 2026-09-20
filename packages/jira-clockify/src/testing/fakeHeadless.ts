/**
 * `FakeHeadlessLayer` — the same service shape as the CLI's `HeadlessLayer`, with every external
 * boundary faked and every write captured.
 *
 * **Why this exists**
 *
 * `HeadlessLayer` is fully live, which is why `commandSurface.test.ts` can only assert `--help`
 * outcomes. This layer keeps the *real* service implementations (TimerService, ReconcileService,
 * AgentSessionReader) and fakes only what leaves the process: Clockify, Jira, both auth services,
 * config, the filesystem, the terminal, and the Coding Agent. Commands can then be run end to end
 * and asserted on what they printed, proposed, and wrote.
 *
 * **How to read a test written against it**
 *
 * - `world.createdClockifyEntries` / `world.jiraWorklogs` are the writes that actually happened.
 * - `world.describeRequests` / `world.describeBatches` do the same for the notes written onto
 *   entries, so what a run *spends* on descriptions is assertable too.
 * - `world.attributorRequests` is every session asked about and `world.attributorBatches` is the
 *   number of *calls* those took, so both "cost nothing" and "batched, not one-by-one" are
 *   assertable. `world.maxAttributorInFlight` is the most calls that ever overlapped.
 * - `world.stdout` / `world.stderr` are the lines the command printed, split by stream, which is
 *   what the JSON Output Contract is about.
 * - `world.prompts` is what the terminal rendered. Prompt text goes through `Terminal.display`,
 *   not `Console`, so this is the only place a confirmation's wording is observable.
 * - `world.transcriptReads` is every transcript path opened, so a scope rule that promises a file is
 *   never read can be asserted rather than assumed.
 * - `world.transcripts` is the transcripts on disk, read live. Append to it mid-run to model a
 *   session that starts, or grows, while a long-running command is watching.
 * - `keep` scripts the row picker: `keep[i] === false` unchecks row `i`. Omitting `keep` entirely
 *   sends no input at all, which is the same signal as a missing TTY.
 *
 * **Why it ships**
 *
 * It lives in `src` and is exported as `@knpkv/jira-clockify/testing.js` because it is the highest
 * seam in the package and the only one a *consumer* can drive: a web server over these services has
 * to be testable against captured writes rather than a real Clockify account. Kept out of the barrel
 * so nothing production imports it by accident.
 */
import { NodePath } from "@effect/platform-node"
import type { ClockifyApiClientContract, TimeEntry } from "@knpkv/clockify-api-client"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import type * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { systemError } from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Terminal from "effect/Terminal"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { defaultSessionAgentSettings } from "../agent/agentSettings.js"
import { LogToStderrLive } from "../cli/layers.js"
import { layer as agentSessionReaderLayer } from "../services/AgentSessionReader.js"
import { ClockifyAuth } from "../services/ClockifyAuth.js"
import { ConfigService, type JcfConfig } from "../services/ConfigService.js"
import { HomeDirectory } from "../services/HomeDirectory.js"
import { layer as issueFactsLayer } from "../services/IssueFacts.js"
import { layer as reconcileServiceLayer } from "../services/ReconcileService.js"
import { layer as savedEntriesLayer } from "../services/SavedEntries.js"
import { type AttributionChoice, SessionAttributor, SessionAttributorError } from "../services/SessionAttributor.js"
import { layer as sourceLedgerLayer } from "../services/SourceLedger.js"
import { StateWriter } from "../services/StateWriter.js"
import { layer as ticketServiceLayer } from "../services/TicketService.js"
import { layer as timerServiceLayer } from "../services/TimerService.js"

export const FAKE_HOME = "/fake-home"
export const FAKE_WORKSPACE_ID = "ws-fake"
export const FAKE_USER_ID = "user-fake"

/** A Clockify write the command performed. */
export interface CreatedClockifyEntry {
  readonly description: string
  readonly start: string
  readonly end: string | undefined
  /** What the command asked Clockify to bill. `undefined` means it left the choice to Clockify. */
  readonly billable: boolean | undefined
}

/**
 * The text of a Jira worklog comment, read back out of the document format Jira takes.
 *
 * Deliberately tolerant: a test asserts on what a reader would see, and walking the node tree for
 * every `text` leaf says that without also pinning the paragraph structure around it.
 */
/**
 * One node of Jira's document format, reduced to what reading a comment back needs.
 *
 * Decoded rather than inspected: the tree is external data, and a schema is what turns "some
 * object" into something with a `text` and a `content` this can rely on.
 */
const AdfNode = Schema.Struct({
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown)
})

const decodeAdfNode = Schema.decodeUnknownOption(AdfNode)

/** The worklog fields the fake reads back off a POST body. */
const WorklogPayload = Schema.Struct({
  started: Schema.optional(Schema.String),
  timeSpentSeconds: Schema.optional(Schema.Finite),
  comment: Schema.optionalKey(Schema.Json)
})

type WorklogPayload = typeof WorklogPayload.Type

const decodeWorklogPayload = Schema.decodeUnknownOption(Schema.fromJsonString(WorklogPayload))

const commentText = <UnparsedInput>(comment: UnparsedInput): string => {
  const texts: Array<string> = []
  const walk = <Node>(node: Node): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const decoded = decodeAdfNode(node)
    if (Option.isNone(decoded)) return
    const { content, text } = decoded.value
    if (text !== undefined) texts.push(text)
    if (content !== undefined) walk(content)
  }
  walk(comment)
  return texts.join(" ")
}

/** A Jira worklog the command posted. */
export interface PostedJiraWorklog {
  readonly issueKey: string
  readonly started: string
  readonly timeSpentSeconds: number
  /** The worklog comment as plain text, flattened out of Jira's document format. */
  readonly comment: string
}

/** Everything a test can observe after running a command. */
export interface FakeWorld {
  readonly createdClockifyEntries: Array<CreatedClockifyEntry>
  readonly jiraWorklogs: Array<PostedJiraWorklog>
  readonly updatedClockifyEntries: Array<
    { readonly id: string; readonly payload: Parameters<ClockifyApiClientContract["updateTimeEntry"]>[2] }
  >
  readonly updatedJiraWorklogs: Array<
    {
      readonly id: string
      readonly issueKey: string
      readonly payload: WorklogPayload
      readonly adjustEstimate: string | undefined
    }
  >
  readonly attributorRequests: Array<{ readonly candidateKeys: ReadonlyArray<string>; readonly digest: string }>
  /** One entry per Coding Agent *call*, holding the session ids that call covered. */
  readonly attributorBatches: Array<ReadonlyArray<string>>
  /** Every work item a note was asked for, and the material it was asked from. */
  readonly describeRequests: Array<{
    readonly ticketKey: string | null
    readonly summary: string | null
    readonly digest: string
  }>
  /** One entry per description call, listing the Issue Keys it covered. */
  readonly describeBatches: Array<ReadonlyArray<string | null>>
  /** High-water mark of overlapping attributor calls. 1 means they ran one after another. */
  maxAttributorInFlight: number
  readonly stdout: Array<string>
  readonly stderr: Array<string>
  /** Raw terminal writes, including ANSI. Prompt wording is asserted with `toContain`. */
  readonly prompts: Array<string>
  /**
   * The transcripts on disk, keyed `"<project-dir>/<file>.jsonl"`, live rather than snapshotted.
   * Append to it mid-run to model a session that is still being worked in.
   */
  readonly transcripts: Record<string, string>
  /** Every transcript path actually opened, so "never even read" is assertable rather than implied. */
  readonly transcriptReads: Array<string>
  /** Files the command wrote, by path — the watch lease among them. */
  readonly writtenFiles: Record<string, string>
  /** Whether Jira accepts worklogs. Flip it mid-test to model logging back in between two runs. */
  jiraLoggedIn: boolean
  /** Running Clockify timer. Flip it mid-test to model one starting after a retained read. */
  runningTimer: ExistingClockifyEntry | null
  /** Provider reads to fail before returning to normal; tests set this at synchronization hooks. */
  jiraWorklogReadFailuresRemaining: number
  jiraSearchFailuresRemaining: number
  /** Issues omitted from JQL search while direct worklog reads remain authoritative. */
  readonly jiraSearchHiddenIssues: Set<string>
  /** Replace visible Clockify fixtures between synchronized phases of one command. */
  readonly setClockifyEntries: (entries: ReadonlyArray<ExistingClockifyEntry>) => void
  /** Replace visible Jira fixtures between synchronized phases of one command. */
  readonly setJiraWorklogs: (entries: Readonly<Record<string, ReadonlyArray<ExistingJiraWorklog>>>) => void
}

/** An existing Clockify entry, in the shape a test wants to write it. */
export interface ExistingClockifyEntry {
  readonly id?: string
  readonly userId?: string
  readonly billable?: boolean
  readonly projectId?: string | null
  readonly taskId?: string | null
  readonly tagIds?: ReadonlyArray<string> | null
  readonly description: string
  readonly start: string
  /** Omit to model a *running* entry — the case whose time is invisible to the tally. */
  readonly end?: string | undefined
}

/** An existing Jira worklog, keyed by issue in {@link FakeHeadlessOptions.jiraWorklogs}. */
export interface ExistingJiraWorklog {
  readonly id?: string
  readonly author?: { readonly accountId: string }
  readonly comment?: Schema.Json
  readonly visibility?: { readonly type: "group" | "role"; readonly value: string }
  readonly started: string
  readonly timeSpentSeconds: number
}

export interface FakeHeadlessOptions {
  /** Private file snapshot carried into a fresh fake process for restart tests. */
  readonly writtenFiles?: Readonly<Record<string, string>> | undefined
  readonly config?: Partial<JcfConfig> | undefined
  /** Let concurrent HTTP fixtures observe the same config snapshot before either saves. */
  readonly delayConfigReads?: boolean | undefined
  /** Synthetic Linux namespace for crash-recovery tests; absent keeps the fake fail-closed. */
  readonly pidNamespaceInode?: number | undefined
  /**
   * Transcripts to serve from `~/.claude/projects`, keyed `"<project-dir>/<file>.jsonl"`.
   */
  readonly transcripts?: Readonly<Record<string, string>> | undefined
  readonly clockifyEntries?: ReadonlyArray<ExistingClockifyEntry> | undefined
  readonly jiraWorklogs?: Readonly<Record<string, ReadonlyArray<ExistingJiraWorklog>>> | undefined
  /** The Coding Agent's answer, or a failure to model one being unavailable. */
  readonly attributor?:
    | ((request: { readonly candidateKeys: ReadonlyArray<string> }) => AttributionChoice | "fail")
    | undefined
  /**
   * The note a Coding Agent returns for a work item. Omit for "the prompts do not say", which is
   * what a real session with nothing quotable produces.
   */
  readonly describer?:
    | ((request: { readonly ticketKey: string | null; readonly digest: string }) => string | null | "fail")
    | undefined
  /** Test synchronization hook immediately before a description batch is answered. */
  readonly beforeDescribe?: ((world: FakeWorld) => void) | undefined
  /** Test synchronization hook after a prompt is shown but before its scripted input is read. */
  readonly beforePromptInput?: ((world: FakeWorld) => void) | undefined
  /**
   * Which proposal rows to leave checked in the picker, by position. Every row starts checked, so
   * `[true, false]` unchecks the second. Omit entirely to send no input — the no-TTY case.
   */
  readonly keep?: ReadonlyArray<boolean> | undefined
  /** A Clockify timer already running when the command starts. */
  readonly runningTimer?: { readonly description: string; readonly start: string } | undefined
  /** Whether Jira accepts worklog posts. */
  readonly jiraLoggedIn?: boolean | undefined
  /** A successful create response without its optional provider ID. */
  readonly jiraPostOmitsId?: boolean | undefined
  /** Existing worklogs whose provider read omits its optional identity field. */
  readonly jiraReadOmitsId?: boolean | undefined
  readonly jiraCloudId?: string | undefined
  /** Make Jira's current-user endpoint fail while the stored auth session remains present. */
  readonly jiraCurrentUserFails?: boolean | undefined
  /** Make every worklog *read* fail, to model a transient Jira outage mid-run. */
  readonly jiraWorklogReadFails?: boolean | undefined
  /** Limit each Jira worklog read page while retaining the provider's total count. */
  readonly jiraWorklogPageSize?: number | undefined
  /** Return invalid or failed evidence on a later Jira worklog page. */
  readonly jiraWorklogPageFault?:
    | "failure"
    | "missing"
    | "inconsistent"
    | "stalled"
    | "missing-duration"
    | "missing-started"
    | "missing-author"
    | "missing-id"
    | "empty-id"
    | "spaces-id"
    | "tab-newline-id"
    | undefined
  /** Make every Clockify entry creation fail, to model the write half refusing. */
  readonly clockifyWritesFail?: boolean | undefined
  /** Test-only boundary after a remote Clockify create but before its caller records the receipt. */
  readonly afterClockifyWrite?: ((world: FakeWorld) => void) | undefined
  /** Make the running-timer safety read fail before a timer command can proceed. */
  readonly clockifyRunningTimerReadFails?: boolean | undefined
  /**
   * Serve existing Clockify entries this many per page, so a caller that reads only the first page
   * demonstrably misses the rest. Unset means one page however many entries there are.
   */
  readonly clockifyPageSize?: number | undefined
  /** Paths whose writes fail with a permission error — an unwritable config directory. */
  readonly unwritablePaths?: ReadonlyArray<string> | undefined
  /** Test synchronization after an in-memory file becomes visible but before its write completes. */
  readonly afterFileWrite?: ((path: string) => Effect.Effect<void>) | undefined
  /** Paths whose file read or directory listing fails. Matched by suffix. */
  readonly unreadableTranscripts?: ReadonlyArray<string> | undefined
  /** The terminal's width, which is what the picker lays its rows out for. */
  readonly columns?: number | undefined
  /** Issue summaries Jira will return, keyed by issue key. Unlisted keys 404. */
  readonly issueSummaries?: Readonly<Record<string, string>> | undefined
  /**
   * Assignees by issue key. A key with a summary but no entry here omits the assignee field.
   *
   * By default a string serves as both the display name and account id. Tests can override the
   * optional display name independently while preserving the account identity.
   */
  readonly issueAssignees?: Readonly<Record<string, string | null>> | undefined
  /** Override Jira's optional display name independently of its assignee account id. */
  readonly issueAssigneeDisplayNames?: Readonly<Record<string, string | null>> | undefined
  /** The account this fake Jira is logged in as, for deciding whose tickets are whose. */
  readonly jiraAccountId?: string | undefined
}

/** Whoever the fake is logged in as unless a test says otherwise. */
export const FAKE_ACCOUNT_ID = "acct-me"

const defaultConfig: JcfConfig = {
  sessionAgent: defaultSessionAgentSettings,
  defaultJql: "",
  refreshInterval: 30,
  projectMap: {},
  workspaceId: null,
  defaultProjectId: null,
  defaultProjectName: null,
  defaultBillable: true,
  sessionRoots: [],
  sessionTicketMap: {},
  sessionIdleCapSeconds: 300,
  sessionConfidenceFloor: 0.7,
  sessionOwnership: "assigned",
  sessionOwnershipOverrides: [],
  sessionDwellSeconds: 900
}

const makeTimeEntry = (entry: ExistingClockifyEntry, id: string): TimeEntry => ({
  id: entry.id ?? id,
  description: entry.description,
  billable: entry.billable ?? true,
  userId: entry.userId ?? FAKE_USER_ID,
  ...(entry.projectId !== undefined && { projectId: entry.projectId }),
  ...(entry.taskId !== undefined && { taskId: entry.taskId }),
  workspaceId: FAKE_WORKSPACE_ID,
  timeInterval: { start: entry.start, ...((entry.end !== undefined) && { end: entry.end }) },
  tagIds: entry.tagIds ?? [],
  type: "REGULAR",
  isLocked: false
})

/** A `File.Info` with no mtime, so the reader's mtime pre-filter never skips a fixture. */
const fileInfo = (type: FileSystem.File.Info["type"]): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none()
})

const TRANSCRIPT_ROOT = `${FAKE_HOME}/.claude/projects`

/**
 * A read-only in-memory filesystem serving the transcript fixtures a test declared.
 *
 * Read live from `world.transcripts` on every call rather than snapshotted at layer construction.
 * A watch is a command that runs while the transcripts underneath it grow, so a test has to be able
 * to append a prompt between two ticks — with a snapshot, every tick would see the same day.
 */
const fakeFileSystemLayer = (
  transcripts: Record<string, string>,
  reads: Array<string>,
  written: Record<string, string>,
  unwritable: ReadonlyArray<string>,
  unreadable: ReadonlyArray<string>,
  afterFileWrite: (path: string) => Effect.Effect<void>,
  pidNamespaceInode?: number
) => {
  /**
   * The project directory a transcript really lives in: the Claude CLI derives it from the working
   * directory the session ran in, not from anything the test chose.
   *
   * Derived here rather than taken from the fixture key so a test cannot accidentally file an
   * out-of-scope session inside a Session Root — which is the behaviour the reader's pre-read scope
   * filter depends on. The key's own directory is the fallback for a fixture with no readable `cwd`.
   */
  const projectDirOf = (key: string, content: string): string => {
    for (const line of content.split("\n")) {
      if (!line.includes("\"cwd\"")) continue
      const parsed: unknown = JSON.parse(line)
      const cwd = Predicate.isObject(parsed) ? parsed["cwd"] : undefined
      if (Predicate.isString(cwd)) return cwd.replace(/[/.]/g, "-")
    }
    return key.split("/")[0] ?? key
  }

  const fileName = (key: string): string => key.slice(key.lastIndexOf("/") + 1)
  const path = (key: string, content: string) => `${TRANSCRIPT_ROOT}/${projectDirOf(key, content)}/${fileName(key)}`
  const files = () => new Map<string, string>(Object.entries(transcripts).map(([key, c]) => [path(key, c), c]))
  const projectDirs = () => new Set(Object.entries(transcripts).map(([key, c]) => projectDirOf(key, c)))
  const directories = () => {
    const dirs = new Set([FAKE_HOME, `${FAKE_HOME}/.claude`, TRANSCRIPT_ROOT, `${FAKE_HOME}/.jcf`])
    for (const dir of projectDirs()) dirs.add(`${TRANSCRIPT_ROOT}/${dir}`)
    return dirs
  }

  const notFound = (method: string, path: string) =>
    Effect.fail(
      systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        description: "No such file or directory",
        pathOrDescriptor: path
      })
    )

  const permissionDenied = (method: string, path: string) =>
    Effect.fail(
      systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method,
        description: "permission denied",
        pathOrDescriptor: path
      })
    )

  const syncedHandle = (type: FileSystem.File.Info["type"]): FileSystem.File => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: Effect.succeed(fileInfo(type)),
    seek: () => Effect.succeed(FileSystem.Size(0)),
    sync: Effect.void,
    read: () => Effect.succeed(FileSystem.Size(0)),
    readAlloc: () => Effect.succeed(Option.none()),
    truncate: () => Effect.void,
    write: (buffer) => Effect.succeed(FileSystem.Size(buffer.length)),
    writeAll: () => Effect.void
  })

  return FileSystem.layerNoop({
    realPath: (path) =>
      directories().has(path) || files().has(path) || written[path] !== undefined
        ? Effect.succeed(path)
        : notFound("realPath", path),
    open: (path) =>
      directories().has(path)
        ? Effect.succeed(syncedHandle("Directory"))
        : written[path] !== undefined
        ? Effect.succeed(syncedHandle("File"))
        : notFound("open", path),
    exists: (path) => Effect.succeed(directories().has(path) || files().has(path) || written[path] !== undefined),
    stat: (path) =>
      unreadable.includes(path)
        ? permissionDenied("stat", path)
        : path === "/proc/self/ns/pid" && pidNamespaceInode !== undefined
        ? Effect.succeed({ ...fileInfo("File"), ino: Option.some(pidNamespaceInode) })
        : directories().has(path)
        ? Effect.succeed(fileInfo("Directory"))
        : files().has(path) || written[path] !== undefined
        ? Effect.succeed(fileInfo("File"))
        : notFound("stat", path),
    readDirectory: (path) => {
      if (unreadable.some((suffix) => path.endsWith(suffix))) return permissionDenied("readDirectory", path)
      if (path === TRANSCRIPT_ROOT) return Effect.succeed([...projectDirs()])
      const prefix = `${path}/`
      const entries = [...files().keys()]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
      return directories().has(path) ? Effect.succeed(entries) : notFound("readDirectory", path)
    },
    readFileString: (path) => {
      if (path.startsWith(`${TRANSCRIPT_ROOT}/`)) reads.push(path)
      // Matched by suffix, so a test names the fixture it wrote rather than reproducing the project
      // directory encoding the Claude CLI derives from a session's `cwd`.
      if (unreadable.some((suffix) => path.endsWith(suffix))) {
        return permissionDenied("readFileString", path)
      }
      const stored = written[path]
      if (stored !== undefined) return Effect.succeed(stored)
      const content = files().get(path)
      return content === undefined ? notFound("readFileString", path) : Effect.succeed(content)
    },
    // The config service writes through this; nothing in these tests reads it back from disk.
    makeDirectory: () => Effect.void,
    // A real store, so anything the CLI writes and reads back — the watch lease — behaves. `wx` is
    // honoured, because an exclusive create is exactly what the lease relies on for its exclusion.
    writeFileString: (path, content, options) =>
      unwritable.includes(path)
        // Deliberately not `AlreadyExists`: telling those two apart is the whole point of the
        // lease's fail-closed rule, so the fake must be able to produce the other one.
        ? Effect.fail(
          systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "writeFileString",
            description: "permission denied",
            pathOrDescriptor: path
          })
        )
        : options?.flag === "wx" && written[path] !== undefined
        ? Effect.fail(
          systemError({
            _tag: "AlreadyExists",
            module: "FileSystem",
            method: "writeFileString",
            description: "file already exists",
            pathOrDescriptor: path
          })
        )
        : Effect.sync(() => {
          written[path] = content
        }).pipe(Effect.andThen(afterFileWrite(path))),
    remove: (path) =>
      Effect.sync(() => {
        delete written[path]
      }),
    rename: (from, to) =>
      written[from] === undefined
        ? notFound("rename", from)
        : unwritable.includes(to)
        ? permissionDenied("rename", to)
        : Effect.sync(() => {
          written[to] = written[from]!
          delete written[from]
        })
  })
}

const keypress = (name: string): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl: false, meta: false, shift: false }
})

/**
 * Translate "keep these rows" into the keys a multi-select actually receives.
 *
 * The picker's cursor starts on its two meta options (select-all, invert), so choice `i` sits at
 * cursor position `i + 2`. Every row starts checked, so only the rows to *drop* need a `space`.
 */
export const pickerKeys = (keep: ReadonlyArray<boolean>): ReadonlyArray<Terminal.UserInput> => {
  const keys: Array<Terminal.UserInput> = []
  let cursor = 0
  keep.forEach((keepRow, index) => {
    if (keepRow) return
    const target = index + 2
    for (; cursor < target; cursor++) keys.push(keypress("down"))
    keys.push(keypress("space"))
  })
  keys.push(keypress("enter"))
  return keys
}

/** The conventional terminal width, and the narrowest the picker lays rows out for. */
const DEFAULT_COLUMNS = 80

/**
 * A terminal that replays scripted keypresses. Once the script is exhausted the input queue ends,
 * which `Prompt` reports as `QuitError` — the same outcome as running without a TTY.
 */
const fakeTerminalLayer = (
  options: {
    readonly keep: ReadonlyArray<boolean> | undefined
    readonly columns: number
    readonly beforePromptInput: ((world: FakeWorld) => void) | undefined
  },
  world: FakeWorld
) =>
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(options.columns),
      rows: Effect.succeed(24),
      // Scoped in rc.109, and the queue ends with `Cause.Done` rather than a terminal-specific
      // error. An exhausted script is still what a missing TTY looks like to `Prompt`.
      readInput: Effect.gen(function*() {
        yield* Effect.sync(() => options.beforePromptInput?.(world))
        const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
        // No script at all means no input, so the prompt ends unanswered.
        if (options.keep !== undefined) yield* Queue.offerAll(queue, pickerKeys(options.keep))
        yield* Queue.end(queue)
        return queue
      }),
      readLine: Effect.succeed(""),
      display: (text) =>
        Effect.sync(() => {
          world.prompts.push(text)
        })
    })
  )

/** A console that keeps stdout and stderr apart, which is what the JSON Output Contract needs. */
const captureConsoleLayer = (world: FakeWorld) =>
  Layer.succeed(Console.Console, {
    log: (...args: ReadonlyArray<unknown>) => {
      world.stdout.push(args.map(String).join(" "))
    },
    error: (...args: ReadonlyArray<unknown>) => {
      world.stderr.push(args.map(String).join(" "))
    },
    assert: () => {},
    clear: () => {},
    count: () => {},
    countReset: () => {},
    debug: () => {},
    dir: () => {},
    dirxml: () => {},
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    info: () => {},
    table: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    trace: () => {},
    warn: () => {}
  })

/**
 * Build a fully closed layer with the same services `HeadlessLayer` provides, plus the world the
 * assertions read.
 */
export const makeFakeHeadless = (options: FakeHeadlessOptions = {}) => {
  const world: FakeWorld = {
    createdClockifyEntries: [],
    jiraWorklogs: [],
    updatedClockifyEntries: [],
    updatedJiraWorklogs: [],
    attributorRequests: [],
    attributorBatches: [],
    describeRequests: [],
    describeBatches: [],
    maxAttributorInFlight: 0,
    stdout: [],
    stderr: [],
    prompts: [],
    transcripts: { ...options.transcripts },
    transcriptReads: [],
    // Ordinary fake scenarios model an installation whose earlier provider history was already
    // reviewed. Pass an explicit empty map to exercise first-run migration and its fail-closed path.
    writtenFiles: options.writtenFiles === undefined ?
      {
        [`${FAKE_HOME}/.jcf/source-consumption.v1.json`]: JSON.stringify({
          version: 1,
          reviewedWindows: [
            {
              provider: "clockify",
              scope: JSON.stringify([FAKE_WORKSPACE_ID, FAKE_USER_ID]),
              fromMs: 0,
              toMs: 4_102_444_800_000
            },
            {
              provider: "jira",
              scope: JSON.stringify([options.jiraCloudId ?? "cloud-fake", options.jiraAccountId ?? FAKE_ACCOUNT_ID]),
              fromMs: 0,
              toMs: 4_102_444_800_000
            }
          ],
          pending: [],
          bindings: []
        })
      } :
      { ...options.writtenFiles },
    jiraLoggedIn: options.jiraLoggedIn ?? true,
    runningTimer: options.runningTimer ?? null,
    jiraWorklogReadFailuresRemaining: 0,
    jiraSearchFailuresRemaining: 0,
    jiraSearchHiddenIssues: new Set(),
    setClockifyEntries: (entries) => {
      clockifyLedger.splice(
        0,
        clockifyLedger.length,
        ...entries.map((entry, index) => makeTimeEntry(entry, `replaced-${index}`))
      )
    },
    setJiraWorklogs: (entries) => {
      jiraLedger.clear()
      for (const [key, worklogs] of Object.entries(entries)) {
        jiraLedger.set(key, [...worklogs])
        for (const entry of worklogs) {
          if (entry.id !== undefined) issuedJiraIds.add(entry.id)
        }
      }
    }
  }

  // Ledgers, not fixed fixtures: a write lands here and the next read sees it, which is what
  // makes "run it twice and nothing is proposed the second time" a real assertion.
  const clockifyLedger: Array<TimeEntry> = (options.clockifyEntries ?? []).map((entry, index) =>
    makeTimeEntry(entry, `existing-${index}`)
  )
  const jiraLedger = new Map<string, Array<ExistingJiraWorklog>>(
    Object.entries(options.jiraWorklogs ?? {}).map(([key, worklogs]) => [key, [...worklogs]])
  )
  const issuedJiraIds = new Set(
    [...jiraLedger.values()].flatMap((entries) => entries.flatMap((entry) => entry.id === undefined ? [] : [entry.id]))
  )
  const runningEntry = () => world.runningTimer === null ? null : makeTimeEntry(world.runningTimer, "running-1")

  const clockify: ClockifyApiClientContract = {
    getUser: () =>
      Effect.succeed({
        id: FAKE_USER_ID,
        name: "Fake",
        email: "fake@example.com",
        activeWorkspace: FAKE_WORKSPACE_ID,
        defaultWorkspace: FAKE_WORKSPACE_ID,
        profilePicture: "",
        status: "ACTIVE"
      }),
    getWorkspaces: () => Effect.succeed([{ id: FAKE_WORKSPACE_ID, name: "WS", imageUrl: "" }]),
    getProjects: () => Effect.succeed([]),
    getProjectByName: () => Effect.succeed(null),
    // Paged when a test asks for it, so "reads only the first page" is observable rather than
    // assumed. `getRunningTimer` has its own path, so the running entry rides along on page one.
    getTimeEntries: (_ws, _user, params) => {
      const running = runningEntry()
      const all = running === null ? [...clockifyLedger] : [...clockifyLedger, running]
      const page = params?.page ?? 1
      const cap = options.clockifyPageSize
      // One page holds everything, and the page after it is empty — a paginating caller has to be
      // able to reach the end. Returning `all` for every page would model a server that never ends.
      if (cap === undefined) return Effect.succeed(page === 1 ? all : [])
      // The smaller of the two, because Clockify may serve fewer than it was asked for — which is
      // the case a caller that stops at the first short page gets wrong.
      const size = Math.min(params?.pageSize ?? cap, cap)
      return Effect.succeed(all.slice((page - 1) * size, page * size))
    },
    getRunningTimer: () =>
      options.clockifyRunningTimerReadFails === true
        ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.get("https://api.clockify.me/running-timer"),
              description: "Clockify running timer is unavailable"
            })
          })
        )
        : Effect.sync(runningEntry),
    getTimeEntry: (_ws, id) =>
      Effect.suspend(() => {
        const entry = clockifyLedger.find((entry) => entry.id === id)
        if (entry !== undefined) return Effect.succeed(entry)
        const request = HttpClientRequest.get(`https://fake.clockify/entries/${id}`)
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request,
              response: HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
            })
          })
        )
      }),
    getTags: () => Effect.succeed([]),
    createTag: (_ws, name) =>
      Effect.succeed({ id: `tag-${name}`, name, workspaceId: FAKE_WORKSPACE_ID, archived: false }),
    findOrCreateTag: (_ws, name) =>
      Effect.succeed({ id: `tag-${name}`, name, workspaceId: FAKE_WORKSPACE_ID, archived: false }),
    createTimeEntry: (_ws, params) =>
      options.clockifyWritesFail === true
        ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.post("https://api.clockify.me/time-entries"),
              description: "Clockify refused the entry"
            })
          })
        )
        : Effect.sync(() => {
          world.createdClockifyEntries.push({
            description: params.description,
            start: params.start,
            end: params.end,
            billable: params.billable
          })
          const entry = makeTimeEntry(
            { description: params.description, start: params.start, end: params.end },
            `created-${clockifyLedger.length}`
          )
          clockifyLedger.push(entry)
          options.afterClockifyWrite?.(world)
          return entry
        }),
    updateTimeEntry: (_ws, id, params) =>
      Effect.sync(() => {
        const index = clockifyLedger.findIndex((entry) => entry.id === id)
        const existing = clockifyLedger[index]
        const saved = makeTimeEntry({
          ...existing,
          ...params,
          description: params.description ?? existing?.description ?? "",
          start: params.start
        }, id)
        world.updatedClockifyEntries.push({ id, payload: params })
        if (index >= 0) clockifyLedger[index] = saved
        return saved
      }),
    deleteTimeEntry: () => Effect.void,
    stopTimer: (_ws, _user, params) =>
      Effect.succeed(makeTimeEntry({ description: "", start: "", end: params.end }, "stopped-1"))
  }

  // Read through the world, not captured, so one world can model logging back in between two runs —
  // which is exactly the flow the "Jira refused, go and log in, restart" message asks the user for.
  const loggedIn = () => world.jiraLoggedIn

  const jsonResponse = <ResponseBody>(
    request: Parameters<typeof HttpClientResponse.fromWeb>[0],
    status: number,
    body: ResponseBody
  ) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    )

  const requestPayload = (body: { readonly _tag: string }): WorklogPayload => {
    if (body._tag !== "Uint8Array" || !("body" in body) || !Predicate.isUint8Array(body.body)) return {}
    return Option.getOrElse(
      decodeWorklogPayload(new TextDecoder().decode(body.body)),
      (): WorklogPayload => ({})
    )
  }

  /**
   * The single Jira boundary. Both the generated `JiraApiClient` (reads) and TimerService's raw
   * worklog POST (writes) go through it, so reads exercise the real client's decoding rather than
   * a hand-shaped stub of a very large generated interface.
   */
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const exactWorklog = request.url.match(/issue\/([^/]+)\/worklog\/([^/?]+)/)
        if (exactWorklog !== null) {
          const issueKey = exactWorklog[1] ?? ""
          const id = exactWorklog[2] ?? ""
          const entries = jiraLedger.get(issueKey) ?? []
          const index = entries.findIndex((entry, index) => (entry.id ?? `wl-${index}`) === id)
          const entry = entries[index]
          if (entry === undefined) return jsonResponse(request, 404, { errorMessages: ["Worklog not found"] })
          if (request.method === "PUT") {
            const payload = requestPayload(request.body)
            entries[index] = {
              ...entry,
              started: payload.started ?? entry.started,
              timeSpentSeconds: payload.timeSpentSeconds ?? entry.timeSpentSeconds,
              ...(payload.comment !== undefined && { comment: payload.comment })
            }
            world.updatedJiraWorklogs.push({
              issueKey,
              id,
              payload,
              adjustEstimate: [...request.urlParams].find(([key]) => key === "adjustEstimate")?.[1]
            })
          }
          return jsonResponse(request, 200, {
            author: { accountId: options.jiraAccountId ?? FAKE_ACCOUNT_ID },
            ...entries[index],
            id
          })
        }
        const worklogMatch = request.url.match(/issue\/([^/]+)\/worklog/)
        if (request.method === "POST" && worklogMatch !== null) {
          const payload = requestPayload(request.body)
          const issueKey = worklogMatch[1] ?? "unknown"
          let nextId = 0
          while (issuedJiraIds.has(`wl-created-${nextId}`)) nextId++
          const entryId = `wl-created-${nextId}`
          issuedJiraIds.add(entryId)
          const started = payload.started ?? ""
          const timeSpentSeconds = payload.timeSpentSeconds ?? 0
          world.jiraWorklogs.push({ issueKey, started, timeSpentSeconds, comment: commentText(payload.comment) })
          jiraLedger.set(issueKey, [...(jiraLedger.get(issueKey) ?? []), {
            id: entryId,
            started,
            timeSpentSeconds,
            ...(payload.comment !== undefined && { comment: payload.comment })
          }])
          return jsonResponse(request, 201, options.jiraPostOmitsId === true ? {} : { id: entryId })
        }
        if (worklogMatch !== null) {
          const requestedStartAt = Number(request.urlParams.params.find(([name]) => name === "startAt")?.[1] ?? 0)
          if (requestedStartAt > 0 && options.jiraWorklogPageFault === "failure") {
            return jsonResponse(request, 500, { errorMessages: ["Later worklog page unavailable"] })
          }
          if (options.jiraWorklogReadFails === true || world.jiraWorklogReadFailuresRemaining > 0) {
            if (world.jiraWorklogReadFailuresRemaining > 0) world.jiraWorklogReadFailuresRemaining--
            return jsonResponse(request, 500, { errorMessages: ["Jira is having a moment"] })
          }
          const numberParam = (name: string): number | undefined => {
            const raw = request.urlParams.params.find(([candidate]) => candidate === name)?.[1]
            if (raw === undefined) return undefined
            const parsed = Number(raw)
            return Number.isFinite(parsed) ? parsed : undefined
          }
          const startedAfter = numberParam("startedAfter")
          const startedBefore = numberParam("startedBefore")
          const startAt = numberParam("startAt") ?? 0
          const entries = (jiraLedger.get(worklogMatch[1] ?? "") ?? []).filter((worklog) => {
            const startedMs = new Date(worklog.started).getTime()
            return (startedAfter === undefined || startedMs >= startedAfter) &&
              (startedBefore === undefined || startedMs < startedBefore)
          })
          const pageSize = options.jiraWorklogPageSize ?? entries.length
          const page = entries.slice(startAt, startAt + pageSize)
          if (startAt > 0 && options.jiraWorklogPageFault === "missing") {
            return jsonResponse(request, 200, { startAt, maxResults: pageSize, total: entries.length })
          }
          return jsonResponse(request, 200, {
            startAt: startAt > 0 && options.jiraWorklogPageFault === "stalled" ? 0 : startAt,
            maxResults: pageSize,
            total: entries.length + (startAt > 0 && options.jiraWorklogPageFault === "inconsistent" ? 1 : 0),
            worklogs: page.map((worklog, index) => {
              const id = worklog.id ?? `wl-${startAt + index}`
              issuedJiraIds.add(id)
              return {
                id,
                author: { accountId: options.jiraAccountId ?? FAKE_ACCOUNT_ID },
                ...worklog,
                ...(startAt > 0 && options.jiraWorklogPageFault === "missing-duration" && {
                  timeSpentSeconds: undefined
                }),
                ...(startAt > 0 && options.jiraWorklogPageFault === "missing-started" && { started: undefined }),
                ...(startAt > 0 && options.jiraWorklogPageFault === "missing-author" && { author: undefined }),
                ...(startAt > 0 && options.jiraWorklogPageFault === "missing-id" && { id: undefined }),
                ...(startAt > 0 && options.jiraWorklogPageFault === "empty-id" && { id: "" }),
                ...(startAt > 0 && options.jiraWorklogPageFault === "spaces-id" && { id: "   " }),
                ...(startAt > 0 && options.jiraWorklogPageFault === "tab-newline-id" && { id: "\t\n" }),
                ...(options.jiraReadOmitsId === true && { id: undefined })
              }
            })
          })
        }
        const issueMatch = request.url.match(/issue\/([^/?]+)(?:\?|$)/)
        if (request.method === "GET" && issueMatch !== null) {
          const key = issueMatch[1] ?? ""
          const summary = (options.issueSummaries ?? {})[key]
          if (summary === undefined) {
            return jsonResponse(request, 404, { errorMessages: ["Issue does not exist"] })
          }
          const assignee = (options.issueAssignees ?? {})[key]
          const displayName = (options.issueAssigneeDisplayNames ?? {})[key]
          return jsonResponse(request, 200, {
            id: "10000",
            key,
            fields: {
              summary,
              ...((assignee !== undefined) && {
                assignee: assignee === null ? null : displayName === null
                  ? {}
                  : { displayName: displayName ?? assignee }
              })
            }
          })
        }
        if (request.url.includes("/myself")) {
          if (options.jiraCurrentUserFails === true) {
            return jsonResponse(request, 500, { errorMessages: ["Current user unavailable"] })
          }
          return jsonResponse(request, 200, {
            accountId: options.jiraAccountId ?? FAKE_ACCOUNT_ID,
            displayName: "Fake User"
          })
        }
        if (request.url.includes("/search/jql")) {
          if (world.jiraSearchFailuresRemaining > 0) {
            world.jiraSearchFailuresRemaining--
            return jsonResponse(request, 500, { errorMessages: ["Jira search is unavailable"] })
          }
          // A `key in (…)` search answers about exactly those keys. Any other JQL keeps the old
          // behaviour: whatever the ledger happens to hold. The query lives in `urlParams` rather
          // than in `url` — the client keeps them apart until the request is actually sent.
          const jql = request.urlParams.params.find(([name]) => name === "jql")?.[1]
          const clause = jql === undefined ? null : jql.match(/key in \(([^)]*)\)/)
          if (clause !== null) {
            const keys = (clause[1] ?? "").split(",").map((key) => key.trim()).filter((key) => key !== "")
            const summaries = options.issueSummaries ?? {}
            const assignees = options.issueAssignees ?? {}
            const displayNames = options.issueAssigneeDisplayNames ?? {}
            return jsonResponse(request, 200, {
              // Only the keys this fake Jira knows about, so a test can model an issue that is gone.
              issues: keys.filter((key) => summaries[key] !== undefined).map((key, index) => ({
                id: String(index),
                key,
                fields: {
                  summary: summaries[key],
                  ...((assignees[key] !== undefined) && {
                    assignee: assignees[key] === null
                      ? null
                      : displayNames[key] === null
                      ? { accountId: assignees[key] }
                      : { accountId: assignees[key], displayName: displayNames[key] ?? assignees[key] }
                  })
                }
              }))
            })
          }
          return jsonResponse(request, 200, {
            issues: [...jiraLedger.keys()]
              .filter((key) => !world.jiraSearchHiddenIssues.has(key))
              .map((key, index) => ({ id: String(index), key }))
          })
        }
        return jsonResponse(request, 404, { errorMessages: [`unrouted: ${request.method} ${request.url}`] })
      })
    )
  )

  let attributorInFlight = 0
  const attributorLayer = Layer.succeed(SessionAttributor, {
    attribute: (requests) =>
      Effect.gen(function*() {
        for (const request of requests) {
          world.attributorRequests.push({ candidateKeys: request.candidateKeys, digest: request.digest })
        }
        world.attributorBatches.push(requests.map((request) => request.sessionId))
        attributorInFlight += 1
        world.maxAttributorInFlight = Math.max(world.maxAttributorInFlight, attributorInFlight)
        // Yield so sibling calls get a chance to start. A real call is a CLI process taking tens of
        // seconds, so overlapping is the whole point; without a suspension point here every fake
        // call would complete before the next began and the high-water mark could not tell a
        // concurrent implementation from a sequential one.
        //
        // Cooperative yielding, not `Effect.sleep`: `it.effect` runs on a TestClock that nothing
        // here advances, so a sleep would never return.
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        attributorInFlight -= 1
        const answers: Array<{ sessionId: string; choice: AttributionChoice }> = []
        for (const request of requests) {
          const answer = options.attributor?.(request) ?? { _tag: "None" }
          // A single "fail" fails the whole call, which is what a real timeout does to a batch.
          if (answer === "fail") {
            return yield* new SessionAttributorError({ message: "claude executable not found" })
          }
          answers.push({ sessionId: request.sessionId, choice: answer })
        }
        return answers
      }),
    describe: (requests) =>
      Effect.gen(function*() {
        options.beforeDescribe?.(world)
        for (const request of requests) {
          world.describeRequests.push({
            ticketKey: request.ticketKey,
            summary: request.summary,
            digest: request.digest
          })
        }
        world.describeBatches.push(requests.map((request) => request.ticketKey))
        const answers: Array<{ id: string; note: string | null }> = []
        for (const request of requests) {
          const answer = options.describer?.(request) ?? null
          // As with attribution, one "fail" fails the whole call — a timeout costs a batch.
          if (answer === "fail") {
            return yield* new SessionAttributorError({ message: "claude executable not found" })
          }
          answers.push({ id: request.id, note: answer })
        }
        return answers
      })
  })

  /**
   * A spawner that refuses to spawn.
   *
   * The Coding Agent is faked at the `SessionAttributor` seam, so nothing in these tests should
   * reach a child process — but the layer was previously left open, which typechecking would have
   * caught had this package's tests been in a tsconfig. Failing loudly beats a real `claude` process
   * starting during a test run.
   */
  const SpawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("the fake headless layer spawns no child processes"))
  )

  const HomeLayer = Layer.succeed(HomeDirectory, { path: FAKE_HOME })
  // A ledger rather than a constant: `set` is how the config commands do their whole job, so a
  // fake that discards it can only ever assert what was printed, not what was stored.
  let config: JcfConfig = { ...defaultConfig, ...options.config }
  const ConfigLayer = Layer.succeed(ConfigService, {
    get: Effect.gen(function*() {
      const snapshot = config
      if (options.delayConfigReads === true) yield* Effect.sleep("10 millis")
      return snapshot
    }),
    set: (patch) =>
      Effect.sync(() => {
        config = { ...config, ...patch }
      }),
    configDir: Effect.succeed(`${FAKE_HOME}/.jcf`)
  })
  const ClockifyAuthLayer = Layer.succeed(ClockifyAuth, {
    getConfig: Effect.succeed({
      apiKey: Redacted.make("key"),
      workspaceId: FAKE_WORKSPACE_ID,
      userId: FAKE_USER_ID,
      baseUrl: "https://api.clockify.me/api"
    }),
    save: () => Effect.void,
    isConfigured: Effect.succeed(true)
  })
  const JiraAuthLayer = Layer.succeed(JiraAuth, {
    configure: () => Effect.void,
    isConfigured: () => Effect.succeed(loggedIn()),
    login: () => Effect.void,
    logout: () => Effect.void,
    getAccessToken: () => Effect.succeed(Redacted.make(loggedIn() ? "jira-token" : "")),
    getCloudId: () => Effect.succeed(options.jiraCloudId ?? "cloud-fake"),
    getSiteUrl: () => Effect.succeed("https://fake.atlassian.net"),
    getCurrentUser: () =>
      Effect.succeed({
        account_id: options.jiraAccountId ?? FAKE_ACCOUNT_ID,
        name: "Fake User",
        email: "fake@example.com"
      }),
    getActiveProfile: () => Effect.succeed(null),
    listProfiles: () => Effect.succeed([]),
    switchProfile: () => Effect.succeed(null),
    removeProfile: () => Effect.succeed(null),
    isLoggedIn: () => Effect.succeed(loggedIn())
  })
  const StateWriterLayer = Layer.succeed(StateWriter, {
    write: () => Effect.void,
    read: Effect.succeed({
      active: false,
      ticketKey: null,
      summary: null,
      project: null,
      startedAt: null,
      startedAt_unix: null,
      elapsed: 0,
      clockifyEntryId: null
    }),
    clear: Effect.void
  })

  const ClockifyLayer = Layer.succeed(ClockifyApiClient, clockify)
  const JiraConfigLayer = Layer.succeed(JiraApiConfig, {
    baseUrl: "https://fake.atlassian.net",
    auth: { type: "basic", email: "fake@example.com", apiToken: Redacted.make("token") }
  })
  const FileSystemLayer = fakeFileSystemLayer(
    world.transcripts,
    world.transcriptReads,
    world.writtenFiles,
    options.unwritablePaths ?? [],
    options.unreadableTranscripts ?? [],
    options.afterFileWrite ?? (() => Effect.void),
    options.pidNamespaceInode
  )

  const Externals = Layer.mergeAll(
    ClockifyLayer,
    ClockifyAuthLayer,
    JiraAuthLayer,
    ConfigLayer,
    StateWriterLayer,
    HomeLayer,
    FileSystemLayer,
    NodePath.layer,
    // The CLI runner writes help and error text through Stdio; the command's own output goes
    // through the captured Console instead.
    Stdio.layerTest({}),
    httpClientLayer,
    attributorLayer,
    fakeTerminalLayer({
      keep: options.keep,
      columns: options.columns ?? DEFAULT_COLUMNS,
      beforePromptInput: options.beforePromptInput
    }, world),
    captureConsoleLayer(world),
    SpawnerLayer,
    // Mirrors HeadlessLayer: warnings must land on stderr, or they corrupt --json output.
    LogToStderrLive
  )

  // The real generated client over the routed fake HttpClient, so read decoding is exercised.
  const JiraLayer = JiraApiClient.layer.pipe(
    Layer.provide(JiraConfigLayer),
    Layer.provide(httpClientLayer)
  )

  const TimerLive = timerServiceLayer.pipe(Layer.provide(Externals))
  const SourceLedgerLive = sourceLedgerLayer.pipe(Layer.provide(Externals))
  const ReaderLive = agentSessionReaderLayer.pipe(Layer.provide(Externals))
  const ReconcileLive = reconcileServiceLayer.pipe(
    Layer.provide(Externals),
    Layer.provide(JiraLayer),
    Layer.provide(TimerLive),
    Layer.provide(ReaderLive),
    Layer.provide(SourceLedgerLive)
  )
  const SavedLive = savedEntriesLayer.pipe(Layer.provide(Externals), Layer.provide(JiraLayer))
  const TicketLive = ticketServiceLayer.pipe(Layer.provide(Externals), Layer.provide(JiraLayer))
  const IssueFactsLive = issueFactsLayer.pipe(Layer.provide(Externals), Layer.provide(JiraLayer))

  // `ReconcileService` is built from the timer, the reader and the Jira client, so those cannot sit
  // beside it in a `mergeAll` — that builds its members in parallel. They go underneath.
  const layer = Layer.mergeAll(ReconcileLive, TicketLive, IssueFactsLive, SavedLive).pipe(
    Layer.provideMerge(Layer.mergeAll(TimerLive, ReaderLive, JiraLayer, SourceLedgerLive)),
    Layer.provideMerge(Externals)
  )

  return { layer, sourceLedgerLayer: SourceLedgerLive, world }
}
