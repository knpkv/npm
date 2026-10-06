// The hub's stylesheet stack, in its order, and Connect's surface from source, mounted the way client-entry does.
import "@knpkv/rly/styles.css"
import "../../src/styles.css"
import "@knpkv/herdr-work/styles.css"
// The hub's own sheet styles Connect's header nav, so the fixture shows the header that ships.
import "../../../herdr-approvals/src/styles.css"
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
