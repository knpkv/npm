import mermaid from "mermaid"
import { observeGuideDiagrams } from "./diagram-mount.js"
import { makeMermaidDrawer } from "./mermaid-drawer.js"

const draw = makeMermaidDrawer(mermaid)

/**
 * Mount diagrams for one wrapper containing an embedded GuidePage. Call after React commits,
 * and return the cleanup from the host effect. Ordinary code does not initialize Mermaid.
 * The bundled runtime retains strict security, theme updates and print suspension.
 */
export const mountGuideDiagrams = (root: HTMLElement): () => void => observeGuideDiagrams(root, draw)
