/**
 * Deriving a Usage Event's Booking from its Attribution Inputs, and mining the Active Ticket from
 * what the human typed.
 *
 * **Mental model**
 *
 * - **A Booking is computed, never stored** (ADR 0002): {@link bookingOf} is pure, so a sharper
 *   rule reaches every event already recorded, including those whose transcripts were pruned.
 * - **Branch, then path, then Active Ticket.** Naming a branch or a worktree is deliberate; a key
 *   typed into a shared session is the weakest signal and only counts when it is the only one and
 *   its project is a Known Project, so `GPT-6` or `SHA-256` in a prompt books nothing.
 * - **Only the human's words count.** Agents inject instruction files and environment blocks as
 *   user-role messages, and those quote ticket-shaped examples. They are stripped before mining.
 *
 * Ported from session-counter's attribution, with jira-clockify's stricter key pattern.
 *
 * @module
 */
import { Predicate } from "effect"
import type { AttributionInputs } from "./Model.js"

/** What a Usage Event's consumption counts toward. */
export type Booking =
  | { readonly _tag: "Ticket"; readonly key: string }
  | { readonly _tag: "Repo"; readonly name: string }

/**
 * A Jira key: an uppercase letter, one to nine more uppercase alphanumerics, a dash and a number.
 * Bounded by non-alphanumerics rather than `\b`, because `_` is a word character and branch names
 * like `feature_PROJ-42_work` would otherwise match nothing.
 */
const TICKET_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![A-Za-z0-9])/g

const ticketKeys = (text: string): ReadonlyArray<string> => [...text.matchAll(TICKET_KEY)].map((match) => match[0])

/** Documentation filler: an ascending run from 1 or one repeated digit, three digits or more. */
export const isPlaceholderTicketKey = (key: string): boolean => {
  const digits = key.slice(key.lastIndexOf("-") + 1)
  if (digits.length < 3) return false
  const ascending = [...digits].every((digit, index) => digit === String((index + 1) % 10))
  const repeated = [...digits].every((digit) => digit === digits[0])
  return ascending || repeated
}

/** The first key a branch names. No placeholder filter: naming a branch is deliberate. */
export const ticketKeyFromBranch = (branch: string): string | null => ticketKeys(branch)[0] ?? null

/** The deepest key a path names, so `worktrees/PROJ-1/PROJ-2` is working on `PROJ-2`. */
export const ticketKeyFromPath = (cwd: string): string | null => ticketKeys(cwd).at(-1) ?? null

/** The one distinct non-placeholder key in typed text, or null when there are none or several. */
export const singleTicket = (text: string): string | null => {
  const distinct = [...new Set(ticketKeys(text).filter((key) => !isPlaceholderTicketKey(key)))]
  return distinct.length === 1 ? distinct[0] ?? null : null
}

/** True when typed text names any non-placeholder key, even ambiguously. */
export const namesTickets = (text: string): boolean => ticketKeys(text).some((key) => !isPlaceholderTicketKey(key))

/**
 * The repo a working directory belongs to. Worktrees live at `…/worktrees/<repo>/<branch>`, so
 * that segment wins; otherwise the last path segment.
 */
export const repoName = (cwd: string): string => {
  const worktree = /\/worktrees\/([^/]+)\//u.exec(cwd)?.[1]
  if (worktree !== undefined) return worktree
  const base = cwd.split("/").filter((segment) => segment !== "").at(-1)
  return base ?? "unknown"
}

/** The project a key belongs to: `RPS` for `RPS-7071`. */
export const projectOf = (key: string): string => key.slice(0, key.lastIndexOf("-"))

/**
 * The Known Projects: every project a branch or worktree path has named, plus the configured ones.
 * Naming a branch is deliberate, so those keys vouch for their project.
 */
export const knownProjects = (
  places: Iterable<{ readonly branch: string; readonly cwd: string }>,
  configured: Iterable<string>
): ReadonlySet<string> => {
  const projects = new Set(configured)
  for (const place of places) {
    for (const key of [ticketKeyFromBranch(place.branch), ticketKeyFromPath(place.cwd)]) {
      if (key !== null) projects.add(projectOf(key))
    }
  }
  return projects
}

/** A Usage Event's Booking, and the typed key it set aside, if any. */
export interface Attribution {
  readonly booking: Booking
  /** An Active Ticket whose project is not a Known Project: `GPT-6`, `SHA-256`. */
  readonly ignoredKey: string | null
}

/**
 * Branch first, then path, then the Active Ticket when its project is known; otherwise the repo.
 * Branch and path keys are trusted as they are; only typed text is checked against the projects.
 */
export const attribute = (inputs: AttributionInputs, projects: ReadonlySet<string>): Attribution => {
  const deliberate = ticketKeyFromBranch(inputs.branch) ?? ticketKeyFromPath(inputs.cwd)
  if (deliberate !== null) return { booking: { _tag: "Ticket", key: deliberate }, ignoredKey: null }
  const typed = inputs.activeTicket
  if (typed !== null && projects.has(projectOf(typed))) {
    return { booking: { _tag: "Ticket", key: typed }, ignoredKey: null }
  }
  return { booking: { _tag: "Repo", name: repoName(inputs.cwd) }, ignoredKey: typed }
}

/** A stable id that keeps a ticket and a repo of the same spelling apart. */
export const bookingId = (booking: Booking): string =>
  booking._tag === "Ticket" ? `ticket:${booking.key}` : `repo:${booking.name}`

/**
 * Blocks Claude Code wraps around context it injects into a user turn. `command-args` is not one:
 * it is what the human typed after a slash command, so only its tags are removed.
 */
const CLAUDE_INJECTED = /<(system-reminder|command-name|command-message|local-command-[a-z-]+)>[\s\S]*?<\/\1>/gu
const COMMAND_ARGS_TAG = /<\/?command-args>/gu

/** A Claude user turn's content: a string, or blocks of which only `text` blocks are typed words. */
export type ClaudeContent = string | ReadonlyArray<{ readonly type: string; readonly text?: string | undefined }>

/**
 * The text a human typed into one Claude user turn: string content or `text` blocks, with tool
 * results and injected reminder/command blocks removed.
 */
export const claudeHumanText = (content: ClaudeContent): string => {
  const raw = Predicate.isString(content)
    ? content
    : content.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join("\n")
  return raw.replace(CLAUDE_INJECTED, "").replace(COMMAND_ARGS_TAG, " ").trim()
}

/** Codex input items that are context it injected, not words the human typed. */
const CODEX_INJECTED_PREFIXES = ["# AGENTS.md instructions", "<environment_context>", "<user_instructions>"]

/** Reminder blocks the harness wraps around context it adds to a Codex user item. */
const CODEX_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu

/** The text a human typed in one Codex `input_text` item; injected context yields "". */
export const codexHumanText = (text: string): string => {
  const trimmed = text.replace(CODEX_REMINDER, "").trim()
  return CODEX_INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ? "" : trimmed
}
