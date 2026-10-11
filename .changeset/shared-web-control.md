---
"@knpkv/browser-pairing": minor
"@knpkv/jira-clockify": minor
"@knpkv/jcf-web": minor
"@knpkv/codecommit-web": patch
---

Share the owner-only web control file and bearer login route through the browser-pairing control export. Keep existing sign-in commands and product messages.

The week-view control file moves to `~/.jcf/web/control.json` in its own private leaf directory, so existing configuration directories keep their permissions. Legacy control files stay untouched and are no longer read.

The week view now rejects linked or permissive control paths and malformed or foreign bootstrap URLs, matching the stricter shared checks.

Breaking for direct importers: the inferred service requirements and error types of `jira-clockify`'s `WebControl.writeControlFile` / `removeControlFile` and `jcf-web`'s `makeCommand` change, and `jcf-web` no longer exports `loginControlRouter` (use the one from `@knpkv/browser-pairing/control`).
