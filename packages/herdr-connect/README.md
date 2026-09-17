# `@knpkv/herdr-connect`

Fleet agent directory and authenticated Herdr terminal control.

The directory combines the local inventory with peer `/v1/connect/agents/local` responses. Peer requests time out after 1.5 seconds and run with bounded concurrency. An offline, unavailable, timed-out, or malformed peer becomes a typed partial failure; healthy agents remain usable.

The terminal connector resolves an opaque agent ID against the current local inventory, starts `herdr terminal session control`, streams Schema-decoded frames, and writes bounded input, resize, scroll, and release commands. Its session is scoped, so interruption releases or kills the child instead of leaving an attach process behind.

The connected terminal also exposes a touch-friendly key rail with fixed Escape, Tab, arrow, Ctrl, and Alt controls. Ctrl and Alt are one-shot modifiers: choose one, press a supported key or compatible terminal input, and the modifier clears after the typed `terminal.input` command is sent. Unsupported combinations are disabled or rejected; the rail never accepts arbitrary command text, and ordinary Ghostty input remains unchanged.

Browser consumers can import `@knpkv/herdr-connect/client` for the mounting entry, `@knpkv/herdr-connect/surface` for the embeddable state and view, and `@knpkv/herdr-connect/styles.css` for package-owned styles. Exact `host` plus stable `agent` query parameters select that room. The relationship store keys metadata by exact host and stable agent ID. Trusted live inventory may replace a stored parent only for the same host, stable agent ID, and pane with a strictly newer observation; durable, stale, equal, or pane-changing observations cannot reparent an agent. The view renders reported roots and parent relations; missing, cross-host, cyclic, or ambiguous ownership stays explicit and is never guessed.

Browser contracts are available through `@knpkv/herdr-connect/model`; browser subpaths do not pull SQLite or Node process code into the bundle.
