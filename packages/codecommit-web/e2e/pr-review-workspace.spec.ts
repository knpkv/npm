import { expect, type Page, test } from "@playwright/test"

const pullRequest = {
  account: {
    awsAccountId: "111111111111",
    profile: "production",
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

const routeReviewWorkspace = async (page: Page, expectedKind: "explain" | "review" = "review") => {
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
  await page.route("**/api/prs/111111111111/42/relay-review", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      revisionId: "revision-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      kind: expectedKind
    })
    await route.fulfill({
      body: JSON.stringify({
        pullRequestId: "42",
        revisionId: "revision-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        kind: expectedKind,
        result: expectedKind === "explain"
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
      }),
      contentType: "application/json",
      status: 200
    })
  })
}

test("renders a substantive Relay explanation", async ({ page }) => {
  await routeReviewWorkspace(page, "explain")
  await page.goto("/accounts/111111111111/prs/42")

  await page.getByRole("button", { name: "Explain" }).click()
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByRole("heading", { name: "Change explanation" })).toBeVisible()
  await expect(page.getByText("The patch raises the retry budget used by the payment request flow.")).toBeVisible()
})

test("reviews an exact CodeCommit diff with Relay", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 })
  await routeReviewWorkspace(page)
  await page.goto("/accounts/111111111111/prs/42")

  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toBeVisible()
  await expect(page.getByText("export const retries = 3")).toBeVisible()
  await page.getByRole("button", { name: "Run Relay" }).click()
  await expect(page.getByRole("button", { name: /Retry amplification/ })).toBeVisible()
  await expect(page.getByText("P2 · Retry amplification")).toBeVisible()
  await expect(page.getByText("The changed constant expands retries without an idempotency guard.")).toBeVisible()
  await expect(page.getByText("Static patch review only.").first()).toBeVisible()
  await expect(page.getByText("mode 100644 → 100755")).toBeVisible()
  await expect(page.getByLabel("P2 finding: Retry amplification")).toBeVisible()
  await expect(page.getByLabel("P3 finding: Before-path evidence")).toBeVisible()

  await page.screenshot({ fullPage: true, path: "test-results/codecommit-web/pr-review-workspace.png" })
  await page.setViewportSize({ height: 844, width: 390 })
  await expect(page.getByRole("heading", { name: "Diff & Relay" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test("reloads the diff only when the streamed pull request revision changes", async ({ page }) => {
  let eventCount = 0
  let diffRequestCount = 0
  let currentRevision = "revision-1"

  await page.route("**/api/events/", async (route) => {
    eventCount++
    if (eventCount >= 3) currentRevision = "revision-2"
    const fetchedAt = new Date(Date.parse(pullRequest.fetchedAt) + eventCount * 1_000).toISOString()
    const lastModifiedDate = currentRevision === "revision-1"
      ? pullRequest.lastModifiedDate
      : "2026-08-12T09:31:00.000Z"
    await route.fulfill({
      body: `data: ${
        JSON.stringify({
          accounts: [{ ...pullRequest.account, enabled: true }],
          currentUser: "reviewer",
          lastUpdated: fetchedAt,
          pendingReviewCount: 1,
          pullRequests: [{ ...pullRequest, fetchedAt, lastModifiedDate }],
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

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText(`head ${"b".repeat(12)}`)).toBeVisible()
  await expect.poll(() => eventCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(diffRequestCount).toBe(1)
  await expect.poll(() => eventCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  await expect(page.getByText(`head ${"c".repeat(12)}`)).toBeVisible()
  await expect(page.getByText("export const retries = 4")).toBeVisible()
  expect(diffRequestCount).toBe(2)
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
  await page.route("**/api/prs/111111111111/42/relay-review", async (route) => {
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

test("uses a bounded fallback for newline-dense files", async ({ page }) => {
  const denseBefore = Array.from({ length: 2_499 }, (_, index) => `before ${index}`).join("\n")
  const denseAfter = Array.from({ length: 2_499 }, (_, index) => `after ${index}`).join("\n")
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
          path: "src/dense.ts",
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
    await route.fulfill({
      body: JSON.stringify({
        fileIndex: 0,
        revisionId: "revision-1",
        state: "text",
        before: denseBefore,
        after: denseAfter
      }),
      contentType: "application/json",
      status: 200
    })
  })

  await page.goto("/accounts/111111111111/prs/42")
  await expect(page.getByText("Diff too large to render")).toBeVisible()
  await expect(page.getByText("This file exceeds the browser diff-complexity safety limit.")).toBeVisible()
  await expect(page.locator("[data-rly-diff-code-view]")).toHaveCount(0)
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
