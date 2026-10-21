import { expect, it } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodeHostView, type CodeHostViewProps, CodeReadStatusView } from "../src/client/components/host-code-view.js"
import type { CodePullRequest, CodeUnavailable } from "../src/host-contract.js"

const ref = "00000000-0000-4000-8000-000000000001"
const props: CodeHostViewProps = {
  active: true,
  page: "diffs",
  selected: ref,
  selectedFile: 0,
  queue: { value: { _tag: "Ready", items: [], more: false, observedAt: 1 }, loading: false, failure: null },
  detail: { value: null, loading: false, failure: null },
  diff: {
    value: {
      _tag: "Ready",
      diff: {
        pullRequestId: "7",
        revisionId: "revision",
        baseCommit: "base",
        headCommit: "head",
        readAt: 1,
        cacheUpdatedAt: 1,
        files: [{
          index: 0,
          status: "modified",
          path: "example.ts",
          previousPath: null,
          beforeMode: "100644",
          afterMode: "100644"
        }]
      }
    },
    loading: false,
    failure: null
  },
  content: { value: null, loading: false, failure: null },
  query: { filter: "open", search: "", offset: 0 },
  tabs: {
    "pull-requests": { label: "Pull requests", href: "#code/pull-requests" },
    reviews: { label: "Reviews", href: "#code/reviews" },
    diffs: { label: "Diffs", href: "#code/diffs" }
  },
  hrefFor: () => `?ref=${ref}#code/diffs`,
  hrefForFile: () => `?ref=${ref}&file=0#code/diffs`,
  nextHref: null,
  ownerUIHref: null,
  onSearch: () => {},
  onFilter: () => {},
  onClose: () => {},
  onRefresh: () => {}
}

it("refuses large DOM diffs while rendering small file text without HTML execution", () => {
  const content = (text: string): CodeHostViewProps["content"] => ({
    value: {
      _tag: "Ready",
      content: {
        fileIndex: 0,
        revisionId: "revision",
        state: "text",
        before: null,
        after: text
      }
    },
    loading: false,
    failure: null
  })
  const small = renderToStaticMarkup(
    createElement(CodeHostView, { ...props, content: content("<script>alert(\"x\")</script>") })
  )
  expect(small).toContain("&lt;script&gt;")
  expect(small).not.toContain("<script>")
  for (const text of ["x".repeat(102_401), "line\n".repeat(2_001)]) {
    const large = renderToStaticMarkup(createElement(CodeHostView, { ...props, content: content(text) }))
    expect(large).not.toContain("<pre")
    expect(large).toContain("exceeds the display limit")
  }
})

it("renders only read controls and machine-local owner links for closed permission states", () => {
  for (
    const reason of ["permission_required", "sign_in_required", "unavailable"] satisfies ReadonlyArray<
      CodeUnavailable["reason"]
    >
  ) {
    const remote = renderToStaticMarkup(
      createElement(CodeHostView, {
        ...props,
        page: "pull-requests",
        selected: null,
        queue: { value: { _tag: "Unavailable", reason, host: null }, loading: false, failure: null }
      })
    )
    expect(remote).not.toContain("127.0.0.1")
    expect(remote).not.toMatch(/>Grant<|>Sign in<|>Publish<|>Approve</)
    expect(remote).toContain("Use the Code owner UI on the credential host.")
    expect(remote).not.toContain("cannot be opened from this device")
    const local = renderToStaticMarkup(
      createElement(CodeHostView, {
        ...props,
        page: "pull-requests",
        selected: null,
        ownerUIHref: "http://127.0.0.1:3000/",
        queue: { value: { _tag: "Unavailable", reason, host: null }, loading: false, failure: null }
      })
    )
    expect(local).toContain("href=\"http://127.0.0.1:3000/\"")
  }
})

it("points an unreadable owner cache at its service without offering hub repair authority", () => {
  const markup = renderToStaticMarkup(
    createElement(CodeHostView, {
      ...props,
      page: "pull-requests",
      selected: null,
      queue: {
        value: { _tag: "Unavailable", reason: "cache_unavailable", host: null },
        loading: false,
        failure: null
      }
    })
  )
  expect(markup).toContain("Check the Code owner service and hub log on this host, then read again.")
  expect(markup).toContain("Read again")
  expect(markup).not.toContain("Start the Code owner UI")
  expect(markup).not.toContain("cannot be opened from this device")
  expect(markup).not.toMatch(/>Migrate<|>Repair<|>Start service<|>Grant</)
})

it("marks a deep-linked diff possibly outdated using the exact cached detail when absent from the queue", () => {
  const detail: CodeHostViewProps["detail"] = {
    value: {
      _tag: "Ready",
      item: {
        ref,
        id: "7",
        repository: "example",
        title: "Example",
        author: "Example",
        status: "OPEN",
        approval: "unknown",
        createdAt: 1,
        updatedAt: 2,
        observedAt: 2
      },
      description: "",
      sourceBranch: "feature",
      destinationBranch: "main"
    },
    loading: false,
    failure: null
  }
  const old = renderToStaticMarkup(createElement(CodeHostView, { ...props, detail }))
  expect(old).toContain("This diff may be outdated")
  expect(old.replace(/<[^>]+>/gu, "")).toContain("Base “Commit title unavailable”. Head “Commit title unavailable”.")
  expect(old).toContain("Read ")
  if (props.diff.value?._tag !== "Ready") return expect.unreachable()
  const fresh = renderToStaticMarkup(
    createElement(CodeHostView, {
      ...props,
      detail,
      diff: { ...props.diff, value: { _tag: "Ready", diff: { ...props.diff.value.diff, cacheUpdatedAt: 2 } } }
    })
  )
  expect(fresh).not.toContain("This diff may be outdated")
})

/** A composed host keeps one stable live region while the painted read states use the approved panels. */
it("renders opt-in read-state panels without changing plain defaults or adding another live region", () => {
  for (
    const [state, kind, words] of [
      [{ value: null, loading: true, failure: null }, "loading", "Reading cached details…"],
      [{ value: null, loading: false, failure: "network" }, "failure", "The hub could not be reached."],
      [
        { value: { _tag: "Unavailable", reason: "other_host", host: "fixture-host" }, loading: false, failure: null },
        "unavailable",
        "Code unavailable"
      ]
    ] satisfies ReadonlyArray<readonly [Parameters<typeof CodeReadStatusView>[0]["state"], string, string]>
  ) {
    const panel = renderToStaticMarkup(
      createElement(CodeReadStatusView, {
        state,
        ownerUIHref: null,
        loadingLabel: "Reading cached details…",
        announce: false,
        presentation: "panel"
      })
    )
    expect(panel).toContain(`data-code-read-notice="${kind}"`)
    expect(panel).toContain(words)
    expect(panel).not.toContain("role=\"status\"")
    expect(panel).not.toContain("aria-live=")
    const plain = renderToStaticMarkup(
      createElement(CodeReadStatusView, { state, ownerUIHref: null, loadingLabel: "Reading cached details…" })
    )
    expect(plain).not.toContain("data-code-read-notice=")
    expect(plain).toContain(words)
  }
})

/** The host supplies one retry; a panel places it after copy without multiplying it across retained states. */
it("embeds the single host action in the current panel and leaves plain callers unchanged", () => {
  const action = createElement("button", { type: "button" }, "Read again")
  for (
    const state of [
      { value: null, loading: false, failure: "network" },
      { value: { _tag: "Unavailable", reason: "unavailable", host: null }, loading: false, failure: null },
      { value: { _tag: "Unavailable", reason: "unavailable", host: null }, loading: true, failure: "network" }
    ] satisfies ReadonlyArray<Parameters<typeof CodeReadStatusView>[0]["state"]>
  ) {
    const panel = renderToStaticMarkup(createElement(CodeReadStatusView, {
      state,
      ownerUIHref: null,
      loadingLabel: "Reading file…",
      presentation: "panel",
      action
    }))
    expect(panel.match(/<button/gu)).toHaveLength(1)
    expect(panel).toMatch(/data-code-read-notice="(?:failure|unavailable)"[^>]*>[\s\S]*Read again<\/button><\/div>/u)
    const plain = renderToStaticMarkup(createElement(CodeReadStatusView, {
      state,
      ownerUIHref: null,
      loadingLabel: "Reading file…",
      action
    }))
    expect(plain).not.toContain("<button")
  }
})

// Read diff from a PR lands on Diffs: the chosen diff is the page's subject, so it comes before the queue
// rather than under every cached row, and it is the focus target the shell moves to.
it("puts the selected pull request's diff before the queue on Diffs", () => {
  const item: CodePullRequest = {
    ref,
    id: "7",
    repository: "example-repository",
    title: "Example change",
    author: "example-author",
    status: "OPEN",
    approval: "waiting",
    createdAt: 1,
    updatedAt: 1,
    observedAt: 1
  }
  const markup = renderToStaticMarkup(
    createElement(CodeHostView, {
      ...props,
      queue: { value: { _tag: "Ready", items: [item], more: false, observedAt: 1 }, loading: false, failure: null }
    })
  )
  const diffAt = markup.indexOf("Read-only diff")
  const queueAt = markup.indexOf("code-host-queue")
  expect(diffAt).toBeGreaterThan(-1)
  expect(queueAt).toBeGreaterThan(-1)
  expect(diffAt).toBeLessThan(queueAt)
  expect(markup).toMatch(/<section class="code-host-diff" tabindex="-1" aria-labelledby="[^"]+"/u)
})

// The hub can't see why the owner stopped refreshing, only when the cache last heard from AWS.
it("says when a queue the owner hasn't refreshed for over an hour last heard from AWS", () => {
  const hour = 3_600_000
  const lastRead = Date.UTC(2026, 9, 7, 21, 42)
  const item = (observedAt: number | null, status: CodePullRequest["status"] = "OPEN"): CodePullRequest => ({
    ref,
    id: "7",
    repository: "example-repository",
    title: "Example change",
    author: "example-author",
    status,
    approval: "waiting",
    createdAt: 1,
    updatedAt: 1,
    observedAt
  })
  const render = (observedAt: number, items: ReadonlyArray<CodePullRequest>) =>
    renderToStaticMarkup(
      createElement(CodeHostView, {
        ...props,
        page: "pull-requests",
        selected: null,
        ownerUIHref: "http://127.0.0.1:4780",
        queue: { value: { _tag: "Ready", items, more: false, observedAt }, loading: false, failure: null }
      })
    )
  const stale = render(lastRead + 8 * 24 * hour, [item(lastRead), item(lastRead - hour)])
  expect(stale).toContain("Not refreshed since")
  expect(stale).toContain(
    "The Code owner refreshes this cache from AWS. Its AWS sign-in may have expired. Open the Code owner UI to check, then read again."
  )
  expect(stale).toContain("href=\"http://127.0.0.1:4780\"")
  expect(render(lastRead + 10 * 60_000, [item(lastRead)])).not.toContain("Not refreshed since")
  expect(render(lastRead + 8 * 24 * hour, [item(null)])).not.toContain("Not refreshed since")
  // A refresh rewrites only open rows: old merged or closed rows in "All cached" say nothing about it.
  expect(render(lastRead + 8 * 24 * hour, [item(lastRead, "MERGED"), item(lastRead, "CLOSED")])).not.toContain(
    "Not refreshed since"
  )
  expect(
    render(lastRead + 8 * 24 * hour, [item(lastRead + 8 * 24 * hour - 60_000), item(lastRead, "MERGED")])
  ).not.toContain("Not refreshed since")
})

it("says Code is not set up on this computer when no credential host is configured", () => {
  const markup = renderToStaticMarkup(
    createElement(CodeHostView, {
      ...props,
      page: "pull-requests",
      selected: null,
      queue: { value: { _tag: "Unavailable", reason: "not_configured", host: null }, loading: false, failure: null }
    })
  )
  expect(markup).toContain("Code isn’t set up on this computer.")
})
