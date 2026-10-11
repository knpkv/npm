import { RegistryProvider } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { Schema } from "effect"
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { BlockedConnectSurface } from "./blocked-connect-surface.js"

class HubConnectMountError extends Schema.TaggedError<HubConnectMountError>()("HubConnectMountError", {
  detail: Schema.String
}) {}

const root = document.querySelector<HTMLElement>("#fleet-connect-root")
if (root === null) throw new HubConnectMountError({ detail: "Connect root is missing" })
createRoot(root).render(
  createElement(RegistryProvider, null, createElement(BlockedConnectSurface, { atoms: makeConnectAtoms() }))
)
