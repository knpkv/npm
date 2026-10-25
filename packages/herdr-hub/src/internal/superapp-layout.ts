/**
 * Which installed modules the super-app shows, and where.
 *
 * @module
 */
import type { AppState } from "@knpkv/hub-app"

const mobileOrder: ReadonlyArray<string> = ["connect", "fleet", "code"]
const primaryOrder: ReadonlyArray<string> = ["connect", "fleet"]
/** Destinations the phone bar holds beside More, as the design draws it. */
const mobileSlots = 4
/**
 * Core modules' places on the `nav.order` scale apps declare, so an app lands between them: Usage (30) sits after
 * Code, where the hub's own Usage was. A core module not listed goes last.
 */
const coreOrder = new Map([
  ["connect", 0],
  ["fleet", 10],
  ["code", 20],
  ["resources", 40],
  ["sandboxes", 50],
  ["stacks", 60]
])

/** An installed app's id and the placement its manifest asks for. */
export interface AppPlacement<Id extends string> {
  readonly id: Id
  readonly nav: { readonly order: number; readonly primary: boolean; readonly mobile: boolean }
}

/** Where an app that has never answered goes: no manifest says otherwise, so last, and not on the phone bar. */
const unplacedNav = { order: 1_000, primary: false, mobile: false }

/**
 * Where each listed app goes: its manifest's placement, or {@link unplacedNav} before it has answered (its nav item,
 * named by its id, keeps its routes resolvable). A core module's duplicate gets none.
 */
export const appPlacements = (states: ReadonlyArray<AppState>): ReadonlyArray<AppPlacement<string>> =>
  states.flatMap((state) =>
    state._tag === "Ready"
      ? [{ id: state.manifest.id, nav: state.manifest.nav }]
      : state.reason === "duplicate"
      ? []
      : [{ id: state.id, nav: state.manifest?.nav ?? unplacedNav }]
  )

/** Module ids for the shell's sidebar, phone bar and primary group, each in display order. */
export interface SuperappLayout<Id extends string> {
  readonly modules: ReadonlyArray<Id>
  readonly mobileModules: ReadonlyArray<Id>
  readonly primaryModules: ReadonlyArray<Id>
}

/**
 * The shell's module ids for this host. A standalone host (`fleet` false) has no Fleet module, so it is
 * dropped from the sidebar and the phone bar, and the sidebar is one flat group with no divider.
 *
 * Apps go by `nav.order` among the core modules, and on the phone bar when `nav.mobile` says so and a slot is left
 * (four destinations beside More; the rest are under More). The primary group
 * stays the hub's own (Connect, Fleet): an app's `nav.primary` is not honoured yet, so installing one never moves
 * the divider.
 */
export const superappLayout = <Id extends string>(
  installed: ReadonlyArray<Id>,
  fleet: boolean,
  apps: ReadonlyArray<AppPlacement<Id>> = []
): SuperappLayout<Id> => {
  const core = installed.filter((id) => fleet || id !== "fleet")
  const placed = [
    ...core.map((id, index) => ({ id, order: coreOrder.get(id) ?? Number.MAX_SAFE_INTEGER, app: 0, index })),
    ...apps.map((app, index) => ({ id: app.id, order: app.nav.order, app: 1, index }))
  ]
  const modules = placed
    .sort((a, b) => a.order - b.order || a.app - b.app || a.index - b.index)
    .map((entry) => entry.id)
  const pick = (order: ReadonlyArray<string>) => order.flatMap((id) => core.filter((module) => module === id))
  const mobileApps = new Set(apps.filter((app) => app.nav.mobile).map((app) => app.id))
  return {
    modules,
    mobileModules: [...pick(mobileOrder), ...modules.filter((id) => mobileApps.has(id))].slice(0, mobileSlots),
    primaryModules: fleet ? pick(primaryOrder) : modules
  }
}
