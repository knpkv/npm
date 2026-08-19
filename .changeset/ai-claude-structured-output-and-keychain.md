---
"@knpkv/ai-claude": patch
---

Fix two defects that made the provider unusable in practice.

`generateObject` and any other structured-output call always failed: the `--json-schema` argument
declared `$schema: https://json-schema.org/draft/2020-12/schema`, and the Claude CLI validates that
argument against its own registered meta-schemas, of which it has only draft-07. It rejected every
request with `no valid JSON Schema: no schema with key or ref …`. The dialect is now left to the
CLI's default, which accepts the shapes Effect Schema emits.

Every call also failed on macOS with `Not logged in · Please run /login` even for a signed-in user,
because the reviewed child environment withheld `USER`. Login Keychain items are scoped to the
account name, so the CLI could not find its own credentials. `USER` is now forwarded; it carries no
secret, being the account name the process already runs as.

Adds `access: "none"`, which withholds every tool. Given file tools the CLI often explores the
filesystem before answering, which costs turns and wall clock on a prompt that is already
self-contained — measured on a classification prompt at 42s over 6 turns with `Read,Glob,Grep`
against 15s over 2 turns with none.
