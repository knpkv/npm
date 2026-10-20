/** Synthetic read inputs shared by reference and live capture. No provider or write authority. @module */
import {
  CodeCommitSummaryResult,
  CodeDetail,
  CodeDiffContentResult,
  CodeQueue,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { WorkSnapshots } from "@knpkv/herdr-work/model"
import { BackendStatus, RelayEvent, SessionInfo } from "@knpkv/relay/wire"
import { Schema } from "effect"
import type { Fixture } from "../../../design-conformance/src/schema.js"
import { FleetLimits } from "../../../herdr-connect/src/limits.js"
import { FleetConnectAgentPage } from "../../../herdr-connect/src/model.js"
import { FleetUsage } from "../../../herdr-connect/src/usage.js"
import { BlockedPushSettings } from "../../src/blocked-push-model.js"
import { DashboardSnapshot } from "../../src/dashboard-model.js"
import { NeedsYouResult } from "../../src/module-needs-you.js"
import type { ReviewState as ReviewFixtureState } from "./inventory.js"

export const CODE_REFERENCE = "00000000-0000-4000-8000-000000000451"

const CommitToken = /\{commit:([0-9a-f]{7,40})\}/gu

const JsonText = Schema.fromJsonString(Schema.Json)

/** Design copy names a commit as `{commit:a1b2c3d}`; the live readings carry the id itself. */
export const untokenCommits = (value: Schema.Json): Schema.Json =>
  Schema.decodeUnknownSync(JsonText)(Schema.encodeSync(JsonText)(value).replace(CommitToken, "$1"))

export const DesignCommits = Schema.Record(
  Schema.String,
  Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
    title: Schema.NonEmptyString,
    at: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u))
  })
)

/** A design commit: its short id, full id, title and commit time. */
export interface DesignCommit {
  readonly short: string
  readonly id: string
  readonly title: string
  readonly committedAt: number
}

/**
 * The commits a design names, timed on `day` when given (the reading's own day, so a label shows only the
 * time, as the design draws it) and on the design's own date otherwise.
 */
export const designCommits = (
  commits: typeof DesignCommits.Type | undefined,
  day?: string
): ReadonlyArray<DesignCommit> =>
  commits === undefined ? [] : Object.entries(commits).map(
    ([short, commit]) => ({
      short,
      id: commit.id,
      title: commit.title,
      committedAt: Date.parse(`${day ?? commit.at.slice(0, 10)}T${commit.at.slice(11)}:00.000Z`)
    })
  )

const CodeReviewCommits = Schema.Struct({ codeReview: Schema.Struct({ commits: Schema.optionalKey(DesignCommits) }) })

/** The /commit reading for a live id: the design commit it starts with, or none. */
export const designCommitResult = (
  commits: ReadonlyArray<DesignCommit>,
  commit: string | null
): CodeCommitSummaryResult | undefined => {
  const found = commit === null ? undefined : commits.find((entry) => commit.startsWith(entry.short))
  return found === undefined
    ? undefined
    : Schema.decodeUnknownSync(CodeCommitSummaryResult)({
      _tag: "Ready",
      commit: { commitId: found.id, title: found.title, committedAt: found.committedAt }
    })
}
export type { ReviewState as ReviewFixtureState } from "./inventory.js"
type RecordedRun = Extract<
  Extract<CodeReviewResult, { readonly _tag: "Ready" }>["reading"]["workspace"]["run"],
  { readonly _tag: "Ready" }
>["run"]
type ReviewDisposition = NonNullable<RecordedRun["threads"][number]["finding"]>["disposition"]
const ClockTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
const LineNumber = Schema.Union([Schema.Int.check(Schema.isGreaterThan(0)), Schema.Literal("")])
const File = Schema.Struct({
  path: Schema.NonEmptyString,
  hunks: Schema.Array(Schema.Struct({
    lines: Schema.Array(Schema.Struct({
      t: Schema.Literals([" ", "+", "-"]),
      n: LineNumber,
      o: LineNumber,
      s: Schema.String
    }))
  }))
})
const ReferenceFinding = Schema.Struct({
  sev: Schema.Literals(["P0", "P1", "P2", "P3", "P4"]),
  claim: Schema.NonEmptyString,
  file: Schema.NullOr(Schema.NonEmptyString),
  line: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  why: Schema.String,
  axis: Schema.optionalKey(Schema.Literals(["Standards", "Spec", "Security"])),
  confidence: Schema.optionalKey(Schema.Literals([
    "High",
    "Medium",
    "Low",
    "High confidence",
    "Medium confidence",
    "Low confidence"
  ])),
  extra: Schema.optionalKey(Schema.Struct({
    requirement: Schema.optionalKey(Schema.String),
    evidence: Schema.optionalKey(Schema.String),
    rec: Schema.optionalKey(Schema.String),
    verify: Schema.optionalKey(Schema.String)
  })),
  patch: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})

const ReferenceData = Schema.Struct({
  codeReview: Schema.Struct({
    shell: Schema.Struct({ hubHost: Schema.NonEmptyString, hosts: Schema.Struct({ label: Schema.String }) }),
    approvals: Schema.Struct({
      badge: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 256 }))
    }),
    states: Schema.Record(Schema.String, Schema.Struct({ variant: Schema.optionalKey(Schema.String) })),
    review: Schema.Struct({
      pr: Schema.Struct({
        repo: Schema.NonEmptyString,
        number: Schema.NonEmptyString,
        title: Schema.NonEmptyString,
        branch: Schema.NonEmptyString,
        base: Schema.NonEmptyString,
        author: Schema.NonEmptyString,
        updated: Schema.NonEmptyString
      }),
      findings: Schema.Record(Schema.String, ReferenceFinding),
      files: Schema.Array(File),
      variants: Schema.Record(Schema.String, Schema.Json)
    })
  })
})
const Message = Schema.Struct({ name: Schema.NonEmptyString, at: ClockTime, body: Schema.String })
const Discussion = Schema.Struct({
  id: Schema.NonEmptyString,
  file: Schema.NonEmptyString,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  outdated: Schema.optionalKey(Schema.String),
  root: Message,
  replies: Schema.Array(Message)
})
const LegacyVariant = Schema.Struct({
  threads: Schema.Array(Discussion),
  findings: Schema.Array(Schema.NonEmptyString),
  legacy: Schema.Struct({
    reviewerLine: Schema.String,
    text: Schema.Record(Schema.String, Schema.Struct({ rec: Schema.String, verify: Schema.String }))
  }),
  summary: Schema.Struct({ verdictQuote: Schema.String, reviewed: Schema.String })
})
const RecordedVariant = Schema.Struct({
  findings: Schema.Array(Schema.NonEmptyString),
  summary: Schema.Struct({ changed: Schema.NonEmptyString, risks: Schema.Array(Schema.String) })
})
const SavedState = Schema.Struct({
  summary: Schema.optionalKey(Schema.Struct({ reviewed: Schema.optionalKey(Schema.NonEmptyString) })),
  pr: Schema.optionalKey(Schema.Struct({ updated: Schema.optionalKey(Schema.NonEmptyString) })),
  lineText: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  threads: Schema.optionalKey(Schema.Array(Schema.Union([
    Discussion,
    Schema.Struct({ id: Schema.NonEmptyString, finding: Schema.NonEmptyString, replies: Schema.Array(Message) })
  ]))),
  recStatus: Schema.optionalKey(Schema.Record(
    Schema.String,
    Schema.Struct({
      word: Schema.Union([
        Schema.Literals(["Resolved", "Dismissed: False positive"]),
        Schema.String.check(Schema.isPattern(/^Fix pushed in \S+, waiting for re-review$/u))
      ]),
      note: Schema.optionalKey(Schema.String)
    })
  ))
})

/** Saved display dispositions carry no command or write capability, actor or invented timestamp. */
const savedDisposition = (state: typeof SavedState.Type, id: string): ReviewDisposition => {
  const recorded = state.recStatus?.[id]
  if (recorded === undefined) return { _tag: "Open" }
  if (recorded.word === "Resolved") return { _tag: "Resolved" }
  if (recorded.word === "Dismissed: False positive") {
    return { _tag: "Dismissed", reason: "false_positive", note: recorded.note ?? null }
  }
  const match = /^Fix pushed in (\S+), waiting for re-review$/u.exec(recorded.word)
  return { _tag: "FixedVerify", commit: Schema.decodeUnknownSync(Schema.NonEmptyString)(match?.[1]) }
}

const ExplainVariant = Schema.Struct({
  summary: Schema.Struct({ prose: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)) })
})
const ReferencePost = Schema.Union([
  Schema.Struct({ name: Schema.NonEmptyString, at: ClockTime, deleted: Schema.Literal(true) }),
  Schema.Struct({
    name: Schema.NonEmptyString,
    at: ClockTime,
    body: Schema.String,
    deleted: Schema.optionalKey(Schema.Literal(false))
  })
])
const ConversationVariant = Schema.Struct({
  findings: Schema.Array(Schema.NonEmptyString),
  conv: Schema.Struct({
    items: Schema.Array(Schema.Union([
      Schema.Struct({ source: Schema.Literal("codecommit"), posts: Schema.Array(ReferencePost) }),
      Schema.Struct({ finding: Schema.NonEmptyString, posts: Schema.Array(ReferencePost) }),
      Schema.Struct({ kind: Schema.Literal("agent"), body: Schema.String, at: ClockTime })
    ]))
  })
})

const conversationPosts = (id: string, posts: ReadonlyArray<typeof ReferencePost.Type>) =>
  posts.map((post, index) => ({
    id: `${id}-${index}`,
    author: post.name,
    createdAt: Date.parse(`2026-10-11T${post.at}:00.000Z`),
    text: post.deleted === true ? "" : post.body,
    deleted: post.deleted === true
  }))
const Provenance = Schema.Tuple([
  Schema.NonEmptyString,
  Schema.NonEmptyString,
  Schema.NonEmptyString,
  Schema.Literal("Code review")
])
const ReadingStamp = Schema.Struct({ at: ClockTime, head: Schema.NonEmptyString })

const referenceReading = (data: Fixture["data"]) => {
  const { approvals, review, shell, states } = Schema.decodeUnknownSync(ReferenceData)(untokenCommits(data)).codeReview
  const legacy = Schema.decodeUnknownSync(LegacyVariant)(review.variants["ready-readonly-legacy"])
  const provenance = Schema.decodeUnknownSync(Provenance)(legacy.legacy.reviewerLine.split(", "))
  const raw = /^Reviewed (\d{2}:\d{2}), head (\S+)$/u.exec(legacy.summary.reviewed)
  const stamp = Schema.decodeUnknownSync(ReadingStamp)({ at: raw?.[1], head: raw?.[2] })
  // The synthetic reference's Sunday is 11 October 2026; no wall clock is consulted.
  const observedAt = Date.parse(`2026-10-11T${stamp.at}:00.000Z`)
  const commits = designCommits(Schema.decodeUnknownSync(CodeReviewCommits)(data).codeReview.commits)
  return { review, shell, approvals, legacy, provenance, stamp, observedAt, states, commits }
}

/** Legacy snapshots contain prose and provenance, without inventing optional structured findings. */
export const makeReviewFixture = (
  data: Fixture["data"],
  state: ReviewFixtureState = "review-ready-readonly-legacy"
): CodeReviewResult => {
  const { legacy, provenance, review, stamp: legacyStamp, states } = referenceReading(data)
  if (state === "code-owner-unavailable") {
    return Schema.decodeUnknownSync(CodeReviewResult)({ _tag: "Unavailable", reason: "other_host", host: "build-host" })
  }
  const variantKey = states[state]?.variant
  const variant = variantKey === undefined ? undefined : review.variants[variantKey]
  const saved = Schema.decodeUnknownSync(SavedState)(variant)
  const stampMatch = saved.summary?.reviewed === undefined
    ? null
    : /^Reviewed (\d{2}:\d{2}), head (\S+)$/u.exec(saved.summary.reviewed)
  const stamp = saved.summary?.reviewed === undefined ?
    legacyStamp
    : Schema.decodeUnknownSync(ReadingStamp)({ at: stampMatch?.[1], head: stampMatch?.[2] })
  const observedAt = Date.parse(`2026-10-11T${stamp.at}:00.000Z`)
  const absentRun = state.startsWith("review-run-unavailable") ||
    state === "review-conversation-comments-unavailable" ||
    state === "conversation-incomplete"
  const notRecorded = state === "review-not-recorded-readonly"
  const commentsReason = state === "review-run-unavailable-comments-over-limit" ?
    "over_limit"
    : state === "review-run-unavailable-comments-corrupt" ?
    "corrupt"
    : state === "review-run-unavailable-no-comments" || state === "review-conversation-comments-unavailable" ||
        state === "comments-only-unavailable" ?
    "not_cached" :
    null
  const conversation = state === "deleted-comment" || state === "conversation-agent-summary" ||
      state === "conversation-finding-discussion" || state === "conversation-incomplete" ||
      state === "review-conversation-readonly"
    ? Schema.decodeUnknownSync(ConversationVariant)(review.variants[state])
    : null
  const explain = state === "recorded-explain"
    ? Schema.decodeUnknownSync(ExplainVariant)(review.variants[state])
    : null
  const recorded =
    state === "review-ready-readonly-legacy" || explain !== null || conversation !== null || absentRun || notRecorded ||
      state === "read-pending" || state === "review-transport-failed"
      ? null
      : Schema.decodeUnknownSync(RecordedVariant)(variant)
  const changedHead = state === "different-revision-findings-head" || state === "different-revision-no-findings"
  const identity = {
    namespace: "codecommit",
    subjectId: CODE_REFERENCE,
    revisionId: "recorded-revision",
    baseRevision: state === "different-revision-findings-base" ? "fixture-current-base" : "fixture-base",
    // The corrected synthetic mismatch frame names e7f8a9b as the current branch head.
    headRevision: changedHead ? "e7f8a9b" : stamp.head
  }
  const files = review.files.map((file, index) => ({
    index,
    path: state === "placement-refused"
      ? Schema.decodeUnknownSync(Schema.NonEmptyString)(review.files[0]?.path)
      : file.path,
    previousPath: null,
    status: "modified",
    beforeMode: state === "diff-rejected" ? "invalid-mode" : "100644",
    afterMode: "100644"
  }))
  const findingIds = absentRun || notRecorded ? [] : conversation !== null
    ? Array.from(
      new Set([
        ...conversation.findings,
        ...conversation.conv.items.flatMap((item) => "finding" in item ? [item.finding] : [])
      ])
    )
    : explain !== null
    ? []
    : recorded === null
    ? legacy.findings
    : recorded.findings
  const conflict = state === "review-threads-conflict" || state === "review-conversation-threads-conflict"
  const threads = findingIds.map((id) => {
    const finding = Schema.decodeUnknownSync(ReferenceFinding)(review.findings[id])
    const text = legacy.legacy.text[id]
    const disposition = savedDisposition(saved, id)
    const messages = conversation?.conv.items.find((item) => "finding" in item && item.finding === id)
    return {
      id,
      source: "agent",
      anchor: finding.file === null
        ? { _tag: "Unanchored" }
        : finding.line === null
        ? { _tag: "File", path: finding.file, outdated: false }
        : { _tag: "Line", path: finding.file, line: finding.line, side: "after", outdated: false },
      resolved: disposition._tag === "Resolved",
      messages: messages !== undefined && "posts" in messages ?
        conversationPosts(id, messages.posts)
        : saved.threads?.flatMap((thread) =>
          "finding" in thread && thread.finding === id ? conversationPosts(id, thread.replies) : []
        ) ?? [],
      finding: {
        severity: finding.sev,
        claim: finding.claim,
        axis: recorded === null ? null : finding.axis ?? null,
        confidence: recorded === null || finding.confidence === undefined
          ? null
          : finding.confidence.replace(/ confidence$/u, "").toLowerCase(),
        summary: recorded === null ? null : finding.extra?.evidence ?? null,
        why: finding.why,
        recommendation: recorded === null ? text?.rec ?? "" : finding.extra?.rec ?? "",
        verification: recorded === null ? text?.verify ?? "" : finding.extra?.verify ?? "",
        requirement: recorded === null ? null : finding.extra?.requirement ?? null,
        patch: recorded === null || finding.patch === undefined || finding.patch === null || finding.file === null
          ? null
          : { path: finding.file, headRevision: stamp.head, text: finding.patch.join("\n") },
        disposition
      }
    }
  })
  const discussionRecords = state === "review-ready-readonly-legacy" || state === "read-retained" || conflict
    ? legacy.threads
    : (saved.threads ?? []).flatMap((thread) => "root" in thread ? [thread] : [])
  const discussions = discussionRecords.map((thread) => ({
    id: thread.id,
    source: "codecommit",
    anchor: {
      _tag: "Line",
      path: thread.file,
      line: thread.line,
      side: "after",
      outdated: thread.outdated !== undefined
    },
    resolved: false,
    finding: null,
    messages: [thread.root, ...thread.replies].map((message, index) => ({
      id: `${thread.id}-${index}`,
      author: message.name,
      createdAt: Date.parse(`2026-10-11T${message.at}:00.000Z`),
      text: message.body,
      deleted: false
    }))
  }))
  const conversationThreads = conversation === null ?
    discussions :
    conversation.conv.items.flatMap((item, index) =>
      "source" in item ?
        [{
          id: `conversation-${index}`,
          source: item.source,
          anchor: { _tag: "Unanchored" },
          resolved: false,
          finding: null,
          messages: conversationPosts(`conversation-${index}`, item.posts)
        }] :
        []
    )
  const agentSummary = conversation?.conv.items.find((item) => "kind" in item)
  return Schema.decodeUnknownSync(CodeReviewResult)({
    _tag: "Ready",
    reading: {
      diff: {
        pullRequestId: review.pr.number,
        revisionId: identity.revisionId,
        baseCommit: identity.baseRevision,
        headCommit: identity.headRevision,
        readAt: observedAt,
        cacheUpdatedAt: observedAt,
        files
      },
      workspace: {
        identity,
        observedAt,
        run: absentRun ? { _tag: "Unavailable", reason: "io" } : notRecorded ? { _tag: "NotRecorded" } : {
          _tag: "Ready",
          run: {
            id: "recorded-run",
            identity: { ...identity, baseRevision: "fixture-base", headRevision: stamp.head },
            profile: {
              id: "recorded-profile",
              name: provenance[0],
              kind: explain === null ? "review" : "explain",
              provider: "fixture",
              harness: provenance[1] === "Claude Code" ? "native-claude" : provenance[1],
              model: provenance[2],
              skillIds: []
            },
            kind: explain === null ? "review" : "explain",
            completedAt: observedAt,
            summary: conversation !== null
              ? agentSummary !== undefined && "body" in agentSummary ? agentSummary.body : ""
              : explain !== null
              ? ""
              : recorded === null
              ? legacy.summary.verdictQuote
              : recorded.summary.changed,
            explanation: explain === null ? null : explain.summary.prose.join("\n\n"),
            risks: recorded === null ? null : recorded.summary.risks,
            focus: null,
            rules: null,
            threads: conflict ? discussions.slice(0, 1) : threads
          }
        },
        conversations: commentsReason === null
          ? { _tag: "Ready", observedAt, threads: conflict ? discussions.slice(0, 1) : conversationThreads }
          : { _tag: "Unavailable", reason: commentsReason },
        checks: { _tag: "Unknown" }
      }
    }
  })
}

/** Feed real Before/After strings to the shipped parser; never manufacture rendered diff rows. */
export const makeReviewContents = (
  data: Fixture["data"],
  state: ReviewFixtureState = "review-ready-readonly-legacy"
): ReadonlyArray<CodeDiffContentResult> => {
  const { review, states } = referenceReading(data)
  const key = states[state]?.variant
  const saved = Schema.decodeUnknownSync(SavedState)(key === undefined ? undefined : review.variants[key])
  return review.files.map((file, fileIndex) => {
    if (state === "diff-unavailable") {
      return Schema.decodeUnknownSync(CodeDiffContentResult)({
        _tag: "Unavailable",
        reason: "unavailable",
        host: null
      })
    }
    // Unshown synthetic lines are empty. The product recomputes real hunks; reference hunk headings are not parser proof.
    const before: Array<string> = []
    const after: Array<string> = []
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.t !== "+" && line.o !== "") before[line.o - 1] = line.s
        if (line.t !== "-" && line.n !== "") after[line.n - 1] = line.s
      }
    }
    for (const [location, text] of Object.entries(saved.lineText ?? {})) {
      const prefix = `${file.path}:`
      if (!location.startsWith(prefix)) continue
      const line = Schema.decodeUnknownSync(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)))(
        location.slice(prefix.length)
      )
      after[line - 1] = text
    }
    return Schema.decodeUnknownSync(CodeDiffContentResult)({
      _tag: "Ready",
      content: {
        fileIndex,
        revisionId: "recorded-revision",
        state: "text",
        before: before.join("\n") + "\n",
        after: after.join("\n") + "\n"
      }
    })
  })
}

/**
 * Minimal canonical shell readings: approvals badge, peer hosts and an idle Relay. No background provider requests
 * or decision endpoints exist.
 */
export const makeShellReadings = (options: {
  readonly hubHost: string
  readonly hostCount: number
  readonly badge: number
  readonly observedAt: number
}) => {
  const { badge, hostCount, hubHost, observedAt } = options
  const shell = { hubHost }
  const approvals = { badge }
  const pending = Array.from({ length: approvals.badge }, (_, index) => ({
    id: `fixture-approval-${index}`,
    actor: "Synthetic requester",
    createdAt: observedAt,
    updatedAt: observedAt,
    approvalExpiresAt: null,
    approvalAvailable: false,
    approvedBy: null,
    status: "pending_approval",
    payload: { kind: "nix.apply", ref: "main" }
  }))
  const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
    host: shell.hubHost,
    observedAt,
    approvalsEnabled: true,
    approvalApp: {
      canonical: true,
      canonicalUrl: "/",
      pushEnabled: false,
      superapp: true,
      fleet: true,
      workEnabled: false
    },
    work: null,
    status: {
      host: shell.hubHost,
      applyConfigured: false,
      branch: "main",
      dirty: false,
      repository: "fixture",
      revision: "fixture-revision",
      herdr: { agents: [], available: true, error: null }
    },
    records: [],
    historyNextCursor: null,
    directory: {
      currentUrl: "/",
      links: Array.from(
        { length: hostCount - 1 },
        (_, index) => ({ host: `fixture-peer-${index + 1}`, online: false, url: null })
      ),
      error: null
    },
    pendingApprovals: { local: pending, remote: [], failures: [], nextCursors: [] }
  })
  const needsYou = Schema.decodeUnknownSync(NeedsYouResult)({
    _tag: "Complete",
    items: pending.map((job) => ({
      key: `fleet:${shell.hubHost.toLowerCase()}:${job.id}`,
      provider: "fleet",
      destination: { _tag: "FleetApproval", module: "fleet", host: shell.hubHost, jobId: job.id },
      kind: "nix.apply",
      actor: job.actor,
      createdAt: job.createdAt,
      expiresAt: null
    }))
  })
  const work = Schema.decodeUnknownSync(WorkSnapshots)({
    observedAt,
    now: { window: "now", asOf: observedAt, observedAt, goals: [] },
    day: { window: "day", asOf: observedAt, observedAt, goals: [] },
    week: { window: "week", asOf: observedAt, observedAt, goals: [] },
    month: { window: "month", asOf: observedAt, observedAt, goals: [] }
  })
  const agents = Schema.decodeUnknownSync(FleetConnectAgentPage)({ agents: [], failures: [], nextCursor: null })
  const blockedSettings = Schema.decodeUnknownSync(BlockedPushSettings)({ mutedAgents: [], quietHours: null })
  const relayEvent = Schema.encodeSync(Schema.fromJsonString(RelayEvent))({
    _tag: "Snapshot",
    session: "fixture-session",
    seq: 0,
    messages: [],
    runIds: [],
    queued: []
  })
  const session = Schema.decodeUnknownSync(SessionInfo)({ tools: [], backend: "codex-cli", cancel: false })
  const backends = Schema.decodeUnknownSync(Schema.Array(BackendStatus))([])
  const limits = Schema.decodeUnknownSync(FleetLimits)({ hosts: [], failures: [], peersListed: true })
  const usage = Schema.decodeUnknownSync(FleetUsage)({ hosts: [], failures: [], peersListed: true })
  return { snapshot, needsYou, work, agents, blockedSettings, relayEvent, session, backends, limits, usage }
}

export const makeCodeReadings = (data: Fixture["data"], state: ReviewFixtureState = "review-ready-readonly-legacy") => {
  const { approvals, commits, observedAt, review, shell, states } = referenceReading(data)
  const key = states[state]?.variant
  const saved = Schema.decodeUnknownSync(SavedState)(key === undefined ? undefined : review.variants[key])
  const updated = Schema.decodeUnknownSync(ClockTime)(
    (saved.pr?.updated ?? review.pr.updated).replace(/^Updated /u, "")
  )
  const unavailable = { _tag: "Unavailable", reason: "other_host", host: "build-host" }
  const detail = Schema.decodeUnknownSync(CodeDetail)(
    state === "code-owner-unavailable" ? unavailable : {
      _tag: "Ready",
      item: {
        ref: CODE_REFERENCE,
        id: review.pr.number,
        repository: review.pr.repo,
        title: review.pr.title,
        author: review.pr.author.replace(/^Opened by /u, ""),
        status: "OPEN",
        approval: "waiting",
        createdAt: observedAt,
        updatedAt: Date.parse(`2026-10-11T${updated}:00.000Z`),
        observedAt
      },
      description: "",
      sourceBranch: review.pr.branch,
      destinationBranch: review.pr.base
    }
  )
  const queue = Schema.decodeUnknownSync(CodeQueue)(
    state === "code-owner-unavailable" ? unavailable : {
      _tag: "Ready",
      observedAt,
      more: false,
      items: detail._tag === "Ready" ? [detail.item] : []
    }
  )
  const hostCount = Schema.decodeUnknownSync(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 256 }))
  )(shell.hosts.label.split(" ")[0])
  const shellReadings = makeShellReadings({ hubHost: shell.hubHost, hostCount, badge: approvals.badge, observedAt })
  return {
    ...shellReadings,
    queue,
    detail,
    review: makeReviewFixture(data, state),
    contents: makeReviewContents(data, state),
    commits
  }
}
