---
"@knpkv/jcf-web": minor
"@knpkv/agent-usage": minor
"@knpkv/codecommit-web": minor
---

Serve the built client with Effect's `HttpStaticServer` instead of three hand-rolled routers. jcf-web and agent-usage export `staticClient(root)` from `server/HttpApplication.js` in place of `isWithinDirectory`; jcf-web also exports `apiApplication` and `StaticRouter`, the two halves `application` merges, so a host can give the static client its own FileSystem. Visible changes: responses carry `Cache-Control: no-cache` plus ETag/304 and byte-range support, content types include a charset, only extensionless HTML navigations fall back to `index.html` (a missing `*.js` or an index-less directory is now 404), and a malformed percent-encoded path is a 404 (previously 500 in jcf-web and codecommit-web, 400 in agent-usage). codecommit-web's traversal guard no longer accepts sibling directories that share the client directory's name prefix.
