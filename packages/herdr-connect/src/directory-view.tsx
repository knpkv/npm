import { useSyncExternalStore, type MouseEvent } from "react"

const subscribe = (changed: () => void) => {
  window.addEventListener("popstate", changed)
  return () => window.removeEventListener("popstate", changed)
}

/** Subscribe to the browser URL, shared with the canonical hub's history owner. */
export const useConnectDirectoryLocation = (): string =>
  useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => ""
  )

/** Preserve the owning module and embedded frame while changing the directory view. */
export const connectDirectoryHref = (
  view: "active" | "archived",
  target?: { readonly host: string; readonly id: string }
): string => {
  const url = new URL(window.location.href)
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

/** Unmodified links participate in shared Back/Forward history; modifier clicks remain native links. */
export const navigateConnectDirectory = (event: MouseEvent<HTMLAnchorElement>): void => {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  syncConnectDirectoryHistory(event.currentTarget.href)
}

/** Notify both the directory subscription and its owning hub after a URL-addressable action. */
export const syncConnectDirectoryHistory = (href: string, mode: "push" | "replace" = "push"): void => {
  if (mode === "replace") window.history.replaceState(null, "", href)
  else window.history.pushState(null, "", href)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

/** The directory's URL-addressable views, with Active as the default. */
export const ConnectDirectorySwitch = ({ archived = false }: { readonly archived?: boolean }) => (
  <nav aria-label="Agent directory view" className="connect-directory-switch">
    <a
      aria-current={archived ? undefined : "page"}
      href={connectDirectoryHref("active")}
      onClick={navigateConnectDirectory}
    >
      Active
    </a>
    <a
      aria-current={archived ? "page" : undefined}
      href={connectDirectoryHref("archived")}
      onClick={navigateConnectDirectory}
    >
      Archived
    </a>
  </nav>
)
