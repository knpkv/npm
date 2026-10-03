/**
 * Deriving a Usage Event's Booking from its Attribution Inputs, and mining the Active Ticket from
 * what the human typed.
 *
 * **Mental model**
 *
 * - **A Booking is computed, never stored** (ADR 0002): {@link bookingOf} is pure, so a sharper
 *   rule reaches every event already recorded, including those whose transcripts were pruned.
 * - **Branch, then path, then Active Ticket.** Naming a branch or a worktree is deliberate; a key
 *   typed into a shared session is the weakest signal and only counts when it is the only one.
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

/** Branch first, then path, then the Active Ticket; otherwise the repo. */
export const bookingOf = (inputs: AttributionInputs): Booking => {
  const key = ticketKeyFromBranch(inputs.branch) ?? ticketKeyFromPath(inputs.cwd) ?? inputs.activeTicket
  return key === null ? { _tag: "Repo", name: repoName(inputs.cwd) } : { _tag: "Ticket", key }
}

/** A stable id that keeps a ticket and a repo of the same spelling apart. */
export const bookingId = (booking: Booking): string =>
  booking._tag === "Ticket" ? `ticket:${booking.key}` : `repo:${booking.name}`

/** Blocks Claude Code wraps around context it injects into a user turn. */
const CLAUDE_INJECTED = /<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/gu

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
  return raw.replace(CLAUDE_INJECTED, "").trim()
}

/** Codex input items that are context it injected, not words the human typed. */
const CODEX_INJECTED_PREFIXES = ["# AGENTS.md instructions", "<environment_context>", "<user_instructions>"]

/** The text a human typed in one Codex `input_text` item; injected context yields "". */
export const codexHumanText = (text: string): string => {
  const trimmed = text.trim()
  return CODEX_INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ? "" : trimmed
}
