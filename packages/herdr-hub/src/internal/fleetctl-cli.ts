/**
 * How `fleetctl` reads its first arguments: help, a known command, or a usage mistake. Pure, so it
 * runs before any configuration is loaded: `fleetctl --help` works on a machine with no fleet config.
 *
 * @module
 */
import {
  FleetValidationError,
  JobPayload,
  type JobRecord,
  WorkAbandon,
  WorkAdmit,
  type WorkJobKind,
  WorkReassign,
  WorkReconcile,
  WorkRecover
} from "@knpkv/herdr-fleet"
import { Data, Effect, Predicate, Schema, SchemaIssue } from "effect"

/** Makes field-supplied terminal controls visible without changing ordinary Unicode text. */
const terminalText = (value: string): string =>
  value.replace(/\p{Cc}/gu, (character) => {
    switch (character) {
      case "\n":
        return "\\n"
      case "\r":
        return "\\r"
      case "\t":
        return "\\t"
      default:
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    }
  })

/** The terminal-safe New Work line shared by job, follow, and pending-submit output. */
export const formatNewWorkGoal = (payload: JobRecord["payload"]): string | null => {
  if (payload.kind !== "agent.delegate" || payload.newWork === undefined) return null
  return `New Work goal: ${terminalText(payload.repository)}@${terminalText(payload.newWork.branch)} — ${
    terminalText(payload.newWork.title)
  }`
}

/** Raw job output retains terminal errors; delegation also names the proposed Work goal. */
export const formatJobRecord = (record: JobRecord, approvalUrl?: string): string => {
  const body = approvalUrl === undefined ? record : { ...record, approvalUrl }
  const value = JSON.stringify(body, null, 2).split("\n").map(terminalText).join("\n")
  const newWork = formatNewWorkGoal(record.payload)
  return newWork === null ? value : `${value}\n${newWork}`
}

const workLines = [
  "  work record HOST CHECKPOINT_JSON",
  "  work snapshot [HOST]",
  "  work admission-preflight HOST TARGET_JSON",
  "  work recovery-preflight HOST TARGET_JSON",
  "  work recovery-context HOST GOAL_ID"
]

/** Every command with its arguments, as `fleetctl --help` prints it. */
export const usage = [
  "Usage: fleetctl COMMAND [ARGS]",
  "",
  "Commands:",
  "  hosts",
  "  status HOST",
  "  history HOST [LIMIT]",
  "  job HOST ID",
  "  follow HOST ID",
  "  submit HOST nix.check",
  "  submit HOST nix.apply REF",
  "  submit HOST agent.delegate (consult|transition_summary|review|work) REPOSITORY PROMPT...",
  "  submit HOST agent.message SESSION MESSAGE...",
  "  submit HOST work.reconcile PAYLOAD_JSON",
  "  submit HOST work.admit PAYLOAD_JSON",
  "  submit HOST work.recover PAYLOAD_JSON",
  "  submit HOST work.reassign PAYLOAD_JSON",
  "  submit HOST work.abandon PAYLOAD_JSON",
  ...workLines,
  "  apply-everywhere REF",
  "",
  "Run fleetctl work --help for the work operations alone."
].join("\n")

/** The `work` subcommands only, for `fleetctl work --help`. */
export const workUsage = ["Usage: fleetctl work OPERATION [ARGS]", "", "Operations:", ...workLines].join("\n")

/** A command line `fleetctl` cannot run: a one-line reason, then the usage that applies. */
export class FleetctlUsageError extends Data.TaggedError("FleetctlUsageError")<{
  readonly reason: string
  readonly usage: string
}> {}

/** What the process should print to stderr for a usage mistake: the cause on one line, then usage. */
export const formatUsageError = (error: FleetctlUsageError): string =>
  `fleetctl: ${oneLine(error.reason)}\n\n${error.usage}`

const commands = new Set(["hosts", "status", "history", "job", "follow", "submit", "work", "apply-everywhere"])

/** Help to print and exit 0, or a command to run. */
export type Invocation =
  | { readonly _tag: "Help"; readonly text: string }
  | { readonly _tag: "Run"; readonly command: string; readonly rest: ReadonlyArray<string> }

const isHelpFlag = (argument: string) => argument === "--help" || argument === "-h"

/** Classify the arguments before anything else runs; an unknown or missing command is a usage error. */
export const parseInvocation = (args: ReadonlyArray<string>): Invocation | FleetctlUsageError => {
  const [command, ...rest] = args
  if (command === undefined) return new FleetctlUsageError({ reason: "missing command", usage })
  if (command === "help" || isHelpFlag(command)) {
    return { _tag: "Help", text: rest[0] === "work" ? workUsage : usage }
  }
  if (!commands.has(command)) return new FleetctlUsageError({ reason: `unknown command "${command}"`, usage })
  // Only right after the command: a later "-h" may be part of an agent prompt or message.
  if (rest[0] !== undefined && isHelpFlag(rest[0])) {
    return { _tag: "Help", text: command === "work" ? workUsage : usage }
  }
  const missing = missingArguments(command, rest)
  if (missing !== null) return new FleetctlUsageError({ reason: `${command} needs ${missing}`, usage })
  return { _tag: "Run", command, rest }
}

/** Arguments a command cannot run without, checked before any configuration is read. */
const missingArguments = (command: string, rest: ReadonlyArray<string>): string | null => {
  switch (command) {
    case "follow":
    case "job":
      return rest.length < 2 ? "HOST and ID" : null
    case "submit":
      return rest.length < 2 ? "HOST and a job kind" : null
    case "apply-everywhere":
      return rest.length < 1 ? "REF" : null
    default:
      return null
  }
}

/** Job kinds `fleetctl submit HOST KIND` accepts, in the order the usage lists them. */
export const jobKinds: ReadonlyArray<string> = [
  "nix.check",
  "nix.apply",
  "agent.delegate",
  "agent.message",
  "work.reconcile",
  "work.admit",
  "work.recover",
  "work.reassign",
  "work.abandon"
]

/** One line naming the unknown host and the hosts this machine knows. */
export const unknownHostDetail = (target: string, hosts: ReadonlyArray<string>): string =>
  hosts.length === 0
    ? `unknown host "${target}"; this machine knows no fleet hosts (check the fleet configuration)`
    : `unknown host "${target}"; known hosts: ${hosts.join(", ")} (run fleetctl hosts to see which are online)`

/** One line naming the unknown job kind and the kinds that exist. */
export const unknownKindDetail = (kind: string | undefined): string =>
  kind === undefined || kind === ""
    ? `submit needs a job kind; kinds: ${jobKinds.join(", ")}`
    : `unknown job kind "${kind}"; kinds: ${jobKinds.join(", ")}`

/** Any error detail as one line: decoder messages span several lines, a terminal error should not. */
export const oneLine = (detail: string): string => detail.trim().replace(/\s*\n\s*/gu, "; ")

/**
 * The one JSON payload a `work.*` command takes. Its `kind` may be left out and is the command's own;
 * any other problem is reported in one line naming each failing field and what it expected.
 */
export const workPayload = Effect.fn("Fleetctl.workPayload")(function*(kind: WorkJobKind, args: ReadonlyArray<string>) {
  const body = args[1]
  if (args.length !== 2 || body === undefined) {
    return yield* new FleetValidationError({ detail: `${kind} requires one JSON payload` })
  }
  const fields = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PayloadObject))(body).pipe(
    Effect.mapError(() => new FleetValidationError({ detail: `${kind} payload is not a JSON object` }))
  )
  if (Predicate.hasProperty(fields, "kind") && fields["kind"] !== kind) {
    return yield* new FleetValidationError({ detail: `${kind} payload kind does not match the command` })
  }
  const failed = (error: Schema.SchemaError) =>
    new FleetValidationError({ detail: `${kind} payload: ${describeIssue(error.issue)}` })
  // This command's own schema first, reporting every problem; then the job union the server takes.
  yield* Schema.decodeUnknownEffect(workSchemas[kind], { onExcessProperty: "error", errors: "all" })({
    ...fields,
    kind
  }).pipe(Effect.mapError(failed))
  return yield* Schema.decodeUnknownEffect(JobPayload, { onExcessProperty: "error" })({ ...fields, kind }).pipe(
    Effect.mapError(failed)
  )
})

const PayloadObject = Schema.Record(Schema.String, Schema.Unknown)

const workSchemas = {
  "work.reconcile": WorkReconcile,
  "work.admit": WorkAdmit,
  "work.recover": WorkRecover,
  "work.reassign": WorkReassign,
  "work.abandon": WorkAbandon
} satisfies Record<WorkJobKind, Schema.Top>

/** `targetGoal: Missing key; reason: Expected string, got 3`: each failing field and what it expected. */
const describeIssue = (issue: SchemaIssue.Issue): string =>
  SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues
    .map(({ message, path }) => {
      const at = (path ?? []).map((segment) => String(Predicate.hasProperty(segment, "key") ? segment.key : segment))
      return `${at.length === 0 ? "" : `${at.join(".")}: `}${message.replaceAll(/\s+/gu, " ")}`
    })
    .join("; ")
