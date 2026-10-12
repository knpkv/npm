import "@knpkv/rly/styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router"
import { AppProviders } from "./AppProviders.js"
import { makeRouter } from "./router.js"
import { makeBootstrapPairing, readBootstrapHandoff } from "./bootstrapHandoff.js"

const code = readBootstrapHandoff(window.location, window.history)
const router = makeRouter(code === null ? null : makeBootstrapPairing(code))

const rootElement = document.querySelector<HTMLElement>("#root")

if (rootElement === null) {
  throw new Error("Control Center requires a #root element")
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>
)
