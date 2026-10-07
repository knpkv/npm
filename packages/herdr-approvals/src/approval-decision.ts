/**
 * One approval decision and its keyboard shortcuts, shared by the host dashboard and the
 * Approvals countdown.
 *
 * @module
 */

export type ApprovalDecision = {
  readonly decision: "approve" | "reject"
  readonly jobId: string
}

/** Ctrl/Cmd+Enter approves, Ctrl/Cmd+Shift+Backspace rejects; anything else is not a decision. */
export const approvalShortcutFor = ({
  key,
  modified,
  shift
}: {
  readonly key: string
  readonly modified: boolean
  readonly shift: boolean
}): ApprovalDecision["decision"] | null => {
  if (!modified) return null
  if (key === "Enter" && !shift) return "approve"
  if (key === "Backspace" && shift) return "reject"
  return null
}
