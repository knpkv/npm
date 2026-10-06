---
"@knpkv/jira-clockify": minor
"@knpkv/jira-api-client": minor
---

Connect Jira with an API token, and set up each system on its own:

- `jcf auth jira token` asks for your Jira address, email and an API token, checks them with Jira, and saves them to `~/.jcf/jira.json` (owner-only). The token is never printed. A failed check says whether the site, the token or the network was wrong. The OAuth app (`create`, `configure`, `login`) stays as the advanced option; when both exist the token is used.
- `jcf` with nothing connected asks about Jira and Clockify in turn, and either can be skipped. With one connected it opens straight away. Without a terminal it prints both commands and exits 1.
- Commands that need Jira (`issue list`, `timer start`, `sync reconcile`) fail with "Jira is not connected. Run jcf auth jira token to connect it." and exit 1, instead of reporting no issues. `auth clockify setup` takes `--api-key` and fails without a terminal. Failed `timer` and `config set project` steps and a failed reconcile exit non-zero.
- `jcf auth status` names the Clockify workspace and the next command for anything not connected. Every command has a help description, and `--version` reports the package version.
- `@knpkv/jira-api-client`: a basic-auth credential may carry its `siteUrl`, used as the request host, so a credential re-read per request keeps its site.
