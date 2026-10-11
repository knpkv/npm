import type {
  CodeDetail,
  CodeDiffContentResult,
  CodeDiffResult,
  CodePullRequest,
  CodeQueue,
  CodeQueueQuery,
  CodeUnavailable
} from "@knpkv/codecommit-web/host"

export const CODE_REF = "00000000-0000-4000-8000-000000000001"
export const CODE_OTHER_REF = "00000000-0000-4000-8000-000000000002"
const unavailable = (state: string): CodeUnavailable | null => {
  const reason = state === "permission"
    ? "permission_required"
    : state === "signin"
    ? "sign_in_required"
    : state === "unavailable"
    ? "cache_unavailable"
    : state === "otherhost"
    ? "other_host"
    : null
  return reason === null ? null : { _tag: "Unavailable", reason, host: state === "otherhost" ? "cedar" : null }
}
export const codeItems = (now: number, state: string): ReadonlyArray<CodePullRequest> => [
  {
    ref: CODE_REF,
    id: "752",
    repository: state === "long" ? "r".repeat(256) : "storefront",
    title: state === "long"
      ? "A readable title with ordinary words ".repeat(130).slice(0, 4096)
      : "Make the queue reading explicit",
    author: state === "long" ? "Example author ".repeat(20).slice(0, 256) : "Example author",
    status: "OPEN",
    approval: "waiting",
    createdAt: now - 86_400_000,
    updatedAt: state === "changed" ? now : now - 600_000,
    observedAt: now - 480_000
  },
  {
    ref: CODE_OTHER_REF,
    id: "748",
    repository: "catalog",
    title: "Keep the file reader bounded",
    author: "Example reviewer",
    status: "OPEN",
    approval: "unknown",
    createdAt: now - 172_800_000,
    updatedAt: now - 1_200_000,
    observedAt: now - 480_000
  }
]
export const codeQueueFixture = (query: CodeQueueQuery, now: number, state: string): CodeQueue =>
  unavailable(state) ??
    {
      _tag: "Ready",
      observedAt: now,
      more: false,
      items: state === "empty" ? [] : codeItems(now, state)
        .filter((item) =>
          (query.filter !== "reviews" || item.approval === "waiting") &&
          `${item.title} ${item.repository}`.toLowerCase().includes(query.search.toLowerCase())
        ).slice(query.offset, query.offset + 50)
    }
export const codeDetailFixture = (ref: string, now: number, state: string): CodeDetail | null => {
  const failure = unavailable(state)
  if (failure !== null) return failure
  const item = codeItems(now, state).find((item) => item.ref === ref)
  return item === undefined ?
    null :
    {
      _tag: "Ready",
      item,
      description: "Cached description. <script> remains text, never markup.",
      sourceBranch: state === "long" ? "feature/" + "b".repeat(248) : "feature/reading",
      destinationBranch: "main"
    }
}
export const codeDiffFixture = (ref: string, now: number, state: string): CodeDiffResult | null => {
  const failure = unavailable(state)
  if (failure !== null) return failure
  const item = codeItems(now, state).find((item) => item.ref === ref)
  return item === undefined ?
    null :
    {
      _tag: "Ready",
      diff: {
        pullRequestId: item.id,
        revisionId: `revision-${item.id}`,
        baseCommit: "base-commit",
        headCommit: "head-commit",
        readAt: now,
        cacheUpdatedAt: item.updatedAt,
        files: [
          {
            index: 0,
            path: state === "long" ? "src/" + "p".repeat(4092) : "src/reading.ts",
            previousPath: null,
            status: "modified",
            beforeMode: "100644",
            afterMode: "100644"
          },
          {
            index: 1,
            path: "src/bounds.ts",
            previousPath: null,
            status: "added",
            beforeMode: null,
            afterMode: "100644"
          }
        ]
      }
    }
}
export const codeContentFixture = (index: number, revisionId: string, state: string): CodeDiffContentResult =>
  unavailable(state) ??
    {
      _tag: "Ready",
      content: {
        fileIndex: index,
        revisionId,
        state: "text",
        before: index === 0 ? "export const reading = 'previous'\n" : null,
        after: state === "large"
          ? "line\n".repeat(2_001)
          : index === 0
          ? "export const reading = 'explicit'\n"
          : "export const bound = 100\n"
      }
    }
