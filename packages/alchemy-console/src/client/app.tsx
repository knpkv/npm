import { ThemeProvider, useDocumentTheme } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { Effect, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { StackListView, type StackListState } from "../views.js"
import { bootstrap } from "./bootstrap.js"
import { readStackList } from "./stack-list.js"
import "../views.css"
import "./shell.css"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)

/** The application owns only foreground reads; each read immediately discards the previous rows. */
const App = (): ReactElement => {
  useDocumentTheme("system")
  const [state, setState] = useState<StackListState>({ _tag: "Loading" })
  const [session, setSession] = useState("Signing in…")
  const active = useRef(false)
  const mounted = useRef(false)
  const readAgain = useCallback(() => {
    if (active.current) return
    active.current = true
    setState({ _tag: "Loading" })
    void runtime
      .runPromise(readStackList())
      .then(
        (next) => {
          if (!mounted.current) return
          setState(next)
          setSession(
            next._tag === "Ready"
              ? "Owner session connected"
              : next._tag === "Unauthorized"
                ? "Sign-in required"
                : "Owner session not verified"
          )
        },
        () => {
          if (mounted.current) setState({ _tag: "Failed", reason: "transport" })
        }
      )
      .finally(() => {
        active.current = false
      })
  }, [])
  useEffect(() => {
    mounted.current = true
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) readAgain()
    }
    window.addEventListener("pageshow", resume)
    void runtime.runPromise(bootstrap().pipe(Effect.withTracerEnabled(false))).then(
      (success) => {
        if (!mounted.current) return
        if (success) {
          setSession("Checking owner session…")
          readAgain()
        } else {
          setSession("Sign-in required")
          setState({ _tag: "Unauthorized", reason: "bootstrap" })
        }
      },
      () => {
        if (!mounted.current) return
        setSession("Sign-in required")
        setState({ _tag: "Unauthorized", reason: "bootstrap" })
      }
    )
    return () => {
      mounted.current = false
      window.removeEventListener("pageshow", resume)
    }
  }, [readAgain])
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
        <StackListView
          state={state}
          copy={{
            product: "Alchemy console",
            signInInstruction: "Run alchemy-console login for a fresh link."
          }}
          onReadAgain={readAgain}
        />
      </main>
    </ThemeProvider>
  )
}

// A pasted fresh link on the failure page is a same-document navigation; reload to spend its new code.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(window.location.hash.slice(1)).has("bootstrap_token")) window.location.reload()
})
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) void runtime.dispose()
})
const root = document.getElementById("root")
if (root !== null) createRoot(root).render(<App />)
