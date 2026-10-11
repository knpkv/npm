---
"@knpkv/herdr-hub": minor
---

Open the canonical hub on Today, with one server-collected needs-you list, exact Fleet approval links and the existing agent/history snapshots. Discovery is Fleet-only initially. Failed and partial reads remain visible; polling stops when Today is inactive or the document is hidden. Room to work links to the existing Fleet Usage view.

Add browser-safe needs-you schemas, the Today descriptor and view, an optional closed provider effect on ModuleHandlers, and product layers on HttpServerOptions. The hub owns collection and the reserved Today read route, bounds each provider, validates destinations, deduplicates rows and issues no approval proofs.

Require query codecs for module read and write routes. Handlers receive validated selectors; invalid or excess selectors fail before the handler runs. Existing route constructors must supply the new query argument. ModuleListener and product descriptors now exclude the Work peer listener, which retains its restricted existing API.
