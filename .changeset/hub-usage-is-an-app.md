---
"@knpkv/herdr-hub": minor
"@knpkv/hub-app": minor
---

The hub's shell mounts installed apps, and Usage moves out of the hub into the `@knpkv/herdr-usage` app. Install it with `herdr-hub apps add @knpkv/herdr-usage`; it appears where the hub's own Usage was, and its routes and bookmarks are unchanged. A hub without it says so on any Usage link. The dashboard snapshot gains `apps` (the registry's states for that listener and the authenticated login), `usageModule` is no longer one of `builtInModuleIds`, and `makeUsageModuleViews` is removed. `ShellContext` gains the optional `href` and `host`, and `AppClientModule` checks a loaded client module before a shell mounts it.
