import { describe, expect, it } from "@effect/vitest"
import { AppId, type AppState } from "@knpkv/hub-app"
import { appPlacements, superappLayout } from "../src/internal/superapp-layout.js"

const usage = { id: "usage", nav: { order: 30, primary: true, mobile: true } }

describe("superappLayout", () => {
  it("puts Fleet beside Connect for a host in a fleet", () => {
    expect(superappLayout(["connect", "fleet", "code", "resources", "stacks"], true, [usage])).toEqual({
      modules: ["connect", "fleet", "code", "usage", "resources", "stacks"],
      mobileModules: ["connect", "fleet", "code", "usage"],
      primaryModules: ["connect", "fleet"]
    })
  })

  it("leaves Fleet out everywhere and draws one flat group on a standalone host", () => {
    expect(superappLayout(["connect", "fleet", "code", "resources", "stacks"], false, [usage])).toEqual({
      modules: ["connect", "code", "usage", "resources", "stacks"],
      mobileModules: ["connect", "code", "usage"],
      // One flat group: without Fleet there is nothing to divide Connect from.
      primaryModules: ["connect", "code", "usage", "resources", "stacks"]
    })
  })

  // An installed app takes its manifest's place among the core modules, never the primary group's divider.
  it("places apps by nav.order, on the phone bar only when they ask", () => {
    const later = { id: "later", nav: { order: 100, primary: true, mobile: false } }
    expect(superappLayout(["connect", "fleet", "code", "sandboxes"], true, [later, usage])).toEqual({
      modules: ["connect", "fleet", "code", "usage", "sandboxes", "later"],
      mobileModules: ["connect", "fleet", "code", "usage"],
      primaryModules: ["connect", "fleet"]
    })
  })

  // The phone bar holds four destinations beside More, as the design draws it; later apps are under More.
  it("caps the phone bar at four destinations", () => {
    const mobile = (id: string, order: number) => ({ id, nav: { order, primary: false, mobile: true } })
    expect(superappLayout(["connect", "fleet", "code"], true, [usage, mobile("notes", 31), mobile("later", 90)]))
      .toMatchObject({ mobileModules: ["connect", "fleet", "code", "usage"] })
    expect(superappLayout(["connect", "fleet", "code"], false, [usage, mobile("notes", 31), mobile("later", 90)]))
      .toMatchObject({ mobileModules: ["connect", "code", "usage", "notes"] })
  })

  // An app that has never answered has no manifest, yet keeps a nav item (its id) so its routes resolve; it sorts last
  // and stays off the phone bar. A duplicate of a core id gets none.
  it("places every listed app but duplicates, a never-answered one last and off the phone bar", () => {
    const states: ReadonlyArray<AppState> = [
      {
        _tag: "Unavailable",
        id: AppId.make("fresh"),
        manifest: null,
        reason: "starting",
        detail: "fresh is starting."
      },
      { _tag: "Unavailable", id: AppId.make("connect"), manifest: null, reason: "duplicate", detail: "" }
    ]
    expect(appPlacements(states)).toEqual([{ id: "fresh", nav: { order: 1_000, primary: false, mobile: false } }])
  })
})
