---
"@knpkv/codecommit-core": patch
"@knpkv/control-center": patch
---

AWS credential resolution now passes every profile name, `default` included, explicitly to the SDK. When a profile has no SSO configuration, resolution reads only that profile from shared configuration (`fromIni`). Ambient environment, web-identity, and instance credentials can no longer stand in for a named profile, so the identity used always matches the profile shown in the UI and audit records.
