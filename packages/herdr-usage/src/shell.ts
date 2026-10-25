/**
 * What the Usage client takes from whichever shell mounts it: the header chrome and its page links.
 *
 * @module
 */
import type { ShellContext } from "@knpkv/hub-app"
import type { UsageChrome, UsagePageId } from "./views.js"

/** The parts of a {@link ShellContext} these read; fields added after contract 1 shipped are optional. */
export type UsageShellContext = Pick<ShellContext, "caller" | "setEmpty" | "headerOutlet" | "setHeaderMode"> & {
  readonly host?: string
  readonly href?: (page: string, search?: URLSearchParams) => string
}

/**
 * The header chrome, when the shell can group its header around the page. The outlet may still be null: the hub
 * renders it only once the page asks to group, and until then the page draws its title and tabs inline.
 */
export const usageChrome = (context: UsageShellContext): UsageChrome | null => {
  const { setHeaderMode } = context
  return setHeaderMode === undefined
    ? null
    : {
      host: context.host ?? context.caller.login,
      headerOutlet: context.headerOutlet ?? null,
      setEmpty: context.setEmpty,
      setGrouped: (grouped) => setHeaderMode(grouped ? "grouped" : "shell")
    }
}

/** The link to one Usage page with these selectors: the shell's own when it builds them, else the shared route shape. */
export const usageHref = (context: UsageShellContext) => (page: UsagePageId, search: URLSearchParams): string => {
  if (context.href !== undefined) return context.href(page, search)
  const query = new URLSearchParams(search)
  query.delete("tab")
  return `?${query.toString()}#usage/${page}`
}
