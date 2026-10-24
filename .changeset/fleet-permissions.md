---
"@knpkv/herdr-fleet": minor
---

Add hub permissions: a closed `Permission` list, the optional `users`, `hosts` and `local` configuration keys, and `can(config, principal, permission)` for `Person`, `Host`, `Local`, `Service` and `Anonymous` callers. A permission name the hub does not know decodes, grants nothing, and is listed by `unknownPermissions`. No hub reads them yet.
