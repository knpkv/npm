import { type ModuleDescriptor, moduleHref, moduleLinkTarget } from "../modules.js"

/** Only the canonical shell translates Fleet's standalone Connect handoff links into its module. */
export const hubModuleLinkTarget = (
  href: string,
  current: URL,
  click: Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  descriptors: ReadonlyArray<ModuleDescriptor>
): ReturnType<typeof moduleLinkTarget> => {
  if (!URL.canParse(href, current)) return null
  const target = new URL(href, current)
  const fleet = descriptors.find((module) => module.id === "fleet")
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
  return moduleLinkTarget(target.href, current, click, descriptors)
}
