import { useMemo, useSyncExternalStore, type MouseEvent } from "react"

/** A host owns the complete directory URL and every history mutation together. Builders clone url. */
export interface ConnectDirectoryLocation {
  readonly url: URL
  readonly navigate: (href: string, mode: "push" | "replace") => void
  /** Consume a pushed selection or replace a direct selection with its parent using the host's history. */
  readonly closeSelection: (parentHref: string) => void
}

const subscribe = (changed: () => void) => {
  window.addEventListener("popstate", changed)
  return () => window.removeEventListener("popstate", changed)
}
const noSubscription = () => () => {}

/** Controlled directories never subscribe to another module's browser location. */
export const useConnectDirectoryLocation = (location?: ConnectDirectoryLocation): ConnectDirectoryLocation => {
  const href = useSyncExternalStore(
    location === undefined ? subscribe : noSubscription,
    () => location?.url.href ?? window.location.href,
    () => location?.url.href ?? "http://localhost/"
  )
  const navigate = location?.navigate ?? syncConnectDirectoryHistory
  const closeSelection = location?.closeSelection ?? closeStandaloneDirectorySelection
  return useMemo(() => ({ url: new URL(href), navigate, closeSelection }), [href, navigate, closeSelection])
}

/** Preserve the owning module and embedded frame while changing the directory view. */
export const connectDirectoryHref = (
  view: "active" | "archived",
  target?: { readonly host: string; readonly id: string },
  directory?: URL
): string => {
  const url = new URL(directory?.href ?? window.location.href)
  for (const key of ["view", "host", "agent", "open", "closed"]) url.searchParams.delete(key)
  if (view === "archived") url.searchParams.set("view", "archived")
  if (target !== undefined) {
    url.searchParams.set("host", target.host)
    url.searchParams.set("agent", target.id)
    url.searchParams.set("open", "stage")
  }
  return `${url.pathname}${url.search}${url.hash}`
}

/** Link a loaded archive closure while preserving the directory's owning module and fragment. */
export const connectArchivedParentHref = (directory: URL, closure: string): string => {
  const url = new URL(directory.href)
  url.searchParams.set("closed", closure)
  return `${url.pathname}${url.search}${url.hash}`
}

/** Unmodified links use their location owner; modifier clicks remain native links. */
export const navigateConnectDirectory = (
  event: MouseEvent<HTMLAnchorElement>,
  location?: ConnectDirectoryLocation
): void => {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  const navigate = location?.navigate ?? syncConnectDirectoryHistory
  navigate(event.currentTarget.href, "push")
}

/** Standalone history retains its existing null state and popstate notification. Controlled hosts never call this. */
export const syncConnectDirectoryHistory = (href: string, mode: "push" | "replace" = "push"): void => {
  if (mode === "replace") window.history.replaceState(null, "", href)
  else window.history.pushState(null, "", href)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

/** Keep the shipped standalone archive dismissal; embedded hosts supply their own selection close. */
const closeStandaloneDirectorySelection = (href: string): void => syncConnectDirectoryHistory(href, "push")

/** The directory's URL-addressable views, with Active as the default. */
export const ConnectDirectorySwitch = ({
  archived = false,
  home = false,
  location
}: {
  readonly archived?: boolean
  readonly home?: boolean
  readonly location?: ConnectDirectoryLocation | undefined
}) => (
  <nav aria-label="Agent directory view" className={home ? "connect-home-switch" : "connect-directory-switch"}>
    <a
      aria-current={archived ? undefined : "page"}
      href={connectDirectoryHref("active", undefined, location?.url)}
      onClick={(event) => navigateConnectDirectory(event, location)}
    >
      Active
    </a>
    <a
      aria-current={archived ? "page" : undefined}
      href={connectDirectoryHref("archived", undefined, location?.url)}
      onClick={(event) => navigateConnectDirectory(event, location)}
    >
      Archived
    </a>
  </nav>
)
