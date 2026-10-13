/** Mount the production stage and notification controls with the real hub stylesheet stack. */
import "../../src/assets.css"
import { RegistryProvider } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { Schema } from "effect"
import { createRoot } from "react-dom/client"
import { BlockedConnectSurface } from "../../src/blocked-connect-surface.js"

const parameters = new URLSearchParams(location.search)
const state = Schema.decodeUnknownSync(Schema.Literals(["2v", "2v-v2", "2v-v3", "2v-v4"]))(
  parameters.get("state") ?? "2v"
)
document.body.dataset["rlyTheme"] = Schema.decodeUnknownSync(Schema.Literals(["light", "dark"]))(
  parameters.get("theme") ?? "dark"
)
const root = document.querySelector("#fleet-connect-root")
if (root !== null) {
  createRoot(root).render(
    <RegistryProvider>
      <BlockedConnectSurface
        embedded
        directoryLocation={{
          url: new URL(window.location.href),
          navigate: (href, mode) => {
            if (mode === "replace") window.history.replaceState(null, "", href)
            else window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          },
          closeSelection: (href) => {
            window.history.replaceState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
        }}
        atoms={makeConnectAtoms()}
        notificationState={state === "2v-v4" ? "disabled" : "enabled"}
      />
    </RegistryProvider>
  )
}
