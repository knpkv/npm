import { HttpStaticServer } from "effect/http"

/**
 * Serves the built client at `root` for every non-API route. Extensionless HTML navigations fall back
 * to `index.html`; `no-cache` makes the browser revalidate, so a rebuilt `index.html` never points at
 * hashed assets that no longer exist.
 */
export const staticClient = (root: string) => HttpStaticServer.layer({ cacheControl: "no-cache", root, spa: true })
