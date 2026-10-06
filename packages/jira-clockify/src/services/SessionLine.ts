/**
 * One transcript line reduced to what presence accounting needs, shared by every Coding Agent's
 * adapter so the supervised-turn rules live in one segmenter.
 *
 * @module
 */

/**
 * What a line says about whether the person was present.
 *
 * - `prompt` — the person typed it (including a message queued while the agent was busy). Opens a
 *   supervised turn and always counts.
 * - `work` — the agent working: output, tool results, completed items. Counts only inside an open
 *   supervised turn, and keeps it open.
 * - `turn-end` — the agent's last word in a turn. Counts inside an open turn, then closes it.
 * - `machine` — a turn nobody typed: a task notification or an auto-continuation. Closes the turn
 *   and never counts.
 * - `context` — metadata such as a Codex turn context. Carries directory changes, never counts.
 */
export type Presence = "prompt" | "work" | "turn-end" | "machine" | "context"

export interface SessionLine {
  readonly sessionId: string
  readonly cwd: string
  readonly gitBranch: string | null
  readonly atMs: number
  /** Readable text for ticket mining and the digest; `""` when the line carries none. */
  readonly text: string
  readonly presence: Presence
}
