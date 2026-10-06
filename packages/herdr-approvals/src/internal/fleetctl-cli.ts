/**
 * How `fleetctl` reads its first arguments: help, a known command, or a usage mistake. Pure, so it
 * runs before any configuration is loaded: `fleetctl --help` works on a machine with no fleet config.
 *
 * @module
 */
import { Data } from "effect"

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
export const formatUsageError = (error: FleetctlUsageError): string => `fleetctl: ${error.reason}\n\n${error.usage}`

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
