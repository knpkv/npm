import { ThemeProvider, useDocumentTheme } from "@knpkv/rly/foundations"
import { Button, Text } from "@knpkv/rly/primitives"
import { Effect, ManagedRuntime } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import {
  ResourceDetailView,
  StackDetailView,
  StackListView,
  type StackDetailState,
  type StackListState
} from "../views.js"
import type { PlanState } from "../plan.js"
import { readStackPlan } from "./plan.js"
import { bootstrap } from "./bootstrap.js"
import { readStackDetail } from "./stack-detail.js"
import { readStackList } from "./stack-list.js"
import { readRoute, routeHref, type ConsoleRoute } from "./route.js"
import "../views.css"
import "./shell.css"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const initialRoute = readRoute(window.location.search)
const copy = { product: "Alchemy console", signInInstruction: "Run alchemy-console login for a fresh link." }
type PageState =
  | { readonly _tag: "List"; readonly state: StackListState }
  | { readonly _tag: "Detail"; readonly state: StackDetailState }
const loading = (route: ConsoleRoute): PageState =>
  route._tag === "List" ? { _tag: "List", state: { _tag: "Loading" } } : { _tag: "Detail", state: { _tag: "Loading" } }

/** Navigation and foreground refresh replace all content. Abort old reads so late responses cannot cross stack identities. */
const App = (): ReactElement => {
  useDocumentTheme("system")
  const [route, setRoute] = useState<ConsoleRoute>(initialRoute)
  const [page, setPage] = useState<PageState>(loading(initialRoute))
  const [plan, setPlan] = useState<{ readonly id: string; readonly state: PlanState } | null>(null)
  const [planReload, setPlanReload] = useState(0)
  const [session, setSession] = useState("Signing in…")
  const routeRef = useRef<ConsoleRoute>(initialRoute)
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const initialized = useRef(false)
  const readAgain = useCallback(() => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    const target = routeRef.current
    setPage(loading(target))
    const read: Effect.Effect<PageState, never, HttpClient.HttpClient> =
      target._tag === "List"
        ? readStackList().pipe(Effect.map((state): PageState => ({ _tag: "List", state })))
        : readStackDetail(target.id).pipe(Effect.map((state): PageState => ({ _tag: "Detail", state })))
    void runtime.runPromise(read, { signal: controller.signal }).then(
      (next) => {
        if (!mounted.current || controller.signal.aborted) return
        setPage(next)
        setSession(
          next.state._tag === "Ready"
            ? "Owner session connected"
            : next.state._tag === "Unauthorized"
              ? "Sign-in required"
              : "Owner session not verified"
        )
      },
      () => {
        if (!mounted.current || controller.signal.aborted) return
        setPage(
          target._tag === "List"
            ? { _tag: "List", state: { _tag: "Failed", reason: "transport" } }
            : { _tag: "Detail", state: { _tag: "Failed", reason: "transport" } }
        )
        setSession("Owner session not verified")
      }
    )
  }, [])
  useEffect(() => {
    mounted.current = true
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted && initialized.current) readAgain()
    }
    const navigate = () => {
      const next = readRoute(window.location.search)
      routeRef.current = next
      setRoute(next)
      if (initialized.current) readAgain()
    }
    window.addEventListener("pageshow", resume)
    window.addEventListener("popstate", navigate)
    void runtime.runPromise(bootstrap().pipe(Effect.withTracerEnabled(false))).then(
      (success) => {
        if (!mounted.current) return
        if (success) {
          initialized.current = true
          // Bootstrap has already stripped the fragment before POST. Restore only the validated UI destination.
          window.history.replaceState(null, "", routeHref(routeRef.current))
          setSession("Checking owner session…")
          readAgain()
        } else {
          setSession("Sign-in required")
          setPage(
            routeRef.current._tag === "List"
              ? { _tag: "List", state: { _tag: "Unauthorized", reason: "bootstrap" } }
              : { _tag: "Detail", state: { _tag: "Unauthorized", reason: "bootstrap" } }
          )
        }
      },
      () => {
        if (!mounted.current) return
        setSession("Sign-in required")
        setPage(
          routeRef.current._tag === "List"
            ? { _tag: "List", state: { _tag: "Unauthorized", reason: "bootstrap" } }
            : { _tag: "Detail", state: { _tag: "Unauthorized", reason: "bootstrap" } }
        )
      }
    )
    return () => {
      mounted.current = false
      active.current?.abort()
      window.removeEventListener("pageshow", resume)
      window.removeEventListener("popstate", navigate)
    }
  }, [readAgain])
  const planId =
    route._tag === "Stack" && route.tab === "plan" && route.resource === null && page.state._tag === "Ready"
      ? route.id
      : null
  useEffect(() => {
    if (planId === null) {
      setPlan(null)
      return
    }
    const controller = new AbortController()
    setPlan({ id: planId, state: { _tag: "Loading" } })
    void runtime.runPromise(readStackPlan(planId), { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return
        if (result._tag === "Plan") setPlan({ id: planId, state: result.state })
        else {
          setPage({ _tag: "Detail", state: result })
          if (result._tag === "Unauthorized") setSession("Sign-in required")
          if (result._tag === "Failed") setSession("Owner session not verified")
        }
      },
      () => {
        if (!controller.signal.aborted) setPlan({ id: planId, state: { _tag: "Unreachable" } })
      }
    )
    return () => controller.abort()
  }, [planId, planReload])
  const stack = page._tag === "Detail" && page.state._tag === "Ready" ? page.state.stack : null
  const resource =
    route._tag === "Stack" && route.resource !== null
      ? stack?.resources.find((row) => row.fqn === route.resource)
      : undefined
  return (
    <ThemeProvider theme="system" className="ac-console">
      <a className="ac-skip" href="#content">
        Skip to stacks
      </a>
      <header className="ac-shell-header">
        <Text as="strong">Alchemy console</Text>
        <div className="ac-shell-meta">
          <Text variant="code">{window.location.host}</Text>
          <Text variant="meta" tone="secondary">
            {session}
          </Text>
        </div>
      </header>
      <main id="content" className="ac-main" tabIndex={-1}>
        {route._tag === "Stack" ? (
          <nav className="ac-breadcrumbs" aria-label="Stack navigation">
            <a data-rly-hit-area href="/" className="ac-detail-link">
              Stacks
            </a>
            {stack === null ? null : (
              <>
                <span aria-hidden="true">/</span>
                <a
                  data-rly-hit-area
                  className="ac-detail-link"
                  href={routeHref({ ...route, resource: null, tab: "resources" })}
                >
                  {stack.app} {stack.stage}
                </a>
              </>
            )}
            {resource === undefined ? null : (
              <>
                <span aria-hidden="true">/</span>
                <span aria-current="page">{resource.logicalId}</span>
              </>
            )}
            {page.state._tag === "Ready" ? (
              <Button className="ac-read ac-detail-read" onClick={readAgain}>
                Read again
              </Button>
            ) : null}
          </nav>
        ) : null}
        {page._tag === "List" ? (
          <StackListView
            state={page.state}
            copy={copy}
            onReadAgain={readAgain}
            stackHref={(summary) => routeHref({ _tag: "Stack", id: summary.id, resource: null, tab: "resources" })}
          />
        ) : route._tag === "Stack" && route.resource !== null && stack !== null ? (
          resource === undefined ? (
            <section className="ac-state-panel">
              <Text as="h1" variant="section-title">
                This resource is no longer available.
              </Text>
              <Text as="p" tone="secondary">
                Return to this stack’s Resources. Nothing was changed.
              </Text>
            </section>
          ) : (
            <ResourceDetailView
              stack={stack}
              resource={resource}
              copy={copy}
              stackHref={routeHref({ ...route, resource: null, tab: "resources" })}
              resourceHref={(row) => routeHref({ ...route, resource: row.fqn, tab: "resources" })}
            />
          )
        ) : (
          <StackDetailView
            state={page.state}
            copy={copy}
            onReadAgain={readAgain}
            planState={plan?.id === planId ? plan.state : { _tag: "Loading" }}
            onReadPlanAgain={() => setPlanReload((count) => count + 1)}
            tab={route._tag === "Stack" ? route.tab : "resources"}
            onTabChange={(tab) => {
              if (route._tag !== "Stack") return
              const next: ConsoleRoute = { ...route, tab, resource: null }
              routeRef.current = next
              window.history.pushState(null, "", routeHref(next))
              setRoute(next)
            }}
            resourceHref={(row) =>
              route._tag === "Stack" ? routeHref({ ...route, resource: row.fqn, tab: "resources" }) : "/"
            }
          />
        )}
      </main>
    </ThemeProvider>
  )
}

// A pasted fresh link is a same-document navigation; reload to spend its new code.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(window.location.hash.slice(1)).has("bootstrap_token")) window.location.reload()
})
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) void runtime.dispose()
})
const root = document.getElementById("root")
if (root !== null) createRoot(root).render(<App />)
