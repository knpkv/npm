/** Safe display derivation at the host-local read boundary. No provider locator is returned. @module */
import type { CachedPullRequest } from "@knpkv/codecommit-core/CacheService/repos/PullRequestRepo/internal.js"
import { type Approval, approvalOf } from "@knpkv/codecommit-core/Domain.js"
import { Option, Schema, SchemaGetter } from "effect"
import type { CodePullRequest, CodeReference } from "../host-contract.js"

const DisplayAuthorFromArn = Schema.String.check(Schema.isPattern(
  /^arn:(?:aws|aws-cn|aws-us-gov):(?:iam|sts)::[0-9]{12}:(?:user\/[^\s]+|assumed-role\/[^/\s]+\/[^/\s]+)$/
)).pipe(Schema.decodeTo(Schema.String, {
  decode: SchemaGetter.transform((value) => value.slice(value.lastIndexOf("/") + 1)),
  encode: SchemaGetter.forbiddenEncoding
}))
const decodeAuthor = Schema.decodeUnknownResult(DisplayAuthorFromArn)

export const codeDisplayAuthor = (raw: string): string => {
  const author = raw.trim()
  if (!author.startsWith("arn:")) return author.slice(0, 256)
  const decoded = decodeAuthor(author)
  return decoded._tag === "Success" ? decoded.success.slice(0, 256) : "Unknown author"
}

/** Approval is the cached reading, not a new evaluation; unknown never becomes passed. */
const decodeObservedAt = Schema.decodeUnknownOption(Schema.DateFromString)

const approvalState = {
  Approved: "approved",
  NotRequired: "not_required",
  Pending: "waiting",
  Unknown: "unknown"
} satisfies Record<Approval["_tag"], CodePullRequest["approval"]>

export const codePullRequest = (row: CachedPullRequest, ref: CodeReference): CodePullRequest => ({
  ref,
  id: row.id,
  repository: row.repositoryName,
  title: row.title.slice(0, 4096),
  author: codeDisplayAuthor(row.author),
  status: row.status,
  approval: !row.approvalBaselineKnown || row.approvalUnknownReason !== null
    ? "unknown" :
    approvalState[approvalOf(row)._tag],
  createdAt: row.creationDate.getTime(),
  updatedAt: row.lastModifiedDate.getTime(),
  observedAt: Option.map(decodeObservedAt(row.fetchedAt), (value) => value.getTime()).pipe(Option.getOrNull)
})
