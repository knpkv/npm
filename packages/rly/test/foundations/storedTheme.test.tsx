// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { decodeRlyTheme, ThemeProvider, useDocumentTheme, useStoredTheme } from "../../src/foundations/ThemeProvider.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const KEY = "test_theme"
const browserStorage = (): Storage => window.localStorage
const roots: Array<Root> = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  localStorage.clear()
})

const ThemedApp = ({ id }: { readonly id: string }): ReactElement => {
  const [theme, setTheme] = useStoredTheme(KEY, browserStorage)
  return (
    <ThemeProvider data-app={id} theme={theme}>
      <button onClick={() => setTheme("dark")} type="button">
        dark
      </button>
    </ThemeProvider>
  )
}

const mount = async (element: ReactElement): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(element))
  return host
}

const themeOf = (host: ParentNode, id: string): string | null =>
  host.querySelector(`[data-app="${id}"]`)?.getAttribute("data-theme") ?? null

describe("decodeRlyTheme", () => {
  it("accepts only the closed theme names", () => {
    expect(decodeRlyTheme("dark")).toBe("dark")
    expect(decodeRlyTheme("system")).toBe("system")
    expect(decodeRlyTheme("Dark")).toBeUndefined()
    expect(decodeRlyTheme(null)).toBeUndefined()
  })
})

describe("useStoredTheme", () => {
  it("falls back to system for missing or unknown stored values", async () => {
    localStorage.setItem(KEY, "sepia")
    const host = await mount(<ThemedApp id="a" />)
    expect(themeOf(host, "a")).toBe("system")
  })

  it("persists a change and keeps every consumer in the same tab in sync", async () => {
    const host = await mount(
      <>
        <ThemedApp id="a" />
        <ThemedApp id="b" />
      </>
    )
    await act(async () => host.querySelector("button")?.click())
    expect(localStorage.getItem(KEY)).toBe("dark")
    expect(themeOf(host, "a")).toBe("dark")
    expect(themeOf(host, "b")).toBe("dark")
  })

  it("follows changes written by another tab, including a cleared store", async () => {
    const host = await mount(<ThemedApp id="a" />)
    localStorage.setItem(KEY, "light")
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "light" })))
    expect(themeOf(host, "a")).toBe("light")

    localStorage.clear()
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })))
    expect(themeOf(host, "a")).toBe("system")
  })

  it("ignores storage events for other keys", async () => {
    const host = await mount(<ThemedApp id="a" />)
    localStorage.setItem("other", "dark")
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "dark" })))
    expect(themeOf(host, "a")).toBe("system")
  })

  it("hydrates a server-rendered system theme into the stored theme", async () => {
    const host = document.createElement("div")
    host.innerHTML = renderToString(<ThemedApp id="a" />)
    document.body.append(host)
    expect(themeOf(host, "a")).toBe("system")

    localStorage.setItem(KEY, "dark")
    await act(async () => {
      roots.push(hydrateRoot(host, <ThemedApp id="a" />))
    })
    expect(themeOf(host, "a")).toBe("dark")
  })

  it("falls back to system and keeps the choice for the page when storage is refused", async () => {
    const refused = (): Storage => {
      throw new DOMException("denied", "SecurityError")
    }
    const Refused = (): ReactElement => {
      const [theme, setTheme] = useStoredTheme("refused_theme", refused)
      return (
        <ThemeProvider data-app="r" theme={theme}>
          <button onClick={() => setTheme("light")} type="button">
            light
          </button>
        </ThemeProvider>
      )
    }
    const host = await mount(<Refused />)
    expect(themeOf(host, "r")).toBe("system")
    await act(async () => host.querySelector("button")?.click())
    expect(themeOf(host, "r")).toBe("light")
  })

  it("keeps setTheme stable when the caller passes a new storage thunk each render", async () => {
    const setters = new Set<unknown>()
    const Inline = ({ tick }: { readonly tick: number }): ReactElement => {
      const [theme, setTheme] = useStoredTheme(KEY, () => window.localStorage)
      setters.add(setTheme)
      return (
        <ThemeProvider data-tick={tick} theme={theme}>
          x
        </ThemeProvider>
      )
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(<Inline tick={1} />))
    await act(async () => root.render(<Inline tick={2} />))
    expect(setters.size).toBe(1)
  })

  it("rejects a blank storage key", () => {
    expect(() => renderToString(<StoredWithKey storageKey=" " />)).toThrow("visible text")
  })
})

const StoredWithKey = ({ storageKey }: { readonly storageKey: string }): ReactElement => {
  const [theme] = useStoredTheme(storageKey, browserStorage)
  return <ThemeProvider theme={theme}>x</ThemeProvider>
}

describe("useDocumentTheme", () => {
  const DocumentThemed = ({ theme }: { readonly theme: "system" | "light" | "dark" }): ReactElement => {
    useDocumentTheme(theme)
    return <p>content</p>
  }

  it("themes the document root so the viewport canvas and scrollbars follow the choice", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<DocumentThemed theme="light" />))
    expect(document.documentElement.dataset.theme).toBe("light")
    await act(async () => root.render(<DocumentThemed theme="dark" />))
    expect(document.documentElement.dataset.theme).toBe("dark")
    await act(async () => root.unmount())
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it("renders on the server without touching the document", () => {
    expect(renderToString(<DocumentThemed theme="dark" />)).toContain("content")
  })
})
