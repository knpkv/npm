import type { JobPayload, JobRecord } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const requestTextMaxLength = 16 * 1_024
const redactedInternalPrompt = "[redacted internal prompt]"
const redactedCredential = "[redacted credential]"

export const redactedJobHash = "0".repeat(64)

const requestText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(requestTextMaxLength)
)

export const ApprovalRequestField = Schema.Struct({
  key: requestText,
  label: requestText,
  redacted: Schema.Boolean,
  value: requestText
})
export type ApprovalRequestField = typeof ApprovalRequestField.Type

export const ApprovalRequest = Schema.Struct({
  fields: Schema.Array(ApprovalRequestField),
  kind: requestText,
  title: requestText
})
export type ApprovalRequest = typeof ApprovalRequest.Type

const credentialAssignment =
  /((?:password|passwd|secret|token|credential|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu
const credentialUri = /:\/\/[^/\s:@]+(?::[^/\s@]*)?@/gu

const sanitizeRequestText = (value: string): string =>
  value
    .replace(credentialUri, "://[redacted credential]@")
    .replace(credentialAssignment, `$1${redactedCredential}`)

const field = (key: string, label: string, value: string, redacted = false): ApprovalRequestField => ({
  key,
  label,
  redacted,
  value
})

export const approvalRequestFor = (payload: JobPayload): ApprovalRequest => {
  switch (payload.kind) {
    case "browser.mcp.recover":
      return {
        fields: [],
        kind: payload.kind,
        title: "Recover browser MCP"
      }
    case "nix.check":
      return {
        fields: [],
        kind: payload.kind,
        title: "Check Nix configuration"
      }
    case "nix.apply":
      return {
        fields: [field("ref", "Revision", sanitizeRequestText(payload.ref))],
        kind: payload.kind,
        title: "Apply Nix configuration"
      }
    case "agent.delegate":
      return {
        fields: [
          field("mode", "Mode", payload.mode),
          field("repository", "Repository", sanitizeRequestText(payload.repository)),
          ...(payload.channel === undefined ? [] : [field("channel", "Channel", payload.channel)]),
          field("prompt", "Prompt", redactedInternalPrompt, true)
        ],
        kind: payload.kind,
        title: payload.mode === "consult" ? "Ask the coordinator" : "Delegate agent work"
      }
    case "agent.message":
      return {
        fields: [
          field("session", "Agent session", payload.session),
          field("message", "Message", redactedInternalPrompt, true)
        ],
        kind: payload.kind,
        title: "Message an agent"
      }
  }
}

export const sanitizeJobPayload = (payload: JobPayload): JobPayload => {
  switch (payload.kind) {
    case "browser.mcp.recover":
    case "nix.check":
      return payload
    case "nix.apply":
      return { ...payload, ref: sanitizeRequestText(payload.ref) }
    case "agent.delegate":
      return {
        ...payload,
        prompt: redactedInternalPrompt,
        repository: sanitizeRequestText(payload.repository)
      }
    case "agent.message":
      return { ...payload, message: redactedInternalPrompt }
  }
}

export const sanitizeJobRecord = (record: JobRecord): JobRecord => ({
  ...record,
  approvalNonce: null,
  error: null,
  hash: redactedJobHash,
  payload: sanitizeJobPayload(record.payload),
  result: null
})
