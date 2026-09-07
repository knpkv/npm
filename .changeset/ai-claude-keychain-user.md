---
"@knpkv/ai-claude": patch
---

Forward `USER` to the Claude CLI. Every call failed on macOS with `Not logged in · Please run
/login` even for a signed-in user, because the reviewed child environment withheld it. Login
Keychain items are scoped to the account name, so the CLI could not find its own credentials. It
carries no secret, being the account name the process already runs as.
