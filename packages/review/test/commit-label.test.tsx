// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CommitLabel,
  type CommitSummary,
  type CommitSummaryReading,
  CommitSummaryProvider,
  commitTimeWords,
  useCommitSummaries,
  useCommitWords
} from "../src/commit-label.js"

const fullId = "c41e7a2f5b0d9e8c7a6b5f4e3d2c1b0a9f8e7d6c"
const now = Date.UTC(2026, 9, 17, 15, 0)

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ""
})

const render = (reading: CommitSummaryReading, copy?: boolean): HTMLElement => {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      <CommitSummaryProvider source={{ read: () => reading, now, timeZone: "UTC" }}>
        <p>
          Reviewed 14:02, head <CommitLabel commit={fullId} {...(copy === undefined ? {} : { copy })} />
        </p>
      </CommitSummaryProvider>
    )
  )
  return container
}

describe("commitTimeWords", () => {
  it("gives only the time for a commit made today and the date too otherwise", () => {
    expect(commitTimeWords(Date.UTC(2026, 9, 17, 14, 18), now, "UTC")).toBe("14:18")
    expect(commitTimeWords(Date.UTC(2026, 9, 15, 14, 18), now, "UTC")).toBe("15 Oct 14:18")
  })

  it("gives the date too when there is no reading time to call today", () => {
    expect(commitTimeWords(Date.UTC(2026, 9, 17, 14, 18), null, "UTC")).toBe("17 Oct 14:18")
  })

  it("decides today in the reader's zone", () => {
    expect(commitTimeWords(Date.UTC(2026, 9, 16, 23, 30), now, "Europe/Amsterdam")).toBe("01:30")
  })
})

describe("CommitLabel", () => {
  it("names the commit by title and time and never shows its id", () => {
    const view = render({
      _tag: "Ready",
      title: "Restore the draft on reconnect",
      committedAt: Date.UTC(2026, 9, 17, 14, 18)
    })
    expect(view.textContent).toBe("Reviewed 14:02, head “Restore the draft on reconnect, 14:18”")
    expect(view.textContent).not.toMatch(/c41e7a2/)
    expect(view.querySelector(".rv-commit-words")?.getAttribute("title")).toBe(
      `Restore the draft on reconnect\nCommit ${fullId}`
    )
  })

  it("copies the full commit id from its button", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const view = render({ _tag: "Ready", title: "Restore the draft on reconnect", committedAt: now })
    const button = view.querySelector<HTMLButtonElement>("button[aria-label='Copy commit id']")
    expect(button).not.toBeNull()
    await act(async () => button?.click())
    expect(writeText).toHaveBeenCalledWith(fullId)
  })

  it("leaves the copy button out where there is no room for it, keeping the tooltip", () => {
    const view = render({ _tag: "Ready", title: "Restore the draft on reconnect", committedAt: now }, false)
    expect(view.querySelector("button")).toBeNull()
    expect(view.querySelector(".rv-commit-words")?.getAttribute("title")).toContain(`Commit ${fullId}`)
  })

  it("says the title is unavailable, with the time when it is known, and keeps the copy button", () => {
    expect(render({ _tag: "Ready", title: null, committedAt: Date.UTC(2026, 9, 17, 14, 2) }).textContent).toBe(
      "Reviewed 14:02, head “Commit title unavailable, 14:02”"
    )
    act(() => root?.unmount())
    const failed = render({ _tag: "Unavailable" })
    expect(failed.textContent).toBe("Reviewed 14:02, head “Commit title unavailable”")
    expect(failed.querySelector("button[aria-label='Copy commit id']")).not.toBeNull()
  })

  it("reads as busy, without the id, while the title loads", () => {
    const view = render({ _tag: "Loading" })
    expect(view.textContent).toBe("Reviewed 14:02, head “Reading commit…”")
    expect(view.querySelector("[aria-busy='true']")).not.toBeNull()
  })
})

describe("useCommitSummaries", () => {
  it("loads each commit once and shows a failed load as unavailable", async () => {
    const calls: Array<string> = []
    const load = (commitId: string) => {
      calls.push(commitId)
      return commitId === "bad"
        ? Promise.reject(new Error("refused"))
        : Promise.resolve({ title: "Restore the draft on reconnect", committedAt: now })
    }
    const Both = () => {
      const source = useCommitSummaries(load, now, "UTC")
      return (
        <CommitSummaryProvider source={source}>
          <CommitLabel commit="good" /> <CommitLabel commit="good" /> <CommitLabel commit="bad" />
        </CommitSummaryProvider>
      )
    }
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<Both />))
    await act(async () => {})
    expect(calls).toEqual(["good", "bad"])
    expect(container.textContent).toContain("“Restore the draft on reconnect, 15:00”")
    expect(container.textContent).toContain("“Commit title unavailable”")
  })
})

describe("useCommitWords", () => {
  it("gives the label as plain text for places that take only text", () => {
    const Fact = () => <output>{useCommitWords(fullId)}</output>
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    act(() =>
      root?.render(
        <CommitSummaryProvider
          source={{
            read: () => ({ _tag: "Ready", title: "Restore the draft on reconnect", committedAt: now }),
            now,
            timeZone: "UTC"
          }}
        >
          <Fact />
        </CommitSummaryProvider>
      )
    )
    expect(container.textContent).toBe("Restore the draft on reconnect, 15:00")
  })
})

describe("useCommitWords for an optional commit", () => {
  it("reads nothing and gives null for no commit", () => {
    const requested: Array<string> = []
    const Fact = () => <output>{useCommitWords(null) ?? "none"}</output>
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    act(() =>
      root?.render(
        <CommitSummaryProvider
          source={{ read: () => ({ _tag: "Loading" }), request: (commit) => requested.push(commit), now }}
        >
          <Fact />
        </CommitSummaryProvider>
      )
    )
    expect(container.textContent).toBe("none")
    expect(requested).toEqual([])
  })
})

describe("useCommitSummaries across loaders and failures", () => {
  const Labels = (props: { readonly load: (commitId: string) => Promise<CommitSummary>; readonly show: boolean }) => {
    const source = useCommitSummaries(props.load, now, "UTC")
    return (
      <CommitSummaryProvider source={source}>{props.show ? <CommitLabel commit="head" /> : null}</CommitSummaryProvider>
    )
  }
  const mount = () => {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    return container
  }

  it("asks again for a commit whose read failed, once a label asks for it again", async () => {
    let calls = 0
    const load = () => {
      calls += 1
      return calls === 1
        ? Promise.reject(new TypeError("refused"))
        : Promise.resolve({ title: "Second try", committedAt: now })
    }
    const container = mount()
    await act(async () => root?.render(<Labels load={load} show />))
    expect(container.textContent).toContain("Commit title unavailable")
    await act(async () => root?.render(<Labels load={load} show={false} />))
    await act(async () => root?.render(<Labels load={load} show />))
    expect(calls).toBe(2)
    expect(container.textContent).toContain("“Second try, 15:00”")
  })

  it("ignores a previous loader's late answer", async () => {
    let finishOld: (summary: CommitSummary) => void = () => undefined
    const old = () =>
      new Promise<CommitSummary>((resolve) => {
        finishOld = resolve
      })
    const current = () => Promise.resolve({ title: "Current pull request", committedAt: now })
    const container = mount()
    await act(async () => root?.render(<Labels load={old} show />))
    await act(async () => root?.render(<Labels load={current} show />))
    await act(async () => finishOld({ title: "Previous pull request", committedAt: now }))
    expect(container.textContent).toContain("“Current pull request, 15:00”")
  })
})

describe("copying a commit id", () => {
  it("says so when the browser refuses the copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new TypeError("denied")) }
    })
    const view = render({ _tag: "Ready", title: "Restore the draft on reconnect", committedAt: now })
    expect(view.querySelector("[role='status'], [role='alert']")).toBeNull()
    await act(async () => view.querySelector<HTMLButtonElement>("button[aria-label='Copy commit id']")?.click())
    expect(view.querySelector("[role='alert']")?.textContent).toBe("Couldn’t copy the commit id")
  })
})
