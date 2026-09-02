import {
  AgentConnectTarget,
  AgentWorkerIdentity,
  JobActor,
  JobIdentifier,
  JobPayload,
  JobStatus
} from "@knpkv/herdr-fleet/model"
import type { JobPayload as JobPayloadType, JobRecord } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const requestTextMaxLength = 16 * 1_024
const redactedInternalPrompt = "[redacted internal prompt]"
const redactedCredential = "[redacted credential]"

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

/**
 * Browser-facing job data deliberately omits canonical approval credentials,
 * integrity hashes, and terminal output. It is not a `JobRecord` substitute.
 */
export const SanitizedJobRecord = Schema.Struct({
  id: JobIdentifier,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  actor: JobActor,
  approvalExpiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  approvedBy: Schema.NullOr(JobActor),
  approvedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  rejectedBy: Schema.optionalKey(Schema.NullOr(JobActor)),
  rejectedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  expiredAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  status: JobStatus,
  payload: JobPayload,
  worker: Schema.optionalKey(AgentWorkerIdentity),
  connectTarget: Schema.optionalKey(AgentConnectTarget)
})
export type SanitizedJobRecord = typeof SanitizedJobRecord.Type

const credentialAssignment =
  /((?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key))\s*[:=]\s*)(\[redacted credential\][^\s,;]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;]+)/giu
const credentialDigestAuthorization = /((?:authorization)\s*[:=]\s*)digest\s+[^\r\n]*/giu
const credentialAuthorization =
  /((?:authorization)\s*[:=]\s*)(?:(?:bearer|basic|digest|token)\s+)?(\[redacted credential\][^\s,;]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;]+)/giu
const credentialUri = /:\/\/[^/\s]+@/gu
const safeUriQueryKeys = new Set(["branch", "ref", "revision", "sha"])

const sanitizeUriQueryParameters = (value: string): string =>
  value.replace(
    /([?&#])([^=#&\s]+)=([^&#]*)/gu,
    (match, separator: string, key: string, parameterValue: string) => {
      const sanitizedValue = safeUriQueryKeys.has(key.toLowerCase())
        ? sanitizeUriQueryParameters(parameterValue)
        : redactedCredential
      return `${separator}${key}=${sanitizedValue}`
    }
  )

const sanitizeRequestText = (value: string, maximumLength: number): string => {
  const sanitized = sanitizeUriQueryParameters(value.replace(credentialUri, "://[redacted credential]@"))
    .replace(credentialDigestAuthorization, "$1[redacted credential]")
    .replace(
      credentialAuthorization,
      (match, prefix: string, credential: string) =>
        credential === redactedCredential ? match : `${prefix}${redactedCredential}`
    )
    .replace(
      credentialAssignment,
      (match, prefix: string, credential: string) =>
        credential === redactedCredential ? match : `${prefix}${redactedCredential}`
    )
  return sanitized.length <= maximumLength
    ? sanitized
    : `${sanitized.slice(0, maximumLength - redactedCredential.length)}${redactedCredential}`
}

const field = (key: string, label: string, value: string, redacted = false): ApprovalRequestField => ({
  key,
  label,
  redacted,
  value
})

export const approvalRequestFor = (payload: JobPayloadType): ApprovalRequest => {
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
        fields: [field("ref", "Revision", sanitizeRequestText(payload.ref, 4 * 1_024))],
        kind: payload.kind,
        title: "Apply Nix configuration"
      }
    case "agent.delegate":
      return {
        fields: [
          field("mode", "Mode", payload.mode),
          field("repository", "Repository", sanitizeRequestText(payload.repository, 2 * 1_024)),
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

export const sanitizeJobPayload = (payload: JobPayloadType): JobPayloadType => {
  switch (payload.kind) {
    case "browser.mcp.recover":
    case "nix.check":
      return payload
    case "nix.apply":
      return { ...payload, ref: sanitizeRequestText(payload.ref, 4 * 1_024) }
    case "agent.delegate":
      return {
        ...payload,
        prompt: redactedInternalPrompt,
        repository: sanitizeRequestText(payload.repository, 2 * 1_024)
      }
    case "agent.message":
      return { ...payload, message: redactedInternalPrompt }
  }
}

export const sanitizeJobRecord = (record: JobRecord): SanitizedJobRecord => {
  return Object.assign(
    {
      actor: record.actor,
      approvedBy: record.approvedBy,
      createdAt: record.createdAt,
      id: record.id,
      status: record.status,
      payload: sanitizeJobPayload(record.payload),
      updatedAt: record.updatedAt
    },
    record.approvalExpiresAt === undefined ? {} : { approvalExpiresAt: record.approvalExpiresAt },
    record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt },
    record.connectTarget === undefined ? {} : { connectTarget: record.connectTarget },
    record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt },
    record.rejectedAt === undefined ? {} : { rejectedAt: record.rejectedAt },
    record.rejectedBy === undefined ? {} : { rejectedBy: record.rejectedBy },
    record.worker === undefined ? {} : { worker: record.worker }
  )
}
