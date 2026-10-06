// The hub's stylesheet stack and Connect surface from source, mounted the way client-entry does.
import "@knpkv/rly/styles.css"
import "../../src/styles.css"
import "@knpkv/herdr-work/styles.css"
import { RegistryProvider } from "@effect/atom-react"
import { createRoot } from "react-dom/client"
import { ConnectSurface, makeConnectAtoms } from "../../src/client.js"

const root = document.querySelector<HTMLElement>("#fleet-connect-root")
if (root !== null) {
  createRoot(root).render(
    <RegistryProvider>
      <ConnectSurface atoms={makeConnectAtoms()} />
    </RegistryProvider>
  )
}
