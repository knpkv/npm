---
"@knpkv/control-center": minor
---

The data root defaults to `$XDG_DATA_HOME/control-center`, or `~/.local/share/control-center`, instead of `.control-center` in the current directory, so `npx @knpkv/control-center` finds the same data from anywhere. `CONTROL_CENTER_DATA_ROOT` still overrides it. A `.control-center` left in the current directory is never moved: each start names it and says how to keep it (`CONTROL_CENTER_DATA_ROOT=<path>`) or move it (`backup`, then `restore`).
