// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { connectArchivedParentHref, connectDirectoryHref, ConnectDirectorySwitch } from "../src/directory-view.js"

/** Every derivation clones the owner's URL, so selectors cannot leak between sibling links. */
it("derives archive and live parent links without mutating the supplied location", () => {
  const url = new URL("http://localhost/?view=archived&closed=first&extra=kept#connect/overview")
  const before = url.href
  const live = new URL(connectDirectoryHref("active", { host: "alpha", id: "agent-1" }, url), url)
  const archive = new URL(connectArchivedParentHref(url, "second"), url)
  expect(url.href).toBe(before)
  expect(live.searchParams.get("view")).toBeNull()
  expect(live.searchParams.get("open")).toBe("stage")
  expect(archive.searchParams.get("closed")).toBe("second")
  expect(archive.searchParams.get("view")).toBe("archived")
  expect(live.hash).toBe("#connect/overview")
  expect(archive.hash).toBe("#connect/overview")
})

/** The controlled callback is the only history writer, with no synthetic browser event. */
it("routes plain clicks to the owner and leaves modified clicks native", async () => {
  const navigate = vi.fn()
  const push = vi.spyOn(window.history, "pushState")
  const pop = vi.fn()
  window.addEventListener("popstate", pop)
  const host = document.createElement("div")
  const root = createRoot(host)
  window.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () =>
      root.render(
        <ConnectDirectorySwitch location={{ url: new URL("http://localhost/#connect/overview"), navigate }} />
      )
    )
    const anchor = host.querySelector<HTMLAnchorElement>('a[href*="view=archived"]')
    expect(anchor).not.toBeNull()
    await act(async () =>
      anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
    )
    expect(navigate).toHaveBeenCalledExactlyOnceWith(anchor?.href, "push")
    expect(push).not.toHaveBeenCalled()
    expect(pop).not.toHaveBeenCalled()
    await act(async () =>
      anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }))
    )
    expect(navigate).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    window.removeEventListener("popstate", pop)
    push.mockRestore()
  }
})
