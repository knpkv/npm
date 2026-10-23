# @knpkv/herdr-usage

Claude and Codex usage and limits across a Relay fleet, as a hub app that also runs on its own.

- `@knpkv/herdr-usage/host`: this machine's readings. `readHostLimits` and `readHostUsage` run the configured
  `agent-usage` command, bounded and cached, and explain in plain sentences when it can't answer. hostd serves
  them to the hub as each peer's `/v1/connect/{limits,usage}/local`.
- `@knpkv/herdr-usage`: the app's server for `@knpkv/hub-app`. `GET /v1/modules/usage/limits` and
  `GET /v1/modules/usage/usage?range=7d&timeZone=Europe/Amsterdam` answer the fleet's readings when the app is
  attached to the hub (through `fleet.read`), and this machine's alone when it runs standalone.

The app's client and executable land when the hub's Usage pages move into this package.
