/**
 * The standalone shell, bundled to `dist/standalone-shell.js` and served at `/app/shell.js`: spends the
 * bootstrap link, renders the app's label and page tabs, routes by hash and mounts the app's client.
 *
 * Routes use the hub's own shape (`?query#<module>/<page>`), so links an app builds work in both shells.
 *
 * @module
 */
import { Effect, ManagedRuntime, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { AppClientModule, type MountedApp, type ShellContext } from "./client.js"
import { AppManifest } from "./manifest.js"

/** The page's own markup is missing a part this shell fills. */
export class StandaloneShellError extends Schema.TaggedError<StandaloneShellError>()("StandaloneShellError", {
  part: Schema.String
}) {}

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const csrfKey = "hub-app-csrf"
const BootstrapReply = Schema.Struct({ csrfToken: Schema.optionalKey(Schema.String) })

const element = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector)
  if (found === null) throw new StandaloneShellError({ part: selector })
  return found
}

/** Spend `#bootstrap_token=…` once, keep the CSRF token for this tab, and drop the fragment. */
const bootstrap = Effect.fn("StandaloneShell.bootstrap")(function*() {
  const code = new URLSearchParams(window.location.hash.slice(1)).get("bootstrap_token")
  if (code === null) return
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.post(new URL("/auth/bootstrap", window.location.href)).pipe(HttpClientRequest.bearerToken(code))
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin", cache: "no-store" })
  )
  const body = yield* response.json
  if (response.status !== 200) return
  const reply = Schema.decodeUnknownOption(BootstrapReply)(body)
  if (Option.isSome(reply) && reply.value.csrfToken !== undefined) {
    window.sessionStorage.setItem(csrfKey, reply.value.csrfToken)
  }
})

/** The page named by `#<module>/<page>`, or the default page for anything else. */
const currentPage = (manifest: AppManifest): string => {
  const [module, page] = window.location.hash.slice(1).split("/")
  return module === manifest.id && manifest.module.pages.some((entry) => entry.id === page) && page !== undefined
    ? page
    : manifest.module.defaultPage
}

const start = async (): Promise<void> => {
  const manifestText = element("#hub-app-manifest").textContent ?? ""
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(AppManifest))(manifestText)
  await runtime.runPromise(
    bootstrap().pipe(Effect.catch((error) => Effect.logWarning("Sign-in link not spent", error)))
  )
  const root = element("#hub-app-root")
  const portalRoot = element("#hub-app-portals")
  element("[data-hub-shell=label]").textContent = manifest.module.label
  const crumb = element("[data-hub-shell=crumb]")
  const slot = element("[data-hub-shell=slot]")
  const outlet = element("[data-hub-shell=outlet]")
  const pages = element("[data-hub-shell=pages]")
  const tabs = manifest.module.pages.map((page) => {
    const link = document.createElement("a")
    link.href = `#${manifest.id}/${page.id}`
    link.textContent = page.label
    pages.append(link)
    return { id: page.id, link }
  })
  // The owner session's cookie is scoped to `/api`.
  const api = (path: `/${string}`) => `/api/v1/modules/${manifest.id}${path}`
  let mounted: MountedApp | null = null
  const context = (): ShellContext => {
    const page = currentPage(manifest)
    for (const tab of tabs) {
      if (tab.id === page) tab.link.setAttribute("aria-current", "page")
      else tab.link.removeAttribute("aria-current")
    }
    return {
      contract: 1,
      mode: "standalone",
      api,
      requestHeaders: () => {
        const csrf = window.sessionStorage.getItem(csrfKey)
        return csrf === null ? {} : { "x-csrf-token": csrf }
      },
      caller: { login: "owner" },
      page,
      search: new URLSearchParams(window.location.search),
      active: true,
      navigate: (href, history) => {
        const target = new URL(href, window.location.href)
        if (history === "push") window.history.pushState(null, "", target)
        else window.history.replaceState(null, "", target)
        mounted?.update(context())
      },
      closeSelection: (parentHref) => {
        window.history.replaceState(null, "", new URL(parentHref, window.location.href))
        mounted?.update(context())
      },
      setCrumb: (items) => {
        crumb.textContent = items.map((item) => item.label).join(" › ")
      },
      setHeaderSlot: (value) => {
        slot.textContent = value === null ? "" : `${value.label}: ${value.text}`
      },
      headerOutlet: outlet,
      setHeaderMode: (mode) => {
        root.toggleAttribute("data-header-grouped", mode === "grouped")
      },
      setEmpty: (empty) => {
        root.toggleAttribute("data-empty", empty)
      },
      setBadge: () => {},
      portalRoot
    }
  }
  const loaded = Schema.decodeUnknownOption(AppClientModule)(await import(`/app/assets/${manifest.client.entry}`))
  if (Option.isNone(loaded) || loaded.value.default.contract !== 1) {
    root.textContent = `${manifest.module.label} can't be shown by this version of its shell.`
    return
  }
  mounted = loaded.value.default.mount(root, context())
  window.addEventListener("popstate", () => mounted?.update(context()))
  window.addEventListener("hashchange", () => mounted?.update(context()))
}

if (document.querySelector("#hub-app-manifest") !== null) void start()
