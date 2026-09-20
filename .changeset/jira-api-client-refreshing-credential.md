---
"@knpkv/jira-api-client": minor
---

Let a client re-read its credential per request. `JiraApiConfigContract` gains an optional
`resolveAuth`, and the credential union it yields is now exported as `JiraApiCredential`.

Without it, a client is pinned for life to the token that existed when its layer was built. That is
invisible in a command that exits in seconds and fatal in one that does not: an Atlassian access
token lasts about an hour, after which every request 401s and no retry inside the process can
recover, because the expired token is already baked into the header. `jcf watch` is meant to run all
day.

Omitting `resolveAuth` keeps the previous behaviour exactly — the credential in `auth` is used as
given, which is right for a basic-auth API token that cannot expire. When it is supplied, both the
`Authorization` header and the API host are derived from the same resolved value, so a resolver
cannot address one site while authenticating against another.
