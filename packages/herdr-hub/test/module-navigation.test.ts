import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Result } from "effect"
import { defineModule, fleetModule, type FleetModuleDestination } from "../src/module-contract.js"
import { canonicalModuleUrl, moduleHref, moduleLinkTarget, readModuleRoute } from "../src/module-navigation.js"

const canonicalFleetUrl = (source: URL) =>
  canonicalModuleUrl(source, [fleetModule], { module: "fleet", page: "approvals" })
const fleetLinkTarget = (href: string, current: URL, click: Parameters<typeof moduleLinkTarget>[2]) =>
  moduleLinkTarget(href, current, click, [fleetModule])

describe("Relay module navigation", () => {
  it("rewrites an old Work link without losing its selected goal", () => {
    const url = canonicalFleetUrl(new URL("https://hub.example/?tab=work&goal=goal-1&window=week"))
    expect(Result.isSuccess(url)).toBe(true)
    if (Result.isFailure(url)) return
    expect(url.success.href).toBe("https://hub.example/?goal=goal-1&window=week#fleet/work")
    expect(readModuleRoute(url.success, [fleetModule])).toEqual(Result.succeed({ module: "fleet", page: "work" }))
  })

  it.each(["approvals", "connect", "work", "usage"])("keeps an old %s tab link", (tab) => {
    const result = canonicalFleetUrl(new URL(`https://hub.example/?tab=${tab}`))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(result.success.href).toBe(`https://hub.example/#fleet/${tab}`)
  })

  it("keeps the hash destination when a stale tab query is also present", () => {
    const result = canonicalFleetUrl(new URL("https://hub.example/?tab=usage&goal=goal-1#fleet/work"))
    if (Result.isFailure(result)) return expect.unreachable()
    expect(result.success.href).toBe("https://hub.example/?goal=goal-1#fleet/work")
  })

  it("reports an unknown tab or hash so the shell can show its default page with a notice", () => {
    for (
      const href of [
        "https://hub.example/?tab=unknown",
        "https://hub.example/?tab=",
        "https://hub.example/#missing/page"
      ]
    ) {
      const result = canonicalFleetUrl(new URL(href))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("ModuleRouteNotFound")
    }
  })

  it("keeps an invalid hash visible even when a valid legacy tab is present", () => {
    const url = new URL("https://hub.example/?tab=work#missing/page")
    expect(canonicalFleetUrl(url)).toMatchObject({ _tag: "Failure", failure: { hash: "#missing/page" } })
    expect(url.href).toBe("https://hub.example/?tab=work#missing/page")
  })

  it("opens a bare module hash on that module's declared default page", () => {
    expect(readModuleRoute(new URL("https://hub.example/#fleet"), [fleetModule])).toEqual(
      Result.succeed({ module: "fleet", page: "approvals" })
    )
  })

  it("refuses a bare module route whose declared default page is not registered", () => {
    expect(
      Result.isFailure(
        readModuleRoute(new URL("https://hub.example/#fleet"), [{ ...fleetModule, defaultPage: "missing" }])
      )
    ).toBe(true)
  })

  it("routes an installed product by its own pages and rejects undeclared pages", () => {
    const notes = defineModule({
      id: "notes",
      label: "Notes",
      defaultPage: "inbox",
      pages: [
        { id: "inbox", label: "Inbox" },
        { id: "archive", label: "Archive" }
      ],
      listeners: ["serve"],
      requires: ["read"]
    })
    expect(readModuleRoute(new URL("https://hub.example/#notes/archive"), [fleetModule, notes])).toEqual(
      Result.succeed({ module: "notes", page: "archive" })
    )
    expect(readModuleRoute(new URL("https://hub.example/#notes"), [fleetModule, notes])).toEqual(
      Result.succeed({ module: "notes", page: "inbox" })
    )
    expect(Result.isFailure(readModuleRoute(new URL("https://hub.example/#notes/work"), [fleetModule, notes]))).toBe(
      true
    )
    expect(moduleHref(notes, "archive", new URLSearchParams({ note: "note-1" }))).toBe("?note=note-1#notes/archive")
  })

  it("keeps destination types limited to pages owned by the selected module", () => {
    expectTypeOf<{ module: "fleet"; page: "work" }>().toExtend<FleetModuleDestination>()
    expectTypeOf<{ module: "fleet"; page: "today" }>().not.toExtend<FleetModuleDestination>()
    expectTypeOf<
      Parameters<typeof canonicalModuleUrl<readonly [typeof fleetModule]>>[2]
    >().toEqualTypeOf<FleetModuleDestination>()
  })

  it("leaves modified clicks to the browser and retains the clicked link's object selectors", () => {
    const current = new URL("https://hub.example/?goal=old#fleet/work")
    const plain = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    const target = fleetLinkTarget("/?tab=work&goal=new&window=week", current, plain)
    if (target === null || Result.isFailure(target)) return expect.unreachable()
    expect(target.success.href).toBe("https://hub.example/?goal=new&window=week#fleet/work")
    for (
      const modified of [
        { ...plain, button: 1 },
        { ...plain, altKey: true },
        { ...plain, ctrlKey: true },
        { ...plain, metaKey: true },
        { ...plain, shiftKey: true }
      ]
    ) {
      expect(fleetLinkTarget("/?tab=work", current, modified)).toBeNull()
    }
    expect(fleetLinkTarget("https://other.example/?tab=work", current, plain)).toBeNull()
    expect(fleetLinkTarget("/connect/?agent=agent-1&open=stage", current, plain)).toBeNull()
  })

  it("keeps module links on the /fleet/ document alias", () => {
    const current = new URL("https://hub.example/fleet/?tab=work")
    const href = moduleHref(fleetModule, "usage")
    expect(new URL(href, current).pathname).toBe("/fleet/")
    const plain = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    const target = fleetLinkTarget(href, current, plain)
    if (target === null || Result.isFailure(target)) return expect.unreachable()
    expect(target.success.href).toBe("https://hub.example/fleet/#fleet/usage")
  })

  it("leaves in-page anchors alone while reporting unknown pages inside installed modules", () => {
    const current = new URL("https://hub.example/#fleet/work")
    const plain = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
    expect(fleetLinkTarget("#main", current, plain)).toBeNull()
    expect(fleetLinkTarget("#fleet/nope", current, plain)).toMatchObject({ _tag: "Failure" })
  })
})
