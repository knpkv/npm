---
"@knpkv/hub-app": minor
"@knpkv/herdr-hub": patch
---

Page metadata no longer has `showInPhoneTitle`: it was deprecated and ignored. A descriptor from an older app that still sends it decodes with the flag dropped; a descriptor literal typed as `ModuleDescriptor` that still writes it fails to compile with an excess-property error, so remove the flag from your descriptors. On a cold load the Hub's arrival focus lands on the page without painting a focus ring on a tab nobody reached by keyboard; the next Tab shows it as before.
