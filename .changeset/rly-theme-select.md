---
"@knpkv/rly": minor
---

Add `useStoredTheme`, `decodeRlyTheme`, and `ThemeSelect`, so apps share one way to remember and choose the theme instead of copying storage code. The hook takes an application-chosen key and lazily supplied storage, stays correct through server rendering and hydration, and keeps tabs in sync.
