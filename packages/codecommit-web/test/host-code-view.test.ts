import { expect, it } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CodeHostView, type CodeHostViewProps } from "../src/client/components/host-code-view.js"
import type { CodeUnavailable } from "../src/host-contract.js"

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
  expect(old).toContain("Base base. Head head.")
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
