import { Result } from "effect"
import {
  type ModuleDescriptor,
  type ModuleDestination,
  moduleHref,
  moduleLinkTarget,
  readModuleRoute
} from "../modules.js"

interface HubModuleAlias {
  readonly from: { readonly _tag: "hash"; readonly value: string } | { readonly _tag: "tab"; readonly value: string }
  readonly to: ModuleDestination
}

/** Migration rows are inert while the source is routable or the destination is not installed. */
export const hubModuleAliases: ReadonlyArray<HubModuleAlias> = [
  { from: { _tag: "hash", value: "#today" }, to: { module: "connect", page: "overview" } },
  { from: { _tag: "hash", value: "#today/overview" }, to: { module: "connect", page: "overview" } },
  { from: { _tag: "hash", value: "#fleet/connect" }, to: { module: "connect", page: "overview" } },
  { from: { _tag: "tab", value: "connect" }, to: { module: "connect", page: "overview" } },
  { from: { _tag: "hash", value: "#fleet/usage" }, to: { module: "usage", page: "by-tool" } },
  { from: { _tag: "tab", value: "usage" }, to: { module: "usage", page: "by-tool" } },
  { from: { _tag: "hash", value: "#usage/by-agent" }, to: { module: "usage", page: "by-tool" } }
]

/**
 * Migrate only retired hub destinations whose replacements are installed. Object selectors
 * stay with the link; explicit hashes take priority over a stale legacy tab parameter.
 */
export const hubModuleUrl = (source: URL, descriptors: ReadonlyArray<ModuleDescriptor>): URL => {
  if (Result.isSuccess(readModuleRoute(source, descriptors))) return new URL(source)
  for (const alias of hubModuleAliases) {
    const matches = alias.from._tag === "hash"
      ? source.hash === alias.from.value
      : source.hash === "" && source.searchParams.get("tab") === alias.from.value &&
        !descriptors.some((module) =>
          module.id === "fleet" && module.pages.some((page) => page.id === alias.from.value)
        )
    if (!matches) continue
    const destination = descriptors.find((module) =>
      module.id === alias.to.module && module.pages.some((page) => page.id === alias.to.page)
    )
    if (destination !== undefined) {
      return new URL(moduleHref(destination, alias.to.page, source.searchParams), source)
    }
  }
  return new URL(source)
}

/** Only the canonical shell translates standalone handoffs and retired module links. */
export const hubModuleLinkTarget = (
  href: string,
  current: URL,
  click: Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  descriptors: ReadonlyArray<ModuleDescriptor>
): ReturnType<typeof moduleLinkTarget> => {
  if (!URL.canParse(href, current)) return null
  const target = new URL(href, current)
  const connect = descriptors.find((module) => module.id === "connect")
  const fleet = descriptors.find((module) => module.id === "fleet")
  if (target.origin === current.origin && target.pathname === "/connect/" && connect !== undefined) {
    return moduleLinkTarget(moduleHref(connect, connect.defaultPage, target.searchParams), current, click, descriptors)
  }
  if (
    target.origin === current.origin && target.pathname === "/connect/" &&
    fleet !== undefined && fleet.pages.some((page) => page.id === "connect")
  ) {
    return moduleLinkTarget(moduleHref(fleet, "connect", target.searchParams), current, click, descriptors)
  }
  // Work's legacy row anchor belongs to the selected goal, now carried in the query.
  if (
    target.pathname === current.pathname && target.searchParams.get("tab") === "work" &&
    target.hash === "#work-selected-goal"
  ) target.hash = ""
  return moduleLinkTarget(hubModuleUrl(target, descriptors).href, current, click, descriptors)
}
