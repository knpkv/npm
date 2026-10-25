// @vitest-environment happy-dom
/**
 * Installed apps in the superapp shell: the shell mounts an app's client into an element it owns, keeps one instance
 * across navigation, swaps it when the app's entry changes, and drops it when the app goes away. A client that throws
 * is shown as `client_failed` without taking the shell down. Clients here are in-memory stand-ins for the module the
 * shell would import from `/apps/<id>/app/assets/<entry>`.
 */
import {
  type AppClientModule,
  AppId,
  type AppManifest,
  type AppState,
  defineAppClient,
  type ShellBadge,
  type ShellContext
} from "@knpkv/hub-app"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type AppModuleOptions, decodeClientModule, makeAppModuleViews } from "../src/app-module-view.js"
import { UsageMovedPanel } from "../src/internal/usage-moved.js"
import { connectModule, type ModuleViews, type ModuleDescriptor } from "../src/modules.js"
import { SuperappShell } from "../src/superapp-view.js"

const manifest = (entry = "client.js", css: ReadonlyArray<string> = []): AppManifest => ({
  contract: 1,
  id: AppId.make("fixture"),
  package: "@knpkv/hub-app-fixture",
  version: "1.0.0",
  module: {
    id: "fixture",
    label: "Fixture",
    defaultPage: "overview",
    pages: [
      { id: "overview", label: "Overview" },
      { id: "detail", label: "Detail" }
    ],
    listeners: ["serve", "local"],
    requires: ["read"]
  },
  client: { entry, css },
  services: [],
  nav: { order: 100, primary: false, mobile: false },
  standalone: { defaultPort: 3199 }
})

const ready = (entry?: string, css?: ReadonlyArray<string>): AppState => ({
  _tag: "Ready",
  manifest: manifest(entry, css)
})

/** What each client did, in order, and the contexts it was given. */
const recorder = () => {
  const events: Array<string> = []
  const contexts: Array<ShellContext> = []
  const roots: Array<HTMLElement> = []
  const client = (name: string) =>
    defineAppClient({
      contract: 1,
      mount: (root, context) => {
        events.push(`${name}:mount:${context.page}`)
        contexts.push(context)
        roots.push(root)
        root.textContent = `${name} page`
        return {
          update: (next) => {
            events.push(`${name}:update:${next.page}:${next.active ? "active" : "hidden"}`)
            contexts.push(next)
          },
          unmount: () => {
            events.push(`${name}:unmount`)
          }
        }
      }
    })
  return { events, contexts, roots, client }
}

type AppClientModuleType = typeof AppClientModule.Type

/** For states the shell must not import a client for: it never answers. */
const unusedLoad = (): Promise<AppClientModuleType> => new Promise(() => {})

const connect: ModuleViews<typeof connectModule> = {
  descriptor: connectModule,
  pages: { overview: () => <h1>Agents</h1> }
}

let root: Root | null = null
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  document.head.replaceChildren()
  window.history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
})

/** Renders the shell with Connect and the apps in `states`; `load` answers each client URL. */
const renderShell = async (
  states: ReadonlyArray<AppState>,
  load: (url: string) => Promise<AppClientModuleType>,
  extra: Partial<AppModuleOptions> & { readonly notFound?: (path: string) => ReactNode | null } = {}
) => {
  const options: AppModuleOptions = {
    host: "ser8",
    viewer: "viewer@example.test",
    badges: {},
    setBadge: () => {},
    load,
    ...extra
  }
  const modules: ReadonlyArray<ModuleViews<ModuleDescriptor>> = [connect, ...makeAppModuleViews(states, options)]
  const element = (
    <SuperappShell
      session={{ access: "loopback", connection: "connected" }}
      modules={modules}
      landing={{ module: "connect", page: "overview" }}
      host="ser8"
      hostCount={1}
      notifications={null}
      {...(extra.notFound === undefined ? {} : { notFound: extra.notFound })}
    />
  )
  if (root === null) {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root?.render(element))
  // The client import resolves on a later microtask.
  await act(async () => {
    await Promise.resolve()
  })
}

const go = async (hash: string) => {
  await act(async () => {
    window.history.pushState(null, "", `/${hash}`)
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
}

const section = () => document.querySelector<HTMLElement>('[data-module="fixture"]')

describe("installed apps in the shell", () => {
  it("mounts a Ready app's client on its own element with the hub's context", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, contexts, events, roots } = recorder()
    const loaded: Array<string> = []
    await renderShell([ready("client-1.js", ["client-1.css"])], (url) => {
      loaded.push(url)
      return Promise.resolve({ default: client("one") })
    })
    expect(loaded).toEqual(["/apps/fixture/app/assets/client-1.js"])
    expect(events[0]).toBe("one:mount:overview")
    expect(roots[0]?.dataset.app).toBe("fixture")
    expect(section()?.textContent).toContain("one page")
    const context = contexts[0]
    expect(context?.mode).toBe("hub")
    expect(context?.api("/limits")).toBe("/apps/fixture/v1/modules/fixture/limits")
    expect(context?.href?.("detail", new URLSearchParams("range=7d"))).toBe("?range=7d#fixture/detail")
    expect(context?.host).toBe("ser8")
    expect(context?.caller.login).toBe("viewer@example.test")
    expect(context?.portalRoot.dataset.app).toBe("fixture")
    expect(
      [...document.head.querySelectorAll<HTMLLinkElement>('link[data-app="fixture"]')].map((link) =>
        link.getAttribute("href")
      )
    ).toEqual(["/apps/fixture/app/assets/client-1.css"])
  })

  // (c) The same entry keeps its instance: navigation and module switches only update it.
  it("updates the mounted client on navigation instead of mounting again", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, events } = recorder()
    await renderShell([ready()], () => Promise.resolve({ default: client("one") }))
    await go("#fixture/detail")
    await go("#connect/overview")
    expect(events.filter((event) => event.includes("mount:"))).toEqual(["one:mount:overview"])
    expect(events).toContain("one:update:detail:active")
    expect(events.at(-1)).toBe("one:update:detail:hidden")
  })

  // A navigation while the client is still loading reaches the mount: no render follows it to update a stale page.
  it("mounts with the page the shell shows when the client arrives, not the one it started loading on", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, events } = recorder()
    let arrive: (module: AppClientModuleType) => void = () => {}
    await renderShell(
      [ready()],
      () =>
        new Promise((resolve) => {
          arrive = resolve
        })
    )
    await go("#fixture/detail")
    await act(async () => {
      arrive({ default: client("one") })
      await Promise.resolve()
    })
    expect(events).toEqual(["one:mount:detail"])
  })

  // An app may re-ask for its header on every update (Usage's page hands the shell a new setter each time). The shell
  // must not answer that with another update, or the two re-render each other forever.
  it("updates the client only when what it sees changes, not on every shell render", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    let updates = 0
    const regrouping = defineAppClient({
      contract: 1,
      mount: (_root, context) => {
        context.setHeaderMode?.("grouped")
        return {
          update: (next) => {
            updates += 1
            if (updates > 50) return
            next.setHeaderMode?.("shell")
            next.setHeaderMode?.("grouped")
          },
          unmount: () => {}
        }
      }
    })
    await renderShell([ready()], () => Promise.resolve({ default: regrouping }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(updates).toBeLessThanOrEqual(2)
    await go("#fixture/detail")
    expect(updates).toBeLessThanOrEqual(4)
  })

  // The shell's arrival focus runs a frame after the route paints, before an app's client has loaded; once the client
  // mounts, focus moves from the shell's fallback to the page's own link.
  it("lands arrival focus on the app's page link once its client mounts", async () => {
    window.history.replaceState(null, "", "/#fixture/detail")
    let arrive: (module: AppClientModuleType) => void = () => {}
    await renderShell(
      [ready()],
      () =>
        new Promise((resolve) => {
          arrive = resolve
        })
    )
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(document.activeElement?.id).toBe("main")
    const linking = defineAppClient({
      contract: 1,
      mount: (root, context) => {
        const link = document.createElement("a")
        link.href = context.href?.(context.page) ?? ""
        link.dataset.modulePage = context.page
        link.textContent = "Detail"
        root.append(link)
        return { update: () => {}, unmount: () => {} }
      }
    })
    await act(async () => {
      arrive({ default: linking })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(document.activeElement?.getAttribute("data-module-page")).toBe("detail")
  })

  // (b) A new entry is a new client: the old one unmounts and loses its CSS before the new one mounts.
  it("swaps the client and its stylesheet when the app's entry changes", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, events } = recorder()
    const load = (url: string) => Promise.resolve({ default: client(url.endsWith("client-2.js") ? "two" : "one") })
    await renderShell([ready("client-1.js", ["client-1.css"])], load)
    await renderShell([ready("client-2.js", ["client-2.css"])], load)
    expect(events).toEqual(["one:mount:overview", "one:unmount", "two:mount:overview"])
    expect(
      [...document.head.querySelectorAll<HTMLLinkElement>('link[data-app="fixture"]')].map((link) =>
        link.getAttribute("href")
      )
    ).toEqual(["/apps/fixture/app/assets/client-2.css"])
  })

  // (a) An app that turns Unavailable unmounts and shows why, under its own label.
  it("unmounts an app that becomes unavailable and shows the registry's reason", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, events } = recorder()
    const load = () => Promise.resolve({ default: client("one") })
    await renderShell([ready()], load)
    await renderShell(
      [
        {
          _tag: "Unavailable",
          id: AppId.make("fixture"),
          manifest: manifest(),
          reason: "crashloop",
          detail: "Fixture kept stopping, so it was left off. Restart it once it's fixed."
        }
      ],
      load
    )
    expect(events).toEqual(["one:mount:overview", "one:unmount"])
    expect(section()?.textContent).toContain("Fixture kept stopping")
    expect(document.querySelector('nav[aria-label="Modules"]')?.textContent).toContain("Fixture")
  })

  it("shows a third-party app that opens only on this machine as a panel, keeping its nav item", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const load = vi.fn(unusedLoad)
    await renderShell(
      [
        {
          _tag: "Unavailable",
          id: AppId.make("fixture"),
          manifest: manifest(),
          reason: "local_only",
          detail: "Fixture opens only on this machine for now."
        }
      ],
      load
    )
    expect(load).not.toHaveBeenCalled()
    expect(section()?.textContent).toContain("Fixture opens only on this machine for now.")
    expect(document.querySelector('nav[aria-label="Modules"]')?.textContent).toContain("Fixture")
  })

  it("shows client_failed for a client that throws, and the rest of the shell keeps working", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const throwing = defineAppClient({
      contract: 1,
      mount: () => {
        throw new Error("broken client")
      }
    })
    await renderShell([ready()], () => Promise.resolve({ default: throwing }))
    expect(section()?.textContent).toContain("Fixture couldn't be shown.")
    await go("#connect/overview")
    expect(document.querySelector('[data-module="connect"]')?.textContent).toContain("Agents")
  })

  it("shows client_failed for a client on a contract this shell doesn't mount", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    await renderShell([ready()], () =>
      Promise.resolve({ default: { contract: 2, mount: () => ({ update: () => {}, unmount: () => {} }) } })
    )
    expect(section()?.textContent).toContain("Fixture couldn't be shown.")
  })

  // The default loader runs every imported module through this before the shell may call its mount.
  it("refuses an imported module that doesn't default-export a client", async () => {
    const { client } = recorder()
    await expect(decodeClientModule({ default: { contract: 1 } })).rejects.toBeDefined()
    await expect(decodeClientModule({})).rejects.toBeDefined()
    const decoded = await decodeClientModule({ default: client("one") })
    expect(decoded.default.contract).toBe(1)
  })

  it("leaves an app whose id a core module holds out of the navigation", async () => {
    await renderShell(
      [
        {
          _tag: "Unavailable",
          id: AppId.make("connect"),
          manifest: null,
          reason: "duplicate",
          detail: "connect uses a name another module already has."
        }
      ],
      unusedLoad
    )
    expect(document.querySelectorAll('[data-module="connect"]')).toHaveLength(1)
  })

  it("lends the grouped header's outlet to the app that asks for it, under its own data-app", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, contexts } = recorder()
    await renderShell([ready()], () => Promise.resolve({ default: client("one") }))
    await act(async () => contexts[0]?.setHeaderMode?.("grouped"))
    const outlet = document.querySelector<HTMLElement>(".superapp-grouped-header-outlet")
    expect(outlet?.dataset.app).toBe("fixture")
    expect(contexts.at(-1)?.headerOutlet).toBe(outlet)
    await act(async () => contexts[0]?.setEmpty(true))
    expect(document.querySelector('.superapp-shell[data-module-empty="true"]')).not.toBeNull()
    await go("#connect/overview")
    expect(document.querySelector(".superapp-grouped-header-outlet")).toBeNull()
  })

  // A manifest carries no icon yet; the shell lends its own drawing to apps it knows, so Usage keeps its glyph.
  it("draws the icon the shell lends an app on its nav item", async () => {
    await renderShell([ready()], unusedLoad, { icons: { fixture: <svg data-testid="fixture-icon" /> } })
    expect(document.querySelector('nav[aria-label="Modules"] [data-testid="fixture-icon"]')).not.toBeNull()
  })

  it("shows the badge an app sets on its nav item", async () => {
    window.history.replaceState(null, "", "/#fixture/overview")
    const { client, contexts } = recorder()
    const badges: Array<ShellBadge | null> = []
    await renderShell([ready()], () => Promise.resolve({ default: client("one") }), {
      setBadge: (_id, badge) => badges.push(badge)
    })
    await act(async () => contexts[0]?.setBadge({ text: "3", label: "3 waiting" }))
    expect(badges).toEqual([{ text: "3", label: "3 waiting" }])
    await renderShell([ready()], () => Promise.resolve({ default: client("one") }), {
      badges: { fixture: { text: "3", label: "3 waiting" } }
    })
    expect(document.querySelector('nav[aria-label="Modules"] a[aria-label="Fixture, 3 waiting"]')).not.toBeNull()
  })

  it("says Usage moved into an app on a hub without it", async () => {
    window.history.replaceState(null, "", "/?range=7d#usage/limits")
    await renderShell([], unusedLoad, {
      notFound: (path) => (path.startsWith("#usage") ? <UsageMovedPanel /> : null)
    })
    expect(document.querySelector("main")?.textContent).toContain("Usage is now an app.")
    expect(document.querySelector("main code")?.textContent).toBe("herdr-hub apps add @knpkv/herdr-usage")
  })
})
