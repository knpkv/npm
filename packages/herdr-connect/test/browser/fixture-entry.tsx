// The hub's stylesheet stack, in its order, and Connect's surface from source, mounted the way client-entry does.
import "@knpkv/rly/styles.css"
import "../../src/styles.css"
import "@knpkv/herdr-work/styles.css"
// The hub's own sheet styles Connect's header nav, so the fixture shows the header that ships.
import "../../../herdr-hub/src/styles.css"
import { RegistryProvider } from "@effect/atom-react"
import { createRoot } from "react-dom/client"
import { ConnectSurface, makeConnectAtoms } from "../../src/client.js"
import { Creature } from "../../src/creature.js"

// `?embedded` mounts Connect the way the hub's Connect tab does: page title, summary, directory.
// `?brows` renders the 64-seed grid here, outside Playwright's component transform.
const root = document.querySelector<HTMLElement>("#fleet-connect-root")
const parameters = new URLSearchParams(location.search)
if (root !== null) {
  createRoot(root).render(
    <RegistryProvider>
      {parameters.has("brows") ? (
        <div data-brow-grid="">
          {Array.from({ length: 64 }, (_, index) => (
            <Creature
              host={["nix", "mbp", "studio", "w24"][index % 4] ?? "nix"}
              id={String(index * 7 + 3)}
              key={index}
              size="stage"
              state="working"
            />
          ))}
        </div>
      ) : (
        <ConnectSurface atoms={makeConnectAtoms()} embedded={parameters.has("embedded")} />
      )}
    </RegistryProvider>
  )
}
