// @vitest-environment happy-dom

import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DeferredWorkspaceScrollRestoration,
  rememberWorkspaceScrollPosition,
  shouldRememberWorkspaceScrollPosition,
  workspaceScrollRestorationKey
} from "../../src/client/workspaceScrollRestoration.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const route = {
  hash: "#release-work",
  pathname: "/w/workspace/releases/release",
  search: "?object=issue&relationship=delivery-link"
}
const originalWindowMethods = {
  cancelAnimationFrame: window.cancelAnimationFrame,
  requestAnimationFrame: window.requestAnimationFrame,
  scrollTo: window.scrollTo
}
const originalScrollHeight = Object.getOwnPropertyDescriptor(document.documentElement, "scrollHeight")
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")
const originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY")

let frameId = 0
let frames = new Map<number, FrameRequestCallback>()
let mountedRoot: Root | undefined
let mountedHost: HTMLDivElement | undefined
let scrollCalls: ReadonlyArray<number> = []

const setScrollY = (value: number): void => {
  Object.defineProperty(window, "scrollY", { configurable: true, value })
}

const setViewport = (maximumScrollY: number): void => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 })
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: maximumScrollY + 600
  })
}

const runFrame = (): boolean => {
  const pending = [...frames.values()]
  frames = new Map()
  if (pending.length === 0) return false
  act(() => pending.forEach((callback) => callback(0)))
  return true
}

const mountRestorer = (strict: boolean): void => {
  const restorer = <DeferredWorkspaceScrollRestoration />
  mountedHost = document.createElement("div")
  document.body.append(mountedHost)
  mountedRoot = createRoot(mountedHost)
  act(() =>
    mountedRoot?.render(
      <MemoryRouter initialEntries={[workspaceScrollRestorationKey(route)]}>
        {strict ? <StrictMode>{restorer}</StrictMode> : restorer}
      </MemoryRouter>
    )
  )
}

const restoreProperty = (target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void => {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key)
    return
  }
  Object.defineProperty(target, key, descriptor)
}

beforeEach(() => {
  frameId = 0
  frames = new Map()
  scrollCalls = []
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    }
  })
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number): void => {
      frames.delete(id)
    }
  })
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: (_x: number, y: number): void => {
      scrollCalls = [...scrollCalls, y]
      setScrollY(y)
    }
  })
  setScrollY(0)
  setViewport(0)
})

afterEach(() => {
  if (mountedRoot !== undefined) act(() => mountedRoot?.unmount())
  mountedHost?.remove()
  mountedRoot = undefined
  mountedHost = undefined
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: originalWindowMethods.cancelAnimationFrame
  })
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: originalWindowMethods.requestAnimationFrame
  })
  Object.defineProperty(window, "scrollTo", { configurable: true, value: originalWindowMethods.scrollTo })
  restoreProperty(document.documentElement, "scrollHeight", originalScrollHeight)
  restoreProperty(window, "innerHeight", originalInnerHeight)
  restoreProperty(window, "scrollY", originalScrollY)
  vi.restoreAllMocks()
})

describe("workspace scroll restoration", () => {
  it("keys the exact route, filters, selection, and anchor independently of history identity", () => {
    const firstHistoryEntry = { ...route, key: "first" }
    const secondHistoryEntry = { ...route, key: "second" }

    expect(workspaceScrollRestorationKey(route)).toBe(
      "/w/workspace/releases/release?object=issue&relationship=delivery-link#release-work"
    )
    expect(workspaceScrollRestorationKey(firstHistoryEntry)).toBe(workspaceScrollRestorationKey(secondHistoryEntry))
    expect(workspaceScrollRestorationKey({ ...route, search: "?object=other" })).not.toBe(
      workspaceScrollRestorationKey(route)
    )
  })

  it("captures only primary unmodified same-tab router navigations", () => {
    const primaryClick = {
      altKey: false,
      button: 0,
      ctrlKey: false,
      defaultPrevented: false,
      metaKey: false,
      shiftKey: false
    }

    expect(shouldRememberWorkspaceScrollPosition(primaryClick, "")).toBe(true)
    expect(shouldRememberWorkspaceScrollPosition(primaryClick, "_self")).toBe(true)
    expect(shouldRememberWorkspaceScrollPosition({ ...primaryClick, button: 1 }, "")).toBe(false)
    expect(shouldRememberWorkspaceScrollPosition({ ...primaryClick, ctrlKey: true }, "")).toBe(false)
    expect(shouldRememberWorkspaceScrollPosition({ ...primaryClick, defaultPrevented: true }, "")).toBe(false)
    expect(shouldRememberWorkspaceScrollPosition({ ...primaryClick, metaKey: true }, "")).toBe(false)
    expect(shouldRememberWorkspaceScrollPosition({ ...primaryClick, shiftKey: true }, "")).toBe(false)
    expect(shouldRememberWorkspaceScrollPosition(primaryClick, "_blank")).toBe(false)
  })

  it("survives StrictMode replay and consumes the target after the first real restoration", () => {
    setViewport(1_000)
    setScrollY(1_000)
    rememberWorkspaceScrollPosition(route)
    setScrollY(0)

    mountRestorer(true)
    expect(frames.size).toBe(1)
    expect(runFrame()).toBe(true)
    expect(window.scrollY).toBe(1_000)
    expect(scrollCalls).toEqual([1_000])

    act(() => mountedRoot?.unmount())
    mountedRoot = undefined
    mountedHost?.remove()
    mountedHost = undefined
    setScrollY(0)
    scrollCalls = []
    mountRestorer(true)
    expect(runFrame()).toBe(false)
    expect(window.scrollY).toBe(0)
    expect(scrollCalls).toEqual([])
  })

  it("stops retrying an unreachable stable target without overriding later user scrolling", () => {
    setViewport(200)
    setScrollY(1_000)
    rememberWorkspaceScrollPosition(route)
    setScrollY(0)

    mountRestorer(false)
    expect(runFrame()).toBe(true)
    expect(window.scrollY).toBe(200)
    setScrollY(0)
    for (let attempt = 0; attempt < 20 && runFrame(); attempt += 1) {
      // Drain the bounded stability window.
    }

    expect(frames.size).toBe(0)
    expect(window.scrollY).toBe(0)
    expect(scrollCalls).toEqual([200])
  })

  it("follows a growing lazy page until the saved target becomes reachable", () => {
    setViewport(200)
    setScrollY(1_000)
    rememberWorkspaceScrollPosition(route)
    setScrollY(0)

    mountRestorer(false)
    expect(runFrame()).toBe(true)
    setViewport(400)
    expect(runFrame()).toBe(true)
    setViewport(700)
    expect(runFrame()).toBe(true)
    setViewport(1_000)
    expect(runFrame()).toBe(true)

    expect(frames.size).toBe(0)
    expect(window.scrollY).toBe(1_000)
    expect(scrollCalls).toEqual([200, 400, 700, 1_000])
  })
})
