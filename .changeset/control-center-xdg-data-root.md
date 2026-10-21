---
"@knpkv/control-center": minor
---

The default data root moved: it is now `$XDG_DATA_HOME/control-center`, or `~/.local/share/control-center`, instead of `.control-center` in the current directory, so `npx @knpkv/control-center` finds the same data from anywhere. Existing data roots are not migrated. `CONTROL_CENTER_DATA_ROOT` still overrides the default. If a `.control-center` is left in the current directory, Control Center names it and says how to keep it (`CONTROL_CENTER_DATA_ROOT=<path>`) or move it (`backup`, then `restore`). Until the new default exists it refuses to start, rather than opening an empty app; `restore` still runs.
