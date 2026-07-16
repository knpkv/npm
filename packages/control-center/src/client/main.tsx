import "@knpkv/rly/styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router"
import { AppProviders } from "./AppProviders.js"
import { router } from "./router.js"

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
