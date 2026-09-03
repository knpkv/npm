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
  approvalAvailable: Schema.Boolean,
  payload: JobPayload,
  worker: Schema.optionalKey(AgentWorkerIdentity),
  connectTarget: Schema.optionalKey(AgentConnectTarget),
  workerTerminalObservedAt: Schema.optionalKey(Schema.NullOr(Schema.Number))
})
export type SanitizedJobRecord = typeof SanitizedJobRecord.Type

const credentialAssignment =
  /((?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key))\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*$|'(?:\\[\s\S]|[^'\\])*$|(?:\[redacted credential\]|[^\s,;]|[,;](?!\s*(?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key))\s*[:=]))+)/giu
const quotedCredentialAssignment =
  /((?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*$|'(?:\\[\s\S]|[^'\\])*$)/giu
const whitespaceCredentialAssignment =
  /((?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key))\s*[:=]\s*)(?!\[redacted credential\])([\s\S]*?)(?=(?:[,;]\s*[a-z0-9]+(?:[_-][a-z0-9]+)*\s*[:=]|$))/giu
const privateKeyMaterial =
  /-----BEGIN (?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY(?: BLOCK)?-----|$)/giu
const credentialDigestAuthorization = /((?:authorization)\s*[:=]\s*)digest\s+[^\r\n]*/giu
const credentialAuthorization =
  /((?:authorization)\s*[:=]\s*)((?:(?:[a-z][a-z\d+.-]*\s+)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|[^\r\n]+))/giu
const credentialUri = /(^|[^\w])\/\/[^/?#]*@/gu
const encodedCredentialAssignment =
  /((?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key))%(?:25){0,2}(?:3d|3a))([^/?#\s&]*)/giu
const safeUriQueryKeys = new Set(["branch", "ref", "revision", "sha"])
const encodedUriPrefix = /^(?:[a-z][a-z\d+.-]*%3a)?%2f%2f/iu
const encodedUriAuthorityBoundary = /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/)[^/?#\s]*%(?:25){0,2}2f/iu
const uriPrefix = /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/iu
const encodedUriMaxDepth = 3
const hasMalformedPercentEscape = (value: string): boolean => /%(?![0-9a-f]{2})/iu.test(value)
const credentialKey =
  /^(?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key))$/iu

const decodeCredentialKey = (value: string): string =>
  value.replace(/\\u([0-9a-f]{4})/giu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))

type EncodedText =
  | { readonly _tag: "encoded"; readonly value: string; readonly layers: number }
  | { readonly _tag: "malformed" | "overflow" }

const decodeEncodedRuns = (value: string): { readonly value: string; readonly hadDecodeError: boolean } | undefined => {
  let changed = false
  let hadDecodeError = false
  const decoded = value.replace(/(?:%[0-9a-f]{2})+/giu, (escaped) => {
    try {
      const decodedRun = decodeURIComponent(escaped)
      if (decodedRun !== escaped) changed = true
      return decodedRun
    } catch {
      hadDecodeError = true
      return escaped
    }
  })
  return changed ? { hadDecodeError, value: decoded } : undefined
}

const encodedText = (value: string): EncodedText | undefined => {
  if (!value.includes("%")) return undefined
  let candidate = value
  for (let layers = 1; layers <= encodedUriMaxDepth; layers += 1) {
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return { _tag: "malformed" }
      candidate = decoded
    } catch {
      const partiallyDecoded = decodeEncodedRuns(candidate)
      if (partiallyDecoded !== undefined) {
        if (partiallyDecoded.hadDecodeError) return { _tag: "malformed" }
        candidate = partiallyDecoded.value
        continue
      }
      if (layers > 1 && /%(?![0-9a-f]{2})/iu.test(candidate)) {
        return { _tag: "encoded", layers: layers - 1, value: candidate }
      }
      return { _tag: "malformed" }
    }
    if (!candidate.includes("%")) return { _tag: "encoded", layers, value: candidate }
  }
  return { _tag: "overflow" }
}

const reencodeText = (value: string, layers: number): string | undefined => {
  let encoded = value
  try {
    for (let layer = 0; layer < layers; layer += 1) {
      encoded = encodeURIComponent(encoded)
    }
    return encoded
  } catch {
    return undefined
  }
}

const sanitizeCredentialText = (value: string): string =>
  value
    .replace(privateKeyMaterial, redactedCredential)
    .replace(credentialDigestAuthorization, "$1[redacted credential]")
    .replace(
      credentialAuthorization,
      (match, prefix: string, credential: string) =>
        credential.trim() === redactedCredential ? match : `${prefix}${redactedCredential}`
    )
    .replace(
      quotedCredentialAssignment,
      (_match, prefix: string, doubleKey: string | undefined, singleKey: string | undefined, credential: string) => {
        const key = decodeCredentialKey(doubleKey ?? singleKey ?? "")
        if (!credentialKey.test(key)) return _match
        const quote = credential.startsWith("'") ? "'" : "\""
        return `${prefix}${quote}${redactedCredential}${quote}`
      }
    )
    .replace(
      whitespaceCredentialAssignment,
      (_match, prefix: string) => `${prefix}${redactedCredential}`
    )
    .replace(
      credentialAssignment,
      (match, prefix: string, credential: string) =>
        credential === redactedCredential ? match : `${prefix}${redactedCredential}`
    )

const sanitizeEncodedCredentialAssignments = (value: string): string =>
  value.replace(encodedCredentialAssignment, (match) => {
    const encoded = encodedText(match)
    if (encoded?._tag !== "encoded") {
      return redactedCredential
    }
    let sanitized = sanitizeCredentialText(encoded.value)
    for (let layer = 0; layer < encoded.layers; layer += 1) {
      sanitized = encodeURIComponent(sanitized)
    }
    return sanitized
  })

const httpSchemePrefix = /^(https?):[\\/]{1,}/iu
const uriAuthority = /^((?:[a-z][a-z\d+.-]*:\/\/|\/\/))([^/?#\s]*)([\s\S]*)$/iu

const normalizeHttpSchemeSeparators = (value: string): string => {
  if (!httpSchemePrefix.test(value)) return value
  return value.replace(httpSchemePrefix, (_match, scheme: string) => `${scheme}://`).replaceAll("\\", "/")
}

const sanitizeDecodedAuthority = (value: string): string => {
  const at = value.lastIndexOf("@")
  return at < 0 ? sanitizeCredentialText(value) : `${redactedCredential}@${value.slice(at + 1)}`
}

const sanitizeUriAuthority = (value: string): string => {
  const match = uriAuthority.exec(value)
  if (match === null) return value
  const prefix = match[1]
  const authority = match[2]
  const suffix = match[3]
  if (prefix === undefined || authority === undefined || suffix === undefined) return redactedCredential

  const encoded = encodedText(authority)
  if (encoded === undefined) return `${prefix}${sanitizeDecodedAuthority(authority)}${suffix}`
  if (encoded._tag !== "encoded") return `${prefix}${redactedCredential}${suffix}`

  const sanitized = sanitizeDecodedAuthority(encoded.value)
  if (sanitized === encoded.value) {
    return hasMalformedPercentEscape(authority) || reencodeText(encoded.value, encoded.layers) === undefined
      ? `${prefix}${redactedCredential}${suffix}`
      : `${prefix}${authority}${suffix}`
  }
  if (hasMalformedPercentEscape(authority)) return `${prefix}${redactedCredential}${suffix}`
  return `${prefix}${reencodeText(sanitized, encoded.layers) ?? redactedCredential}${suffix}`
}

const uriAuthorityAndPath = /^((?:[a-z][a-z\d+.-]*:\/\/|\/\/)[^/?#\s]*)(\/[^?#\s]*)?/iu

const sanitizeEncodedPathSegment = (value: string): string => {
  const encoded = encodedText(value)
  if (encoded === undefined) return sanitizeCredentialText(value)
  if (encoded._tag !== "encoded") return redactedCredential
  const sanitized = sanitizeDecodedUri(encoded.value)
  if (sanitized === encoded.value) {
    return hasMalformedPercentEscape(value) || reencodeText(encoded.value, encoded.layers) === undefined
      ? redactedCredential
      : value
  }
  if (hasMalformedPercentEscape(value)) return redactedCredential
  return reencodeText(sanitized, encoded.layers) ?? redactedCredential
}

const sanitizeEncodedUriPath = (value: string): string =>
  value.replace(
    uriAuthorityAndPath,
    (match, authority: string, path: string | undefined) =>
      path === undefined ? match : `${authority}${path.split("/").map(sanitizeEncodedPathSegment).join("/")}`
  )

const sanitizeEncodedUri = (value: string): string => {
  const normalized = normalizeHttpSchemeSeparators(value)
  const encodedUri = uriPrefix.test(normalized)
  if (encodedUri && !encodedUriAuthorityBoundary.test(normalized)) return sanitizeDecodedUri(normalized)
  const authoritySanitized = encodedUri ? sanitizeUriAuthority(normalized) : normalized
  const encoded = encodedText(authoritySanitized)
  if (encoded === undefined) return sanitizeDecodedUri(value)
  if (encoded._tag !== "encoded") return redactedCredential
  try {
    const sanitized = sanitizeDecodedUri(encoded.value)
    if (sanitized === encoded.value) {
      return reencodeText(encoded.value, encoded.layers) === undefined
        ? redactedCredential
        : authoritySanitized
    }
    if (hasMalformedPercentEscape(normalized)) return redactedCredential
    return reencodeText(sanitized, encoded.layers) ?? redactedCredential
  } catch {
    return redactedCredential
  }
}

const sanitizeDecodedUri = (value: string): string =>
  sanitizeEncodedCredentialAssignments(
    sanitizeEncodedUriPath(
      sanitizeCredentialText(sanitizeUriQueryParameters(sanitizeUriAuthority(normalizeHttpSchemeSeparators(value))))
    )
  )

const sanitizeUriQueryParameters = (value: string): string => {
  if (encodedUriPrefix.test(value)) return sanitizeEncodedUri(value)
  const sanitizedUserInfo = value.replace(
    credentialUri,
    (_match, prefix: string) => `${prefix}//[redacted credential]@`
  )
  return sanitizedUserInfo.replace(
    /([?&#])([^=#&\s]+)=([^&#]*)/gu,
    (_match, separator: string, key: string, parameterValue: string) => {
      const sanitizedValue = safeUriQueryKeys.has(key.toLowerCase())
        ? sanitizeEncodedUri(parameterValue)
        : redactedCredential
      return `${separator}${key}=${sanitizedValue}`
    }
  )
}

const sanitizeRequestText = (value: string, maximumLength: number): string => {
  const sanitized = uriPrefix.test(value) || httpSchemePrefix.test(value) || encodedUriPrefix.test(value)
    ? sanitizeEncodedUri(value)
    : encodedText(value) === undefined
    ? sanitizeCredentialText(sanitizeUriQueryParameters(value))
    : sanitizeEncodedUri(value)
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
      approvalAvailable: record.status === "pending_approval" && record.approvalNonce !== null,
      payload: sanitizeJobPayload(record.payload),
      updatedAt: record.updatedAt
    },
    record.approvalExpiresAt === undefined ? {} : { approvalExpiresAt: record.approvalExpiresAt },
    record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt },
    record.connectTarget === undefined ? {} : { connectTarget: record.connectTarget },
    record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt },
    record.rejectedAt === undefined ? {} : { rejectedAt: record.rejectedAt },
    record.rejectedBy === undefined ? {} : { rejectedBy: record.rejectedBy },
    record.worker === undefined ? {} : { worker: record.worker },
    record.workerTerminalObservedAt === undefined
      ? {}
      : { workerTerminalObservedAt: record.workerTerminalObservedAt }
  )
}
