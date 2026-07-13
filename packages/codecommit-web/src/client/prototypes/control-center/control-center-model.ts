import type { EntityLink, EntityRecord } from "./control-center-foundation.js"

export type TraceId = "deploy" | "failure" | "pipeline" | "prOne" | "prTwo" | "release" | "ticket" | "time"
export interface TraceDetail {
  readonly type: string
  readonly title: string
  readonly status: string
  readonly summary: string
  readonly properties: ReadonlyArray<readonly [string, string]>
  readonly relations: ReadonlyArray<readonly [string, string]>
  readonly activity: ReadonlyArray<string>
}

export interface ReleaseTicket {
  readonly key: string
  readonly title: string
  readonly status: string
  readonly tone: string
}

export interface ReleasePortfolioEntry {
  readonly service: string
  readonly version: string
  readonly state: string
  readonly tone: string
  readonly detail: string
  readonly action: string
  readonly stages: readonly [string, string, string]
}

export type WorkTicket = readonly [key: string, title: string, status: string]
export type WorkPullRequest = readonly [number: string, ticketKeys: ReadonlyArray<string>]
export type WorkEvent = readonly [time: string, label: string, detail: string]
export type NonEmptyReadonlyArray<T> = readonly [T, ...ReadonlyArray<T>]

export interface ReleaseWorkset {
  readonly tickets: NonEmptyReadonlyArray<WorkTicket>
  readonly prs: NonEmptyReadonlyArray<WorkPullRequest>
  readonly pipeline: string
  readonly events: NonEmptyReadonlyArray<WorkEvent>
  readonly confluence: string
  readonly gaps: number
}

export interface WipWorkset {
  readonly tickets: NonEmptyReadonlyArray<WorkTicket>
  readonly prs: NonEmptyReadonlyArray<WorkPullRequest>
  readonly events: NonEmptyReadonlyArray<WorkEvent>
}

function getItem<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[index] ?? items[0]
  if (item === undefined) {
    throw new Error("Expected a non-empty control-center model collection")
  }
  return item
}

export const traceDetails: Readonly<Record<TraceId, TraceDetail>> = {
  ticket: {
    type: "Jira ticket",
    title: "OPS-412",
    status: "Ready · approval missing",
    summary: "Production access approval for the payments service rollout.",
    properties: [["Project", "Operations"], ["Assignee", "Maya Chen"], ["Sprint", "Platform 34"], [
      "Updated",
      "42 minutes ago"
    ]],
    relations: [["implemented by", "PR #284 · Audit logging"], ["included in", "payments-api v2.18.0"], [
      "work logged",
      "3h 45m · 2 people"
    ]],
    activity: ["Agent detected missing approval", "Moved to Ready by Maya", "PR #284 linked from branch name"]
  },
  prOne: {
    type: "CodeCommit pull request",
    title: "#284 · Audit logging",
    status: "Merged · 18 checks passed",
    summary: "Adds structured audit events required by production access policy.",
    properties: [["Repository", "payments-api"], ["Author", "Alex K."], ["Commit", "a84f9d2"], [
      "Merged",
      "Today, 09:41"
    ]],
    relations: [["implements", "OPS-412"], ["included in", "payments-api v2.18.0"], [
      "reviewed by",
      "Maya Chen + Agent"
    ]],
    activity: ["Merged into main", "Release Guardian approved", "All required checks passed"]
  },
  prTwo: {
    type: "CodeCommit pull request",
    title: "#279 · Checkout fix",
    status: "Merged · regression detected",
    summary: "Fixes duplicate payment attempts in the checkout confirmation flow.",
    properties: [["Repository", "payments-api"], ["Author", "Maya Chen"], ["Commit", "58d202f"], [
      "Merged",
      "Yesterday, 16:22"
    ]],
    relations: [["implements", "PAY-118"], ["included in", "payments-api v2.18.0"], [
      "failed in",
      "Pipeline run #1842"
    ]],
    activity: ["3 integration tests failed", "Merged into main", "Two reviewers approved"]
  },
  release: {
    type: "Release candidate",
    title: "payments-api v2.18.0",
    status: "Blocked · 75% ready",
    summary: "Four changes prepared for production. One approval and three integration tests block promotion.",
    properties: [["Owner", "Payments team"], ["Commit", "a84f9d2"], ["Created", "Today, 10:03"], [
      "Target",
      "Production · eu-west-1"
    ]],
    relations: [["contains", "2 PRs · 6 Jira tickets"], ["built by", "payments-production #1842"], [
      "targets",
      "Production deployment"
    ]],
    activity: ["Pipeline reached integration stage", "Release candidate created", "Agent assembled change summary"]
  },
  pipeline: {
    type: "CodePipeline execution",
    title: "payments-production #1842",
    status: "Failed · integration stage",
    summary: "Build and security scans passed. Integration tests stopped the execution after 8m 42s.",
    properties: [["Pipeline", "payments-production"], ["Execution", "#1842"], ["Revision", "a84f9d2"], [
      "Duration",
      "8m 42s"
    ]],
    relations: [["builds", "payments-api v2.18.0"], ["produced", "payments-api:2.18.0-rc.1"], [
      "blocked by",
      "Integration tests"
    ]],
    activity: ["Integration stage failed", "Image scan passed", "Build artifact published"]
  },
  deploy: {
    type: "Deployment",
    title: "Production · eu-west-1",
    status: "Waiting · manual approval",
    summary: "Blue/green production deployment prepared but not yet eligible to start.",
    properties: [["Environment", "production"], ["Strategy", "Blue / green"], ["Approver", "Maya Chen"], [
      "Window",
      "Today, 14:00–16:00"
    ]],
    relations: [["deploys", "payments-api v2.18.0"], ["triggered by", "payments-production #1842"], [
      "protected by",
      "Production approval gate"
    ]],
    activity: ["Approval policy loaded for Maya", "Change window validated", "Rollback plan generated"]
  },
  failure: {
    type: "Test execution",
    title: "Integration tests",
    status: "Failed · 3 of 128 tests",
    summary: "Failures cluster around checkout confirmation and appear related to PR #279.",
    properties: [["Suite", "checkout-flow"], ["Passed", "125"], ["Failed", "3"], ["Runtime", "4m 18s"]],
    relations: [["failed in", "payments-production #1842"], ["suspected change", "PR #279 · Checkout fix"], [
      "blocks",
      "Production deployment"
    ]],
    activity: ["Diagnostic agent started", "Failure signature matched PR #279", "Logs and artifacts retained"]
  },
  time: {
    type: "Clockify roll-up",
    title: "Implementation time",
    status: "3h 45m · fully attributed",
    summary: "Time entries associated with the ticket and code changes in this release.",
    properties: [["Workspace", "Engineering"], ["Project", "Payments"], ["Contributors", "Alex + Maya"], [
      "Billable",
      "3h 15m"
    ]],
    relations: [["tracked against", "OPS-412"], ["contributed to", "payments-api v2.18.0"], [
      "derived from",
      "2 commits + calendar"
    ]],
    activity: ["30m gap auto-filled after approval", "Entries linked to OPS-412", "Release roll-up recalculated"]
  }
}

export const releaseTickets: NonEmptyReadonlyArray<ReleaseTicket> = [
  { key: "OPS-412", title: "Production access approval", status: "Ready · approval missing", tone: "warning" },
  { key: "PAY-118", title: "Prevent duplicate charges", status: "Done · linked to PR #279", tone: "done" },
  { key: "PAY-121", title: "Structured audit events", status: "Done · linked to PR #284", tone: "done" },
  { key: "SEC-77", title: "Redact PCI log fields", status: "Done · linked to PR #284", tone: "done" },
  { key: "OPS-419", title: "Payment health dashboard", status: "Done · linked to PR #279", tone: "done" },
  { key: "PAY-119", title: "Refund-flow telemetry", status: "In review · no PR link", tone: "missing" }
]

export const releasePortfolio: NonEmptyReadonlyArray<ReleasePortfolioEntry> = [
  {
    service: "payments-api",
    version: "2.18.0",
    state: "Can’t ship",
    tone: "blocked",
    detail: "3 tests failed · approval missing",
    action: "Investigate",
    stages: ["Built", "Failed", "Waiting"]
  },
  {
    service: "checkout-web",
    version: "4.7.1",
    state: "Can ship",
    tone: "ready",
    detail: "12 checks passed · approved",
    action: "Deploy",
    stages: ["Built", "Passed", "Ready"]
  },
  {
    service: "identity-api",
    version: "1.12.3",
    state: "Deploying",
    tone: "moving",
    detail: "Production rollout · 62%",
    action: "Watch",
    stages: ["Built", "Passed", "62%"]
  },
  {
    service: "ledger-worker",
    version: "3.4.0",
    state: "Building",
    tone: "building",
    detail: "8 of 12 jobs complete",
    action: "Open",
    stages: ["8/12", "Queued", "—"]
  },
  {
    service: "notifications",
    version: "2.9.2",
    state: "Shipped",
    tone: "shipped",
    detail: "Production live · 24m ago",
    action: "View",
    stages: ["Built", "Passed", "Live"]
  },
  {
    service: "risk-engine",
    version: "0.18.0",
    state: "Needs links",
    tone: "warning",
    detail: "2 changes lack work context",
    action: "Fix trace",
    stages: ["Built", "Passed", "Held"]
  }
]

export const releaseWorksets: NonEmptyReadonlyArray<ReleaseWorkset> = [
  {
    tickets: [
      ["OPS-412", "Production access approval", "Ready · approval missing"],
      ["PAY-118", "Prevent duplicate charges", "Done · linked to PR #279"],
      ["PAY-121", "Structured audit events", "Done · linked to PR #284"],
      ["SEC-77", "Redact PCI log fields", "Done · linked to PR #284"],
      ["OPS-419", "Payment health dashboard", "Done · linked to PR #279"],
      ["PAY-119", "Refund-flow telemetry", "In review · no PR link"]
    ],
    prs: [["#284", ["OPS-412", "PAY-121", "SEC-77"]], ["#279", ["PAY-118", "OPS-419"]]],
    pipeline: "payments-production #1842",
    events: [
      ["10:19", "Production not started", "Blocked by tests + approval"],
      ["10:18", "Integration failed", "3 of 128 tests"],
      ["10:11", "Security scan passed", "0 critical findings"],
      ["10:08", "Build artifact ready", "payments-api:2.18.0-rc.1"],
      ["10:03", "Execution started", "main · a84f9d2"]
    ],
    confluence: "RUN-61 · Payments production rollout runbook",
    gaps: 2
  },
  {
    tickets: [
      ["WEB-203", "One-click address picker", "Done"],
      ["WEB-207", "Restore cart promotions", "Done"],
      ["UX-88", "Checkout accessibility pass", "Accepted"],
      ["QA-156", "Payment matrix regression", "Passed"],
      ["OPS-420", "CDN rollout approval", "Approved"],
      ["DOC-92", "Merchant release notes", "Published"]
    ],
    prs: [["#885", ["WEB-203", "WEB-207", "UX-88"]], ["#881", ["QA-156", "OPS-420", "DOC-92"]]],
    pipeline: "checkout-production #771",
    events: [
      ["09:11", "Production ready", "Awaiting deploy command"],
      ["09:10", "Approval recorded", "Maya Chen"],
      ["09:07", "Browser matrix passed", "142 of 142"],
      ["08:58", "Bundle ready", "checkout-web:4.7.1"],
      ["08:54", "Execution started", "main · f71ca20"]
    ],
    confluence: "RUN-58 · Checkout CDN rollback plan",
    gaps: 0
  },
  {
    tickets: [
      ["ID-77", "Emit MFA method claims", "Done"],
      ["ID-81", "Key-rotation metrics", "Done"],
      ["SEC-84", "Threat-model refresh", "Approved"],
      ["QA-161", "Federation smoke suite", "Passed"],
      ["OPS-425", "Blue-green capacity check", "Passed"],
      ["SUP-31", "Support escalation guide", "Published"]
    ],
    prs: [["#602", ["ID-77", "ID-81", "SEC-84"]], ["#598", ["QA-161", "OPS-425", "SUP-31"]]],
    pipeline: "identity-production #390",
    events: [
      ["10:20", "Rollout at 62%", "0.04% error rate"],
      ["10:12", "Production rollout started", "blue → green"],
      ["10:04", "Verification passed", "96 of 96"],
      ["09:56", "Image published", "identity-api:1.12.3"],
      ["09:51", "Execution started", "main · 09ac821"]
    ],
    confluence: "RUN-63 · Identity rollback procedure",
    gaps: 0
  },
  {
    tickets: [
      ["FIN-310", "Resume batch checkpoints", "In build"],
      ["FIN-314", "Reconcile orphan entries", "Ready"],
      ["DATA-72", "Backfill settlement partitions", "Queued"],
      ["QA-166", "Month-end fixture pack", "Prepared"],
      ["OPS-431", "Worker memory alert", "Configured"],
      ["DOC-97", "Recovery operator guide", "Draft"]
    ],
    prs: [["#114", ["FIN-310", "FIN-314", "DATA-72"]], ["#112", ["QA-166", "OPS-431"]]],
    pipeline: "ledger-build #1188",
    events: [["10:20", "Build at 67%", "4 jobs remaining"], ["10:15", "Worker image building", "job 8 of 12"], [
      "10:11",
      "Dependencies restored",
      "1m 14s"
    ], ["10:08", "Execution started", "main · c28bb17"]],
    confluence: "RUN-67 · Ledger recovery and replay guide",
    gaps: 1
  },
  {
    tickets: [
      ["MSG-91", "Digest delivery preferences", "Done"],
      ["MSG-94", "Classify provider bounces", "Done"],
      ["UX-95", "Email preference copy", "Accepted"],
      ["QA-171", "Provider failover drill", "Passed"],
      ["OPS-438", "Delivery SLO dashboard", "Live"],
      ["DOC-102", "Support launch notes", "Published"]
    ],
    prs: [["#443", ["MSG-91", "MSG-94", "UX-95"]], ["#438", ["QA-171", "OPS-438", "DOC-102"]]],
    pipeline: "notifications-production #912",
    events: [
      ["10:24", "Production healthy", "24 minutes live"],
      ["10:00", "Production live", "All regions"],
      ["09:52", "Rollout started", "10% canary"],
      ["09:47", "Provider tests passed", "84 of 84"],
      ["09:32", "Execution started", "main · d102fc4"]
    ],
    confluence: "RUN-65 · Provider failover playbook",
    gaps: 0
  },
  {
    tickets: [
      ["RISK-55", "Tune sanctions threshold", "Done"],
      ["RISK-61", "Explain score overrides", "Done · unlinked"],
      ["DATA-79", "Refresh watchlist sample", "Validated"],
      ["QA-175", "False-positive benchmark", "Passed"],
      ["OPS-441", "Decision latency alert", "Configured"],
      ["DOC-106", "Analyst rollout guide", "Outdated"]
    ],
    prs: [["#72", ["RISK-55", "DATA-79", "QA-175"]], ["#69", ["OPS-441"]]],
    pipeline: "risk-production #266",
    events: [["10:20", "Promotion held", "Missing change evidence"], ["10:14", "Validation passed", "68 of 68"], [
      "10:08",
      "Model image ready",
      "risk-engine:0.18.0"
    ], ["10:02", "Execution started", "main · 8e40ad1"]],
    confluence: "RUN-54 · Risk analyst rollout guide · outdated",
    gaps: 2
  }
]

export const wipWorkset: WipWorkset = {
  tickets: [
    ["OPS-428", "Bounded provider retries", "In progress"],
    ["PAY-126", "Idempotent retry token", "Done"],
    ["OBS-42", "Retry saturation metrics", "In review"],
    ["QA-180", "Provider degradation tests", "Passed"],
    ["SEC-91", "Retry payload redaction", "Done"],
    ["DOC-110", "Provider response runbook", "Updated"]
  ],
  prs: [["#291", ["OPS-428", "PAY-126", "QA-180"]], ["#293", ["OBS-42", "SEC-91", "DOC-110"]]],
  events: [
    ["10:23", "PR #293 ready", "Awaiting reviewer"],
    ["10:22", "Preview #1852 passed", "64 of 64 tests"],
    ["10:19", "Observability preview ready", "PR #293 · 901cc2e"],
    ["10:14", "Preview restarted", "PR #291 · 4ae118c"],
    ["10:11", "Timing fix pushed", "Commit 4ae118c"],
    ["10:09", "Runbook updated", "Confluence RUN-70"]
  ]
}

export function resolveEntity(id: string): EntityRecord {
  const releaseMatch = releaseWorksets.flatMap((workset, releaseIndex) =>
    workset.tickets.map((ticket) => ({ releaseIndex, ticket, workset }))
  ).find(({ ticket }) => id === "jira:" + ticket[0])
  if (releaseMatch) {
    const { releaseIndex, ticket: [key, title, status], workset } = releaseMatch
    const release = getItem(releasePortfolio, releaseIndex)
    const pr = workset.prs.find(([, keys]) => keys.includes(key))?.[0]
    const approvalMissing = key === "OPS-412"
    const unlinked = status.toLowerCase().includes("unlinked")
    return {
      id,
      service: "jira",
      title: key + " · " + title,
      status,
      verdict: approvalMissing ? "Approval missing." : unlinked ? "Needs a PR." : "Ready for release.",
      completedVerdict: "Ready for release.",
      action: approvalMissing ? "Record approval" : unlinked ? "Link pull request" : null,
      completedStatus: approvalMissing ? "Ready · approval recorded" : unlinked ? "In review · PR linked" : status,
      impact: "Updates Jira and relationship coverage for " + release.service + " " + release.version + ".",
      facts: [
        ["STATUS", status],
        ["OWNER", releaseIndex % 2 === 0 ? "Maya Chen" : "Alex K."],
        [
          "PRIORITY",
          approvalMissing || unlinked ? "High" : "Normal"
        ],
        ["ESTIMATE", String(releaseIndex % 3 + 1) + " points"],
        ["RELEASE", release.service + " " + release.version]
      ],
      tabs: {
        Primary: [
          title + ". Scope is limited to " + release.service + " " + release.version + ".",
          "Acceptance · implementation evidence is verified",
          "Acceptance · " + workset.pipeline + " is linked",
          "Acceptance · operational evidence is current"
        ],
        Activity: [
          status + " · Jira",
          pr ? "Linked to PR " + pr : "No pull request relationship",
          "Included in " + release.service + " " + release.version
        ]
      },
      relationships: [
        ...(pr
          ? [
            {
              kind: "code",
              label: "PR " + pr + " · " + release.service,
              relation: "IMPLEMENTED BY",
              targetId: "pr:" + release.service + ":" + pr.replace("#", "")
            } satisfies EntityLink
          ]
          : []),
        {
          kind: "pipeline",
          label: workset.pipeline,
          relation: "DELIVERED BY",
          targetId: "pipeline:" + release.service
        },
        {
          kind: "release",
          label: release.service + " " + release.version,
          relation: "INCLUDED IN",
          targetId: "release:" + release.service
        },
        {
          kind: "confluence",
          label: workset.confluence,
          relation: "SUPPORTED BY",
          targetId: "page:" + workset.confluence.split(" ")[0]
        }
      ],
      activity: [status + " · Jira", "Synchronized with " + release.service, "Release Guardian verified relationships"]
    }
  }
  const wipTicket = wipWorkset.tickets.find(([key]) => id === "jira:" + key)
  if (wipTicket) {
    const [key, title, status] = wipTicket
    const index = wipWorkset.tickets.indexOf(wipTicket)
    const matchingPr = wipWorkset.prs.find(([, keys]) => keys.includes(key))
    const pr = matchingPr?.[0].replace("#", "") ?? "293"
    const preview = pr === "291" ? "billing-preview:1852" : "observability-preview:774"
    return {
      id,
      service: "jira",
      title: key + " · " + title,
      status,
      verdict: status === "Done" ? "Ready for review." : "Work in progress.",
      completedVerdict: "Ready for review.",
      action: status === "Done" ? null : "Move to review",
      completedStatus: status === "Done" ? status : "In review · evidence linked",
      impact: "Updates OPS-428 workstream state; no release or deployment is changed.",
      facts: [
        ["STATUS", status],
        ["OWNER", index % 2 === 0 ? "Alex K." : "Maya Chen"],
        ["PRIORITY", index < 2 ? "High" : "Normal"],
        ["ESTIMATE", String(index % 3 + 1) + " points"],
        ["WORKSTREAM", "OPS-428 · Active work"]
      ],
      tabs: {
        Primary: [
          title + " for the bounded provider retry workstream.",
          "Acceptance · preview evidence is linked",
          "Acceptance · operational behavior is observable"
        ],
        Activity: [status, "Release Guardian verified context", "Included in OPS-428"]
      },
      relationships: [
        { kind: "code", label: "PR #" + pr, relation: "IMPLEMENTED BY", targetId: "pr:billing-service:" + pr },
        {
          kind: "pipeline",
          label: preview.replace(":", " #"),
          relation: "VERIFIED BY",
          targetId: "pipeline:" + preview
        }
      ],
      activity: [status, "Preview evidence linked", "OPS-428 context verified"]
    }
  }
  if (id.startsWith("pr:billing-service:")) {
    const number = id.split(":")[2] ?? "293"
    const first = number === "291"
    const keys = first ? ["OPS-428", "PAY-126", "QA-180"] : ["OBS-42", "SEC-91", "DOC-110"]
    return {
      id,
      service: "code",
      title: "PR #" + number + " · " + (first ? "Bounded retry policy" : "Retry observability"),
      status: first ? "Open · checks passed" : "Open · review not requested",
      verdict: first ? "Ready for review." : "Review needed.",
      completedVerdict: "Review requested.",
      action: "Request review",
      completedStatus: "Open · review requested",
      impact: "Requests Maya Chen review; no merge or deployment occurs. OPS-428 remains WIP.",
      facts: [
        ["AUTHOR", first ? "Alex K." : "Release Guardian"],
        ["BRANCH", "feat/ops-428-" + (first ? "retry" : "observability") + " → main"],
        ["COMMIT", first ? "c18a7df" : "b93e12a"],
        ["DIFF", first ? "7 files · +184 −21" : "10 files · +256 −30"],
        ["WORKSTREAM", "OPS-428 · Active work"]
      ],
      tabs: {
        Files: keys.map((key) => "src/retry/" + key.toLowerCase() + ".ts · changed"),
        Commits: [(first ? "c18a7df" : "b93e12a") + " · " + (first ? "bounded retry policy" : "retry observability")],
        Checks: ["Build · passed", "Preview · 64/64 passed", "Review · " + (first ? "ready" : "not requested")]
      },
      relationships: [
        ...keys.map((key): EntityLink => ({
          kind: "jira",
          label: key + " · Jira",
          relation: "IMPLEMENTS",
          targetId: "jira:" + key
        })),
        {
          kind: "pipeline",
          label: first ? "billing-preview #1852" : "observability-preview #774",
          relation: "VERIFIED BY",
          targetId: first ? "pipeline:billing-preview:1852" : "pipeline:observability-preview:774"
        }
      ],
      activity: [
        "Preview passed",
        String(keys.length) + " Jira items linked",
        first ? "Reviewer context prepared" : "Review not requested"
      ]
    }
  }
  if (id === "pr:payments-api:301" || id === "pr:risk-engine:74") {
    const payments = id.includes("payments-api")
    return {
      id,
      service: "code",
      title: payments ? "PR #301 · Refund-flow telemetry" : "PR #74 · Explain score overrides",
      status: payments ? "Open · review ready" : "Merged · relationship verified",
      verdict: payments ? "Ready for review." : "Merged.",
      completedVerdict: payments ? "Review requested." : "Merged.",
      action: payments ? "Request review" : null,
      completedStatus: payments ? "Open · review requested" : "Merged · verified",
      impact: payments
        ? "Requests Maya Chen review and keeps payments-api 2.18.0 blocked on tests."
        : "Read-only merged relationship evidence.",
      facts: [
        ["AUTHOR", payments ? "Maya Chen" : "Nina Patel"],
        ["BRANCH", payments ? "feat/pay-119-telemetry → main" : "feat/risk-61-explanations → main"],
        ["COMMIT", payments ? "301ad8f" : "74ea91c"],
        ["DIFF", payments ? "4 files · +92 −11" : "6 files · +148 −24"],
        ["RELEASE", payments ? "payments-api 2.18.0" : "risk-engine 0.18.0"]
      ],
      tabs: {
        Files: payments
          ? [
            "src/refunds/telemetry.ts · +54 −6",
            "src/refunds/events.ts · +28 −3",
            "tests/refund-telemetry.test.ts · +10 −2"
          ]
          : ["src/risk/score-overrides.ts · +88 −14", "src/risk/explanations.ts · +60 −10"],
        Commits: [payments ? "301ad8f · add refund-flow telemetry" : "74ea91c · explain score overrides"],
        Checks: payments
          ? ["Build · passed", "Tests · passed", "Review · ready"]
          : ["Build · passed", "Tests · 68/68 passed", "Merge · verified"]
      },
      relationships: [
        {
          kind: "jira",
          label: payments ? "PAY-119 · Refund-flow telemetry" : "RISK-61 · Explain score overrides",
          relation: "IMPLEMENTS",
          targetId: payments ? "jira:PAY-119" : "jira:RISK-61"
        },
        {
          kind: "pipeline",
          label: payments ? "payments-production #1842" : "risk-production #266",
          relation: "DELIVERED BY",
          targetId: payments ? "pipeline:payments-api" : "pipeline:risk-engine"
        },
        {
          kind: "release",
          label: payments ? "payments-api 2.18.0" : "risk-engine 0.18.0",
          relation: "INCLUDED IN",
          targetId: payments ? "release:payments-api" : "release:risk-engine"
        }
      ],
      activity: [
        payments ? "Review context prepared" : "Merged into main",
        "Jira relationship verified",
        "Release evidence synchronized"
      ]
    }
  }
  if (id.startsWith("pr:")) {
    const [, serviceName = "payments-api", number = "284"] = id.split(":")
    const releaseIndex = releasePortfolio.findIndex(({ service }) => service === serviceName)
    const release = getItem(releasePortfolio, Math.max(0, releaseIndex))
    const workset = getItem(releaseWorksets, Math.max(0, releaseIndex))
    const pr = workset.prs.find(([candidate]) => candidate.replace("#", "") === number) ?? getItem(workset.prs, 0)
    const keys = pr[1]
    const merged = release.tone !== "ready"
    return {
      id,
      service: "code",
      title: "PR #" + number + " · " +
        keys.map((key) => workset.tickets.find(([ticketKey]) => ticketKey === key)?.[1]).filter(Boolean).join(" + "),
      status: merged ? "Merged · verified" : "Open · approved",
      verdict: merged ? "Merged." : "Ready to merge.",
      completedVerdict: "Merged.",
      action: merged ? null : "Merge pull request",
      completedStatus: "Merged · verified",
      impact: "Merging starts " + workset.pipeline + " and affects " + release.service + " " + release.version + ".",
      facts: [
        ["AUTHOR", Number(number) % 2 === 0 ? "Maya Chen" : "Alex K."],
        ["BRANCH", "feat/" + (keys[0] ?? "change").toLowerCase() + " → main"],
        ["COMMIT", serviceName.slice(0, 3) + number.slice(-2) + "a7f"],
        ["DIFF", String(8 + keys.length * 3) + " files · +" + String(120 + keys.length * 41) + " −18"],
        ["RELEASE", release.service + " " + release.version]
      ],
      tabs: {
        Files: keys.map((key, index) =>
          "src/" + key.toLowerCase() + "/" + (index === 0 ? "implementation" : "support") + ".ts · changed"
        ),
        Commits: keys.map((key, index) =>
          serviceName.slice(0, 2) + String(index) + number + " · " + key + " implementation"
        ),
        Checks: [
          "Build · passed",
          "Tests · " + (release.tone === "blocked" ? "3 failed" : "passed"),
          "Security · passed"
        ]
      },
      relationships: [
        ...keys.map((key): EntityLink => ({
          kind: "jira",
          label: key + " · Jira",
          relation: "IMPLEMENTS",
          targetId: "jira:" + key
        })),
        {
          kind: "pipeline",
          label: workset.pipeline,
          relation: "DELIVERED BY",
          targetId: "pipeline:" + release.service
        },
        {
          kind: "release",
          label: release.service + " " + release.version,
          relation: "INCLUDED IN",
          targetId: "release:" + release.service
        }
      ],
      activity: [
        merged ? "Merged into main" : "Two reviewers approved",
        String(keys.length) + " Jira items verified",
        workset.pipeline + " linked"
      ]
    }
  }
  if (id === "pipeline:billing-preview:1852" || id === "pipeline:observability-preview:774") {
    const billing = id.includes("billing-preview")
    return {
      id,
      service: "pipeline",
      title: billing ? "billing-preview #1852" : "observability-preview #774",
      status: "Succeeded · 64/64 passed",
      verdict: "Preview passed.",
      completedVerdict: "Preview passed.",
      action: null,
      impact: "Read-only preview execution.",
      facts: [
        ["TRIGGER", "PR #" + (billing ? "291" : "293")],
        ["COMMIT", billing ? "c18a7df" : "b93e12a"],
        ["ARTIFACT", billing ? "billing-service:ops-428" : "billing-observability:ops-428"],
        ["TARGET", "Preview"],
        ["DURATION", billing ? "6m 14s" : "4m 52s"]
      ],
      tabs: {
        Stages: ["Build · passed", "Preview tests · 64/64 passed", "Evidence published"],
        Logs: ["Provider sandbox ready", "All retry scenarios passed", "Preview complete"],
        Artifacts: [
          billing ? "billing-service:ops-428" : "billing-observability:ops-428",
          "preview-report.json",
          "trace-evidence.json"
        ]
      },
      relationships: [
        {
          kind: "code",
          label: "PR #" + (billing ? "291" : "293"),
          relation: "TRIGGERED BY",
          targetId: "pr:billing-service:" + (billing ? "291" : "293")
        },
        { kind: "jira", label: "OPS-428 · Retry policy", relation: "VERIFIES", targetId: "jira:OPS-428" }
      ],
      activity: ["64/64 preview checks passed", "Evidence published", "Preview completed"]
    }
  }
  if (id.startsWith("pipeline:")) {
    const serviceName = id.slice("pipeline:".length)
    const releaseIndex = Math.max(0, releasePortfolio.findIndex(({ service }) => service === serviceName))
    const release = getItem(releasePortfolio, releaseIndex)
    const workset = getItem(releaseWorksets, releaseIndex)
    const failed = release.tone === "blocked"
    const status = failed
      ? "Failed · 3 tests"
      : release.tone === "moving"
      ? "Deploying · live"
      : release.tone === "shipped"
      ? "Succeeded"
      : release.tone === "building"
      ? "Building"
      : release.tone === "warning"
      ? "Held · missing evidence"
      : "Passed · ready"
    return {
      id,
      service: "pipeline",
      title: workset.pipeline,
      status,
      verdict: failed
        ? "Tests failed."
        : release.tone === "moving"
        ? "Deploying now."
        : release.tone === "shipped"
        ? "Succeeded."
        : release.tone === "warning"
        ? "Waiting for evidence."
        : "Execution is live.",
      completedVerdict: failed ? "Retry started." : "Action started.",
      action: failed
        ? "Retry failed stage"
        : release.tone === "ready"
        ? "Start deployment"
        : release.tone === "moving"
        ? "Watch live"
        : null,
      completedStatus: failed ? "Retry queued · running" : release.tone === "ready" ? "Deploying · started" : status,
      impact: "Changes " + workset.pipeline + "; target is " + release.service + " " + release.version + ".",
      facts: [
        ["TRIGGER", releaseIndex % 2 === 0 ? "Maya Chen" : "Release Guardian"],
        ["COMMIT", release.service.slice(0, 3) + String(releaseIndex) + "a84"],
        ["ARTIFACT", release.service + ":" + release.version],
        ["TARGET", release.tone === "building" ? "Build workers" : "Production"],
        ["DURATION", String(8 + releaseIndex) + "m " + String(12 + releaseIndex * 3) + "s"]
      ],
      tabs: {
        Stages: workset.events.map(([time, label, detail]) => time + " · " + label + " · " + detail),
        Logs: workset.events.map(([time, label]) => time + ":00 [" + label.toUpperCase() + "] " + release.service),
        Artifacts: [
          release.service + ":" + release.version,
          release.service + "-" + release.version + ".sbom",
          "Execution evidence bundle"
        ]
      },
      relationships: [
        ...workset.prs.map(([pr]): EntityLink => ({
          kind: "code",
          label: "PR " + pr + " · " + release.service,
          relation: "TRIGGERED BY",
          targetId: "pr:" + release.service + ":" + pr.replace("#", "")
        })),
        {
          kind: "release",
          label: release.service + " " + release.version,
          relation: "DEPLOYS",
          targetId: "release:" + release.service
        },
        {
          kind: "confluence",
          label: workset.confluence,
          relation: "RUNBOOK",
          targetId: "page:" + workset.confluence.split(" ")[0]
        }
      ],
      activity: workset.events.map(([time, label]) => time + " · " + label)
    }
  }
  if (id.startsWith("page:")) {
    const pageKey = id.slice("page:".length)
    if (pageKey === "RUN-70") {
      return {
        id,
        service: "confluence",
        title: "RUN-70 · Provider degradation response",
        status: "Current · updated 10:09",
        verdict: "Runbook is current.",
        completedVerdict: "Runbook verified.",
        action: null,
        impact: "Read-only verified WIP evidence.",
        facts: [["OWNER", "Alex K."], ["VERSION", "70"], ["WORKSTREAM", "OPS-428"], ["STATE", "Current"], [
          "WATCHERS",
          "6 people"
        ]],
        tabs: {
          Primary: [
            "Provider degradation response",
            "Scope · billing provider retries",
            "Signal · consecutive provider timeouts",
            "Command · billing failover --bounded-retry"
          ],
          Activity: ["Updated at 10:09", "Linked to PR #291", "Verified against preview #1852"]
        },
        relationships: [{
          kind: "jira",
          label: "OPS-428 · Retry policy",
          relation: "SUPPORTS",
          targetId: "jira:OPS-428"
        }, { kind: "code", label: "PR #291", relation: "DOCUMENTS", targetId: "pr:billing-service:291" }],
        activity: ["Updated at 10:09", "Release Guardian verified page", "Linked to WIP"]
      }
    }
    if (pageKey === "RUN-56" || pageKey === "RUN-67") {
      const risk = pageKey === "RUN-56"
      return {
        id,
        service: "confluence",
        title: risk ? "RUN-56 · Risk analyst rollout guide" : "RUN-67 · Ledger recovery guide",
        status: "Current · relationship verified",
        verdict: "Runbook is current.",
        completedVerdict: "Runbook verified.",
        action: null,
        impact: "Verified repair evidence is read-only.",
        facts: [
          ["OWNER", "Nina Patel"],
          ["VERSION", risk ? "56" : "67"],
          ["RELEASE", risk ? "risk-engine 0.18.0" : "ledger-worker 3.4.0"],
          ["STATE", "Current"],
          ["WATCHERS", risk ? "7 people" : "5 people"]
        ],
        tabs: {
          Primary: [
            risk ? "Risk analyst rollout guide" : "Ledger recovery guide",
            risk
              ? "Scope · score override explanations and analyst rollout"
              : "Scope · ledger recovery and reconciliation",
            risk ? "Before you begin · verify risk-production #266" : "Before you begin · verify ledger-build #912",
            risk ? "Command · risk rollout --evidence RUN-56" : "Command · ledger recover --guide RUN-67"
          ],
          Activity: ["Relationship repair applied", "Owner approval verified", "Release Guardian synchronized evidence"]
        },
        relationships: [{
          kind: "jira",
          label: risk ? "DOC-106 · Analyst rollout guide" : "DOC-97 · Recovery documentation",
          relation: "DOCUMENTS",
          targetId: risk ? "jira:DOC-106" : "jira:DOC-97"
        }, {
          kind: "release",
          label: risk ? "risk-engine 0.18.0" : "ledger-worker 3.4.0",
          relation: "APPLIES TO",
          targetId: risk ? "release:risk-engine" : "release:ledger-worker"
        }],
        activity: ["Relationship repair applied", "Owner approval verified", "Release evidence synchronized"]
      }
    }
    const releaseIndex = Math.max(0, releaseWorksets.findIndex(({ confluence }) => confluence.startsWith(pageKey)))
    const workset = releaseWorksets[releaseIndex]!
    const release = releasePortfolio[releaseIndex]!
    const stale = workset.confluence.toLowerCase().includes("outdated")
    return {
      id,
      service: "confluence",
      title: workset.confluence,
      status: stale ? "Outdated · action required" : "Current · verified",
      verdict: stale ? "Runbook is stale." : "Runbook is current.",
      completedVerdict: "Runbook verified.",
      action: stale ? "Update from evidence" : null,
      completedStatus: "Current · owner approved · published",
      impact: "Updates evidence for " + release.service + " " + release.version +
        "; publishing requires owner confirmation.",
      facts: [
        ["OWNER", releaseIndex % 2 === 0 ? "Nina Patel" : "Maya Chen"],
        ["VERSION", String(54 + releaseIndex)],
        ["RELEASE", release.service + " " + release.version],
        ["STATE", stale ? "Stale" : "Verified"],
        ["WATCHERS", String(4 + releaseIndex) + " people"]
      ],
      tabs: {
        Primary: [
          pageKey + " · " + release.service + " operations",
          "Scope · " + release.service + " " + release.version,
          "Before you begin · verify " + workset.pipeline,
          "Command · pipeline rollback " + release.service + " --to previous"
        ],
        Activity: [
          "Release Guardian checked evidence",
          "Linked to " + workset.pipeline,
          "Revision " + String(54 + releaseIndex) + " published"
        ]
      },
      relationships: [{
        kind: "pipeline",
        label: workset.pipeline,
        relation: "VERIFIES",
        targetId: "pipeline:" + release.service
      }, {
        kind: "release",
        label: release.service + " " + release.version,
        relation: "APPLIES TO",
        targetId: "release:" + release.service
      }],
      activity: ["Release Guardian checked evidence", "Linked to " + workset.pipeline, "Owner review recorded"]
    }
  }
  if (id === "clockify:payments-rollup") {
    return {
      id: "clockify:payments-rollup",
      service: "clockify",
      title: "Implementation time · payments-api 2.18.0",
      status: "Approved · fully attributed",
      verdict: "3h 45m attributed.",
      completedVerdict: "3h 45m attributed.",
      action: null,
      impact: "Approved roll-up is read-only.",
      facts: [["CONTRIBUTORS", "Alex K. · Maya Chen"], ["PROJECT", "Payments"], ["DATE", "12 July 2026"], [
        "BILLABLE",
        "Yes"
      ], ["TOTAL", "3h 45m"]],
      tabs: {
        Primary: [
          "Alex K. · 2h 25m · OPS-412 / PR #284",
          "Maya Chen · 1h 20m · PAY-119 / review",
          "All time is attributed"
        ],
        Activity: ["Roll-up approved", "6 work objects linked", "Clockify synchronized"]
      },
      relationships: [
        {
          kind: "jira",
          label: "OPS-412 · Production access approval",
          relation: "ATTRIBUTED TO",
          targetId: "jira:OPS-412"
        },
        { kind: "code", label: "PR #284 · Audit logging", relation: "ATTRIBUTED TO", targetId: "pr:payments-api:284" },
        { kind: "release", label: "payments-api 2.18.0", relation: "INCLUDED IN", targetId: "release:payments-api" }
      ],
      activity: ["Roll-up approved", "3h 45m fully attributed", "Clockify synchronized"]
    }
  }
  return {
    id,
    service: "code",
    title: `Unknown entity · ${id}`,
    status: "Not found",
    verdict: "Object not found.",
    completedVerdict: "Object not found.",
    action: null,
    impact: "No action is available for an unknown object.",
    facts: [["REQUESTED ID", id], ["STATE", "Not found"]],
    tabs: {
      Primary: [
        "This stable entity ID does not exist in the current demo dataset.",
        "Return to the release overview and choose a connected object."
      ],
      Activity: []
    },
    relationships: [{ kind: "release", label: "Release overview", relation: "RECOVER", targetId: "release:overview" }],
    activity: ["Entity resolution failed safely"]
  }
}

export const paymentTicketDetails: ReadonlyArray<TraceDetail> = releaseTickets.map((ticket, index) => {
  const pr = index === 1 || index === 4 ? "PR #279" : index === 5 ? null : "PR #284"
  const assignee = index % 2 === 0 ? "Alex K." : "Maya Chen"
  return {
    type: "Jira issue",
    title: ticket.key,
    status: ticket.status,
    summary: ticket.title,
    properties: [
      ["Project", ticket.key.split("-")[0] ?? ticket.key],
      ["Assignee", assignee],
      ["Status", ticket.status],
      [
        "Priority",
        index === 0 || index === 5 ? "High" : "Medium"
      ]
    ],
    relations: pr
      ? [["implemented by", pr], ["included in", "payments-api v2.18.0"], [
        "verified by",
        index === 0 ? "Approval policy" : "Pipeline #1842"
      ]]
      : [["included in", "payments-api v2.18.0"], ["missing", "Pull request relationship"], [
        "supported by",
        "Clockify · 1h 20m"
      ]],
    activity: [
      `${ticket.key} synchronized at 10:23`,
      pr ? `${pr} relationship verified` : "Release Guardian found no matching PR",
      `${assignee} updated ${ticket.title.toLowerCase()}`
    ]
  }
})
