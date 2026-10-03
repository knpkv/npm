---
"@knpkv/jira-api-client": minor
"@knpkv/control-center": patch
---

Decode Jira change items that omit `toString`. Effect 4.0.0 reads declared struct keys through the prototype, so an omitted `toString` resolved to `Object.prototype.toString` and failed decoding. The new `ownOptionalKey` schema treats that inherited member as an absent key.
