// @vitest-environment happy-dom
import { BrowserFailure, type Identity, RunnerFailure } from "@knpkv/design-conformance"
import { Effect, Result } from "effect"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  type FontDocument,
  inspectCurrentFont,
  inspectFontDocument,
  type RenderedFontReply
} from "../scripts/design-fonts.js"

// Playwright's Node-side source mapper must not fetch source files through the DOM fixture's browser XHR.
vi.hoisted(() => vi.stubGlobal("XMLHttpRequest", undefined))
beforeEach(() => vi.stubGlobal("XMLHttpRequest", undefined))
afterEach(() => vi.unstubAllGlobals())

const identity = { screen: "usage-limits", state: "populated", viewport: 390, theme: "light" } satisfies Identity
const geist: RenderedFontReply = {
  fonts: [{ familyName: "Geist", postScriptName: "Geist-Regular", isCustomFont: true, glyphCount: 5 }]
}

it("requeries current font targets when React replaces nodes between glyph inspections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = document.createElement("div")
      document.body.append(host)
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => createRoot(host)),
        (root) =>
          Effect.sync(() => {
            flushSync(() => root.unmount())
            host.remove()
          })
      )
      const render = (pass: number) =>
        flushSync(() =>
          root.render(
            <section key={pass}>
              <span>Alpha</span>
              <span>Bravo</span>
            </section>
          )
        )
      render(0)
      // Model the protocol's node handles against real React nodes. Detached handles fail, as CDP does.
      const ids = new WeakMap<Element, number>()
      const nodes = new Map<number, Element>()
      let nextId = 1
      const inspection = {
        currentNodes: () =>
          Effect.sync(() =>
            Array.from(host.querySelectorAll("span"), (element) => {
              const previous = ids.get(element)
              if (previous !== undefined) return previous
              const id = nextId++
              ids.set(element, id)
              nodes.set(id, element)
              return id
            })
          ),
        fonts: (id: number) =>
          Effect.suspend(() => {
            if (nodes.get(id)?.isConnected !== true) {
              return Effect.fail(new RunnerFailure({ detail: "Could not find node with given id" }))
            }
            return Effect.succeed(geist)
          })
      }
      const stale = yield* inspection.currentNodes()
      yield* inspectCurrentFont(inspection, identity, 0, 2, "Alpha")
      render(1)
      const staleId = stale[1]
      if (staleId === undefined) return expect.unreachable("Missing initial target")
      const originalFailure = yield* Effect.result(inspection.fonts(staleId))
      expect(Result.isFailure(originalFailure)).toBe(true)
      if (Result.isFailure(originalFailure)) expect(originalFailure.failure.detail).toContain("Could not find node")
      expect(yield* inspectCurrentFont(inspection, identity, 1, 2, "Bravo")).toEqual(geist)
      render(2)
      expect(yield* inspectCurrentFont(inspection, identity, 0, 2, "Alpha")).toEqual(geist)
      const missing = yield* Effect.result(inspectCurrentFont(inspection, identity, 2, 2, "Missing"))
      expect(Result.isFailure(missing)).toBe(true)
    }).pipe(Effect.scoped)
  ))

type Scenario = "replace-once" | "continuous-churn" | "stable-fallback" | "stale-without-change" | "connection-error"

const changingFontDocument = Effect.fn("Test.changingFontDocument")(function* (scenario: Scenario) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => createRoot(host)),
    (root) =>
      Effect.sync(() => {
        flushSync(() => root.unmount())
        host.remove()
      })
  )
  let pass = 0
  const render = () =>
    flushSync(() =>
      root.render(
        <section key={pass++}>
          <span>Alpha</span>
          <span>Bravo</span>
        </section>
      )
    )
  render()
  let epoch = 0
  const observer = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const observer = new MutationObserver(() => {
        epoch += 1
      })
      observer.observe(host, { childList: true, subtree: true, characterData: true })
      return observer
    }),
    (observer) => Effect.sync(() => observer.disconnect())
  )
  const ids = new WeakMap<Element, number>()
  const nodes = new Map<number, Element>()
  let nextId = 1
  let reads = 0
  let snapshots = 0
  const current = () =>
    Array.from(host.querySelectorAll("span"), (element) => {
      const previous = ids.get(element)
      if (previous !== undefined) return previous
      const id = nextId++
      ids.set(element, id)
      nodes.set(id, element)
      return id
    })
  const inspection = {
    invalidationEpoch: () => 0,
    snapshot: () =>
      Effect.sync(() => {
        snapshots += 1
        if (observer.takeRecords().length > 0) epoch += 1
        return {
          epoch,
          nodes: current().map((id, index) => ({
            id,
            index,
            copy: nodes.get(id)?.textContent ?? "",
            visible: true,
            mono: false,
            weight: "400"
          }))
        } satisfies FontDocument
      }),
    currentNodes: () => Effect.sync(current),
    fonts: (id: number) =>
      Effect.suspend((): Effect.Effect<RenderedFontReply, BrowserFailure | RunnerFailure> => {
        reads += 1
        if (scenario === "connection-error") {
          return Effect.fail(
            new BrowserFailure({ operation: "inspect rendered Usage font", cause: { message: "Session closed" } })
          )
        }
        if (scenario === "stable-fallback") {
          return Effect.succeed({ fonts: geist.fonts.map((font) => ({ ...font, isCustomFont: false })) })
        }
        if ((scenario === "replace-once" && reads === 1) || scenario === "stale-without-change") {
          if (scenario === "replace-once") render()
          return Effect.fail(
            new BrowserFailure({
              operation: "inspect rendered Usage font",
              cause: {
                message:
                  "cdpSession.send: Protocol error (CSS.getPlatformFontsForNode): Could not find node with given id"
              }
            })
          )
        }
        if (nodes.get(id)?.isConnected !== true)
          return Effect.fail(new RunnerFailure({ detail: "Detached target accepted" }))
        if (scenario === "continuous-churn" && reads % 2 === 1) render()
        return Effect.succeed(geist)
      })
  }
  return { inspection, reads: () => reads, snapshots: () => snapshots }
})

it("discards the changed attempt and reacquires all targets after same-count React replacement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* changingFontDocument("replace-once")
      const result = yield* inspectFontDocument(fixture.inspection, identity)
      expect(result.map((item) => item.copy)).toEqual(["Alpha", "Bravo"])
      expect(fixture.reads()).toBe(3)
      expect(fixture.snapshots()).toBe(4)
    }).pipe(Effect.scoped)
  ))

it("stops continuous same-count DOM churn after three whole attempts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* changingFontDocument("continuous-churn")
      const result = yield* Effect.result(inspectFontDocument(fixture.inspection, identity))
      if (Result.isSuccess(result)) return expect.unreachable("Churning document accepted")
      expect(result.failure._tag).toBe("RunnerFailure")
      if (result.failure._tag === "RunnerFailure") expect(result.failure.detail).toContain("after 3 attempts")
      expect(fixture.reads()).toBe(6)
      expect(fixture.snapshots()).toBe(6)
    }).pipe(Effect.scoped)
  ))

it("keeps fallback, unobserved stale-node errors and connection failures terminal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const scenario of [
        "stable-fallback",
        "stale-without-change",
        "connection-error"
      ] satisfies ReadonlyArray<Scenario>) {
        const fixture = yield* changingFontDocument(scenario)
        const result = yield* Effect.result(inspectFontDocument(fixture.inspection, identity))
        if (Result.isSuccess(result)) return expect.unreachable(`${scenario} accepted`)
        expect(result.failure._tag).toBe(scenario === "stable-fallback" ? "RunnerFailure" : "BrowserFailure")
        expect(fixture.reads()).toBe(1)
      }
    }).pipe(Effect.scoped)
  ))
