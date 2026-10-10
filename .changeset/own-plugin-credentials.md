---
"@knpkv/control-center": patch
---

Each plugin connection now uses only its own credentials. Connection tests check credential isolation and authentication failures so a connection cannot report healthy using another connection's credentials.
