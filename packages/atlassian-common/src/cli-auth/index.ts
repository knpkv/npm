/**
 * OAuth2 login and token refresh for Atlassian command-line tools.
 *
 * Separate from `./auth` because it carries a Node callback server and a
 * browser launcher; `./auth` stays platform-neutral for server-side consumers.
 *
 * @module
 */
export {
  type AccessibleSite,
  type AtlassianCliAuth,
  type AtlassianCliAuthOptions,
  type LoginOptions,
  makeAtlassianCliAuth
} from "./AtlassianCliAuth.js"
export { HttpServerFactoryLive, NodeCliAuthLive } from "./internal/NodeLayers.js"
export { type HttpServerFactory, HttpServerFactoryTag, makeHttpServerFactory } from "./internal/oauthServer.js"
export { BrowserOpenError, openBrowser } from "./openBrowser.js"
