---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/herdr-hub": minor
---

Add host-local, read-only Code contracts and saved-grant provider authority with mandatory
authenticated-caller audit before execution. Existing owner prompts and provider writes retain
their pairing and CSRF protection. Code content never enters peer/fleet aggregation or hub Relay.

Core adds fresh saved-permission checks, an existing-only private database verifier and a bounded
cache read/audit attachment that refuses unknown schemas without migration or permission repair.
The Code host factory reuses one provider and retries failed scoped attachments after two seconds.

Hub adds explicit credential-host configuration and read-only Code routes. Route callbacks receive
the decoded ModuleCaller; dispatch authorization now returns that typed caller rather than an
unknown value. Consumers must update authorization effects to return the authenticated login.

Code adds a controlled CodeHostView through the browser-safe views entry and a separate host
stylesheet. The hub mounts its queue, cached approvals and immutable diff pages with active-only
abortable reads, opaque target selectors and explicit unavailable states. ModuleViews accepts an
optional decorative navigationIcon; its absence retains the shell's default glyph.

The controlled Code view optionally delegates deliberate target navigation to its host while
modified anchors retain browser behavior. Immutable diff readings include their read time and
cached source timestamp; a changed cached PR warns that a retained diff may be outdated without
initiating another provider read.

The workspace views type entry uses built declarations to isolate owner source aliases. Build Code
web before checking hub consumers. Build and prepack force declaration emission after output cleanup;
published views types, runtime and stylesheet paths remain unchanged.
