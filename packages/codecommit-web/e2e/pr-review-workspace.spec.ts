import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"

const pullRequest = {
  account: {
    awsAccountId: "111111111111",
    profile: "production",
    repoAccountId: "111111111111",
    region: "eu-west-1"
  },
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "andrey",
  commentCount: 0,
  commentedBy: [],
  creationDate: "2026-08-07T09:30:00.000Z",
  description: "Keeps provider callbacks idempotent.",
  destinationBranch: "main",
  fetchedAt: "2026-08-12T09:30:00.000Z",
  healthScore: 10,
  id: "42",
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: "2026-08-12T09:30:00.000Z",
  link: "https://console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/pull-requests/42",
  repositoryName: "payments-api",
  sourceBranch: "feature/safe-retries",
  status: "OPEN",
  title: "feat(payments): make retry handling idempotent"
}

const RelayContinuePayload = Schema.Struct({
  currentReview: Schema.Unknown,
  kind: Schema.String,
  message: Schema.String,
  skillIds: Schema.Array(Schema.String),
  turns: Schema.Array(Schema.Struct({ message: Schema.String, role: Schema.String }))
})
type RelayContinuePayload = typeof RelayContinuePayload.Type
const decodeRelayContinuePayload = Schema.decodeUnknownSync(RelayContinuePayload)

const RelayRunPayload = Schema.Struct({
  revisionId: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  kind: Schema.String,
  skillIds: Schema.Array(Schema.String)
})
type RelayRunPayload = typeof RelayRunPayload.Type
const decodeRelayRunPayload = Schema.decodeUnknownSync(RelayRunPayload)

interface ReviewWorkspaceOptions {
  readonly configGate?: Promise<void>
  readonly configStatus?: number
  readonly onRun?: (payload: RelayRunPayload) => void
  readonly review?: () => {
    readonly defaultProfileId: string
    readonly profiles: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly kind: "explain" | "review" | "security" | "tests"
      readonly skillIds: ReadonlyArray<string>
    }>
  }
}

const routeReviewWorkspace = async (
  page: Page,
  expectedKind: "explain" | "review" | "security" | "tests" = "review",
  reviewGate?: Promise<void>,
  onContinue?: (payload: RelayContinuePayload) => void,
  options?: ReviewWorkspaceOptions
) => {
  let findingPosted = false
  const appState = JSON.stringify({
    accounts: [{ ...pullRequest.account, enabled: true }],
    currentUser: "reviewer",
    lastUpdated: "2026-08-12T09:30:00.000Z",
    pendingReviewCount: 1,
    pullRequests: [pullRequest],
    sandboxes: [],
    status: "idle"
  })
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${appState}\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/config", async (route) => {
    await options?.configGate
    if (options?.configStatus !== undefined && options.configStatus !== 200) {
      await route.fulfill({ body: "config unavailable", contentType: "text/plain", status: options.configStatus })
      return
    }
    await route.fulfill({
      body: JSON.stringify({
        accounts: [{ profile: "production", regions: ["eu-west-1"], enabled: true }],
        autoDetect: true,
        autoRefresh: true,
        refreshIntervalSeconds: 300,
        review: options?.review?.() ?? {
          defaultProfileId: "thorough",
          profiles: [{
            id: "thorough",
            name: "Thorough review",
            kind: "review",
            skillIds: ["builtin:pr-review", "builtin:pr-review-diff"]
          }]
        }
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/comments*", async (route) => {
    await route.fulfill({
      body: JSON.stringify([{
        filePath: "src/retry.ts",
        beforeCommitId: "a".repeat(40),
        afterCommitId: "b".repeat(40),
        relativeFileVersion: "AFTER",
        comments: [
          {
            root: {
              id: "comment-1",
              content: "### Keep this retry path idempotent.\n\n**Owner:** reviewer",
              author: "reviewer",
              creationDate: "2026-08-12T10:00:00.000Z",
              deleted: false,
              filePath: "src/retry.ts",
              lineNumber: 1
            },
            replies: []
          },
          {
            root: {
              id: "comment-deleted",
              content: "Deleted provider comment",
              author: "deleted-reviewer",
              creationDate: "2026-08-12T10:00:00.000Z",
              deleted: true,
              filePath: "src/retry.ts",
              lineNumber: 1
            },
            replies: []
          },
          ...(findingPosted
            ? [{
              root: {
                id: "relay-comment-1",
                content: "P2: Retry amplification",
                author: "relay",
                creationDate: "2026-08-12T10:01:00.000Z",
                deleted: false,
                filePath: "src/retry.ts",
                lineNumber: 1
              },
              replies: []
            }]
            : [])
        ]
      }]),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: [{
          index: 0,
          status: "renamed",
          path: "src/retry.ts",
          previousPath: "src/old-retry.ts",
          beforeMode: "100644",
          afterMode: "100755"
        }]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/0?*", async (route) => {
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({
      revisionId: "revision-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40)
    })
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId: "revision-1",
        state: "text",
        before: "export const retries = 2\n",
        after: "export const retries = 3\n"
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review/stream", async (route) => {
    await reviewGate
    const payload = decodeRelayRunPayload(route.request().postDataJSON())
    if (options?.onRun === undefined) {
      expect(payload).toEqual({
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        kind: expectedKind,
        skillIds: ["builtin:pr-review", "builtin:pr-review-diff"]
      })
    } else {
      options.onRun(payload)
    }
    const review = {
      pullRequestId: "42",
      revisionId: "revision-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      kind: payload.kind,
      result: payload.kind === "explain"
        ? {
          verdict: "The retry budget changes one shared request path.",
          explanation: "The patch raises the retry budget used by the payment request flow.",
          findings: []
        }
        : {
          verdict: "One retry regression needs attention.",
          findings: [
            {
              id: "F1",
              priority: "P2",
              title: "Retry amplification",
              summary: "The extra retry can duplicate a non-idempotent request.",
              details: "The changed constant expands retries without an idempotency guard.",
              recommendation: "Require an idempotency key before retrying.",
              verification: "Static patch review only.",
              publicationTarget: "line-comment",
              location: { scope: "line", filePath: "src/retry.ts", line: 1, side: "after" }
            },
            {
              id: "F2",
              priority: "P3",
              title: "Before-path evidence",
              summary: "The removed line carries the old filename.",
              details: "The before-side annotation must resolve the renamed file's previous path.",
              recommendation: "Keep the previous path bound to deletion annotations.",
              verification: "Static patch review only.",
              publicationTarget: "line-comment",
              location: { scope: "line", filePath: "src/old-retry.ts", line: 1, side: "before" }
            }
          ]
        }
    }
    await route.fulfill({
      body: [
        JSON.stringify({ type: "progress", phase: "revision", message: "Checking exact revision" }),
        JSON.stringify({ type: "progress", phase: "agent", message: "Relay is reviewing the exact patch" }),
        JSON.stringify({ type: "complete", review })
      ].join("\n") + "\n",
      contentType: "application/x-ndjson",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review/findings/*/post", async (route) => {
    const finding = route.request().postDataJSON().finding
    findingPosted = true
    await route.fulfill({
      body: JSON.stringify({ findingId: finding.id, operationId: "comment:123", summary: "posted" }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review/continue", async (route) => {
    const payload = decodeRelayContinuePayload(route.request().postDataJSON())
    onContinue?.(payload)
    await route.fulfill({
      body: [
        JSON.stringify({ type: "progress", phase: "agent", message: "Relay is re-checking the finding" }),
        JSON.stringify({
          type: "complete",
          review: {
            pullRequestId: "42",
            revisionId: "revision-1",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            kind: payload.kind,
            result: payload.currentReview
          },
          reply: "Confirmed against the same exact revision."
        })
      ].join("\n") + "\n",
      contentType: "application/x-ndjson",
      status: 200
    })
  })
}

test("shows an actionable error when Relay profiles cannot load", async ({ page }) => {
  await routeReviewWorkspace(page, "review", undefined, undefined, { configStatus: 500 })

  await page.goto("/accounts/111111111111/prs/42")

  await expect(page.getByRole("alert").filter({ hasText: "Relay profiles unavailable" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible()
  await expect(page.getByText("Loading Relay profiles")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Run Relay" })).toBeDisabled()
})

test("enables Relay after delayed profiles finish loading", async ({ page }) => {
  let releaseConfig: () => void = () => undefined
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve
  })
  await routeReviewWorkspace(page, "review", undefined, undefined, { configGate })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText("Loading Relay profiles")).toBeVisible()
  await expect(page.getByRole("button", { name: "Run Relay" })).toBeDisabled()

  releaseConfig()
  await expect(page.getByText("Loading Relay profiles")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Run Relay" })).toBeEnabled()
})

test("renders a substantive Relay explanation", async ({ page }) => {
  await routeReviewWorkspace(page, "explain")
  await page.goto("/accounts/111111111111/prs/42")

  await page.getByRole("button", { name: "Explain" }).click()
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByRole("heading", { name: "Change explanation" })).toBeVisible()
  await expect(page.getByText("The patch raises the retry budget used by the payment request flow.")).toBeVisible()
})

test("continues a completed review with its original focus and skills", async ({ page }) => {
  const continuations: Array<RelayContinuePayload> = []
  const runs: Array<RelayRunPayload> = []
  let defaultProfileId = "thorough"
  await routeReviewWorkspace(page, "security", undefined, (payload) => continuations.push(payload), {
    onRun: (payload) => runs.push(payload),
    review: () => ({
      defaultProfileId,
      profiles: [
        {
          id: "thorough",
          name: "Thorough review",
          kind: "review",
          skillIds: ["builtin:pr-review", "builtin:pr-review-diff"]
        },
        { id: "quick", name: "Quick review", kind: "tests", skillIds: [] }
      ]
    })
  })
  await page.goto("/accounts/111111111111/prs/42")

  await page.getByRole("button", { name: "Security" }).click()
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByText("P2 · Retry amplification")).toBeVisible()
  expect(runs[0]).toMatchObject({
    kind: "security",
    skillIds: ["builtin:pr-review", "builtin:pr-review-diff"]
  })
  defaultProfileId = "quick"
  await page.reload()
  await expect(page.getByLabel("Profile")).toHaveValue("quick")
  await expect(page.getByText("P2 · Retry amplification")).toBeVisible()
  await page.getByRole("button", { name: /Retry amplification/ }).click()
  await page.getByPlaceholder("Ask Relay about this finding…").fill("Continue this security review.")
  await page.getByRole("button", { exact: true, name: "Send" }).click()
  await expect.poll(() => continuations.length).toBe(1)
  expect(continuations[0]).toMatchObject({
    kind: "security",
    message: "Continue this security review.",
    skillIds: ["builtin:pr-review", "builtin:pr-review-diff"],
    turns: []
  })
  await page.getByPlaceholder("Ask Relay about this finding…").fill("Check the evidence once more.")
  await page.getByRole("button", { exact: true, name: "Send" }).click()
  await expect.poll(() => continuations.length).toBe(2)
  expect(continuations[1]).toMatchObject({
    kind: "security",
    message: "Check the evidence once more.",
    turns: [
      { message: "Continue this security review.", role: "user" },
      { message: "Confirmed against the same exact revision.", role: "assistant" }
    ]
  })
  await page.getByRole("button", { name: "Run again" }).click()
  await expect.poll(() => runs.length).toBe(2)
  expect(runs[1]).toMatchObject({ kind: "tests", skillIds: [] })
})

test("retries a failed continuation without persisting the failed turn", async ({ page }) => {
  const continuations: Array<RelayContinuePayload> = []
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/relay-review/continue", async (route) => {
    const payload = decodeRelayContinuePayload(route.request().postDataJSON())
    continuations.push(payload)
    if (continuations.length === 1) {
      await route.fulfill({ body: "Relay unavailable", contentType: "text/plain", status: 500 })
      return
    }
    await route.fulfill({
      body: `${
        JSON.stringify({
          type: "complete",
          review: {
            pullRequestId: "42",
            revisionId: "revision-1",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            kind: payload.kind,
            result: payload.currentReview
          },
          reply: "Confirmed after retry."
        })
      }\n`,
      contentType: "application/x-ndjson",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: "Run Relay" }).click()
  await page.getByRole("button", { name: /Retry amplification/ }).click()
  const message = "Retry this failed follow-up."
  const composer = page.getByPlaceholder("Ask Relay about this finding…")
  await composer.fill(message)
  await page.getByRole("button", { exact: true, name: "Send" }).click()
  await expect(page.getByText("Relay review failed")).toBeVisible()
  await expect(composer).toHaveValue(message)
  expect(continuations[0]?.turns).toEqual([])

  await page.getByRole("button", { exact: true, name: "Send" }).click()
  await expect(page.getByText("Confirmed after retry.")).toBeVisible()
  expect(continuations[1]?.turns).toEqual([])
  await expect(page.getByRole("log").locator("li[data-role=\"user\"]").filter({ hasText: message })).toHaveCount(1)
  await expect(
    page.getByRole("log").locator("li[data-role=\"assistant\"]").filter({ hasText: "Confirmed after retry." })
  ).toHaveCount(1)
})

test("keeps the prior review session atomic when frames follow completion", async ({ page }) => {
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/relay-review/continue", async (route) => {
    const payload = decodeRelayContinuePayload(route.request().postDataJSON())
    await route.fulfill({
      body: [
        JSON.stringify({
          type: "complete",
          review: {
            pullRequestId: "42",
            revisionId: "revision-1",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            kind: payload.kind,
            result: {
              verdict: "This invalid terminal frame must not replace the prior deck.",
              findings: [{
                id: "F3",
                priority: "P1",
                title: "Uncommitted terminal finding",
                summary: "The transport has not reached a clean EOF.",
                details: "A frame follows this complete event.",
                recommendation: "Stage terminal state until EOF.",
                verification: "Malformed transport fixture.",
                publicationTarget: "pr-comment",
                location: { scope: "file", filePath: "src/retry.ts" }
              }]
            }
          },
          reply: "This reply must not be retained."
        }),
        JSON.stringify({ type: "progress", phase: "agent", message: "Invalid frame after completion" })
      ].join("\n") + "\n",
      contentType: "application/x-ndjson",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: "Run Relay" }).click()
  await page.getByRole("button", { name: /Retry amplification/ }).click()
  await page.getByRole("button", { exact: true, name: "Ack" }).first().click()
  await expect(page.getByText("acknowledged")).toBeVisible()
  const persistedBefore = await page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith("codecommit:relay-review-session:")
    )
    return key === undefined ? null : window.sessionStorage.getItem(key)
  })
  expect(persistedBefore).not.toBeNull()

  const composer = page.getByPlaceholder("Ask Relay about this finding…")
  await composer.fill("Try an invalid continuation.")
  await page.getByRole("button", { exact: true, name: "Send" }).click()

  await expect(page.getByText("Relay review failed")).toBeVisible()
  await expect(composer).toHaveValue("Try an invalid continuation.")
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toBeVisible()
  await expect(page.getByText("Uncommitted terminal finding")).toHaveCount(0)
  await expect(page.getByText("acknowledged")).toBeVisible()
  expect(
    await page.evaluate(() => {
      const key = Object.keys(window.sessionStorage).find((candidate) =>
        candidate.startsWith("codecommit:relay-review-session:")
      )
      return key === undefined ? null : window.sessionStorage.getItem(key)
    })
  ).toBe(persistedBefore)
})

test("commits a staged continuation after clean EOF", async ({ page }) => {
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/relay-review/continue", async (route) => {
    const payload = decodeRelayContinuePayload(route.request().postDataJSON())
    await route.fulfill({
      body: `${
        JSON.stringify({
          type: "complete",
          review: {
            pullRequestId: "42",
            revisionId: "revision-1",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            kind: payload.kind,
            result: {
              verdict: "The staged terminal review is committed after clean EOF.",
              findings: [{
                id: "F3",
                priority: "P1",
                title: "Committed terminal finding",
                summary: "The transport reached a clean EOF.",
                details: "No frame follows this complete event.",
                recommendation: "Commit the staged terminal state.",
                verification: "Clean transport fixture.",
                publicationTarget: "pr-comment",
                location: { scope: "file", filePath: "src/retry.ts" }
              }]
            }
          },
          reply: "This reply is retained after clean EOF."
        })
      }\n`,
      contentType: "application/x-ndjson",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: "Run Relay" }).click()
  await page.getByRole("button", { name: /Retry amplification/ }).click()
  await page.getByPlaceholder("Ask Relay about this finding…").fill("Apply the valid continuation.")
  await page.getByRole("button", { exact: true, name: "Send" }).click()

  await expect(page.getByRole("button", { name: /Committed terminal finding/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toHaveCount(0)
  await expect(page.getByText("This reply is retained after clean EOF.")).toBeVisible()
})

test("keeps a continuation reply visible when its finding is withdrawn", async ({ page }) => {
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/relay-review/continue", async (route) => {
    const payload = decodeRelayContinuePayload(route.request().postDataJSON())
    await route.fulfill({
      body: `${
        JSON.stringify({
          type: "complete",
          review: {
            pullRequestId: "42",
            revisionId: "revision-1",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            kind: payload.kind,
            result: {
              verdict: "The retry finding was withdrawn after verification.",
              findings: [{
                id: "F2",
                priority: "P3",
                title: "Before-path evidence",
                summary: "The removed line carries the old filename.",
                details: "The before-side annotation resolves the renamed file's previous path.",
                recommendation: "Keep the previous path bound to deletion annotations.",
                verification: "Static patch review only.",
                publicationTarget: "line-comment",
                location: { scope: "line", filePath: "src/old-retry.ts", line: 1, side: "before" }
              }]
            }
          },
          reply: "F1 is withdrawn because the retry path is now verified idempotent."
        })
      }\n`,
      contentType: "application/x-ndjson",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: "Run Relay" }).click()
  await page.getByRole("button", { name: /Retry amplification/ }).click()
  await page.getByPlaceholder("Ask Relay about this finding…").fill("Withdraw this if it is resolved.")
  await page.getByRole("button", { exact: true, name: "Send" }).click()

  await expect(page.getByRole("button", { name: /Retry amplification/ })).toHaveCount(0)
  await expect(page.getByText("Discuss withdrawn finding")).toBeVisible()
  await expect(page.getByText("F1 is no longer in the current deck")).toBeVisible()
  await expect(page.getByText("F1 is withdrawn because the retry path is now verified idempotent.")).toBeVisible()
})

test("recovers an interrupted finding publication after reload", async ({ page }) => {
  await routeReviewWorkspace(page)
  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByText("P2 · Retry amplification")).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.sessionStorage.length)).toBeGreaterThan(0)
  await page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith("codecommit:relay-review-session:")
    )
    if (key === undefined) throw new Error("Relay session was not stored")
    const session = JSON.parse(window.sessionStorage.getItem(key) ?? "null")
    session.dispositions = { ...session.dispositions, F1: "posting", F2: "posted" }
    window.sessionStorage.setItem(key, JSON.stringify(session))
  })

  await page.reload()
  await expect(page.getByText("failed", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Accept · post" }).first()).toBeEnabled()
  await expect(page.getByRole("button", { exact: true, name: "Ack" }).first()).toBeEnabled()
  await expect(page.getByRole("button", { exact: true, name: "Reject" }).first()).toBeEnabled()
  await expect(page.getByRole("button", { name: "Accept · post" }).nth(1)).toBeDisabled()
})

test("reviews an exact CodeCommit diff with Relay", async ({ page }) => {
  const reviewGate = Promise.withResolvers<void>()
  await page.setViewportSize({ height: 900, width: 1440 })
  await routeReviewWorkspace(page, "review", reviewGate.promise)
  await page.goto("/accounts/111111111111/prs/42")

  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toBeVisible()
  await expect(page.getByText("export const retries = 3")).toBeVisible()
  const srcDirectory = page.getByRole("button", { name: "src, directory, 1 changed file" })
  await expect(srcDirectory).toHaveAttribute("aria-expanded", "true")
  await srcDirectory.click()
  await expect(page.getByRole("button", { name: /File 1 of 1/ })).toHaveCount(0)
  await srcDirectory.click()
  await expect(page.getByRole("button", { name: /File 1 of 1/ })).toBeVisible()
  const directoryBox = await srcDirectory.locator("code").boundingBox()
  const fileBox = await page.getByRole("button", { name: /File 1 of 1/ }).locator("code").boundingBox()
  expect(directoryBox).not.toBeNull()
  expect(fileBox).not.toBeNull()
  expect(fileBox!.x).toBeGreaterThan(directoryBox!.x + 8)
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByRole("button", { name: "Security" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Tests" })).toBeDisabled()
  await expect(page.getByRole("heading", { name: "Relay is reviewing" })).toBeVisible()
  await expect(page.getByText("Live stages are updating above.")).toBeVisible()
  reviewGate.resolve()
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toBeVisible()
  await expect(page.getByText("Relay is reviewing the exact patch")).toBeVisible()
  await expect(page.getByText("P2 · Retry amplification")).toBeVisible()
  await expect(page.getByText("2 actionable findings")).toBeVisible()
  await expect(page.getByText("The changed constant expands retries without an idempotency guard.")).toBeHidden()
  await page.getByText("Evidence & recommendation").first().click()
  await expect(page.getByText("The changed constant expands retries without an idempotency guard.")).toBeVisible()
  expect(
    await page.getByRole("complementary", { name: "Relay findings" }).evaluate((element) =>
      element.getBoundingClientRect().width
    )
  ).toBeGreaterThanOrEqual(480)
  await page.getByRole("button", { name: /^Comments/ }).click()
  await expect(page.getByText("Keep this retry path idempotent.").last()).toBeVisible()
  await page.getByRole("button", { name: "View in diff" }).click()
  await expect(page.getByLabel("CodeCommit comment by reviewer")).toBeInViewport()
  await expect(page.getByLabel("CodeCommit comment by reviewer")).not.toContainText("###")
  await page.getByRole("button", { name: "View in comments" }).click()
  await expect(page.getByText("Keep this retry path idempotent.").last()).toBeInViewport()
  const commentsTrigger = page.getByRole("button", { name: /^Comments/ })
  await commentsTrigger.click()
  await expect(commentsTrigger).toHaveAttribute("aria-expanded", "false")
  await page.getByLabel("CodeCommit comment by reviewer").getByRole("button", { name: "View in comments" }).click()
  await expect(commentsTrigger).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByText("Keep this retry path idempotent.").last()).toBeInViewport()
  await expect(page.getByLabel("CodeCommit comment by deleted-reviewer")).toHaveCount(0)
  await expect(page.getByText("Deleted provider comment")).toHaveCount(0)
  await expect(page.getByText("Static patch review only.").first()).toBeVisible()
  await expect(page.getByText("mode 100644 → 100755")).toBeVisible()
  await expect(page.getByLabel("P2 finding: Retry amplification")).toBeVisible()
  await expect(page.getByLabel("P3 finding: Before-path evidence")).toBeVisible()
  await page.getByRole("button", { name: /Retry amplification/ }).click()
  await page.getByRole("button", { exact: true, name: "Ack" }).first().click()
  await expect(page).toHaveURL(/\/accounts\/111111111111\/prs\/42$/)
  await expect(page.getByText("acknowledged")).toBeVisible()
  await page.getByRole("button", { name: "Accept · post" }).first().click()
  await expect(page.getByText("posted")).toBeVisible()
  await expect(page.getByText("P2: Retry amplification").last()).toBeVisible()
  await expect(page.getByRole("button", { name: /^Comments 1$/ })).toBeVisible()
  await page.getByRole("button", { exact: true, name: "Reject" }).last().click()
  await expect(page.getByText("rejected")).toBeVisible()
  await page.getByPlaceholder("Ask Relay about this finding…").fill("Verify this again.")
  await page.getByRole("button", { exact: true, name: "Send" }).click()
  await expect(page.getByText("Confirmed against the same exact revision.")).toBeVisible()
  for (let index = 1; index <= 4; index++) {
    const message = `Follow-up ${String(index)}`
    await page.getByPlaceholder("Ask Relay about this finding…").fill(message)
    await page.getByRole("button", { exact: true, name: "Send" }).click()
    await expect(page.getByText(message)).toBeVisible()
    await expect(page.getByText("Confirmed against the same exact revision.")).toHaveCount(index + 1)
  }
  const findingDeck = page.getByRole("region", { name: "Findings" })
  expect(await findingDeck.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await findingDeck.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  const conversationHistory = page.getByRole("log", { name: "Conversation history about F1" })
  expect(await conversationHistory.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await conversationHistory.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(page.getByLabel("Message Relay")).toBeInViewport()
  await page.reload()
  await page
    .getByRole("region", { name: "Conversation about F1" })
    .getByRole("button", { exact: true, name: "Open" })
    .click()
  await expect(page.getByText("Verify this again.")).toBeVisible()
  await expect(page.getByText("Confirmed against the same exact revision.")).toHaveCount(5)
  await expect(page.getByText("posted")).toBeVisible()
  await expect(page.getByText("rejected")).toBeVisible()
  await page.getByRole("button", { name: "Run again" }).click()
  await expect(page.getByText("Verify this again.")).toHaveCount(0)
  await expect(page.getByText("Confirmed against the same exact revision.")).toHaveCount(0)

  await page.screenshot({ fullPage: true, path: "test-results/codecommit-web/pr-review-workspace.png" })
  await page.setViewportSize({ height: 844, width: 390 })
  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test("clears a failed publication error after a successful retry", async ({ page }) => {
  let attempts = 0
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/relay-review/findings/*/post", async (route) => {
    attempts++
    if (attempts === 1) {
      await route.fulfill({ body: JSON.stringify({ message: "Provider rejected the comment." }), status: 500 })
      return
    }
    await route.fulfill({
      body: JSON.stringify({ findingId: "F1", operationId: "comment:retry", summary: "posted" }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.goto("/accounts/111111111111/prs/42")

  await page.getByRole("button", { name: "Run Relay" }).click()
  const post = page.getByRole("button", { name: "Accept · post" }).first()
  await post.click()
  await expect(page.getByText("Finding post failed")).toBeVisible()
  await expect(post).toBeEnabled()

  await post.click()
  await expect(page.getByText("posted")).toBeVisible()
  await expect(page.getByText("Finding post failed")).toHaveCount(0)
})

test("keeps an initial diff failure blocking when no exact workspace was retained", async ({ page }) => {
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({ body: "diff unavailable", contentType: "text/plain", status: 500 })
  })
  await page.goto("/accounts/111111111111/prs/42")

  await expect(page.getByText("Exact diff unavailable")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toHaveCount(0)
})

test("rejects description-target findings before presenting a post action", async ({ page }) => {
  let postAttempts = 0
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/relay-review/stream", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        type: "complete",
        review: {
          pullRequestId: "42",
          revisionId: "revision-1",
          baseCommit: "a".repeat(40),
          headCommit: "b".repeat(40),
          kind: "review",
          result: {
            verdict: "Description suggestion.",
            findings: [{
              id: "F1",
              priority: "P2",
              title: "Rewrite the description",
              summary: "The description is incomplete.",
              details: "The patch changes behavior not mentioned in the description.",
              recommendation: "Update the pull-request description.",
              verification: "Static patch review only.",
              publicationTarget: "description",
              location: { scope: "general" }
            }]
          }
        }
      }) + "\n",
      contentType: "application/x-ndjson",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review/findings/*/post", async (route) => {
    postAttempts++
    await route.abort()
  })
  await page.goto("/accounts/111111111111/prs/42")

  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByText("Relay review failed")).toBeVisible()
  await expect(page.getByRole("button", { name: "Accept · post" })).toHaveCount(0)
  expect(postAttempts).toBe(0)
})

test("reloads after a completed manual refresh without refetching for ordinary SSE churn", async ({ page }) => {
  let eventCount = 0
  let diffRequestCount = 0
  let currentRevision = "revision-1"
  let manualRefreshRequested = false
  let manualRefreshCount = 0
  let changedDiffFailures = 0
  const changedRevisionRefresh = Promise.withResolvers<void>()

  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        accounts: [{ profile: "production", regions: ["eu-west-1"], enabled: true }],
        autoDetect: true,
        autoRefresh: true,
        refreshIntervalSeconds: 300,
        review: {
          defaultProfileId: "thorough",
          profiles: [{ id: "thorough", name: "Thorough review", kind: "review", skillIds: [] }]
        }
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review/stream", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        type: "complete",
        review: {
          pullRequestId: "42",
          revisionId: "revision-1",
          baseCommit: "a".repeat(40),
          headCommit: "b".repeat(40),
          kind: "review",
          result: {
            verdict: "One retry regression needs attention.",
            findings: [{
              id: "F1",
              priority: "P2",
              title: "Retry amplification",
              summary: "The extra retry can duplicate a non-idempotent request.",
              details: "The changed constant expands retries without an idempotency guard.",
              recommendation: "Require an idempotency key before retrying.",
              verification: "Static patch review only.",
              publicationTarget: "line-comment",
              location: { scope: "line", filePath: "src/retry.ts", line: 1, side: "after" }
            }]
          }
        }
      }) + "\n",
      contentType: "application/x-ndjson",
      status: 200
    })
  })

  await page.route("**/api/events/", async (route) => {
    eventCount++
    const fetchedAt = new Date(Date.parse(pullRequest.fetchedAt) + eventCount * 1_000).toISOString()
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [{ ...pullRequest, fetchedAt }],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    diffRequestCount++
    if (currentRevision === "revision-2" && changedDiffFailures === 0) {
      changedDiffFailures++
      await route.fulfill({ body: "diff unavailable", contentType: "text/plain", status: 500 })
      return
    }
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: currentRevision,
        baseCommit: "a".repeat(40),
        headCommit: (currentRevision === "revision-1" ? "b" : "c").repeat(40),
        files: [{
          index: 0,
          status: "modified",
          path: "src/retry.ts",
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/0?*", async (route) => {
    const revisionId = new URL(route.request().url()).searchParams.get("revisionId")
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId,
        state: "text",
        before: "export const retries = 2\n",
        after: `export const retries = ${revisionId === "revision-1" ? "3" : "4"}\n`
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/refresh", async (route) => {
    if (manualRefreshRequested) {
      manualRefreshCount++
      if (manualRefreshCount === 1) {
        await route.fulfill({ body: "refresh failed", contentType: "text/plain", status: 500 })
        return
      }
      if (manualRefreshCount === 3) {
        await changedRevisionRefresh.promise
        currentRevision = "revision-2"
      }
    }
    await route.fulfill({
      body: JSON.stringify({
        revisionId: currentRevision,
        headCommit: (currentRevision === "revision-1" ? "b" : "c").repeat(40)
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText(`head ${"b".repeat(12)}`)).toBeVisible()
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toBeVisible()
  await expect(page.getByLabel("P2 finding: Retry amplification")).toBeVisible()
  await expect.poll(() => eventCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(diffRequestCount).toBe(1)
  manualRefreshRequested = true
  const refreshButton = page.getByRole("button", { exact: true, name: "Refresh" })
  await refreshButton.click()
  await expect(page.getByText("Unable to refresh pull request")).toBeVisible()
  await expect(refreshButton).toBeEnabled()
  expect(diffRequestCount).toBe(1)

  await refreshButton.click()
  await expect(refreshButton).toBeEnabled()
  await expect(page.getByText(`head ${"b".repeat(12)}`)).toBeVisible()
  expect(diffRequestCount).toBe(2)

  await refreshButton.click()
  await expect(refreshButton).toBeDisabled()
  expect(diffRequestCount).toBe(2)
  changedRevisionRefresh.resolve()
  await expect(page.getByText("Latest diff unavailable")).toBeVisible()
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toBeVisible()
  await expect(page.getByText(`head ${"b".repeat(12)}`)).toBeVisible()
  expect(diffRequestCount).toBe(3)

  await expect(refreshButton).toBeEnabled()
  await refreshButton.click()
  await expect(page.getByText(`head ${"c".repeat(12)}`)).toBeVisible()
  await expect(page.getByText("export const retries = 4")).toBeVisible()
  const staleReviewMessage = `This finding deck reviewed ${"b".repeat(12)}; current head is ${"c".repeat(12)}.`
  await expect(page.getByText(staleReviewMessage)).toBeVisible()
  await expect(page.getByRole("button", { name: "Re-review latest" })).toBeVisible()
  await expect(page.getByLabel("P2 finding: Retry amplification")).toHaveCount(0)
  expect(diffRequestCount).toBe(4)
})

test("drops exceptional file state when the exact revision changes", async ({ page }) => {
  let currentRevision = "revision-1"
  let manualRefreshRequested = false
  const replacementContent = Promise.withResolvers<void>()
  await routeReviewWorkspace(page)
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    const replacement = currentRevision === "revision-2"
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: currentRevision,
        baseCommit: "a".repeat(40),
        headCommit: (replacement ? "c" : "b").repeat(40),
        files: [
          {
            index: 0,
            status: "modified",
            path: "src/retry.ts",
            previousPath: null,
            beforeMode: "100644",
            afterMode: "100644"
          },
          {
            index: 1,
            status: "modified",
            path: replacement ? "src/replacement.ts" : "src/legacy.bin",
            previousPath: null,
            beforeMode: "100644",
            afterMode: "100644"
          }
        ]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/*?*", async (route) => {
    const fileIndex = Number(new URL(route.request().url()).pathname.split("/").at(-1))
    if (fileIndex === 1 && currentRevision === "revision-1") {
      await route.fulfill({
        body: JSON.stringify({
          fileIndex,
          revisionId: currentRevision,
          state: "binary",
          before: null,
          after: null
        }),
        contentType: "application/json",
        status: 200
      })
      return
    }
    if (fileIndex === 1) await replacementContent.promise
    await route.fulfill({
      body: JSON.stringify({
        fileIndex,
        revisionId: currentRevision,
        state: "text",
        before: "export const value = 1\n",
        after: "export const value = 2\n"
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/refresh", async (route) => {
    if (manualRefreshRequested) currentRevision = "revision-2"
    await route.fulfill({
      body: JSON.stringify({ revisionId: currentRevision, headCommit: "c".repeat(40) }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: /File 2 of 2: src\/legacy\.bin/ }).click()
  await expect(page.getByRole("button", { name: /File 2 of 2: src\/legacy\.bin, modified, binary:/ })).toBeVisible()

  manualRefreshRequested = true
  await page.getByRole("button", { exact: true, name: "Refresh" }).click()
  await expect(page.getByRole("button", { name: /File 2 of 2: src\/replacement\.ts, modified, Ready/ })).toBeVisible()
  replacementContent.resolve()
  await expect(page.getByText("export const value = 2")).toBeVisible()
})

test("invalidates approver refreshes once per observed head without polling churn", async ({ page }) => {
  let approvalRequests = 0
  let diffRequestCount = 0
  let refreshRequestCount = 0
  let currentRevision = "revision-1"

  await page.clock.install()
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    diffRequestCount++
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: currentRevision,
        baseCommit: "a".repeat(40),
        headCommit: (currentRevision === "revision-1" ? "b" : "c").repeat(40),
        files: [{
          index: 0,
          status: "modified",
          path: "src/retry.ts",
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/0?*", async (route) => {
    const revisionId = new URL(route.request().url()).searchParams.get("revisionId")
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId,
        state: "text",
        before: "export const retries = 2\n",
        after: `export const retries = ${revisionId === "revision-1" ? "3" : "4"}\n`
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/approval-rules", async (route) => {
    approvalRequests++
    await route.fulfill({ body: JSON.stringify("ok"), contentType: "application/json", status: 200 })
  })
  await page.route("**/api/prs/111111111111/42/refresh", async (route) => {
    refreshRequestCount++
    if (approvalRequests > 0) currentRevision = "revision-2"
    await route.fulfill({
      body: JSON.stringify({ revisionId: currentRevision, headCommit: "c".repeat(40) }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText(`head ${"b".repeat(12)}`)).toBeVisible()
  expect(diffRequestCount).toBe(1)
  const initialRefreshRequestCount = refreshRequestCount

  await page.getByRole("button", { name: "andrey" }).first().click()
  await expect.poll(() => approvalRequests).toBe(1)
  await page.clock.fastForward(501)
  await expect.poll(() => refreshRequestCount).toBeGreaterThan(initialRefreshRequestCount)
  await expect(page.getByText(`head ${"c".repeat(12)}`)).toBeVisible()
  expect(diffRequestCount).toBe(2)

  await page.clock.fastForward(10_000)
  await expect.poll(() => refreshRequestCount).toBeGreaterThan(initialRefreshRequestCount + 1)
  expect(diffRequestCount).toBe(2)
})

test("scopes file selection to the exact pull request while preserving same-revision layout state", async ({ page }) => {
  const secondPullRequest = {
    ...pullRequest,
    id: "43",
    link: "https://console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/pull-requests/43",
    title: "fix(payments): keep the retry budget bounded"
  }
  const contentRequests = new Map<string, number>()
  const heldSecondPullRequestDiff = Promise.withResolvers<void>()
  let holdSecondPullRequestDiff = false
  await page.clock.install()
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 2,
          pullRequests: [pullRequest, secondPullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/*/diff", async (route) => {
    const pullRequestId = new URL(route.request().url()).pathname.split("/").at(-2) ?? ""
    if (pullRequestId === "43" && holdSecondPullRequestDiff) await heldSecondPullRequestDiff.promise
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId,
        revisionId: `revision-${pullRequestId}`,
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: Array.from({ length: 6 }, (_, index) => ({
          index,
          status: "modified",
          path: `src/pr-${pullRequestId}-${String(index)}.ts`,
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }))
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/*/diff/*?*", async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/")
    const pullRequestId = segments.at(-3) ?? ""
    const fileIndex = Number(segments.at(-1))
    const key = `${pullRequestId}:${String(fileIndex)}`
    contentRequests.set(key, (contentRequests.get(key) ?? 0) + 1)
    await route.fulfill({
      body: JSON.stringify({
        fileIndex,
        revisionId: `revision-${pullRequestId}`,
        state: "text",
        before: `export const value = "${key}:before"\n`,
        after: `export const value = "${key}:after"\n`
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/comments*", async (route) => {
    const pullRequestId = new URL(route.request().url()).searchParams.get("pullRequestId") ?? ""
    await route.fulfill({
      body: JSON.stringify([{
        filePath: `src/pr-${pullRequestId}-0.ts`,
        beforeCommitId: "a".repeat(40),
        afterCommitId: "b".repeat(40),
        relativeFileVersion: "AFTER",
        comments: [{
          root: {
            id: `comment-${pullRequestId}`,
            content: `Comment for PR ${pullRequestId}`,
            author: "reviewer",
            creationDate: "2026-08-12T10:00:00.000Z",
            deleted: false,
            filePath: `src/pr-${pullRequestId}-0.ts`,
            lineNumber: 1
          },
          replies: []
        }]
      }]),
      contentType: "application/json",
      status: 200
    })
  })

  const navigateTo = async (pullRequestId: string): Promise<void> => {
    await page.evaluate((nextPullRequestId) => {
      window.history.pushState({}, "", `/accounts/111111111111/prs/${nextPullRequestId}`)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, pullRequestId)
  }

  await page.goto("/accounts/111111111111/prs/43")
  await expect(page.getByText("export const value = \"43:0:after\"")).toBeVisible()
  expect(contentRequests.get("43:0")).toBe(1)

  await navigateTo("42")
  await expect(page.getByText("PR 42")).toBeVisible()
  await page.getByRole("button", { name: /^Comments/ }).click()
  await expect(page.getByText("Comment for PR 42").last()).toBeVisible()
  await page.getByRole("button", { name: "View in diff" }).click()
  await expect(page.getByLabel("CodeCommit comment by reviewer")).toBeVisible()
  await page.getByRole("button", { name: /File 6 of 6: src\/pr-42-5\.ts/ }).click()
  await expect(page.getByText("export const value = \"42:5:after\"")).toBeVisible()
  await page.clock.fastForward(31_000)

  holdSecondPullRequestDiff = true
  await navigateTo("43")
  await expect(page.getByText("Loading exact diff")).toBeVisible()
  await expect(page.getByText("Comment link unavailable")).toHaveCount(0)
  await expect(page.getByText("export const value = \"42:5:after\"")).toHaveCount(0)
  expect(contentRequests.get("43:5")).toBeUndefined()
  heldSecondPullRequestDiff.resolve()
  await expect(page.getByText("export const value = \"43:0:after\"")).toBeVisible()
  expect(contentRequests.get("43:5")).toBeUndefined()

  await page.getByRole("button", { name: /File 2 of 6: src\/pr-43-1\.ts/ }).click()
  await expect(page.getByText("export const value = \"43:1:after\"")).toBeVisible()
  await page.getByRole("button", { name: "Stacked" }).click()
  await page.getByRole("button", { name: "Wrap" }).click()
  await expect(page.getByText("export const value = \"43:1:after\"")).toBeVisible()
  expect(contentRequests.get("43:1")).toBe(1)
})

test("does not carry a failed Relay run into another pull request", async ({ page }) => {
  const secondPullRequest = {
    ...pullRequest,
    id: "43",
    link: "https://console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/pull-requests/43",
    title: "fix(payments): keep the retry budget bounded"
  }
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 2,
          pullRequests: [pullRequest, secondPullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        accounts: [{ profile: "production", regions: ["eu-west-1"], enabled: true }],
        autoDetect: true,
        autoRefresh: true,
        refreshIntervalSeconds: 300,
        review: {
          defaultProfileId: "thorough",
          profiles: [{ id: "thorough", name: "Thorough review", kind: "review", skillIds: [] }]
        }
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/*/diff", async (route) => {
    const pullRequestId = new URL(route.request().url()).pathname.split("/").at(-2) ?? ""
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId,
        revisionId: `revision-${pullRequestId}`,
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: [{
          index: 0,
          status: "modified",
          path: "src/retry.ts",
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/*/diff/0?*", async (route) => {
    const revisionId = new URL(route.request().url()).searchParams.get("revisionId")
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId,
        state: "text",
        before: "export const retries = 2\n",
        after: "export const retries = 3\n"
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/relay-review/stream", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ message: "Relay failed for PR 42." }),
      contentType: "application/json",
      status: 500
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByText("Relay review failed")).toBeVisible()

  await page.evaluate(() => {
    window.history.pushState({}, "", "/accounts/111111111111/prs/43")
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  await expect(page.getByText("PR 43")).toBeVisible()
  await expect(page.getByText("Relay review failed")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Run Relay" })).toBeEnabled()
})

test("shows a mode-only change even when file text is unchanged", async ({ page }) => {
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: [{
          index: 0,
          status: "modified",
          path: "scripts/retry.ts",
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100755"
        }]
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/0?*", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId: "revision-1",
        state: "text",
        before: "#!/usr/bin/env bun\n",
        after: "#!/usr/bin/env bun\n"
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText("mode 100644 → 100755")).toBeVisible()
  await expect(page.getByText("No textual changes in this file.")).toBeVisible()
})

test("reflects loaded exceptional content states in the file tree", async ({ page }) => {
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: ["text", "binary", "oversized"].map((name, index) => ({
          index,
          status: "modified",
          path: `src/${name}.ts`,
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }))
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/*?*", async (route) => {
    const fileIndex = Number(new URL(route.request().url()).pathname.split("/").at(-1))
    await route.fulfill({
      body: JSON.stringify({
        fileIndex,
        revisionId: "revision-1",
        state: fileIndex === 0 ? "text" : fileIndex === 1 ? "binary" : "oversized",
        before: fileIndex === 0 ? "before\n" : null,
        after: fileIndex === 0 ? "after\n" : null
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.locator("[data-rly-diff-file-id=\"0\"] button")).toHaveAttribute(
    "data-rly-diff-content-state",
    "ready"
  )
  await page.getByRole("button", { name: /File 2 of 3: src\/binary\.ts/ }).click()
  await expect(page.getByText("Binary change")).toBeVisible()
  await expect(page.locator("[data-rly-diff-file-id=\"1\"] button")).toHaveAttribute(
    "data-rly-diff-content-state",
    "binary"
  )
  await page.getByRole("button", { name: /File 3 of 3: src\/oversized\.ts/ }).click()
  await expect(page.getByText("File too large")).toBeVisible()
  await expect(page.locator("[data-rly-diff-file-id=\"2\"] button")).toHaveAttribute(
    "data-rly-diff-content-state",
    "oversized"
  )
})

test("uses a bounded fallback for newline- and byte-dense files", async ({ page }) => {
  const denseBefore = Array.from({ length: 2_499 }, (_, index) => `before ${index}`).join("\n")
  const denseAfter = Array.from({ length: 2_499 }, (_, index) => `after ${index}`).join("\n")
  const minifiedBefore = "a".repeat(300 * 1024)
  const minifiedAfter = "b".repeat(300 * 1024)
  const moderateBefore = "a".repeat(16 * 1024)
  const moderateAfter = "b".repeat(16 * 1024)
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: ["dense", "minified", "moderate"].map((name, index) => ({
          index,
          status: "modified",
          path: `src/${name}.ts`,
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }))
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/*?*", async (route) => {
    const fileIndex = Number(new URL(route.request().url()).pathname.split("/").at(-1))
    await route.fulfill({
      body: JSON.stringify({
        fileIndex,
        revisionId: "revision-1",
        state: "text",
        before: fileIndex === 0 ? denseBefore : fileIndex === 1 ? minifiedBefore : moderateBefore,
        after: fileIndex === 0 ? denseAfter : fileIndex === 1 ? minifiedAfter : moderateAfter
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText("Diff too large to render")).toBeVisible()
  await expect(page.getByText("This file exceeds the browser diff-complexity safety limit.")).toBeVisible()
  await expect(page.locator("[data-rly-diff-code-view]")).toHaveCount(0)
  await expect(page.locator("[data-rly-diff-file-id=\"0\"] button")).toHaveAttribute(
    "data-rly-diff-content-state",
    "oversized"
  )
  await expect(
    page.getByRole("button", {
      name: /File 1 of 3: src\/dense\.ts, modified, oversized: Browser diff complexity safety limit exceeded\./
    })
  ).toBeVisible()
  await page.getByRole("button", { name: /File 2 of 3: src\/minified\.ts/ }).click()
  await expect(page.getByText("Diff too large to render")).toBeVisible()
  await expect(page.locator("[data-rly-diff-code-view]")).toHaveCount(0)
  await page.getByRole("button", { name: /File 3 of 3: src\/moderate\.ts/ }).click()
  await expect(page.locator("[data-rly-diff-code-view]")).toHaveCount(1)
  await expect(page.getByText("Diff too large to render")).toHaveCount(0)
})

test("renders small disjoint and large append-only changes within the complexity budget", async ({ page }) => {
  const smallBefore = Array.from({ length: 20 }, (_, index) => `before ${index}`).join("\n")
  const smallAfter = Array.from({ length: 20 }, (_, index) => `after ${index}`).join("\n")
  const appendOnly = Array.from({ length: 4_000 }, (_, index) => `append ${index}`).join("\n")
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: ["small", "append"].map((name, index) => ({
          index,
          status: "modified",
          path: `src/${name}.ts`,
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }))
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/*?*", async (route) => {
    const fileIndex = Number(new URL(route.request().url()).pathname.split("/").at(-1))
    await route.fulfill({
      body: JSON.stringify({
        fileIndex,
        revisionId: "revision-1",
        state: "text",
        before: fileIndex === 0 ? smallBefore : "",
        after: fileIndex === 0 ? smallAfter : appendOnly
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText("after 0")).toBeVisible()
  await expect(page.locator("[data-rly-diff-code-view]")).toHaveCount(1)
  await page.getByRole("button", { name: /File 2 of 2: src\/append\.ts/ }).click()
  await expect(page.getByText("append 0")).toBeVisible()
  await expect(page.locator("[data-rly-diff-code-view]")).toHaveCount(1)
  await expect(page.getByText("Diff too large to render")).toHaveCount(0)
})

test("evicts inactive file content while retaining same-file rerenders", async ({ page }) => {
  const contentRequests = new Map<number, number>()
  await page.clock.install()
  await page.route("**/api/events/", async (route) => {
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: pullRequest.fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [pullRequest],
          sandboxes: [],
          status: "idle"
        })
      }\n\n`,
      contentType: "text/event-stream",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        files: ["one", "two"].map((name, index) => ({
          index,
          status: "modified",
          path: `src/${name}.ts`,
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }))
      }),
      contentType: "application/json",
      status: 200
    })
  })
  await page.route("**/api/prs/111111111111/42/diff/*?*", async (route) => {
    const fileIndex = Number(new URL(route.request().url()).pathname.split("/").at(-1))
    contentRequests.set(fileIndex, (contentRequests.get(fileIndex) ?? 0) + 1)
    await route.fulfill({
      body: JSON.stringify({
        fileIndex,
        revisionId: "revision-1",
        state: "text",
        before: `export const value = ${fileIndex}\n`,
        after: `export const value = ${fileIndex + 1}\n`
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText("export const value = 1")).toBeVisible()
  await page.getByRole("button", { name: "Stacked" }).click()
  await expect(page.getByText("export const value = 1")).toBeVisible()
  expect(contentRequests.get(0)).toBe(1)

  await page.getByRole("button", { name: /File 2 of 2: src\/two\.ts/ }).click()
  await expect(page.getByText("export const value = 2")).toBeVisible()
  expect(contentRequests.get(1)).toBe(1)
  await page.clock.fastForward(11_000)
  await page.getByRole("button", { name: /File 1 of 2: src\/one\.ts/ }).click()
  await expect.poll(() => contentRequests.get(0)).toBe(2)
})
