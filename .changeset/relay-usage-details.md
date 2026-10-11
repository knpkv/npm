---
"@knpkv/herdr-hub": minor
"@knpkv/herdr-connect": minor
---

Register a read-only Usage details module with typed range, time-zone and host selectors. Keep legacy Fleet Usage destinations intact and reuse the hub's existing usage and limits reports.

SuperappShell accepts an optional typed mobileModules list for the phone bar, with off-bar modules announced on All modules. ModulePageMount.navigate accepts an optional focus destination. Page focus remains the default; null keeps focus on an in-page selector while its URL is replaced.

Expose the existing stateless UsageTab, browser report loaders, view-state helpers, loopback helpers and report/query types through herdr-connect's browser-safe usage entry. UsageTab's optional presentation selects Limits or Tokens beneath a host-supplied heading; its default Fleet markup and existing UsageSurface behaviour are unchanged. Reports carry no cost, balances, bookings, sessions, paths or prompt prefixes.
