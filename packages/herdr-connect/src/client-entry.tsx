import { RegistryProvider } from "@effect/atom-react"
import { createRoot } from "react-dom/client"
import { ConnectSurface, makeConnectAtoms } from "./client.js"
import { ConnectBootstrapError } from "./errors.js"

const root = document.querySelector<HTMLElement>("#fleet-connect-root")
if (root === null) {
  throw new ConnectBootstrapError({ detail: "Connect root is missing" })
}

createRoot(root).render(
  <RegistryProvider>
    <ConnectSurface atoms={makeConnectAtoms()} />
  </RegistryProvider>
)
