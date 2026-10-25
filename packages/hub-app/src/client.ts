/**
 * The browser half of an app: its client module default-exports an {@link AppClient}, and the shell
 * (the hub's superapp or the standalone shell) mounts it into an element it owns.
 *
 * **Mental model**
 *
 * - The app owns its React root (or none): nothing but this context crosses between shell and app, so
 *   the app's React, rly and effect versions are its own business.
 * - The shell owns history, header, crumb, badge and portals. The app asks for them through the context.
 * - Styling: rly tokens arrive as CSS custom properties from the shell; app CSS is scoped under
 *   `[data-app="<id>"]`, which the shell sets on the mount root and on every element it lends the app (header
 *   outlet, slot, portal root), so portaled content is styled too.
 *
 * @module
 */
import { Predicate, Schema } from "effect"

export interface ShellCrumb {
  readonly label: string
  readonly href: string
}

/** A small reading the app shows in the shell header, such as "3 hosts". */
export interface ShellHeaderSlot {
  readonly label: string
  readonly text: string
}

export interface ShellBadge {
  readonly text: string
  readonly label: string
}

export interface ShellContext {
  readonly contract: 1
  readonly mode: "hub" | "standalone"
  /** Absolute path for a module route: `/apps/<id>/v1/modules/<id>/<path>` in the hub, `/api/v1/modules/<id>/<path>` standalone. */
  readonly api: (path: `/${string}`) => string
  /** Headers the app adds to its own module-route requests: the CSRF token standalone, none in the hub. */
  readonly requestHeaders: () => Readonly<Record<string, string>>
  readonly caller: { readonly login: string }
  readonly page: string
  readonly search: URLSearchParams
  /** False while the app's section is hidden; gate portals and focus traps on it. */
  readonly active: boolean
  readonly navigate: (href: string, history: "push" | "replace", focus?: "page" | "search" | null) => void
  readonly closeSelection: (parentHref: string) => void
  /** Items after `Relay › App › Page`; an empty list clears them. */
  readonly setCrumb: (items: ReadonlyArray<ShellCrumb>) => void
  readonly setHeaderSlot: (slot: ShellHeaderSlot | null) => void
  /**
   * An element in the shell's header the app may portal its own header content into, or null while the shell
   * has none (standalone, or a phone layout without one). Pair it with `setHeaderMode("grouped")`. Added after
   * contract 1 shipped, so a shell may leave both out: an app treats a missing pair as no outlet.
   */
  readonly headerOutlet?: HTMLElement | null
  /** `grouped`: the shell yields its header row to the app's outlet content; `shell` restores its own. */
  readonly setHeaderMode?: (mode: "shell" | "grouped") => void
  /** The app has nothing to show; the shell switches to its empty-state chrome. */
  readonly setEmpty: (empty: boolean) => void
  readonly setBadge: (badge: ShellBadge | null) => void
  /** Shell-owned, theme-scoped container for the app's dialogs and popovers. */
  readonly portalRoot: HTMLElement
  /** Hub only. */
  readonly openHostAccess?: () => void
  /**
   * The link to one of the app's pages with these query parameters, in the route shape this shell reads. Added after
   * contract 1 shipped, so a shell may leave it out: an app then builds `?<search>#<id>/<page>` itself.
   */
  readonly href?: (page: string, search?: URLSearchParams) => string
  /** The machine the hub runs on, for copy such as "Usage on <host>". Hub only; added after contract 1 shipped. */
  readonly host?: string
}

export interface MountedApp {
  /** Called on every navigation or activity change while mounted. */
  readonly update: (context: ShellContext) => void
  readonly unmount: () => void
}

/** The default export of an app's client entry. A `contract` the shell doesn't support is not mounted. */
export interface AppClient {
  readonly contract: number
  readonly mount: (root: HTMLElement, context: ShellContext) => MountedApp
}

/** Typed identity for an app's default export. */
export const defineAppClient = (client: AppClient): AppClient => client

/** An app's client module as a shell loads it, checked before it is mounted: a default export with a contract and a mount. */
export const AppClientModule = Schema.Struct({
  default: Schema.Struct({
    contract: Schema.Number,
    mount: Schema.declare((input): input is AppClient["mount"] => Predicate.isFunction(input))
  })
})
